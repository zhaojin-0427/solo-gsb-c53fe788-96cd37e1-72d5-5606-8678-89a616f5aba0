# 供水检修隔离方案台（Water Supply Maintenance Isolation Workbench）

一个可用 **Docker Compose 一键启动** 的 Web 应用：在画布上维护供水管网（水源、用水
节点、普通管段、可关闭阀门），指定**待检修普通管段**与**必须保供节点**，由后端的
OR-Tools CP-SAT 求解器在 **10 秒**时限内寻找字典序最优的阀门关闭方案，并在画布上
标出关闭阀门、供水 / 断供节点。

现支持**方案批量对比**：从同一个已保存管网创建 2～6 个**不可变检修方案快照**
（每个快照独立指定检修普通管段、必须保供节点与名称），批量调用求解器、保留各次
求解状态、指定基准方案，并按方案名排序返回断供户数、关闭阀门、供水/断供节点，
以及相对基准方案的**新增断供、恢复供水、阀门变更**。

---

## 一、快速启动

前置条件：已安装 Docker 与 Docker Compose 插件（`docker compose version` 可执行）。

```bash
cd /workspace
docker compose up -d --build
```

首次构建需要拉取 `python:3.11-slim` 并安装 OR-Tools，约需 1–3 分钟（取决于网络）。

### 访问方式

启动成功后，用浏览器打开：

> **http://localhost:8000**

页面操作：

1. 先在画布上编辑管网并点击「**保存场景**」（快照必须基于已保存管网）；
2. 点击右上角「**方案批量对比**」打开对比弹窗：
   - 上方表单创建方案快照：填名称、选待检修普通管段、勾选必须保供节点；
   - 在「已有快照」里勾选 **2～6 个**方案，并在「基准方案」下拉中指定基准；
   - 点击「**批量求解并对比**」，后端逐个调用求解器（每个最长 10 秒），
     结果在画布与右栏展示；
3. 画布顶部下拉（或点击右栏方案卡片）可切换查看各方案：**深红节点 = 相对基准
   新增断供、鲜绿节点 = 恢复供水、橙色描边阀门 = 新关阀门、蓝色描边 = 取消关闭**；
4. 「对比历史」可重新打开任意一次历史对比；**刷新页面后会自动恢复最近一次对比**。

> 快照是**不可变**的：创建时即把当时的节点/管段拓扑（含户数等参数）完整拷贝；
> 之后再修改管网，历史快照与历史对比都不会被改写。管网改版后，旧快照会被标记为
> 「历史版本快照」，不能与当前版快照混在同一次对比里（防止拓扑对不上）。

停止服务：

```bash
docker compose down          # 保留数据（命名卷 water-data）
docker compose down -v       # 同时删除已保存的场景与方案
```

查看日志：

```bash
docker compose logs -f web
```

> 端口冲突时，编辑 `docker-compose.yml` 中 `"8000:8000"` 的左侧端口即可，
> 例如改为 `"18000:8000"`，随后访问 http://localhost:18000 。

### 不使用 Docker 的本地运行方式（可选）

```bash
pip install -r requirements.txt
# 数据文件默认写入 /data/water.db；本地没有 /data 时请指定可写路径
export WATER_DB_PATH=./water.db
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

---

## 二、使用说明

### 1. 画布编辑（顶部工具栏）

| 工具 | 操作 |
| --- | --- |
| 选择/拖动 | 点击选中节点或管段；按住节点可拖动位置 |
| ➕ 用水节点 / 水源 | 在画布上点击放置；新用水节点默认 100 户 |
| ── 普通管段 / ⬛ 可关阀门 | 先点起点节点，再点终点节点完成连接（无向，不允许自环） |
| 删除选中 | 删除选中元素；删除节点会级联删除相连管段 |

容量限制（服务端强制校验，超限拒绝保存）：

- 节点 **≤ 80** 个；管段 **≤ 120** 条；其中可关闭阀门 **≤ 40** 个；
- 节点 / 管段 ID 不可重复；管段两端必须是已存在的节点。

### 2. 属性设置（右侧面板）

- **节点**：类型（水源 / 用水）、户数（非负整数）、勾选「必须保供」（可多选）。
  水源不填写户数，也不能被设为保供节点。
- **管段**：可切换「可关闭阀门」属性；普通管段可勾选「待检修普通管段」
  （全图至多一段；阀门不能作为检修段）。

### 3. 保存与求解

- **保存场景**：拓扑及检修 / 保供选择存入服务器上的 SQLite（容器内
  `/data/water.db`，通过命名卷持久化）。修改拓扑会使旧方案自动作废。
- **求解方案**：有未保存修改时会先自动保存；求解完成后：
  - 关闭的阀门在画布上显示为实心方块 + 叉号；
  - **绿色**节点为剩余图中可达水源的供水节点，**红色**为断供节点（含孤岛）；
  - 紫色虚线圈为保供节点，红色虚线管段为检修段；
  - 右侧面板给出状态、断供户数、关闭阀门数、关闭阀门 ID 升序列表等。
- **刷新页面 / 重启容器**：左侧「已保存场景」仍可打开，拓扑、选择与最近一次方案
  都会恢复显示。

### 4. 内置示例

点击顶部「载入示例」可加载一个双水源环网（检修段 `P_M`、保供 N4/N5），
其最优方案为关闭阀门 **V2、V3、V6、V7**，断供 230 户，可直接点「求解方案」体验。

### 5. 方案批量对比

- 先「保存场景」，再点「方案批量对比」创建 2～6 个快照（各自独立的检修段、
  保供节点与名称）；勾选方案并指定基准后批量求解。
- 结果**按方案名排序**，每行给出断供户数、关闭阀门、供水/断供节点，以及相对基准的
  **新增断供 / 恢复供水 / 新关阀门 / 取消关闭 / 断供户数差**。
- 快照不可变：后续拓扑或户数修改不会改写历史快照与历史对比；管网改版后旧快照标记为
  「历史版本」，需基于当前管网重建快照才能再次对比。
- 刷新页面 / 重启容器后，打开该场景会自动恢复最近一次对比结果。

---

## 三、优化模型与判定规则

### 真实连通性判定

关闭选定阀门并移除检修段后，在**剩余无向图**上做从所有水源出发的可达性分析：

- 用水节点可达至少一个水源 ⇒ 计为**供水**；
- 不可达（含与水源分离的孤岛）⇒ 计为**断供**，孤岛绝不计为供水；
- **检修段两端节点都不得接通任何水源**（端点为水源时直接不可行——
  无法对水源本体停水）；
- 所有「必须保供」节点必须可达至少一个水源。

求解器内部用 CP-SAT 的有向弧布尔变量精确编码这一可达闭包，求解结束后再以一次
独立 BFS 复核，画布与统计数字一律以 BFS 复核结果为准。

### 字典序目标（逐级最小化）

1. **断供户数**最少；
2. 在 1 最优的前提下，**关闭阀门数**最少；
3. 在 1、2 最优的前提下，**关闭阀门 ID 升序列表**字典序最小
   （阀门按 ID 字典序编号后，最大化 `Σ 2^i·open_i`，
   即在关闭数相同的方案里优先关闭小编号阀门）。

### 10 秒时限与状态标签

总墙钟时限 **10 秒**，三阶段串行求解并热启动：

| 状态 | 含义 |
| --- | --- |
| ✅ **最优** | 在 10 秒内逐级证明了三个目标的字典序最优 |
| 🟡 **未证最优**（可行） | 时限内得到可行方案但未能完成最优性证明，照常展示 |
| ⚪ **未找到** | 时限内无可行解、也未证明不可行 |
| ❌ **无解** | **仅当** CP-SAT 证明模型不可行时（检修段无法与水源隔离、保供节点必然断供等） |

---

## 四、HTTP API（供调试 / 二次开发）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/scenarios` | 场景列表（含最近方案状态） |
| POST | `/api/scenarios` | 新建场景；校验失败返回 `400` 与中文错误列表 |
| GET | `/api/scenarios/{id}` | 场景详情（含拓扑、拓扑指纹 `topology_hash` 与最近方案） |
| PUT | `/api/scenarios/{id}` | 更新场景（旧方案作废；**不影响**已创建的快照与对比） |
| DELETE | `/api/scenarios/{id}` | 删除场景（级联删除其方案快照与对比历史） |
| POST | `/api/scenarios/{id}/solve` | 求解并持久化方案 |
| GET | `/api/scenarios/{id}/plans` | 方案快照列表（含各自状态与拓扑指纹） |
| POST | `/api/scenarios/{id}/plans` | 基于已保存管网创建不可变快照（仅名称/检修段/保供） |
| GET | `/api/plans/{id}` | 快照详情（含创建时深拷贝的拓扑与求解结果） |
| POST | `/api/plans/{id}/solve` | 单独求解某快照并更新其求解状态 |
| DELETE | `/api/plans/{id}` | 删除快照；已参与对比的快照返回 `409` |
| POST | `/api/scenarios/{id}/comparisons` | **批量求解 2～6 个快照并生成对比** |
| GET | `/api/scenarios/{id}/comparisons` | 对比历史摘要列表 |
| GET | `/api/comparisons/{id}` | 对比完整结果（含拓扑快照、各方案状态与差异） |
| DELETE | `/api/comparisons/{id}` | 删除一条对比历史 |

示例：

```bash
curl -s http://localhost:8000/api/scenarios | python3 -m json.tool
```

### 方案批量对比请求 / 响应示例

以下以内置示例管网（双水源环网，水源 `S1/S2`、用水节点 `N1..N6`、阀门
`V1..V7`、普通管段 `P_M`、`P45`）为例。

**第一步：基于已保存场景（假设 `id=1`）创建两个不可变快照。**
快照只提交名称、检修段、保供节点，拓扑由服务器深拷贝，客户端无法改写。

```bash
# 快照 A：检修 P_M，保供 N4、N5
curl -s -X POST http://localhost:8000/api/scenarios/1/plans \
  -H 'Content-Type: application/json' \
  -d '{"name":"保供优先A","maintenance_pipe_id":"P_M","protected_node_ids":["N4","N5"]}'

# 快照 B：改为检修另一条普通管段 P45，只保供 N1（不同检修段，不同关阀/断供结果）
curl -s -X POST http://localhost:8000/api/scenarios/1/plans \
  -H 'Content-Type: application/json' \
  -d '{"name":"支路检修B","maintenance_pipe_id":"P45","protected_node_ids":["N1"]}'
```

**第二步：批量求解并对比，指定 A 为基准。** 请求体仅需方案 id 列表与基准 id：

```bash
curl -s -X POST http://localhost:8000/api/scenarios/1/comparisons \
  -H 'Content-Type: application/json' \
  -d '{"plan_ids":[1,2],"baseline_plan_id":1}' | python3 -m json.tool
```

实际请求体：

```json
{ "plan_ids": [1, 2], "baseline_plan_id": 1 }
```

实际响应（节选；`elapsed_ms` 因机器而异，结果本身确定）：

```json
{
  "id": 1,
  "scenario_id": 1,
  "baseline_plan_id": 1,
  "baseline_name": "保供优先A",
  "created_at": "2026-10-01T08:30:12Z",
  "nodes": [
    {"id": "S1", "kind": "source", "households": 0, "x": 90.0, "y": 120.0},
    {"id": "S2", "kind": "source", "households": 0, "x": 810.0, "y": 120.0},
    {"id": "N1", "kind": "user", "households": 120, "x": 250.0, "y": 200.0},
    {"id": "N2", "kind": "user", "households": 80,  "x": 450.0, "y": 200.0},
    {"id": "N3", "kind": "user", "households": 150, "x": 650.0, "y": 200.0},
    {"id": "N4", "kind": "user", "households": 60,  "x": 250.0, "y": 420.0},
    {"id": "N5", "kind": "user", "households": 90,  "x": 450.0, "y": 420.0},
    {"id": "N6", "kind": "user", "households": 70,  "x": 650.0, "y": 420.0}
  ],
  "pipes": [
    {"id": "V1",  "a": "S1", "b": "N1", "is_valve": true},
    {"id": "V2",  "a": "N1", "b": "N2", "is_valve": true},
    {"id": "P_M", "a": "N2", "b": "N3", "is_valve": false},
    {"id": "V3",  "a": "N3", "b": "S2", "is_valve": true},
    {"id": "V4",  "a": "N1", "b": "N4", "is_valve": true},
    {"id": "P45", "a": "N4", "b": "N5", "is_valve": false},
    {"id": "V5",  "a": "N5", "b": "N6", "is_valve": true},
    {"id": "V6",  "a": "N6", "b": "N3", "is_valve": true},
    {"id": "V7",  "a": "N2", "b": "N5", "is_valve": true}
  ],
  "plans": [
    {
      "plan_id": 1,
      "name": "保供优先A",
      "is_baseline": true,
      "maintenance_pipe_id": "P_M",
      "protected_node_ids": ["N4", "N5"],
      "solution": {
        "status": "optimal",
        "elapsed_ms": 210,
        "total_households": 570,
        "removed_pipe_ids": ["P_M"],
        "closed_valve_ids": ["V2", "V3", "V6", "V7"],
        "supplied_node_ids": ["N1", "N4", "N5", "N6"],
        "disconnected_node_ids": ["N2", "N3"],
        "reachable_sources": ["S1", "S2"],
        "disconnected_households": 230,
        "served_households": 340,
        "closed_valve_count": 4
      },
      "diff": {
        "newly_disconnected_node_ids": [],
        "restored_supplied_node_ids": [],
        "newly_closed_valve_ids": [],
        "reopened_valve_ids": [],
        "disconnected_households_delta": 0
      }
    },
    {
      "plan_id": 2,
      "name": "支路检修B",
      "is_baseline": false,
      "maintenance_pipe_id": "P45",
      "protected_node_ids": ["N1"],
      "solution": {
        "status": "optimal",
        "elapsed_ms": 160,
        "total_households": 570,
        "removed_pipe_ids": ["P45"],
        "closed_valve_ids": ["V4", "V5", "V7"],
        "supplied_node_ids": ["N1", "N2", "N3", "N6"],
        "disconnected_node_ids": ["N4", "N5"],
        "reachable_sources": ["S1", "S2"],
        "disconnected_households": 150,
        "served_households": 420,
        "closed_valve_count": 3
      },
      "diff": {
        "newly_disconnected_node_ids": ["N4", "N5"],
        "restored_supplied_node_ids": ["N2", "N3"],
        "newly_closed_valve_ids": ["V4", "V5"],
        "reopened_valve_ids": ["V2", "V3", "V6"],
        "disconnected_households_delta": -80
      }
    }
  ]
}
```

读法（以 B 相对基准 A 为例）：

- `plans` 已**按方案名排序**（中文按 Unicode 码位，`保…` 在 `支…` 之前）；
- `diff.newly_disconnected_node_ids`：基准 A 在供水、B 断供的节点
  （**新增断供** `N4、N5`，即检修 `P45` 时被切离的那条支路）；
- `diff.restored_supplied_node_ids`：A 断供、B 恢复供水的节点（`N2、N3`）；
- `diff.newly_closed_valve_ids` / `reopened_valve_ids`：阀门集合变更
  （B 比基准**新关** `V4、V5`，**取消关闭** `V2、V3、V6`；两者都关的 `V7`
  不出现在任一列表中）；
- `disconnected_households_delta = -80`：B 比基准**少断供 80 户**
  （150 − 230；正数=更差，负数=更好），同时关阀数由 4 降到 3。
- 基准方案自身 `diff` 各项为空、delta 为 0；某方案为 `infeasible`/`not_found`/
  `error` 时，其 `solution.status` 如实保留，`diff` 为 `null`（无可执行阀门方案）。

> 上面的阀门集合与断供户数已用穷举（7 个阀门共 128 种组合）按
> “断供户数→关阀数→阀门 ID 字典序”逐级核对，与 CP-SAT 的字典序最优一致；
> `elapsed_ms`、`id`、时间戳以你本机实际返回为准。

**刷新恢复**：对比结果整体入库，重新打开该场景时前端调用
`GET /api/scenarios/1/comparisons` 取历史、再用 `GET /api/comparisons/{id}`
加载完整结果；最近查看的对比 id 记录在浏览器 `localStorage`，刷新后自动还原画布。

### 非法请求的常见返回

- 快照数量不在 2～6、方案重复、基准不在列表、跨管网/跨版本混比：`400`
  （`detail` + 中文 `errors` 列表）；
- 删除已参与对比的快照：`409`（保证历史对比可复现）；
- 每个管网最多保留 6 个快照，超出创建返回 `400`。

---

## 五、项目结构

```
.
├── docker-compose.yml          # 一键启动（命名卷持久化 /data）
├── Dockerfile                  # python:3.11-slim + requirements
├── requirements.txt            # fastapi / uvicorn / pydantic / ortools
├── README.md
├── app/
│   ├── main.py                 # FastAPI 路由 + 静态托管
│   ├── models.py               # Pydantic 请求/摘要模型（含 PlanIn/CompareIn）
│   ├── validation.py           # 容量 / ID / 端点校验 + 快照选择校验 + 拓扑指纹
│   ├── solver.py               # OR-Tools CP-SAT 三阶段字典序求解 + BFS 复核
│   ├── comparison.py           # 批量调用求解器、逐状态保留、相对基准差异计算
│   └── db.py                   # SQLite：scenarios / plans / comparisons 三表
└── static/
    ├── index.html              # 单页界面（含批量对比弹窗与对比结果条）
    ├── css/app.css
    └── js/app.js               # 原生 JavaScript 画布交互（无前端框架）
```

### 技术栈

- 后端：Python 3.11、FastAPI、SQLite（标准库 `sqlite3`）、
  Google OR-Tools CP-SAT；
- 前端：原生 HTML / CSS / JavaScript + Canvas 2D，无构建步骤、无第三方 JS 依赖。
