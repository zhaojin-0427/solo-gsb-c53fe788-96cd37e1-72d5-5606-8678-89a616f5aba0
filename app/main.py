"""FastAPI 入口：场景 CRUD、求解接口、方案批量对比、静态资源托管。"""
from __future__ import annotations

import os
from typing import List

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .comparison import (
    MAX_PLANS_PER_COMPARISON,
    MIN_PLANS_PER_COMPARISON,
    run_comparison,
    solve_plan,
)
from .models import (
    CompareIn,
    ComparisonSummary,
    PlanIn,
    PlanSummary,
    ScenarioIn,
    ScenarioSummary,
)
from .solver import solve
from .validation import normalize, validate_plan_choices

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(BASE_DIR, "static")

app = FastAPI(title="供水检修隔离方案台", version="1.1.0")


@app.on_event("startup")
def _startup() -> None:
    db.init_db()


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/scenarios", response_model=List[ScenarioSummary])
def api_list_scenarios():
    return db.list_scenarios()


@app.get("/api/scenarios/{scenario_id}")
def api_get_scenario(scenario_id: int):
    row = db.get_scenario(scenario_id)
    if row is None:
        raise HTTPException(status_code=404, detail="场景不存在")
    return row


@app.post("/api/scenarios", status_code=201)
def api_create_scenario(sc: ScenarioIn):
    data, errors = normalize(sc)
    if errors:
        return JSONResponse(status_code=400, content={"detail": "管网数据不合法", "errors": errors})
    return db.create_scenario(data)


@app.put("/api/scenarios/{scenario_id}")
def api_update_scenario(scenario_id: int, sc: ScenarioIn):
    if db.get_scenario(scenario_id) is None:
        raise HTTPException(status_code=404, detail="场景不存在")
    data, errors = normalize(sc)
    if errors:
        return JSONResponse(status_code=400, content={"detail": "管网数据不合法", "errors": errors})
    return db.update_scenario(scenario_id, data)


@app.delete("/api/scenarios/{scenario_id}", status_code=204)
def api_delete_scenario(scenario_id: int):
    if not db.delete_scenario(scenario_id):
        raise HTTPException(status_code=404, detail="场景不存在")
    return None


@app.post("/api/scenarios/{scenario_id}/solve")
def api_solve(scenario_id: int):
    row = db.get_scenario(scenario_id)
    if row is None:
        raise HTTPException(status_code=404, detail="场景不存在")

    payload = {
        "nodes": row["nodes"],
        "pipes": row["pipes"],
        "maintenance_pipe_id": row["maintenance_pipe_id"],
        "protected_node_ids": row["protected_node_ids"],
    }
    result = solve(payload)
    db.save_solution(scenario_id, result)
    return {"solution": result, "scenario_id": scenario_id}


# ============================================================
# 方案快照（不可变）
# ============================================================
@app.get("/api/scenarios/{scenario_id}/plans", response_model=List[PlanSummary])
def api_list_plans(scenario_id: int):
    if db.get_scenario(scenario_id) is None:
        raise HTTPException(status_code=404, detail="场景不存在")
    return db.list_plans(scenario_id)


@app.post("/api/scenarios/{scenario_id}/plans", status_code=201)
def api_create_plan(scenario_id: int, plan: PlanIn):
    row = db.get_scenario(scenario_id)
    if row is None:
        raise HTTPException(status_code=404, detail="场景不存在")
    if db.count_plans(scenario_id) >= MAX_PLANS_PER_COMPARISON:
        return JSONResponse(
            status_code=400,
            content={"detail": "方案数量超过限制",
                     "errors": [f"每个管网最多保存 {MAX_PLANS_PER_COMPARISON} 个方案快照"]},
        )
    data, errors = validate_plan_choices(
        row, plan.name, plan.maintenance_pipe_id, plan.protected_node_ids)
    if errors:
        return JSONResponse(status_code=400,
                            content={"detail": "方案数据不合法", "errors": errors})
    return db.create_plan(scenario_id, data)


@app.get("/api/plans/{plan_id}")
def api_get_plan(plan_id: int):
    plan = db.get_plan(plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="方案不存在")
    return plan


@app.post("/api/plans/{plan_id}/solve")
def api_solve_plan(plan_id: int):
    plan = db.get_plan(plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="方案不存在")
    result = solve_plan(plan)
    db.save_plan_solution(plan_id, result)
    return {"solution": result, "plan_id": plan_id}


@app.delete("/api/plans/{plan_id}", status_code=204)
def api_delete_plan(plan_id: int):
    plan = db.get_plan(plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="方案不存在")
    if db.plan_referenced(plan_id):
        return JSONResponse(
            status_code=409,
            content={"detail": "该方案已参与批量对比，为保证历史对比可复现，不可删除；"
                               "可先删除引用它的对比记录。"},
        )
    db.delete_plan(plan_id)
    return None


# ============================================================
# 批量对比
# ============================================================
@app.post("/api/scenarios/{scenario_id}/comparisons", status_code=201)
def api_create_comparison(scenario_id: int, body: CompareIn):
    if db.get_scenario(scenario_id) is None:
        raise HTTPException(status_code=404, detail="场景不存在")

    plan_ids = body.plan_ids
    errors: list[str] = []
    if not (MIN_PLANS_PER_COMPARISON <= len(plan_ids)
            <= MAX_PLANS_PER_COMPARISON):
        errors.append(
            f"一次对比需指定 {MIN_PLANS_PER_COMPARISON}～"
            f"{MAX_PLANS_PER_COMPARISON} 个方案")
    if len(set(plan_ids)) != len(plan_ids):
        errors.append("参与对比的方案不能重复")
    if body.baseline_plan_id not in plan_ids:
        errors.append("基准方案必须包含在参与对比的方案列表中")

    # 归属校验：所有方案必须属于同一已保存管网
    for pid in set(plan_ids):
        plan = db.get_plan(pid)
        if plan is None:
            errors.append(f"方案 {pid} 不存在")
        elif plan["scenario_id"] != scenario_id:
            errors.append(f"方案 {pid} 不属于当前管网，不能跨管网对比")
    if errors:
        return JSONResponse(status_code=400,
                            content={"detail": "对比请求不合法", "errors": errors})

    try:
        saved = run_comparison(scenario_id, plan_ids, body.baseline_plan_id)
    except ValueError as exc:
        return JSONResponse(status_code=400,
                            content={"detail": "对比请求不合法", "errors": [str(exc)]})
    return saved


@app.get("/api/scenarios/{scenario_id}/comparisons",
         response_model=List[ComparisonSummary])
def api_list_comparisons(scenario_id: int):
    if db.get_scenario(scenario_id) is None:
        raise HTTPException(status_code=404, detail="场景不存在")
    return db.list_comparisons(scenario_id)


@app.get("/api/comparisons/{comparison_id}")
def api_get_comparison(comparison_id: int):
    result = db.get_comparison(comparison_id)
    if result is None:
        raise HTTPException(status_code=404, detail="对比记录不存在")
    return result


@app.delete("/api/comparisons/{comparison_id}", status_code=204)
def api_delete_comparison(comparison_id: int):
    if not db.delete_comparison(comparison_id):
        raise HTTPException(status_code=404, detail="对比记录不存在")
    return None


# ---- 静态资源（必须放在 API 路由之后挂载）----
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))
