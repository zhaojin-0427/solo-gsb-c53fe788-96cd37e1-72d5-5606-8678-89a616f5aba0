# 供水检修隔离方案台（Water Supply Maintenance Isolation Workbench）

一个可用 **Docker Compose 一键启动** 的 Web 应用：在画布上维护供水管网（水源、用水
节点、普通管段、可关闭阀门），指定**待检修普通管段**与**必须保供节点**，由后端的
OR-Tools CP-SAT 求解器在 **10 秒**时限内寻找字典序最优的阀门关闭方案，并在画布上
标出关闭阀门、供水 / 断供节点。

支持**方案批量对比**：从同一已保存管网创建 2～6 个**不可变检修方案快照**（各自独立
指定待检修管段、保供节点与名称），批量调用求解器并保留各次求解状态，以任一方案为
**基准方案**，输出各方案的断供户数、关闭阀门、供水 / 断供节点及与基准的
**新增断供 / 恢复供水 / 阀门变更**。快照在创建时冻结拓扑，后续修改场景不会改写
历史快照；对比结果持久化，刷新页面后可重新加载。

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

### 5. 批量对比（方案快照）

右侧面板「批量对比」区块可对**当前已保存场景**发起批量对比（有未保存修改时会先
自动保存）：

1. 点击「新建批量对比」，在弹窗中填写对比名称，并维护 **2～6 个方案**：
   每个方案独立指定**名称**、**待检修普通管段**（下拉选择，阀门不可选）与
   **必须保供节点**（多选）；用「基准」单选钮指定**基准方案**。
2. 点击「开始批量求解」：后端为每个方案复制一份**创建时刻的拓扑快照**并依次调用
   求解器（每个方案最长 10 秒），各次求解状态随快照一并持久化。
3. 结果表按**方案名称排序**，列出每个方案的求解状态、断供户数、关闭阀门列表、
   断供 / 供水节点，以及**与基准方案的差异**：
   - **新增断供**：本方案断供而基准方案供水的节点（含户数）；
   - **恢复供水**：本方案供水而基准方案断供的节点（含户数）；
   - **阀门变更**：相对基准「新增关闭 / 重新开启」的阀门。
4. **不可变性**：快照在创建时冻结拓扑与参数，之后修改场景（增删管段、改户数、
   改保供……）都不会改写历史快照；删除场景会级联删除其对比记录。
5. **持久化**：对比结果存入 SQLite，刷新页面或重启容器后，打开对应场景即可在
   「批量对比」列表中重新查看；每条记录可单独删除。

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
| GET | `/api/scenarios/{id}` | 场景详情（含拓扑与最近方案） |
| PUT | `/api/scenarios/{id}` | 更新场景（旧方案作废；不影响已创建的对比快照） |
| DELETE | `/api/scenarios/{id}` | 删除场景（级联删除其批量对比记录） |
| POST | `/api/scenarios/{id}/solve` | 求解并持久化方案 |
| POST | `/api/scenarios/{id}/comparisons` | 创建批量对比：2～6 个方案快照 + 基准下标，批量求解并持久化 |
| GET | `/api/scenarios/{id}/comparisons` | 该场景的对比记录列表 |
| GET | `/api/comparisons/{id}` | 对比详情（按方案名排序，含与基准的差异） |
| DELETE | `/api/comparisons/{id}` | 删除对比记录 |

示例：

```bash
curl -s http://localhost:8000/api/scenarios | python3 -m json.tool
```

### 批量对比：实际请求与响应示例

以下示例基于「载入示例」内置管网（先保存为场景 `#1`）。请求创建 3 个方案快照，
以第 1 个（`baseline_index: 0`）为基准方案：

```bash
curl -s -X POST http://localhost:8000/api/scenarios/1/comparisons \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "十月检修窗口对比",
    "baseline_index": 0,
    "plans": [
      {"name": "方案A·检修P_M",     "maintenance_pipe_id": "P_M", "protected_node_ids": ["N4", "N5"]},
      {"name": "方案B·检修P45",     "maintenance_pipe_id": "P45", "protected_node_ids": ["N4", "N5"]},
      {"name": "方案C·检修P_M不保供", "maintenance_pipe_id": "P_M", "protected_node_ids": []}
    ]
  }'
```

实际响应（`201 Created`，已按方案名排序；时间戳为真实求解时刻）：

```json
{
  "baseline_key": "1",
  "baseline_name": "方案A·检修P_M",
  "plans": [
    {
      "key": "1",
      "name": "方案A·检修P_M",
      "is_baseline": true,
      "maintenance_pipe_id": "P_M",
      "protected_node_ids": ["N4", "N5"],
      "solve_status": "optimal",
      "solved_at": "2026-10-01T17:34:44Z",
      "disconnected_households": 230,
      "total_households": 570,
      "closed_valve_ids": ["V2", "V3", "V6", "V7"],
      "closed_valve_count": 4,
      "supplied_node_ids": ["N1", "N4", "N5", "N6"],
      "disconnected_node_ids": ["N2", "N3"],
      "diff_vs_baseline": {
        "newly_disconnected_node_ids": [],
        "newly_disconnected_households": 0,
        "restored_node_ids": [],
        "restored_households": 0,
        "valves_newly_closed": [],
        "valves_reopened": []
      }
    },
    {
      "key": "2",
      "name": "方案B·检修P45",
      "is_baseline": false,
      "maintenance_pipe_id": "P45",
      "protected_node_ids": ["N4", "N5"],
      "solve_status": "infeasible",
      "solved_at": "2026-10-01T17:34:44Z",
      "disconnected_households": 570,
      "total_households": 570,
      "closed_valve_ids": [],
      "closed_valve_count": 0,
      "supplied_node_ids": [],
      "disconnected_node_ids": ["N1", "N2", "N3", "N4", "N5", "N6"],
      "diff_vs_baseline": {
        "newly_disconnected_node_ids": ["N1", "N4", "N5", "N6"],
        "newly_disconnected_households": 340,
        "restored_node_ids": [],
        "restored_households": 0,
        "valves_newly_closed": [],
        "valves_reopened": ["V2", "V3", "V6", "V7"]
      }
    },
    {
      "key": "3",
      "name": "方案C·检修P_M不保供",
      "is_baseline": false,
      "maintenance_pipe_id": "P_M",
      "protected_node_ids": [],
      "solve_status": "optimal",
      "solved_at": "2026-10-01T17:34:44Z",
      "disconnected_households": 230,
      "total_households": 570,
      "closed_valve_ids": ["V2", "V3", "V6", "V7"],
      "closed_valve_count": 4,
      "supplied_node_ids": ["N1", "N4", "N5", "N6"],
      "disconnected_node_ids": ["N2", "N3"],
      "diff_vs_baseline": {
        "newly_disconnected_node_ids": [],
        "newly_disconnected_households": 0,
        "restored_node_ids": [],
        "restored_households": 0,
        "valves_newly_closed": [],
        "valves_reopened": []
      }
    }
  ],
  "id": 1,
  "scenario_id": 1,
  "name": "十月检修窗口对比",
  "created_at": "2026-10-01T17:34:44Z"
}
```

> 说明：方案B 的检修段 `P45` 是保供节点 N4、N5 之间唯一的连通管段，其两个端点
> 必须断压，与「N4/N5 必须保供」冲突，故求解状态为 `infeasible`（无解）——
> 各次求解状态都会如实保留在快照中。`diff_vs_baseline` 中
> `newly_disconnected_*` 为相对基准的**新增断供**，`restored_*` 为**恢复供水**，
> `valves_newly_closed` / `valves_reopened` 为**阀门变更**。

刷新页面或重启容器后，可随时取回该对比结果：

```bash
curl -s http://localhost:8000/api/scenarios/1/comparisons | python3 -m json.tool
curl -s http://localhost:8000/api/comparisons/1 | python3 -m json.tool
```

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
│   ├── models.py               # Pydantic 请求模型
│   ├── validation.py           # 容量 / ID / 端点校验（≤80/120/40）+ 批量对比校验
│   ├── solver.py               # OR-Tools CP-SAT 三阶段字典序求解 + BFS 复核
│   ├── compare.py              # 批量对比：不可变快照、批量求解、基准差异计算
│   └── db.py                   # SQLite 持久化（场景 + 对比快照）
└── static/
    ├── index.html              # 单页界面
    ├── css/app.css
    └── js/app.js               # 原生 JavaScript 画布交互（无前端框架）
```

### 技术栈

- 后端：Python 3.11、FastAPI、SQLite（标准库 `sqlite3`）、
  Google OR-Tools CP-SAT；
- 前端：原生 HTML / CSS / JavaScript + Canvas 2D，无构建步骤、无第三方 JS 依赖。
