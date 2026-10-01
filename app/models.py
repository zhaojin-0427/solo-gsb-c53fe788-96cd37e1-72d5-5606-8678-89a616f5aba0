"""Pydantic 请求 / 响应模型。

场景 (scenario) 完整保存节点 / 管段拓扑、待检修普通管段、必须保供节点，
最近一次单方案求解随场景持久化。

方案批量对比新增两类模型：
- PlanIn / PlanSummary：不可变检修方案快照（创建时由服务端深拷贝拓扑）；
- CompareIn / ComparisonSummary：2～6 个快照的一次批量对比及其历史摘要。
"""
from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field, ConfigDict


class NodeIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(..., min_length=1, max_length=64)
    kind: str = Field("user", pattern="^(source|user)$")
    households: int = Field(0, ge=0)
    x: float = Field(0.0)
    y: float = Field(0.0)


class PipeIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(..., min_length=1, max_length=64)
    a: str
    b: str
    is_valve: bool = False


class ScenarioIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str = Field(..., min_length=1, max_length=128)
    nodes: List[NodeIn]
    pipes: List[PipeIn]
    maintenance_pipe_id: Optional[str] = None
    protected_node_ids: List[str] = []


class ScenarioSummary(BaseModel):
    id: int
    name: str
    updated_at: str
    has_solution: bool
    status: Optional[str] = None


# ============================================================
# 方案批量对比
# ============================================================
class PlanIn(BaseModel):
    """创建不可变检修方案快照：只指定名称、检修段与保供节点；
    拓扑（nodes/pipes）在服务端从已保存场景深拷贝，客户端无法改写。"""
    model_config = ConfigDict(extra="ignore")

    name: str = Field(..., min_length=1, max_length=128)
    maintenance_pipe_id: Optional[str] = None
    protected_node_ids: List[str] = []


class PlanSummary(BaseModel):
    id: int
    scenario_id: int
    name: str
    created_at: str
    maintenance_pipe_id: Optional[str] = None
    protected_node_ids: List[str] = []
    topology_hash: str
    has_solution: bool
    status: Optional[str] = None


class CompareIn(BaseModel):
    """一次批量对比：2～6 个同一管网下的方案快照，指定其中一个为基准。"""
    model_config = ConfigDict(extra="ignore")

    plan_ids: List[int] = Field(..., min_length=2, max_length=6)
    baseline_plan_id: int


class ComparisonSummary(BaseModel):
    id: int
    scenario_id: int
    baseline_plan_id: int
    baseline_name: str
    created_at: str
    plan_count: int
    plan_names: List[str]
