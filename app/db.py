"""SQLite 持久化层（标准库 sqlite3，每次请求独立连接，check_same_thread 安全）。

场景与对应方案同表存储：solution_json 为最近一次求解结果，
刷新页面或重启容器（配合 compose 命名卷）后仍可查看。
"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime
from typing import List, Optional

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
