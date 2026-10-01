"""Pydantic 请求模型。

一个场景 (scenario) 完整保存：
- 节点 / 管段拓扑
- 待检修的普通管段 (maintenance_pipe_id)
- 必须保供的节点 ID 列表 (protected_node_ids)
最近一次求解方案会随场景一起持久化（见 db.py）。
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


# ---- 批量对比 ----

class PlanIn(BaseModel):
    """批量对比中的单个检修方案快照定义（拓扑取自创建时的场景）。"""
    model_config = ConfigDict(extra="ignore")

    name: str = Field(..., min_length=1, max_length=64)
    maintenance_pipe_id: str = Field(..., min_length=1, max_length=64)
    protected_node_ids: List[str] = []


class ComparisonIn(BaseModel):
    """一次批量对比：2～6 个方案 + 基准方案下标（数量由 validation 校验）。"""
    model_config = ConfigDict(extra="ignore")

    name: str = Field(..., min_length=1, max_length=128)
    baseline_index: int = Field(..., ge=0)
    plans: List[PlanIn]


class ComparisonSummary(BaseModel):
    id: int
    scenario_id: int
    name: str
    plan_count: int
    created_at: str
