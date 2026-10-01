"""SQLite 持久化层（标准库 sqlite3，每次请求独立连接，check_same_thread 安全）。

三类数据：

* scenarios：场景与最近一次单方案求解结果（solution_json）；
* plans：从场景拓扑深拷贝出来的**不可变检修方案快照**，各自携带独立的
  maintenance_pipe_id / protected_node_ids 与求解结果 solution_json。
  场景拓扑修改（PUT scenarios）只改 scenarios.payload_json，绝不改写
  已存在的 plans / comparisons —— 历史快照永远定格在创建时的管网；
* comparisons：一次批量对比的完整结果（含拓扑快照与逐方案求解状态），
  刷新页面 / 重启容器后仍可原样恢复。
"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime
from typing import List, Optional

from .validation import topology_hash

DB_PATH = os.environ.get("WATER_DB_PATH", "/data/water.db")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS scenarios (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    payload_json    TEXT NOT NULL,
    solution_json   TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    scenario_id     INTEGER NOT NULL,
    name            TEXT NOT NULL,
    payload_json    TEXT NOT NULL,   -- 创建时深拷贝的完整拓扑 + 检修/保供选择（不可变）
    solution_json   TEXT,            -- 该快照最近一次求解结果（可独立重跑）
    created_at      TEXT NOT NULL,
    FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_plans_scenario ON plans(scenario_id);

CREATE TABLE IF NOT EXISTS comparisons (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    scenario_id     INTEGER NOT NULL,
    baseline_plan_id INTEGER NOT NULL,
    result_json     TEXT NOT NULL,   -- 完整对比结果（含拓扑快照、各方案状态与差异）
    created_at      TEXT NOT NULL,
    FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comparisons_scenario ON comparisons(scenario_id);

CREATE TABLE IF NOT EXISTS comparison_plans (
    comparison_id   INTEGER NOT NULL,
    plan_id         INTEGER NOT NULL,
    PRIMARY KEY (comparison_id, plan_id),
    FOREIGN KEY (comparison_id) REFERENCES comparisons(id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
);
"""


def _connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.executescript(_SCHEMA)


def _row_to_detail(row: sqlite3.Row) -> dict:
    payload = json.loads(row["payload_json"])
    solution = json.loads(row["solution_json"]) if row["solution_json"] else None
    return {
        "id": row["id"],
        "name": payload.get("name", row["name"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "nodes": payload["nodes"],
        "pipes": payload["pipes"],
        "maintenance_pipe_id": payload.get("maintenance_pipe_id"),
        "protected_node_ids": payload.get("protected_node_ids", []),
        "topology_hash": topology_hash(payload["nodes"], payload["pipes"]),
        "solution": solution,
    }


def list_scenarios() -> List[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM scenarios ORDER BY updated_at DESC, id DESC"
        ).fetchall()
    out = []
    for r in rows:
        sol = json.loads(r["solution_json"]) if r["solution_json"] else None
        out.append({
            "id": r["id"],
            "name": json.loads(r["payload_json"]).get("name", r["name"]),
            "updated_at": r["updated_at"],
            "has_solution": sol is not None,
            "status": sol["status"] if sol else None,
        })
    return out


def get_scenario(scenario_id: int) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM scenarios WHERE id = ?", (scenario_id,)
        ).fetchone()
    return _row_to_detail(row) if row else None


def create_scenario(data: dict) -> dict:
    now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    payload = {k: data[k] for k in ("name", "nodes", "pipes",
                                    "maintenance_pipe_id", "protected_node_ids")}
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO scenarios (name, payload_json, solution_json, created_at, updated_at)"
            " VALUES (?, ?, NULL, ?, ?)",
            (data["name"], json.dumps(payload, ensure_ascii=False), now, now),
        )
        scenario_id = cur.lastrowid
    return get_scenario(scenario_id)


def update_scenario(scenario_id: int, data: dict) -> Optional[dict]:
    """更新场景；拓扑 / 选择发生变化，旧方案作废（solution 清空）。"""
    now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    payload = {k: data[k] for k in ("name", "nodes", "pipes",
                                    "maintenance_pipe_id", "protected_node_ids")}
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE scenarios SET name = ?, payload_json = ?, solution_json = NULL,"
            " updated_at = ? WHERE id = ?",
            (data["name"], json.dumps(payload, ensure_ascii=False), now, scenario_id),
        )
        if cur.rowcount == 0:
            return None
    return get_scenario(scenario_id)


def save_solution(scenario_id: int, solution: dict) -> Optional[dict]:
    now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE scenarios SET solution_json = ?, updated_at = ? WHERE id = ?",
            (json.dumps(solution, ensure_ascii=False), now, scenario_id),
        )
        if cur.rowcount == 0:
            return None
    return get_scenario(scenario_id)


def delete_scenario(scenario_id: int) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM scenarios WHERE id = ?", (scenario_id,))
        return cur.rowcount > 0


# ============================================================
# 方案快照（plans）
# ============================================================
def _plan_row_to_detail(row: sqlite3.Row) -> dict:
    payload = json.loads(row["payload_json"])
    solution = json.loads(row["solution_json"]) if row["solution_json"] else None
    return {
        "id": row["id"],
        "scenario_id": row["scenario_id"],
        "name": payload.get("name", row["name"]),
        "created_at": row["created_at"],
        "nodes": payload["nodes"],
        "pipes": payload["pipes"],
        "maintenance_pipe_id": payload.get("maintenance_pipe_id"),
        "protected_node_ids": payload.get("protected_node_ids", []),
        "topology_hash": topology_hash(payload["nodes"], payload["pipes"]),
        "solution": solution,
    }


def list_plans(scenario_id: int) -> List[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM plans WHERE scenario_id = ? ORDER BY created_at DESC, id DESC",
            (scenario_id,),
        ).fetchall()
    out = []
    for r in rows:
        payload = json.loads(r["payload_json"])
        sol = json.loads(r["solution_json"]) if r["solution_json"] else None
        out.append({
            "id": r["id"],
            "scenario_id": r["scenario_id"],
            "name": payload.get("name", r["name"]),
            "created_at": r["created_at"],
            "maintenance_pipe_id": payload.get("maintenance_pipe_id"),
            "protected_node_ids": payload.get("protected_node_ids", []),
            "topology_hash": topology_hash(payload["nodes"], payload["pipes"]),
            "has_solution": sol is not None,
            "status": sol["status"] if sol else None,
        })
    return out


def get_plan(plan_id: int) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
    return _plan_row_to_detail(row) if row else None


def create_plan(scenario_id: int, data: dict) -> dict:
    """以当前场景拓扑创建不可变快照：nodes/pipes 在这里被深拷贝进 payload，
    之后无论场景如何修改，本快照内容都不会变化。"""
    now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    payload = {k: data[k] for k in ("name", "nodes", "pipes",
                                    "maintenance_pipe_id", "protected_node_ids")}
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO plans (scenario_id, name, payload_json, solution_json, created_at)"
            " VALUES (?, ?, ?, NULL, ?)",
            (scenario_id, data["name"], json.dumps(payload, ensure_ascii=False), now),
        )
        plan_id = cur.lastrowid
    return get_plan(plan_id)


def count_plans(scenario_id: int) -> int:
    with _connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM plans WHERE scenario_id = ?", (scenario_id,)
        ).fetchone()
    return int(row["c"])


def save_plan_solution(plan_id: int, solution: dict) -> Optional[dict]:
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE plans SET solution_json = ? WHERE id = ?",
            (json.dumps(solution, ensure_ascii=False), plan_id),
        )
        if cur.rowcount == 0:
            return None
    return get_plan(plan_id)


def plan_referenced(plan_id: int) -> bool:
    """方案快照是否已被某次对比引用；引用后不可删除（保证对比历史可复现）。"""
    with _connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM comparison_plans WHERE plan_id = ?",
            (plan_id,),
        ).fetchone()
    return int(row["c"]) > 0


def delete_plan(plan_id: int) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM plans WHERE id = ?", (plan_id,))
        return cur.rowcount > 0


# ============================================================
# 批量对比（comparisons）
# ============================================================
def create_comparison(scenario_id: int, baseline_plan_id: int, result: dict,
                      plan_ids: List[int]) -> dict:
    now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    result = {**result, "created_at": now}
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO comparisons (scenario_id, baseline_plan_id, result_json, created_at)"
            " VALUES (?, ?, ?, ?)",
            (scenario_id, baseline_plan_id,
             json.dumps(result, ensure_ascii=False), now),
        )
        comparison_id = cur.lastrowid
        conn.executemany(
            "INSERT INTO comparison_plans (comparison_id, plan_id) VALUES (?, ?)",
            [(comparison_id, pid) for pid in plan_ids],
        )
    return {"id": comparison_id, **result}


def list_comparisons(scenario_id: int) -> List[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM comparisons WHERE scenario_id = ?"
            " ORDER BY created_at DESC, id DESC",
            (scenario_id,),
        ).fetchall()
    out = []
    for r in rows:
        result = json.loads(r["result_json"])
        out.append({
            "id": r["id"],
            "scenario_id": r["scenario_id"],
            "baseline_plan_id": r["baseline_plan_id"],
            "baseline_name": result.get("baseline_name", ""),
            "created_at": r["created_at"],
            "plan_count": len(result.get("plans", [])),
            "plan_names": [p["name"] for p in result.get("plans", [])],
        })
    return out


def get_comparison(comparison_id: int) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM comparisons WHERE id = ?", (comparison_id,)
        ).fetchone()
    if row is None:
        return None
    result = json.loads(row["result_json"])
    return {"id": row["id"], "scenario_id": row["scenario_id"], **result}


def get_latest_comparison(scenario_id: int) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM comparisons WHERE scenario_id = ?"
            " ORDER BY created_at DESC, id DESC LIMIT 1",
            (scenario_id,),
        ).fetchone()
    if row is None:
        return None
    result = json.loads(row["result_json"])
    return {"id": row["id"], **result}


def delete_comparison(comparison_id: int) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM comparisons WHERE id = ?", (comparison_id,))
        return cur.rowcount > 0
