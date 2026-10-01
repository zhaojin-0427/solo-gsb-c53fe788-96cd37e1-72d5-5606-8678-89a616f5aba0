"""方案批量对比：不可变快照 + 批量求解 + 与基准方案的差异计算。

每个方案在创建对比时复制一份当时的场景拓扑（nodes/pipes），连同自己的
待检修管段、保供节点、名称一起持久化；之后修改场景拓扑或参数都不会
改写这些历史快照。求解直接复用 solver.solve，各次求解状态随快照保留。
"""
from __future__ import annotations

import copy
from datetime import datetime
from typing import List

from .solver import solve


def run_comparison(scenario: dict, plans: List[dict], baseline_index: int) -> dict:
    """对每个方案做拓扑快照并依次调用求解器，返回可持久化的对比载荷。

    scenario：创建对比时的场景详情；plans：已校验的方案定义列表；
    baseline_index：基准方案在 plans 中的下标。
    """
    topology = {
        "nodes": copy.deepcopy(scenario["nodes"]),
        "pipes": copy.deepcopy(scenario["pipes"]),
    }
    solved_plans = []
    for i, plan in enumerate(plans):
        payload = {
            "nodes": copy.deepcopy(topology["nodes"]),
            "pipes": copy.deepcopy(topology["pipes"]),
            "maintenance_pipe_id": plan["maintenance_pipe_id"],
            "protected_node_ids": list(plan["protected_node_ids"]),
        }
        solution = solve(payload)
        solved_plans.append({
            "key": str(i + 1),
            "name": plan["name"],
            "maintenance_pipe_id": plan["maintenance_pipe_id"],
            "protected_node_ids": list(plan["protected_node_ids"]),
            # 不可变快照：完整复制创建时刻的拓扑
            "nodes": payload["nodes"],
            "pipes": payload["pipes"],
            "solve_status": solution["status"],
            "solved_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "solution": solution,
        })
    return {
        "baseline_key": str(baseline_index + 1),
        "plans": solved_plans,
    }


def _diff_vs_baseline(plan: dict, baseline: dict) -> dict:
    """计算 plan 相对 baseline 的差异：新增断供、恢复供水、阀门变更。"""
    sol, base = plan["solution"], baseline["solution"]

    plan_disc = set(sol.get("disconnected_node_ids", []))
    base_disc = set(base.get("disconnected_node_ids", []))
    newly_disconnected = sorted(plan_disc - base_disc)
    restored = sorted(base_disc - plan_disc)

    households = {n["id"]: int(n.get("households", 0)) for n in plan["nodes"]}

    plan_closed = set(sol.get("closed_valve_ids", []))
    base_closed = set(base.get("closed_valve_ids", []))

    return {
        "newly_disconnected_node_ids": newly_disconnected,
        "newly_disconnected_households": sum(households.get(nid, 0)
                                             for nid in newly_disconnected),
        "restored_node_ids": restored,
        "restored_households": sum(households.get(nid, 0) for nid in restored),
        "valves_newly_closed": sorted(plan_closed - base_closed),
        "valves_reopened": sorted(base_closed - plan_closed),
    }


def comparison_view(payload: dict) -> dict:
    """把持久化的对比载荷整理成接口返回视图：方案按名称排序并附带基准差异。"""
    plans = payload["plans"]
    baseline_key = payload["baseline_key"]
    baseline = next(p for p in plans if p["key"] == baseline_key)

    view_plans = []
    for plan in sorted(plans, key=lambda p: p["name"]):
        sol = plan["solution"]
        view_plans.append({
            "key": plan["key"],
            "name": plan["name"],
            "is_baseline": plan["key"] == baseline_key,
            "maintenance_pipe_id": plan["maintenance_pipe_id"],
            "protected_node_ids": plan["protected_node_ids"],
            "solve_status": plan["solve_status"],
            "solved_at": plan["solved_at"],
            "disconnected_households": sol.get("disconnected_households", 0),
            "total_households": sol.get("total_households", 0),
            "closed_valve_ids": sol.get("closed_valve_ids", []),
            "closed_valve_count": sol.get("closed_valve_count", 0),
            "supplied_node_ids": sol.get("supplied_node_ids", []),
            "disconnected_node_ids": sol.get("disconnected_node_ids", []),
            "diff_vs_baseline": _diff_vs_baseline(plan, baseline),
        })
    return {
        "baseline_key": baseline_key,
        "baseline_name": baseline["name"],
        "plans": view_plans,
    }
