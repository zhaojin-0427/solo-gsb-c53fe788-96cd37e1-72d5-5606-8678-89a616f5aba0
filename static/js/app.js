/* 供水检修隔离方案台 —— 原生 JavaScript 前端
 * 状态分为：当前编辑场景 S、画布交互、服务端持久化三部分。
 */
(function () {
  "use strict";

  const LIMITS = { nodes: 80, pipes: 120, valves: 40 };
  const CANVAS_W = 900, CANVAS_H = 600;
  const NODE_R = 13;
  const PIPE_HIT = 7;

  // ---- 全局编辑状态 ----
  const S = {
    scenarioId: null,     // 已保存场景 ID；null 表示未入库的新场景
    name: "未命名场景",
    nodes: [],            // {id, kind:'source'|'user', households, x, y}
    pipes: [],            // {id, a, b, isValve}
    maintenancePipeId: null,
    protectedNodeIds: new Set(),
    solution: null,       // 最近一次求解结果（仅展示用，以服务端为准）
    topologyHash: null,   // 已保存管网当前拓扑指纹（服务端下发）
    selected: null,       // {type:'node'|'pipe', id}
    tool: "select",
    pipePending: null,    // 连管时的第一个节点 id
    dirty: false,
    drag: null,
  };

  // ---- 方案批量对比状态 ----
  const C = {
    active: null,         // 正在画布上查看的对比结果（GET /comparisons/{id} 原样数据）
    viewedPlanId: null,   // 画布当前高亮的方案 id
    plans: [],            // 当前管网的方案快照摘要列表
    modalOpen: false,
    selected: new Set(),  // 弹窗中勾选参与对比的 plan_id
    baselineId: null,
  };

  // 画布 / 命中检测使用的“当前视图”：对比模式下查看的是不可变快照管网，
  // 与编辑器里的 S 完全隔离，编辑操作不会（也无法）改动快照。
  function activeView() {
    if (C.active) {
      const row = C.active.plans.find((r) => r.plan_id === C.viewedPlanId)
        || C.active.plans.find((r) => r.is_baseline)
        || C.active.plans[0];
      return {
        nodes: C.active.nodes,
        pipes: C.active.pipes,
        maintenancePipeId: row ? row.maintenance_pipe_id : null,
        protectedNodeIds: new Set(row ? row.protected_node_ids : []),
        solution: row ? row.solution : null,
        diff: row ? row.diff : null,
        readOnly: true,
      };
    }
    return {
      nodes: S.nodes,
      pipes: S.pipes,
      maintenancePipeId: S.maintenancePipeId,
      protectedNodeIds: S.protectedNodeIds,
      solution: S.solution,
      diff: null,
      readOnly: false,
    };
  }

  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const $ = (id) => document.getElementById(id);

  // ============================================================
  // 工具函数
  // ============================================================
  function toast(msg, kind) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (kind ? " " + kind : "");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => t.classList.add("hidden"), 4200);
  }

  function viewNode(id) { return activeView().nodes.find((n) => n.id === id) || null; }
  function nodeById(id) { return S.nodes.find((n) => n.id === id) || null; }
  function pipeById(id) { return S.pipes.find((p) => p.id === id) || null; }
  function valveCount() { return S.pipes.filter((p) => p.isValve).length; }

  function nextId(prefix, used) {
    let i = 1;
    const pad = prefix === "N" ? 3 : 3;
    while (used.has(prefix + String(i).padStart(pad, "0"))) i += 1;
    const id = prefix + String(i).padStart(pad, "0");
    used.add(id);
    return id;
  }

  function markDirty() {
    S.dirty = true;
    // 拓扑/选择一旦变化，屏幕上旧方案不再可信；也退出只读对比视图回到编辑态
    S.solution = null;
    if (C.active) exitComparison(false);
    renderSolution();
    renderScenarioTag();
  }

  async function api(path, options) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    if (!res.ok) {
      const msg = body && body.errors ? body.errors.join("\n")
        : (body && body.detail ? body.detail : `请求失败 (${res.status})`);
      throw new Error(msg);
    }
    return body;
  }

  // ============================================================
  // 画布坐标
  // ============================================================
  function canvasPos(ev) {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
    return {
      x: (ev.clientX - rect.left) * sx,
      y: (ev.clientY - rect.top) * sy,
    };
  }

  function hitNode(x, y, nodes) {
    // 从后向前（后画的在上层）
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (Math.hypot(n.x - x, n.y - y) <= NODE_R + 3) return n;
    }
    return null;
  }

  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  function hitPipe(x, y, view) {
    const nodes = view.nodes;
    for (let i = view.pipes.length - 1; i >= 0; i--) {
      const p = view.pipes[i];
      const a = nodes.find((n) => n.id === p.a);
      const b = nodes.find((n) => n.id === p.b);
      if (!a || !b) continue;
      if (distToSeg(x, y, a.x, a.y, b.x, b.y) <= PIPE_HIT + (p.isValve || p.is_valve ? 3 : 0)) return p;
    }
    return null;
  }

  // ============================================================
  // 绘制
  // ============================================================
  function viewSolutionState(view) {
    const sol = view.solution;
    if (!sol) return null;
    return {
      closedValves: new Set(sol.closed_valve_ids || []),
      removed: new Set(sol.removed_pipe_ids || []),
      supplied: new Set(sol.supplied_node_ids || []),
      disconnected: new Set(sol.disconnected_node_ids || []),
      newOff: new Set((view.diff && view.diff.newly_disconnected_node_ids) || []),
      restored: new Set((view.diff && view.diff.restored_supplied_node_ids) || []),
      newValve: new Set((view.diff && view.diff.newly_closed_valve_ids) || []),
      reopenValve: new Set((view.diff && view.diff.reopened_valve_ids) || []),
    };
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawView(activeView());
  }

  function drawView(view) {
    const st = viewSolutionState(view);
    const nodesById = new Map(view.nodes.map((n) => [n.id, n]));
    const isValve = (p) => !!(p.isValve || p.is_valve);

    // ---- 管段 ----
    view.pipes.forEach((p) => {
      const a = nodesById.get(p.a), b = nodesById.get(p.b);
      if (!a || !b) return;
      const isMaint = p.id === view.maintenancePipeId;
      const closed = st && st.closedValves.has(p.id);
      const removed = st && st.removed.has(p.id);
      const newClosed = st && st.newValve.has(p.id);
      const reopened = st && st.reopenValve.has(p.id);

      ctx.save();
      ctx.lineWidth = isMaint ? 3.5 : 2.4;
      if (isMaint) {
        ctx.strokeStyle = "#c0392b";
        ctx.setLineDash([8, 6]);
      } else if (isValve(p)) {
        ctx.strokeStyle = closed ? "#8a4a16" : "#5c6773";
        ctx.setLineDash(closed ? [5, 4] : []);
      } else {
        ctx.strokeStyle = "#5c6773";
      }
      if (removed && !isMaint) ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();

      // 阀门标记（管中点的小方块）
      if (isValve(p)) {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        ctx.save();
        ctx.translate(mx, my);
        ctx.rotate(ang);
        ctx.fillStyle = closed ? "#b5651d" : "#ffffff";
        ctx.strokeStyle = newClosed ? "#d35400" : (reopened ? "#1d4e89" : "#8a4a16");
        ctx.lineWidth = newClosed || reopened ? 3 : 2;
        ctx.fillRect(-6, -6, 12, 12);
        ctx.strokeRect(-6, -6, 12, 12);
        if (closed) {
          // 叉号表示关闭
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(-3.5, -3.5); ctx.lineTo(3.5, 3.5);
          ctx.moveTo(3.5, -3.5); ctx.lineTo(-3.5, 3.5);
          ctx.stroke();
        }
        ctx.restore();
      }

      // 对比差异描边：新关阀门（橙）/ 取消关闭（蓝）
      if (newClosed || reopened) {
        ctx.save();
        ctx.strokeStyle = newClosed ? "rgba(211,84,0,.9)" : "rgba(29,78,137,.9)";
        ctx.lineWidth = 5;
        ctx.globalAlpha = 0.3;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.restore();
      }

      // 选中高亮（仅编辑模式）
      if (!view.readOnly && S.selected && S.selected.type === "pipe" && S.selected.id === p.id) {
        ctx.save();
        ctx.strokeStyle = "#1d6fb8";
        ctx.lineWidth = 5;
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.restore();
      }
    });

    // ---- 连管预览 ----
    if (!view.readOnly && S.pipePending && S.mousePos) {
      const n = nodeById(S.pipePending);
      if (n) {
        ctx.save();
        ctx.strokeStyle = "#1d6fb8";
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(n.x, n.y);
        ctx.lineTo(S.mousePos.x, S.mousePos.y);
        ctx.stroke();
        ctx.restore();
      }
    }

    // ---- 节点 ----
    view.nodes.forEach((n) => {
      const selected = !view.readOnly && S.selected && S.selected.type === "node" && S.selected.id === n.id;
      const isProtected = view.protectedNodeIds.has(n.id);
      const isSource = n.kind === "source";
      let fill, stroke = "#334155";

      if (isSource) {
        fill = "#1d6fb8";
      } else if (st) {
        if (st.newOff.has(n.id)) fill = "#8e1b0f";          // 新增断供：深红
        else if (st.restored.has(n.id)) fill = "#13a368";   // 恢复供水：鲜绿
        else fill = st.disconnected.has(n.id) ? "#c0392b" : "#2f8f5f";
      } else {
        fill = "#2f8f5f";
      }

      // 保供虚线外圈
      if (isProtected) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, NODE_R + 5, 0, Math.PI * 2);
        ctx.strokeStyle = "#7d3c98";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.beginPath();
      ctx.arc(n.x, n.y, NODE_R, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = selected ? 3.5 : 2;
      ctx.strokeStyle = selected ? "#0b3d6b" : stroke;
      ctx.stroke();

      // 差异节点加一圈醒目标记：新增断供 / 恢复供水
      if (st && (st.newOff.has(n.id) || st.restored.has(n.id))) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, NODE_R + 3, 0, Math.PI * 2);
        ctx.strokeStyle = st.newOff.has(n.id) ? "#d35400" : "#0b6b3f";
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      // 水源用 S 字样
      ctx.fillStyle = "#fff";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(isSource ? "水" : "", n.x, n.y);

      // ID + 户数标签
      ctx.fillStyle = "#1f2933";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      const label = isSource ? n.id : `${n.id}·${n.households}户`;
      ctx.fillText(label, n.x, n.y + NODE_R + 12);
    });
  }

  // ============================================================
  // 属性面板
  // ============================================================
  function renderInspector() {
    const box = $("inspector");
    if (!S.selected) {
      box.innerHTML = `
        <p class="muted">未选中任何元素。</p>
        <ul class="tip">
          <li>选择“普通管段/阀门”工具后，依次点击两个节点即可连线。</li>
          <li>点击节点可设置类型、户数、保供标记。</li>
          <li>点击普通管段可将其设为待检修段。</li>
        </ul>`;
      return;
    }

    if (S.selected.type === "node") {
      const n = nodeById(S.selected.id);
      if (!n) { S.selected = null; return renderInspector(); }
      box.innerHTML = `
        <div class="row">
          <label>节点 ID（不可修改）</label>
          <input type="text" value="${n.id}" disabled>
        </div>
        <div class="row">
          <label>类型</label>
          <select id="inp-kind">
            <option value="user" ${n.kind === "user" ? "selected" : ""}>用水节点</option>
            <option value="source" ${n.kind === "source" ? "selected" : ""}>水源</option>
          </select>
        </div>
        <div class="row" id="row-households" ${n.kind === "source" ? 'style="display:none"' : ""}>
          <label>户数（非负整数）</label>
          <input type="number" id="inp-households" min="0" step="1" value="${n.households}">
        </div>
        <div class="row">
          <label class="checkline">
            <input type="checkbox" id="inp-protected" ${S.protectedNodeIds.has(n.id) ? "checked" : ""}
              ${n.kind === "source" ? "disabled" : ""}>
            必须保供
          </label>
        </div>
        <div class="row">
          <button type="button" class="danger" id="inp-delete">删除该节点及其管段</button>
        </div>`;

      $("inp-kind").addEventListener("change", (e) => {
        n.kind = e.target.value;
        if (n.kind === "source") {
          n.households = 0;
          S.protectedNodeIds.delete(n.id);
        }
        markDirty();
        refreshAll();
      });
      $("inp-households").addEventListener("input", (e) => {
        const v = parseInt(e.target.value, 10);
        n.households = Number.isFinite(v) && v >= 0 ? v : 0;
        markDirty();
        draw();
        updateCounts();
      });
      $("inp-protected").addEventListener("change", (e) => {
        if (e.target.checked) S.protectedNodeIds.add(n.id);
        else S.protectedNodeIds.delete(n.id);
        markDirty();
        draw();
      });
      $("inp-delete").addEventListener("click", () => deleteNode(n.id));
    } else {
      const p = pipeById(S.selected.id);
      if (!p) { S.selected = null; return renderInspector(); }
      const canMaint = !p.isValve;
      box.innerHTML = `
        <div class="row">
          <label>管段 ID（不可修改）</label>
          <input type="text" value="${p.id}" disabled>
        </div>
        <div class="row">
          <label>端点</label>
          <input type="text" value="${p.a} ↔ ${p.b}" disabled>
        </div>
        <div class="row">
          <label class="checkline">
            <input type="checkbox" id="inp-valve" ${p.isValve ? "checked" : ""}>
            可关闭阀门（计入 ${LIMITS.valves} 个阀门限额）
          </label>
        </div>
        <div class="row">
          <label class="checkline">
            <input type="checkbox" id="inp-main" ${S.maintenancePipeId === p.id ? "checked" : ""}
              ${p.isValve ? "disabled" : ""}>
            待检修普通管段（全图至多一段）
          </label>
          ${p.isValve ? '<p class="sol-note">阀门不能作为检修段；如需检修请先取消其阀门属性。</p>' : ""}
        </div>
        <div class="row">
          <button type="button" class="danger" id="inp-delete">删除该管段</button>
        </div>`;

      $("inp-valve").addEventListener("change", (e) => {
        if (e.target.checked && valveCount() >= LIMITS.valves) {
          e.target.checked = false;
          toast(`可关闭阀门最多 ${LIMITS.valves} 个`, "error");
          return;
        }
        p.isValve = e.target.checked;
        if (!p.isValve && S.maintenancePipeId !== p.id) {
          /* 保持普通管段 */
        }
        markDirty();
        refreshAll();
      });
      $("inp-main").addEventListener("change", (e) => {
        if (p.isValve) return;
        S.maintenancePipeId = e.target.checked ? p.id : null;
        markDirty();
        draw();
      });
      $("inp-delete").addEventListener("click", () => deletePipe(p.id));
    }
  }

  function refreshAll() {
    draw();
    renderInspector();
    updateCounts();
  }

  function updateCounts() {
    if (C.active) {
      const row = C.active.plans.find((r) => r.plan_id === C.viewedPlanId);
      $("stat-counts").textContent = `对比 #${C.active.id}（只读快照）`;
      $("stat-mode").textContent = row ? `查看方案：${row.name}` : "";
      $("stat-scenario").textContent = `基准：${C.active.baseline_name}`;
      return;
    }
    $("stat-counts").textContent =
      `节点 ${S.nodes.length}/${LIMITS.nodes} · 管段 ${S.pipes.length}/${LIMITS.pipes} · 阀门 ${valveCount()}/${LIMITS.valves}`;
    const modeMap = {
      select: "选择/拖动", "add-user": "放置用水节点", "add-source": "放置水源",
      "add-pipe": "连接普通管段：点击起点节点", "add-valve": "连接阀门：点击起点节点",
    };
    $("stat-mode").textContent = modeMap[S.tool] || "";
    if (S.pipePending) $("stat-mode").textContent += `（起点 ${S.pipePending}，再点一个节点）`;
  }

  function renderScenarioTag() {
    $("stat-scenario").textContent =
      (S.scenarioId ? `场景 #${S.scenarioId} · ${S.name}` : `新场景 · ${S.name}`) +
      (S.dirty ? " · 未保存" : "");
  }

  // ============================================================
  // 方案面板
  // ============================================================
  const STATUS_TEXT = {
    optimal: "✅ 最优",
    feasible: "🟡 找到可行方案（未证最优）",
    infeasible: "❌ 无解（已证明不存在可行方案）",
    not_found: "⚪ 未找到可行方案",
  };

  function renderSolution() {
    const box = $("solution-box");
    const sol = S.solution;
    if (!sol) {
      box.innerHTML = '<p class="muted">尚未求解。</p>';
      return;
    }
    const note = {
      optimal: "已在 10 秒时限内证明全局最优。",
      feasible: `求解器在时限内找到可行方案，但未能在 10 秒内证明最优（耗时 ${sol.elapsed_ms} ms）。`,
      infeasible: "已在时限内证明该场景不存在任何可行隔离方案（如检修段无法与水源隔离、保供节点必然断供）。",
      not_found: "求解器在 10 秒内未找到任何可行方案，也未能证明无解。请调整管网或保供要求后重试。",
    }[sol.status] || "";

    box.innerHTML = `
      <div class="sol-status ${sol.status}">${STATUS_TEXT[sol.status] || sol.status}</div>
      <dl class="sol-grid">
        <dt>断供户数</dt><dd>${sol.disconnected_households} / ${sol.total_households}</dd>
        <dt>关闭阀门</dt><dd>${sol.closed_valve_count} 个</dd>
        <dt>求解耗时</dt><dd>${sol.elapsed_ms} ms</dd>
      </dl>
      <div class="row"><label class="muted">关闭阀门（按 ID 升序）</label>
        <div class="sol-list">${(sol.closed_valve_ids || []).join(", ") || "—"}</div></div>
      <div class="row"><label class="muted">断供节点</label>
        <div class="sol-list">${(sol.disconnected_node_ids || []).join(", ") || "—"}</div></div>
      <div class="row"><label class="muted">供水节点</label>
        <div class="sol-list">${(sol.supplied_node_ids || []).join(", ") || "—"}</div></div>
      <p class="sol-note">${note}</p>`;
  }

  // ============================================================
  // 编辑操作
  // ============================================================
  function addNode(kind, x, y) {
    if (S.nodes.length >= LIMITS.nodes) {
      toast(`节点最多 ${LIMITS.nodes} 个`, "error");
      return null;
    }
    const used = new Set(S.nodes.map((n) => n.id));
    const id = nextId("N", used);
    const n = {
      id, kind, households: kind === "source" ? 0 : 100,
      x: Math.round(x), y: Math.round(y),
    };
    S.nodes.push(n);
    S.selected = { type: "node", id };
    markDirty();
    refreshAll();
    return n;
  }

  function connectPipe(aId, bId, isValve) {
    if (aId === bId) { toast("不能连接同一个节点（不允许自环）", "error"); return; }
    if (S.pipes.length >= LIMITS.pipes) {
      toast(`管段最多 ${LIMITS.pipes} 条`, "error");
      return;
    }
    if (isValve && valveCount() >= LIMITS.valves) {
      toast(`可关闭阀门最多 ${LIMITS.valves} 个`, "error");
      return;
    }
    const used = new Set(S.pipes.map((p) => p.id));
    const id = nextId(isValve ? "V" : "P", used);
    const p = { id, a: aId, b: bId, isValve };
    S.pipes.push(p);
    S.selected = { type: "pipe", id };
    markDirty();
    refreshAll();
  }

  function deleteNode(id) {
    const related = S.pipes.filter((p) => p.a === id || p.b === id);
    S.pipes = S.pipes.filter((p) => p.a !== id && p.b !== id);
    S.nodes = S.nodes.filter((n) => n.id !== id);
    S.protectedNodeIds.delete(id);
    if (S.maintenancePipeId && related.some((p) => p.id === S.maintenancePipeId)) {
      S.maintenancePipeId = null;
    }
    S.selected = null;
    markDirty();
    refreshAll();
  }

  function deletePipe(id) {
    S.pipes = S.pipes.filter((p) => p.id !== id);
    if (S.maintenancePipeId === id) S.maintenancePipeId = null;
    S.selected = null;
    markDirty();
    refreshAll();
  }

  // ============================================================
  // 画布交互
  // ============================================================
  canvas.addEventListener("pointerdown", (ev) => {
    // 对比视图只读：画布不响应任何编辑 / 选择
    if (C.active) { ev.preventDefault(); return; }
    canvas.setPointerCapture(ev.pointerId);
    const { x, y } = canvasPos(ev);
    const n = hitNode(x, y, S.nodes);

    if (S.tool === "add-user") { addNode("user", x, y); setTool("select"); return; }
    if (S.tool === "add-source") { addNode("source", x, y); setTool("select"); return; }

    if (S.tool === "add-pipe" || S.tool === "add-valve") {
      if (n) {
        if (!S.pipePending) {
          S.pipePending = n.id;
          updateCounts();
        } else if (S.pipePending !== n.id) {
          connectPipe(S.pipePending, n.id, S.tool === "add-valve");
          S.pipePending = null;
          setTool("select");
        }
      } else {
        toast("管段端点必须是已存在的节点，请先放置节点", "error");
      }
      return;
    }

    // select
    const p = n ? null : hitPipe(x, y, activeView());
    if (n) {
      S.selected = { type: "node", id: n.id };
      S.drag = { id: n.id, dx: n.x - x, dy: n.y - y, moved: false };
    } else if (p) {
      S.selected = { type: "pipe", id: p.id };
    } else {
      S.selected = null;
    }
    renderInspector();
    draw();
  });

  canvas.addEventListener("pointermove", (ev) => {
    if (C.active) return;
    const pos = canvasPos(ev);
    S.mousePos = pos;
    if (S.drag) {
      const n = nodeById(S.drag.id);
      if (n) {
        n.x = Math.max(NODE_R, Math.min(CANVAS_W - NODE_R, pos.x + S.drag.dx));
        n.y = Math.max(NODE_R, Math.min(CANVAS_H - NODE_R, pos.y + S.drag.dy));
        S.drag.moved = true;
        draw();
      }
    } else if (S.pipePending) {
      draw();
    }
  });

  canvas.addEventListener("pointerup", (ev) => {
    if (S.drag && S.drag.moved) markDirty();
    S.drag = null;
  });

  canvas.addEventListener("pointerleave", () => { S.mousePos = null; draw(); });

  $("btn-delete").addEventListener("click", () => {
    if (!S.selected) { toast("请先在画布上选中节点或管段"); return; }
    if (S.selected.type === "node") deleteNode(S.selected.id);
    else deletePipe(S.selected.id);
  });

  document.querySelectorAll('input[name="tool"]').forEach((radio) => {
    radio.addEventListener("change", (e) => setTool(e.target.value));
  });

  function setTool(tool) {
    S.tool = tool;
    S.pipePending = null;
    const r = document.querySelector(`input[name="tool"][value="${tool}"]`);
    if (r) r.checked = true;
    updateCounts();
    draw();
  }

  // ============================================================
  // 场景序列化 / 服务端交互
  // ============================================================
  function serialize() {
    return {
      name: S.name || "未命名场景",
      nodes: S.nodes.map((n) => ({
        id: n.id, kind: n.kind, households: n.households, x: n.x, y: n.y,
      })),
      pipes: S.pipes.map((p) => ({
        id: p.id, a: p.a, b: p.b, is_valve: p.isValve,
      })),
      maintenance_pipe_id: S.maintenancePipeId,
      protected_node_ids: Array.from(S.protectedNodeIds),
    };
  }

  function loadScenario(data) {
    S.scenarioId = data.id;
    S.name = data.name;
    S.nodes = data.nodes.map((n) => ({ ...n }));
    S.pipes = data.pipes.map((p) => ({
      id: p.id, a: p.a, b: p.b, isValve: p.is_valve,
    }));
    S.maintenancePipeId = data.maintenance_pipe_id || null;
    S.protectedNodeIds = new Set(data.protected_node_ids || []);
    S.solution = data.solution || null;
    S.topologyHash = data.topology_hash || null;
    S.selected = null;
    S.pipePending = null;
    S.dirty = false;
    renderSolution();
    refreshAll();
    renderScenarioTag();
    renderListActive();
    // 切换场景默认回到编辑视图；随后尝试恢复最近一次对比
    exitComparison(false);
    toast(`已载入场景 #${data.id}`, "success");
    restoreLatestComparison();
  }

  async function saveScenario() {
    const body = serialize();
    try {
      if (S.scenarioId == null) {
        const created = await api("/api/scenarios", { method: "POST", body: JSON.stringify(body) });
        S.scenarioId = created.id;
        S.topologyHash = created.topology_hash || null;
      } else {
        const updated = await api(`/api/scenarios/${S.scenarioId}`, { method: "PUT", body: JSON.stringify(body) });
        S.topologyHash = updated.topology_hash || null;
      }
      S.dirty = false;
      // 保存的是拓扑/选择，服务端已将旧方案置空；画布同步清空，等待重新求解
      S.solution = null;
      renderSolution();
      renderScenarioTag();
      await loadScenarioList();
      renderListActive();
      toast("场景已保存", "success");
      return true;
    } catch (e) {
      toast("保存失败：\n" + e.message, "error");
      return false;
    }
  }

  async function solveScenario() {
    // 有未保存修改时先保存
    if (S.scenarioId == null || S.dirty) {
      toast("检测到未保存修改，正在先保存场景…");
      const ok = await saveScenario();
      if (!ok) return;
    }
    if (C.active) exitComparison();
    if (!S.maintenancePipeId) {
      if (!confirm("尚未选择待检修的普通管段，仍要求解吗？\n（此时求解的是当前管网的供水连通状态）")) return;
    }
    $("btn-solve").disabled = true;
    toast("求解中，最长等待 10 秒…");
    try {
      const r = await api(`/api/scenarios/${S.scenarioId}/solve`, { method: "POST" });
      S.solution = r.solution;
      renderSolution();
      draw();
      await loadScenarioList();
      const st = STATUS_TEXT[r.solution.status] || r.solution.status;
      toast(`求解完成：${st}`, r.solution.status === "infeasible" || r.solution.status === "not_found" ? "error" : "success");
    } catch (e) {
      toast("求解失败：\n" + e.message, "error");
    } finally {
      $("btn-solve").disabled = false;
    }
  }

  // ============================================================
  // 场景列表
  // ============================================================
  async function loadScenarioList() {
    const list = await api("/api/scenarios");
    const ul = $("scenario-list");
    $("scenario-hint").textContent = list.length ? "" : "尚未加载场景。";
    ul.innerHTML = list.map((sc) => {
      const short = { optimal: "最优", feasible: "未证最优", infeasible: "无解", not_found: "未找到" };
      const pill = sc.status
        ? `<span class="status-pill pill-${sc.status}">${short[sc.status] || sc.status}</span>`
        : "";
      return `<li data-id="${sc.id}" class="${S.scenarioId === sc.id ? "active" : ""}">
        <div class="sc-name">${pill}${escapeHtml(sc.name)}</div>
        <div class="sc-meta">#${sc.id} · ${sc.updated_at.replace("T", " ").replace("Z", "")}${sc.has_solution ? " · 有方案" : ""}</div>
        <button class="sc-del" data-del="${sc.id}" title="删除场景">✕</button>
      </li>`;
    }).join("");
  }

  function renderListActive() {
    document.querySelectorAll("#scenario-list li").forEach((li) => {
      li.classList.toggle("active", Number(li.dataset.id) === S.scenarioId);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  $("scenario-list").addEventListener("click", async (ev) => {
    const delBtn = ev.target.closest("[data-del]");
    if (delBtn) {
      ev.stopPropagation();
      const id = Number(delBtn.dataset.del);
      if (!confirm("确定删除该场景及其方案？此操作不可恢复。")) return;
      await api(`/api/scenarios/${id}`, { method: "DELETE" });
      if (S.scenarioId === id) resetScene();
      await loadScenarioList();
      toast("场景已删除", "success");
      return;
    }
    const li = ev.target.closest("li[data-id]");
    if (!li) return;
    if (S.dirty && !confirm("当前场景有未保存修改，切换将丢弃这些修改，是否继续？")) return;
    const data = await api(`/api/scenarios/${li.dataset.id}`);
    loadScenario(data);
  });

  // ============================================================
  // 新建 / 示例
  // ============================================================
  function resetScene() {
    S.scenarioId = null;
    S.name = "未命名场景";
    S.nodes = [];
    S.pipes = [];
    S.maintenancePipeId = null;
    S.protectedNodeIds = new Set();
    S.solution = null;
    S.topologyHash = null;
    S.selected = null;
    S.pipePending = null;
    S.dirty = false;
    C.plans = [];
    exitComparison();
    setTool("select");
    renderSolution();
    refreshAll();
    renderScenarioTag();
    renderListActive();
  }

  $("btn-new").addEventListener("click", () => {
    if (S.dirty && !confirm("当前场景有未保存修改，确定新建空白场景吗？")) return;
    resetScene();
  });

  // 内置示例：双水源 + 环网 + 待检修管段，演示最优隔离
  function loadSample() {
    const data = {
      name: "示例·双水源环网检修",
      nodes: [
        { id: "S1", kind: "source", households: 0, x: 90, y: 120 },
        { id: "S2", kind: "source", households: 0, x: 810, y: 120 },
        { id: "N1", kind: "user", households: 120, x: 250, y: 200 },
        { id: "N2", kind: "user", households: 80, x: 450, y: 200 },
        { id: "N3", kind: "user", households: 150, x: 650, y: 200 },
        { id: "N4", kind: "user", households: 60, x: 250, y: 420 },
        { id: "N5", kind: "user", households: 90, x: 450, y: 420 },
        { id: "N6", kind: "user", households: 70, x: 650, y: 420 },
      ],
      pipes: [
        { id: "V1", a: "S1", b: "N1", is_valve: true },
        { id: "V2", a: "N1", b: "N2", is_valve: true },
        { id: "P_M", a: "N2", b: "N3", is_valve: false },   // 待检修普通管段
        { id: "V3", a: "N3", b: "S2", is_valve: true },
        { id: "V4", a: "N1", b: "N4", is_valve: true },
        { id: "P45", a: "N4", b: "N5", is_valve: false },
        { id: "V5", a: "N5", b: "N6", is_valve: true },
        { id: "V6", a: "N6", b: "N3", is_valve: true },
        { id: "V7", a: "N2", b: "N5", is_valve: true },
      ],
      maintenance_pipe_id: "P_M",
      protected_node_ids: ["N4", "N5"],
    };
    S.scenarioId = null;
    S.name = data.name;
    S.nodes = data.nodes.map((n) => ({ ...n }));
    S.pipes = data.pipes.map((p) => ({ id: p.id, a: p.a, b: p.b, isValve: p.is_valve }));
    S.maintenancePipeId = data.maintenance_pipe_id;
    S.protectedNodeIds = new Set(data.protected_node_ids);
    S.solution = null;
    S.selected = null;
    S.pipePending = null;
    S.dirty = true;
    renderSolution();
    refreshAll();
    renderScenarioTag();
    renderListActive();
    toast("已载入内置示例，点击“求解方案”查看最优隔离结果");
  }

  $("btn-sample").addEventListener("click", () => {
    if (S.dirty && !confirm("当前场景有未保存修改，载入示例将丢弃它们，是否继续？")) return;
    loadSample();
  });

  $("btn-save").addEventListener("click", saveScenario);
  $("btn-solve").addEventListener("click", solveScenario);

  window.addEventListener("beforeunload", (e) => {
    if (S.dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  // ============================================================
  // 方案批量对比
  // ============================================================
  const CMP_LIMIT = 6;

  function cmpEls() {
    return {
      modal: $("cmp-modal"),
      pipeSel: $("cmp-new-pipe"),
      protectedBox: $("cmp-new-protected"),
      nameInput: $("cmp-new-name"),
      planList: $("cmp-plan-list"),
      planCount: $("cmp-plan-count"),
      staleHint: $("cmp-stale-hint"),
      baselineSel: $("cmp-baseline"),
      runBtn: $("cmp-run"),
      runHint: $("cmp-run-hint"),
      history: $("cmp-history"),
      bar: $("cmp-bar"),
      barTitle: $("cmp-bar-title"),
      barSelect: $("cmp-bar-select"),
      box: $("comparison-box"),
    };
  }

  // 快照新旧判定直接使用服务端在场景详情 / 方案摘要中下发的 topology_hash，
  // 无需前端重复计算指纹。

  function fillNewPlanForm() {
    const { pipeSel, protectedBox, nameInput } = cmpEls();
    pipeSel.innerHTML = '<option value="">（不选，仅查看连通状态）</option>' +
      S.pipes.filter((p) => !p.isValve)
        .map((p) => `<option value="${p.id}"${p.id === S.maintenancePipeId ? " selected" : ""}>${p.id}（${p.a} ↔ ${p.b}）</option>`)
        .join("");
    protectedBox.innerHTML = S.nodes.filter((n) => n.kind !== "source").map((n) =>
      `<label><input type="checkbox" value="${n.id}"${S.protectedNodeIds.has(n.id) ? " checked" : ""}>${n.id}</label>`
    ).join("") || '<span class="muted">暂无用水节点</span>';
    if (!nameInput.value) {
      const idx = C.plans.length + 1;
      nameInput.placeholder = `例如：检修方案 ${idx}`;
    }
  }

  async function refreshPlans() {
    if (S.scenarioId == null) { C.plans = []; }
    else { C.plans = await api(`/api/scenarios/${S.scenarioId}/plans`); }
    renderPlanList();
  }

  function renderPlanList() {
    const { planList, planCount, staleHint } = cmpEls();
    planCount.textContent = `（${C.plans.length}/${CMP_LIMIT}）`;
    const staleCount = C.plans.filter((p) => p.topology_hash !== S.topologyHash).length;
    staleHint.textContent = staleCount
      ? `· ${staleCount} 个快照来自历史版本管网，已标记（不能与当前版混比）`
      : "";

    if (!C.plans.length) {
      planList.innerHTML = '<p class="muted">还没有方案快照，请先在上方创建。</p>';
    } else {
      planList.innerHTML = C.plans.map((p) => {
        const stale = p.topology_hash !== S.topologyHash;
        const checked = C.selected.has(p.id) && !stale ? "checked" : "";
        const short = { optimal: "最优", feasible: "未证最优", infeasible: "无解",
                        not_found: "未找到", error: "求解异常" };
        const pill = p.status
          ? `<span class="status-pill pill-${p.status}">${short[p.status] || p.status}</span>`
          : '<span class="muted">未求解</span>';
        return `
        <div class="cmp-plan-row${stale ? " stale" : ""}" data-id="${p.id}">
          <input type="checkbox" class="pr-check" data-id="${p.id}" ${checked} ${stale ? "disabled" : ""}>
          <div class="pr-main">
            <div class="pr-name">${escapeHtml(p.name)} ${pill}
              ${stale ? '<span class="pr-stale">历史版本快照</span>' : ""}</div>
            <div class="pr-meta">#${p.id} · 检修段 ${p.maintenance_pipe_id || "—"} ·
              保供 ${(p.protected_node_ids || []).join("、") || "无"}</div>
          </div>
          <button type="button" class="pr-del" data-del="${p.id}" title="删除快照">✕</button>
        </div>`;
      }).join("");
    }
    renderBaselineOptions();
  }

  function selectedPlanIds() {
    return C.plans.filter((p) => C.selected.has(p.id) && p.topology_hash === S.topologyHash)
      .map((p) => p.id);
  }

  function renderBaselineOptions() {
    const { baselineSel, runHint, runBtn } = cmpEls();
    const ids = selectedPlanIds();
    if (C.baselineId == null || !ids.includes(C.baselineId)) {
      C.baselineId = ids[0] != null ? ids[0] : null;
    }
    baselineSel.innerHTML = ids.length
      ? ids.map((id) => {
          const p = C.plans.find((x) => x.id === id);
          return `<option value="${id}"${id === C.baselineId ? " selected" : ""}>${escapeHtml(p.name)}</option>`;
        }).join("")
      : '<option value="">（先勾选方案）</option>';
    const ok = ids.length >= 2 && ids.length <= CMP_LIMIT;
    runBtn.disabled = !ok;
    runHint.textContent = ids.length
      ? `已勾选 ${ids.length} 个方案，基准方案为「${escapeHtml((C.plans.find((x) => x.id === C.baselineId) || {}).name || "")}」。`
        + (ok ? "" : "（至少勾选 2 个）")
      : `勾选 2～${CMP_LIMIT} 个同一版管网的快照后发起对比。`;
  }

  async function createPlanFromForm() {
    if (S.scenarioId == null) { toast("请先保存管网后再创建方案快照", "error"); return; }
    if (C.plans.length >= CMP_LIMIT) {
      toast(`每个管网最多保存 ${CMP_LIMIT} 个方案快照`, "error"); return;
    }
    const { nameInput, pipeSel, protectedBox } = cmpEls();
    const name = nameInput.value.trim() || `检修方案 ${C.plans.length + 1}`;
    const maintenance_pipe_id = pipeSel.value || null;
    const protected_node_ids = Array.from(
      protectedBox.querySelectorAll("input:checked")).map((c) => c.value);
    try {
      await api(`/api/scenarios/${S.scenarioId}/plans`, {
        method: "POST",
        body: JSON.stringify({ name, maintenance_pipe_id, protected_node_ids }),
      });
      nameInput.value = "";
      toast(`方案快照「${name}」已创建（不可变）`, "success");
      await refreshPlans();
      fillNewPlanForm();
    } catch (e) {
      toast("创建快照失败：\n" + e.message, "error");
    }
  }

  async function runCompare() {
    const ids = selectedPlanIds();
    if (ids.length < 2 || ids.length > CMP_LIMIT) {
      toast(`请勾选 2～${CMP_LIMIT} 个方案`, "error"); return;
    }
    const baseline_plan_id = Number(cmpEls().baselineSel.value);
    const { runBtn } = cmpEls();
    runBtn.disabled = true;
    runBtn.textContent = `批量求解中（${ids.length} × 最长 10 秒）…`;
    toast(`正在依次求解 ${ids.length} 个方案，请稍候…`);
    try {
      const result = await api(`/api/scenarios/${S.scenarioId}/comparisons`, {
        method: "POST",
        body: JSON.stringify({ plan_ids: ids, baseline_plan_id }),
      });
      await refreshPlans();
      await loadHistory();
      showComparison(result);
      closeCompareModal();
      toast("批量对比完成", "success");
    } catch (e) {
      toast("对比失败：\n" + e.message, "error");
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "批量求解并对比";
    }
  }

  // ---- 对比结果展示 ----
  function showComparison(result) {
    C.active = result;
    C.viewedPlanId = result.baseline_plan_id;
    // 刷新后恢复：记住该管网最近查看的对比
    try { localStorage.setItem(cmpStorageKey(), String(result.id)); } catch (_) {}
    document.querySelector(".canvas-wrap").classList.add("cmp-readonly");
    renderCmpBar();
    renderComparisonBox();
    draw();
    updateCounts();
  }

  function exitComparison(redraw = true) {
    C.active = null;
    C.viewedPlanId = null;
    const wrap = document.querySelector(".canvas-wrap");
    if (wrap) wrap.classList.remove("cmp-readonly");
    cmpEls().bar.classList.add("hidden");
    cmpEls().box.innerHTML = '<p class="muted">尚未生成对比。</p>';
    if (redraw) { draw(); updateCounts(); }
  }

  function cmpStorageKey() {
    return S.scenarioId == null ? "" : `water.cmp.${S.scenarioId}`;
  }

  async function restoreLatestComparison() {
    if (S.scenarioId == null) { exitComparison(); return; }
    try {
      const list = await api(`/api/scenarios/${S.scenarioId}/comparisons`);
      if (!list.length) { exitComparison(); return; }
      let targetId = null;
      try { targetId = Number(localStorage.getItem(cmpStorageKey())); } catch (_) {}
      const hit = list.find((c) => c.id === targetId) || list[0];
      const full = await api(`/api/comparisons/${hit.id}`);
      showComparison(full);
    } catch (e) {
      exitComparison();
    }
  }

  function renderCmpBar() {
    const { bar, barTitle, barSelect } = cmpEls();
    if (!C.active) { bar.classList.add("hidden"); return; }
    bar.classList.remove("hidden");
    barTitle.textContent =
      `#${C.active.id} · 基准「${C.active.baseline_name}」 · ${C.active.plans.length} 个方案`;
    barSelect.innerHTML = C.active.plans.map((r) =>
      `<option value="${r.plan_id}"${r.plan_id === C.viewedPlanId ? " selected" : ""}>${
        r.is_baseline ? "★ " : ""}${escapeHtml(r.name)}</option>`).join("");
  }

  const CMP_STATUS_TEXT = {
    optimal: "✅ 最优",
    feasible: "🟡 未证最优（可行）",
    infeasible: "❌ 无解",
    not_found: "⚪ 未找到",
    error: "💥 求解异常",
  };

  function chips(ids, cls, label) {
    if (!ids || !ids.length) return "";
    return `<div class="cmp-chips"><span class="cmp-diff-label">${label}</span>` +
      ids.map((id) => `<span class="chip ${cls}">${escapeHtml(id)}</span>`).join("") + "</div>";
  }

  function renderComparisonBox() {
    const { box } = cmpEls();
    const cmp = C.active;
    if (!cmp) return;
    box.innerHTML = `
      <div class="cmp-summary">对比 #${cmp.id} · 基准方案「${escapeHtml(cmp.baseline_name)}」
        · 结果按方案名排序 · ${(cmp.created_at || "").replace("T", " ").replace("Z", "")}</div>
      <div class="cmp-cards">
        ${cmp.plans.map((r) => renderCmpCard(r, cmp)).join("")}
      </div>`;
  }

  function renderCmpCard(r, cmp) {
    const sol = r.solution || {};
    const activeCls = r.plan_id === C.viewedPlanId ? "" : " inactive";
    const baseCls = r.is_baseline ? " baseline" : "";
    const d = r.diff;
    let body;
    if (!sol.status) {
      body = '<p class="cmp-no-diff">无求解结果。</p>';
    } else if (r.is_baseline) {
      body = cmpSolBody(sol) + '<p class="cmp-no-diff">基准方案（差异项均以它为参照）。</p>';
    } else if (d) {
      const delta = d.disconnected_households_delta;
      const deltaTxt = delta === 0 ? "持平"
        : (delta > 0 ? `多断供 <span class="worse">+${delta}</span> 户`
                     : `少断供 <span class="better">${delta}</span> 户`);
      body = cmpSolBody(sol) + `
        <div class="cmp-stat-line">相对基准：${deltaTxt}</div>
        ${chips(d.newly_disconnected_node_ids, "chip-new-off", "新增断供")}
        ${chips(d.restored_supplied_node_ids, "chip-restored", "恢复供水")}
        ${chips(d.newly_closed_valve_ids, "chip-new-valve", "新关阀门")}
        ${chips(d.reopened_valve_ids, "chip-reopen", "取消关闭")}
        ${(!d.newly_disconnected_node_ids.length && !d.restored_supplied_node_ids.length &&
           !d.newly_closed_valve_ids.length && !d.reopened_valve_ids.length)
          ? '<p class="cmp-no-diff">与基准方案结果一致。</p>' : ""}`;
    } else {
      const reason = sol.status === "error"
        ? `求解异常：${escapeHtml(sol.error || "")}`
        : "该方案状态为「无解 / 未找到」，没有可执行的阀门方案，故不计算差异。";
      body = `<p class="cmp-no-diff">${reason}</p>`;
    }
    return `
      <div class="cmp-card${baseCls}${activeCls}" data-view-plan="${r.plan_id}">
        <div class="cmp-card-head">
          <span class="cmp-card-name">${escapeHtml(r.name)}</span>
          ${r.is_baseline ? '<span class="cmp-badge">基准</span>' : ""}
          <span>${CMP_STATUS_TEXT[sol.status] || sol.status || "—"}</span>
        </div>
        <div class="cmp-card-meta">检修段 ${r.maintenance_pipe_id || "—"} ·
          保供 ${(r.protected_node_ids || []).join("、") || "无"} ·
          耗时 ${sol.elapsed_ms != null ? sol.elapsed_ms + " ms" : "—"}</div>
        ${body}
      </div>`;
  }

  function cmpSolBody(sol) {
    return `
      <div class="cmp-stat-line">断供户数 <b>${sol.disconnected_households}</b> / ${sol.total_households}
        · 关闭阀门 <b>${sol.closed_valve_count}</b> 个</div>
      <div class="cmp-chips"><span class="cmp-diff-label">关闭阀门</span>${
        (sol.closed_valve_ids || []).map((id) => `<span class="chip">${escapeHtml(id)}</span>`).join("") || '<span class="chip">—</span>'}</div>
      <div class="cmp-chips"><span class="cmp-diff-label">供水节点</span>${
        (sol.supplied_node_ids || []).map((id) => `<span class="chip chip-restored">${escapeHtml(id)}</span>`).join("") || '<span class="chip">—</span>'}</div>
      <div class="cmp-chips"><span class="cmp-diff-label">断供节点</span>${
        (sol.disconnected_node_ids || []).map((id) => `<span class="chip chip-new-off">${escapeHtml(id)}</span>`).join("") || '<span class="chip">—</span>'}</div>`;
  }

  // ---- 历史 ----
  async function loadHistory() {
    const { history } = cmpEls();
    if (S.scenarioId == null) { history.innerHTML = '<p class="muted">请先保存管网。</p>'; return; }
    const list = await api(`/api/scenarios/${S.scenarioId}/comparisons`);
    if (!list.length) {
      history.innerHTML = '<p class="muted">暂无对比记录。</p>';
      return;
    }
    history.innerHTML = list.map((c) => `
      <div class="cmp-hist-row" data-id="${c.id}">
        <div class="hr-main" data-open="${c.id}">
          <div class="hr-title">#${c.id} · 基准「${escapeHtml(c.baseline_name)}」 · ${c.plan_count} 个方案</div>
          <div class="hr-meta">${c.created_at.replace("T", " ").replace("Z", "")} · ${
            c.plan_names.map(escapeHtml).join("、")}</div>
        </div>
        <button type="button" class="hr-del" data-del="${c.id}" title="删除对比记录">✕</button>
      </div>`).join("");
  }

  async function openComparison(id) {
    try {
      const full = await api(`/api/comparisons/${id}`);
      showComparison(full);
      closeCompareModal();
    } catch (e) {
      toast("加载对比失败：" + e.message, "error");
    }
  }

  // ---- 弹窗开关 ----
  async function openCompareModal() {
    if (S.scenarioId == null) {
      toast("请先保存管网（方案快照必须基于同一已保存管网）", "error"); return;
    }
    if (S.dirty) {
      toast("管网有未保存修改，正在先保存…");
      const ok = await saveScenario();
      if (!ok) return;
    }
    C.modalOpen = true;
    cmpEls().modal.classList.remove("hidden");
    C.selected = new Set();
    C.baselineId = null;
    fillNewPlanForm();
    await refreshPlans();
    await loadHistory();
  }

  function closeCompareModal() {
    C.modalOpen = false;
    cmpEls().modal.classList.add("hidden");
  }

  $("btn-compare").addEventListener("click", openCompareModal);
  $("cmp-modal-close").addEventListener("click", closeCompareModal);
  cmpEls().modal.addEventListener("click", (ev) => {
    if (ev.target === cmpEls().modal) closeCompareModal();
  });
  $("cmp-new-add").addEventListener("click", createPlanFromForm);
  $("cmp-run").addEventListener("click", runCompare);
  cmpEls().baselineSel.addEventListener("change", (ev) => {
    C.baselineId = Number(ev.target.value);
    renderBaselineOptions();
  });
  cmpEls().planList.addEventListener("click", async (ev) => {
    const delBtn = ev.target.closest("[data-del]");
    if (delBtn) {
      const id = Number(delBtn.dataset.del);
      if (!confirm("删除该不可变快照？此操作不可恢复。")) return;
      try {
        await api(`/api/plans/${id}`, { method: "DELETE" });
        C.selected.delete(id);
        await refreshPlans();
        toast("快照已删除", "success");
      } catch (e) {
        toast("删除失败：" + e.message, "error");
      }
      return;
    }
  });
  cmpEls().planList.addEventListener("change", (ev) => {
    const cb = ev.target.closest(".pr-check");
    if (!cb) return;
    const id = Number(cb.dataset.id);
    if (cb.checked) C.selected.add(id); else C.selected.delete(id);
    renderBaselineOptions();
  });
  cmpEls().history.addEventListener("click", async (ev) => {
    const delBtn = ev.target.closest("[data-del]");
    if (delBtn) {
      const id = Number(delBtn.dataset.del);
      if (!confirm("删除该对比记录？历史快照本身保留。")) return;
      await api(`/api/comparisons/${id}`, { method: "DELETE" });
      try { localStorage.removeItem(cmpStorageKey()); } catch (_) {}
      if (C.active && C.active.id === id) exitComparison();
      await loadHistory();
      return;
    }
    const opener = ev.target.closest("[data-open]");
    if (opener) openComparison(Number(opener.dataset.open));
  });
  cmpEls().box.addEventListener("click", (ev) => {
    const card = ev.target.closest("[data-view-plan]");
    if (card) {
      C.viewedPlanId = Number(card.dataset.viewPlan);
      renderCmpBar();
      renderComparisonBox();
      draw();
    }
  });
  cmpEls().barSelect.addEventListener("change", (ev) => {
    C.viewedPlanId = Number(ev.target.value);
    renderComparisonBox();
    draw();
  });
  $("cmp-bar-exit").addEventListener("click", () => exitComparison());

  // ============================================================
  // 启动
  // ============================================================
  function init() {
    draw();
    updateCounts();
    renderScenarioTag();
    loadScenarioList().catch((e) => toast("加载场景列表失败：" + e.message, "error"));
  }
  init();
})();
