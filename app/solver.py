"""隔离方案求解器（OR-Tools CP-SAT）。

建模：有向弧 + 深度锚定的可达性传播
==================================
设每个可关闭阀门 v 有布尔变量 open_v（1=保持开启，0=关闭）；
待检修普通管段直接从图中移除。

对每条“剩余管段” e=(u,v) 建两个有向布尔弧 d(u→v)、d(v→u)：

* 水源 u：普通管上 d=1，阀门上 d ⇔ open_e；
* 用水户 u：d(u→v) ⇔ 管段畅通 AND u 可达水源
  （普通管：d ⇔ reach(u)；阀门：d ⇔ open_e ∧ reach(u)）。

每个可达用水节点 v 必须选取一条入弧 d(u→v) 作为“父弧”，并满足
    depth(v) = depth(u) + 1（水源 depth 视为 0），
不可达时 reach(v)=0、depth(v)=0。

depth 沿路径严格递减并最终锚定到水源，因此：

* reach_v = 1 当且仅当在“关阀 + 移除检修段”后的剩余无向图里存在
  水源→v 的真实路径；与水源分离的孤岛（哪怕节点间互相连边）不可能
  靠“互指入弧”自我确认可达，绝不会被计为供水；
* 水也无法“穿过”被强制断压的检修段端点供给下游。

字典序目标（分三阶段求解，前一阶段最优值固化为后阶段硬约束）：
  1) 最小化断供户数（=最大化 Σ households_u·reach_u）；
  2) 最小化关闭阀门数；
  3) 关闭阀门 ID 升序列表最小：阀门按 ID 字典序编号 0..V-1，关闭数固定时
     最大化 Σ 2^i·open_i —— 在大小相同的关闭集合中取字典序最小者
     （等价于优先关闭小编号阀门，已用穷举对照验证）。

10 秒总时限：阶段链全部被证明 OPTIMAL 才标“最优”；
超时但有可行解标“未证最优”；模型不可行标“无解”；其余“未找到”。
"""
from __future__ import annotations

import time
from collections import deque
from typing import Dict, List, Optional

from ortools.sat.python import cp_model

TIME_LIMIT_SECONDS = 10.0


def solve(data: dict) -> dict:
    t0 = time.perf_counter()

    nodes: List[dict] = data["nodes"]
    pipes: List[dict] = data["pipes"]
    maintenance_pipe_id: Optional[str] = data.get("maintenance_pipe_id")
    protected: set[str] = set(data.get("protected_node_ids", []))

    node_ids = [n["id"] for n in nodes]
    source_ids = {n["id"] for n in nodes if n["kind"] == "source"}
    is_source = {n["id"]: n["kind"] == "source" for n in nodes}
    households = {n["id"]: int(n["households"]) for n in nodes}
    total_hh = sum(h for nid, h in households.items() if not is_source[nid])

    valve_pipes = [p for p in pipes if p["is_valve"]]
    valve_ids_sorted = sorted(p["id"] for p in valve_pipes)
    valve_index = {vid: i for i, vid in enumerate(valve_ids_sorted)}
    V = len(valve_ids_sorted)

    maintenance_pipe = next((p for p in pipes if p["id"] == maintenance_pipe_id), None)
    maintenance_removed_id = maintenance_pipe["id"] if maintenance_pipe else None

    # 检修段端点若是水源：物理上无法隔离，直接令模型不可行
    endpoint_sources = (
        {maintenance_pipe["a"], maintenance_pipe["b"]} & source_ids
        if maintenance_pipe else set()
    )

    def build_stage(stage: int, best_hh: Optional[int], best_closed: Optional[int],
                    hint: Optional[dict]):
        m = cp_model.CpModel()

        open_var: Dict[str, cp_model.IntVar] = {
            p["id"]: m.NewBoolVar(f"open_{p['id']}") for p in valve_pipes
        }
        reach: Dict[str, cp_model.IntVar] = {
            nid: m.NewBoolVar(f"reach_{nid}")
            for nid in node_ids if not is_source[nid]
        }
        user_count = len(reach)
        depth: Dict[str, cp_model.IntVar] = {
            nid: m.NewIntVar(0, max(1, user_count), f"depth_{nid}")
            for nid in node_ids if not is_source[nid]
        }
        for nid, var in reach.items():
            m.Add(depth[nid] == 0).OnlyEnforceIf(var.Not())
            m.Add(depth[nid] >= 1).OnlyEnforceIf(var)

        # entries[v] = (arc, 上游节点 u)
        entries: Dict[str, List[tuple]] = {nid: [] for nid in node_ids}

        for p in pipes:
            if p["id"] == maintenance_removed_id:
                continue
            a, b = p["a"], p["b"]
            ov = open_var[p["id"]] if p["is_valve"] else None
            for u, v in ((a, b), (b, a)):
                if is_source[v]:
                    continue  # 水源不接收输水
                if is_source[u]:
                    arc = m.NewBoolVar(f"arc_{p['id']}_{u}_{v}")
                    if ov is None:
                        m.Add(arc == 1)  # 普通管直连水源
                    else:
                        m.Add(arc == ov)  # 阀门：开即通
                else:
                    arc = m.NewBoolVar(f"arc_{p['id']}_{u}_{v}")
                    # arc ⇔ 管段畅通 AND reach(u)
                    m.Add(arc <= reach[u])
                    if ov is not None:
                        m.Add(arc <= ov)
                        m.Add(arc >= reach[u] + ov - 1)
                    else:
                        m.Add(arc == reach[u])
                m.Add(arc <= reach[v])  # arc => reach(v)
                entries[v].append((arc, u))

        # 可达节点必须选一条父弧，depth(v)=depth(u)+1（水源 depth=0）
        for nid, var in reach.items():
            arcs_in = entries[nid]
            if not arcs_in:
                m.Add(var == 0)
                continue
            parents = []
            for arc, u in arcs_in:
                sel = m.NewBoolVar(f"parent_{nid}_{u}")
                m.AddImplication(sel, arc)
                if is_source[u]:
                    m.Add(depth[nid] == 1).OnlyEnforceIf(sel)
                else:
                    m.Add(depth[nid] == depth[u] + 1).OnlyEnforceIf(sel)
                parents.append(sel)
            m.Add(sum(parents) == var)

        for nid in protected:
            if nid in reach:
                m.Add(reach[nid] == 1)

        if maintenance_pipe is not None:
            for ep in (maintenance_pipe["a"], maintenance_pipe["b"]):
                if not is_source[ep]:
                    m.Add(reach[ep] == 0)

        if endpoint_sources:
            bogus = m.NewBoolVar("impossible_maintenance_touches_source")
            m.Add(bogus == 0)
            m.Add(bogus == 1)

        served_hh = sum(households[nid] * var for nid, var in reach.items())
        closed_count = sum(1 - var for var in open_var.values())

        if best_hh is not None:
            m.Add(served_hh >= best_hh)
        if best_closed is not None:
            m.Add(closed_count <= best_closed)

        if stage == 1:
            m.Maximize(served_hh)
        elif stage == 2:
            m.Minimize(closed_count)
        else:
            # 关闭数固定；编号越小的阀门位权越小，最大化时优先被牺牲（关闭）
            m.Add(closed_count == best_closed)
            m.Maximize(sum((1 << valve_index[vid]) * var
                           for vid, var in open_var.items()))

        if hint is not None:
            for vid, var in open_var.items():
                m.AddHint(var, 0 if vid in hint["closed"] else 1)
            for nid, var in reach.items():
                m.AddHint(var, 1 if nid in hint["supplied_users"] else 0)

        return m, {"open": open_var, "reach": reach}

    def run_stage(stage, best_hh, best_closed, hint, remaining):
        model_, vars_ = build_stage(stage, best_hh, best_closed, hint)
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = max(0.05, remaining)
        solver.parameters.num_search_workers = 8
        solver.parameters.random_seed = 20260930
        solver.parameters.log_search_progress = False
        status = solver.Solve(model_)
        return solver, status, vars_

    def extract(solver, vars_):
        closed = {vid for vid, var in vars_["open"].items() if solver.Value(var) == 0}
        supplied = {nid for nid, var in vars_["reach"].items() if solver.Value(var) == 1}
        return {"closed": closed, "supplied_users": supplied,
                "served_hh": sum(households[nid] for nid in supplied)}

    base_result = {
        "elapsed_ms": int((time.perf_counter() - t0) * 1000),
        "removed_pipe_ids": [maintenance_removed_id] if maintenance_removed_id else [],
        "total_households": total_hh,
    }
    no_solution = {
        **base_result,
        "closed_valve_ids": [],
        "supplied_node_ids": [],
        "disconnected_node_ids":
            [n["id"] for n in nodes if not is_source[n["id"]]],
        "reachable_sources": [],
        "disconnected_households": total_hh,
        "served_households": 0,
        "closed_valve_count": 0,
    }

    # ---- 阶段 1：最小化断供户数 ----
    s1, st1, v1 = run_stage(1, None, None, None,
                            TIME_LIMIT_SECONDS - (time.perf_counter() - t0))
    if st1 == cp_model.INFEASIBLE:
        return {**no_solution, "status": "infeasible"}
    if st1 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {**no_solution, "status": "not_found"}

    best = extract(s1, v1)
    proven = False

    if st1 == cp_model.OPTIMAL:
        # ---- 阶段 2：最小化关闭阀门数 ----
        s2, st2, v2 = run_stage(2, best["served_hh"], None, best,
                                TIME_LIMIT_SECONDS - (time.perf_counter() - t0))
        if st2 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            cand = extract(s2, v2)
            if cand["served_hh"] >= best["served_hh"]:
                best = cand
        if st2 == cp_model.OPTIMAL:
            # ---- 阶段 3：关闭 ID 升序列表字典序最小 ----
            k = len(best["closed"])
            s3, st3, v3 = run_stage(3, best["served_hh"], k, best,
                                    TIME_LIMIT_SECONDS - (time.perf_counter() - t0))
            if st3 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                cand = extract(s3, v3)
                if cand["served_hh"] >= best["served_hh"] and len(cand["closed"]) <= k:
                    best = cand
            proven = st3 == cp_model.OPTIMAL

    # ---- BFS 在剩余图上复核真实连通性（展示以复核结果为准）----
    closed = best["closed"]
    removed = set(closed)
    if maintenance_removed_id:
        removed.add(maintenance_removed_id)

    adj: Dict[str, List[str]] = {nid: [] for nid in node_ids}
    for p in pipes:
        if p["id"] in removed:
            continue
        adj[p["a"]].append(p["b"])
        adj[p["b"]].append(p["a"])

    sources = [nid for nid in node_ids if is_source[nid]]
    reachable = set(sources)
    q = deque(sources)
    while q:
        u = q.popleft()
        for w in adj[u]:
            if w not in reachable:
                reachable.add(w)
                q.append(w)

    supplied_node_ids = [nid for nid in node_ids
                         if not is_source[nid] and nid in reachable]
    disconnected_node_ids = [nid for nid in node_ids
                             if not is_source[nid] and nid not in reachable]
    disconnected_hh = sum(households[nid] for nid in disconnected_node_ids)

    return {
        **base_result,
        "status": "optimal" if proven else "feasible",
        "closed_valve_ids": sorted(closed),
        "supplied_node_ids": supplied_node_ids,
        "disconnected_node_ids": disconnected_node_ids,
        "reachable_sources": sorted(s for s in sources if s in reachable),
        "disconnected_households": disconnected_hh,
        "served_households": total_hh - disconnected_hh,
        "closed_valve_count": len(closed),
    }
