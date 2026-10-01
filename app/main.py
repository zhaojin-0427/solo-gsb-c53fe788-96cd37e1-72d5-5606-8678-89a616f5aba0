"""FastAPI 入口：场景 CRUD、求解接口、静态资源托管。"""
from __future__ import annotations

import os
from typing import List

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .models import ScenarioIn, ScenarioSummary
from .solver import solve
from .validation import normalize

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(BASE_DIR, "static")

app = FastAPI(title="供水检修隔离方案台", version="1.0.0")


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


# ---- 静态资源（必须放在 API 路由之后挂载）----
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))
