"""方案批量对比：逐个调用现有求解器并计算相对基准方案的差异。

每次对比针对同一已保存管网下 2～6 个不可变方案快照：

* 每个快照独立求解（沿用 solver.solve，10 秒时限、状态标签完全一致），
  各次求解的状态、阀门、供水/断供节点都原样保留；
* 以用户指定的基准方案为参照，为其余方案计算：
  新增断供节点 / 恢复供水节点 / 新增关闭阀门 / 取消关闭阀门，
  以及断供户数之差（正=比基准多断供）；
* 结果行按方案名（再按 plan_id）升序排列。

任何一次求解抛异常都不会中断整批：该方案被标记 status="error"，
错误信息与其他方案结果一起返回并持久化。
"""
from __future__ import annotations

from typing import Dict, List, Optional

from . import db
from .solver import solve
from .validation import topology_canonical

MAX_PLANS_PER_COMPARISON = 6
MIN_PLANS_PER_COMPARISON = 2


def _topology_signature(plan: dict) -> str:
    """拓扑指纹：节点与管段（忽略顺序）。同一次对比的所有快照必须一致，
    即必须来自同版管网 —— 管网在快照创建后若被改动，新旧快照不能混在
    一张对比表里。"""
    return topology_canonical(plan["nodes"], plan["pipes"])


def _plan_payload(plan: dict) -> dict:
    return {
        "nodes": plan["nodes"],
        "pipes": plan["pipes"],
        "maintenance_pipe_id": plan["maintenance_pipe_id"],
        "protected_node_ids": plan["protected_node_ids"],
    }


def solve_plan(plan: dict) -> dict:
    """对单个快照调用现有求解器；异常归一化为 error 状态结果。"""
    try:
        return solve(_plan_payload(plan))
    except Exception as exc:  # noqa: BLE001 - 批量任务需保留每次的失败状态
        nodes = plan["nodes"]
        total_hh = sum(int(n.get("households", 0)) for n in nodes
                       if n.get("kind") != "source")
        return {
            "status": "error",
            "error": f"{type(exc).__name__}: {exc}"[:500],
            "elapsed_ms": 0,
            "removed_pipe_ids": [plan["maintenance_pipe_id"]]
                                 if plan.get("maintenance_pipe_id") else [],
            "total_households": total_hh,
            "closed_valve_ids": [],
            "supplied_node_ids": [],
            "disconnected_node_ids":
                [n["id"] for n in nodes if n.get("kind") != "source"],
            "reachable_sources": [],
            "disconnected_households": total_hh,
            "served_households": 0,
            "closed_valve_count": 0,
        }


def _diff_against_baseline(sol: Optional[dict], base: Optional[dict]) -> Optional[dict]:
    """计算某方案相对基准方案的差异。任一方案缺少“具体可执行结果”
    （optimal/feasible）时返回 None：无解、未找到、求解错误都不产生差异。"""
    concrete = {"optimal", "feasible"}
    if not sol or not base:
        return None
    if sol.get("status") not in concrete or base.get("status") not in concrete:
        return None

    cur_disc = set(sol.get("disconnected_node_ids", []))
    base_disc = set(base.get("disconnected_node_ids", []))
    cur_supplied = set(sol.get("supplied_node_ids", []))
    base_supplied = set(base.get("supplied_node_ids", []))
    cur_closed = set(sol.get("closed_valve_ids", []))
    base_closed = set(base.get("closed_valve_ids", []))

    # 新增断供：基准在供水、本方案断供；恢复供水：反之
    newly_disconnected = sorted(cur_disc & base_supplied)
    restored_supplied = sorted(cur_supplied & base_disc)
    newly_closed = sorted(cur_closed - base_closed)       # 基准没关、本方案关闭
    reopened = sorted(base_closed - cur_closed)           # 基准关闭、本方案不再关闭

    return {
        "newly_disconnected_node_ids": newly_disconnected,
        "restored_supplied_node_ids": restored_supplied,
        "newly_closed_valve_ids": newly_closed,
        "reopened_valve_ids": reopened,
        "disconnected_households_delta":
            int(sol.get("disconnected_households", 0))
            - int(base.get("disconnected_households", 0)),
    }


def _row(plan: dict, sol: dict, is_baseline: bool,
         baseline_sol: Optional[dict]) -> dict:
    return {
        "plan_id": plan["id"],
        "name": plan["name"],
        "is_baseline": is_baseline,
        "maintenance_pipe_id": plan["maintenance_pipe_id"],
        "protected_node_ids": list(plan.get("protected_node_ids", [])),
        "solution": sol,
        # 基准方案自身差异全部为空，保证其在前端也走统一渲染
        "diff": {
            "newly_disconnected_node_ids": [],
            "restored_supplied_node_ids": [],
            "newly_closed_valve_ids": [],
            "reopened_valve_ids": [],
            "disconnected_households_delta": 0,
        } if is_baseline else _diff_against_baseline(sol, baseline_sol),
    }


def run_comparison(scenario_id: int, plan_ids: List[int],
                   baseline_plan_id: int) -> Optional[dict]:
    """批量求解并生成对比结果。入参由路由层校验；返回 None 表示场景不存在。

    结果整体写入 comparisons 表（含拓扑快照），之后场景拓扑再被修改也不会
    影响历史对比的展示。
    """
    scenario = db.get_scenario(scenario_id)
    if scenario is None:
        return None

    # 取快照并核对归属（必须同属本场景、且不重复）
    plans: Dict[int, dict] = {}
    for pid in plan_ids:
        plan = db.get_plan(pid)
        if plan is None or plan["scenario_id"] != scenario_id:
            raise ValueError(f"方案 {pid} 不存在或不属于场景 {scenario_id}")
        plans[pid] = plan
    baseline = db.get_plan(baseline_plan_id)
    if baseline is None or baseline_plan_id not in plans:
        raise ValueError("基准方案必须包含在参与对比的方案列表中")

    # 所有快照必须来自同一版管网（拓扑/参数一致），否则拒绝混比
    signatures = {pid: _topology_signature(plans[pid]) for pid in plan_ids}
    if len(set(signatures.values())) != 1:
        raise ValueError(
            "参与对比的方案来自不同版本的管网（管网在这些方案创建后被修改过）；"
            "请用当前管网重新创建方案后再对比")

    # 逐个求解并持久化各次求解状态（批量调用现有求解器）
    solutions: Dict[int, dict] = {}
    for pid in plan_ids:
        sol = solve_plan(plans[pid])
        solutions[pid] = sol
        db.save_plan_solution(pid, sol)

    baseline_sol = solutions[baseline_plan_id]

    rows = [
        _row(plans[pid], solutions[pid], pid == baseline_plan_id, baseline_sol)
        for pid in plan_ids
    ]
    # 按方案名排序（同名再按 plan_id，保证稳定）
    rows.sort(key=lambda r: (r["name"], r["plan_id"]))

    # 拓扑取快照自身（各快照已校验为同版），不读实时场景：
    # 这样即使对比创建后场景再被修改，历史对比里展示的仍是当时的管网
    snap = plans[plan_ids[0]]
    result = {
        "scenario_id": scenario_id,
        "baseline_plan_id": baseline_plan_id,
        "baseline_name": baseline["name"],
        "nodes": snap["nodes"],
        "pipes": snap["pipes"],
        "plans": rows,
    }
    saved = db.create_comparison(scenario_id, baseline_plan_id, result,
                                 list(dict.fromkeys(plan_ids)))
    return saved
