"""场景数据校验：容量限制、ID 唯一性、端点存在性等。

任何不合法的管网都在这里被拒绝，返回中文错误列表；非法场景不会入库。
"""
from __future__ import annotations

from typing import List, Tuple

from .models import ScenarioIn

MAX_NODES = 80
MAX_PIPES = 120
MAX_VALVES = 40
MAX_HOUSEHOLDS = 100_000_000  # 单个节点户数上限，防止求解器数值溢出
COORD_BOUND = 100_000.0


def validate_scenario(sc: ScenarioIn) -> List[str]:
    """返回错误信息列表；空列表表示合法。"""
    errors: List[str] = []

    # ---- 容量限制 ----
    if len(sc.nodes) > MAX_NODES:
        errors.append(f"节点数量 {len(sc.nodes)} 超过上限 {MAX_NODES}")
    if len(sc.pipes) > MAX_PIPES:
        errors.append(f"管段数量 {len(sc.pipes)} 超过上限 {MAX_PIPES}")
    valve_count = sum(1 for p in sc.pipes if p.is_valve)
    if valve_count > MAX_VALVES:
        errors.append(f"可关闭阀门数量 {valve_count} 超过上限 {MAX_VALVES}")

    # ---- 节点 ID 重复 ----
    seen_nodes: set[str] = set()
    dup_nodes: set[str] = set()
    for n in sc.nodes:
        nid = n.id.strip()
        if nid in seen_nodes:
            dup_nodes.add(nid)
        seen_nodes.add(nid)
        if n.households > MAX_HOUSEHOLDS:
            errors.append(f"节点 {nid} 的户数 {n.households} 超过上限 {MAX_HOUSEHOLDS}")
        if not (-COORD_BOUND <= n.x <= COORD_BOUND and -COORD_BOUND <= n.y <= COORD_BOUND):
            errors.append(f"节点 {nid} 坐标超出允许范围")
        if n.kind == "source" and n.households not in (0,):
            errors.append(f"水源节点 {nid} 不能填写户数")
    for nid in sorted(dup_nodes):
        errors.append(f"节点 ID 重复：{nid}")

    # ---- 管段校验 ----
    seen_pipes: set[str] = set()
    dup_pipes: set[str] = set()
    for p in sc.pipes:
        pid = p.id.strip()
        if pid in seen_pipes:
            dup_pipes.add(pid)
        seen_pipes.add(pid)

        # 端点不存在
        missing = [e for e in (p.a, p.b) if e not in seen_nodes]
        if missing:
            errors.append(f"管段 {pid} 的端点不存在：{'、'.join(missing)}")
        # 自环
        if p.a == p.b:
            errors.append(f"管段 {pid} 的两个端点不能相同（不允许自环）")
    for pid in sorted(dup_pipes):
        errors.append(f"管段 ID 重复：{pid}")

    # ---- 检修管段 ----
    if sc.maintenance_pipe_id is not None:
        pid = sc.maintenance_pipe_id
        if pid not in seen_pipes:
            errors.append(f"待检修管段不存在：{pid}")
        else:
            target = next(p for p in sc.pipes if p.id == pid)
            if target.is_valve:
                errors.append(f"待检修管段 {pid} 必须是普通管段，不能是阀门")

    # ---- 保供节点 ----
    seen_protected: set[str] = set()
    for nid in sc.protected_node_ids:
        if nid in seen_protected:
            continue
        seen_protected.add(nid)
        if nid not in seen_nodes:
            errors.append(f"必须保供的节点不存在：{nid}")
            continue
        node = next(n for n in sc.nodes if n.id == nid)
        if node.kind == "source":
            errors.append(f"水源节点 {nid} 无需设为保供节点（水源本身不耗水）")

    # 没有管段却选了检修段等情况已在上面覆盖
    _ = (MAX_NODES, MAX_PIPES, MAX_VALVES)
    return errors


def normalize(sc: ScenarioIn) -> Tuple[dict, List[str]]:
    """把场景规整成入库 / 求解所需的纯数据结构。"""
    errors = validate_scenario(sc)
    if errors:
        return {}, errors

    data = {
        "name": sc.name.strip() or "未命名场景",
        "nodes": [
            {"id": n.id.strip(), "kind": n.kind, "households": int(n.households),
             "x": float(n.x), "y": float(n.y)}
            for n in sc.nodes
        ],
        "pipes": [
            {"id": p.id.strip(), "a": p.a, "b": p.b, "is_valve": bool(p.is_valve)}
            for p in sc.pipes
        ],
        "maintenance_pipe_id": sc.maintenance_pipe_id,
        "protected_node_ids": list(dict.fromkeys(sc.protected_node_ids)),
    }
    return data, []
