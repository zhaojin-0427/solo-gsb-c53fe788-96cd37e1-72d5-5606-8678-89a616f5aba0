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
    comparisons: [],      // 当前场景的批量对比摘要列表
    selected: null,       // {type:'node'|'pipe', id}
    tool: "select",
    pipePending: null,    // 连管时的第一个节点 id
    dirty: false,
    drag: null,
  };

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
    // 拓扑/选择一旦变化，屏幕上旧方案不再可信
    S.solution = null;
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

  function hitNode(x, y) {
    // 从后向前（后画的在上层）
    for (let i = S.nodes.length - 1; i >= 0; i--) {
      const n = S.nodes[i];
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

  function hitPipe(x, y) {
    for (let i = S.pipes.length - 1; i >= 0; i--) {
      const p = S.pipes[i];
      const a = nodeById(p.a), b = nodeById(p.b);
      if (!a || !b) continue;
      if (distToSeg(x, y, a.x, a.y, b.x, b.y) <= PIPE_HIT + (p.isValve ? 3 : 0)) return p;
    }
    return null;
  }

  // ============================================================
  // 绘制
  // ============================================================
  function solutionState() {
    const sol = S.solution;
    if (!sol) return null;
    return {
      closedValves: new Set(sol.closed_valve_ids || []),
      removed: new Set(sol.removed_pipe_ids || []),
      supplied: new Set(sol.supplied_node_ids || []),
      disconnected: new Set(sol.disconnected_node_ids || []),
    };
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const st = solutionState();

    // ---- 管段 ----
    S.pipes.forEach((p) => {
      const a = nodeById(p.a), b = nodeById(p.b);
      if (!a || !b) return;
      const isMaint = p.id === S.maintenancePipeId;
      const closed = st && st.closedValves.has(p.id);
      const removed = st && st.removed.has(p.id);

      ctx.save();
      ctx.lineWidth = isMaint ? 3.5 : 2.4;
      if (isMaint) {
        ctx.strokeStyle = "#c0392b";
        ctx.setLineDash([8, 6]);
      } else if (p.isValve) {
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
      if (p.isValve) {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        ctx.save();
        ctx.translate(mx, my);
        ctx.rotate(ang);
        ctx.fillStyle = closed ? "#b5651d" : "#ffffff";
        ctx.strokeStyle = "#8a4a16";
        ctx.lineWidth = 2;
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

      // 选中高亮
      if (S.selected && S.selected.type === "pipe" && S.selected.id === p.id) {
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
    if (S.pipePending && S.mousePos) {
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
    S.nodes.forEach((n) => {
      const selected = S.selected && S.selected.type === "node" && S.selected.id === n.id;
      const isProtected = S.protectedNodeIds.has(n.id);
      let fill, stroke = "#334155";

      if (n.kind === "source") {
        fill = "#1d6fb8";
      } else if (st) {
        fill = st.disconnected.has(n.id) ? "#c0392b" : "#2f8f5f";
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

      // 水源用 S 字样
      ctx.fillStyle = "#fff";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(n.kind === "source" ? "水" : "", n.x, n.y);

      // ID + 户数标签
      ctx.fillStyle = "#1f2933";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      const label = n.kind === "source" ? n.id : `${n.id}·${n.households}户`;
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
    canvas.setPointerCapture(ev.pointerId);
    const { x, y } = canvasPos(ev);
    const n = hitNode(x, y);

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
    const p = n ? null : hitPipe(x, y);
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
    S.selected = null;
    S.pipePending = null;
    S.dirty = false;
    renderSolution();
    refreshAll();
    renderScenarioTag();
    renderListActive();
    loadComparisons().catch((e) => toast("加载批量对比失败：" + e.message, "error"));
    toast(`已载入场景 #${data.id}`, "success");
  }

  async function saveScenario() {
    const body = serialize();
    try {
      if (S.scenarioId == null) {
        const created = await api("/api/scenarios", { method: "POST", body: JSON.stringify(body) });
        S.scenarioId = created.id;
      } else {
        await api(`/api/scenarios/${S.scenarioId}`, { method: "PUT", body: JSON.stringify(body) });
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
    S.comparisons = [];
    S.selected = null;
    S.pipePending = null;
    S.dirty = false;
    setTool("select");
    renderSolution();
    renderCmpList();
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

  // ============================================================
  // 批量对比
  // ============================================================
  const CMP_MIN = 2, CMP_MAX = 6;
  let cmpDraft = null;   // 编辑器草稿 {name, baseline, plans:[{name, mpid, protected:[]}]}

  function cmpModal() { return $("cmp-modal"); }

  function openCmpModal(title) {
    $("cmp-modal-title").textContent = title;
    cmpModal().classList.remove("hidden");
  }

  function closeCmpModal() {
    cmpModal().classList.add("hidden");
    $("cmp-modal-body").innerHTML = "";
    cmpDraft = null;
  }

  $("cmp-modal-close").addEventListener("click", closeCmpModal);
  cmpModal().addEventListener("click", (ev) => {
    if (ev.target === cmpModal()) closeCmpModal();
  });

  async function loadComparisons() {
    if (S.scenarioId == null) { S.comparisons = []; renderCmpList(); return; }
    S.comparisons = await api(`/api/scenarios/${S.scenarioId}/comparisons`);
    renderCmpList();
  }

  function renderCmpList() {
    const ul = $("cmp-list");
    if (S.scenarioId == null) {
      ul.innerHTML = "";
      return;
    }
    ul.innerHTML = S.comparisons.map((c) => `
      <li data-cmp="${c.id}">
        <div class="cmp-name">${escapeHtml(c.name)}</div>
        <div class="cmp-meta">#${c.id} · ${c.plan_count} 个方案 · ${c.created_at.replace("T", " ").replace("Z", "")}</div>
        <button class="cmp-del" data-cmp-del="${c.id}" title="删除该对比记录">✕</button>
      </li>`).join("");
  }

  $("cmp-list").addEventListener("click", async (ev) => {
    const delBtn = ev.target.closest("[data-cmp-del]");
    if (delBtn) {
      ev.stopPropagation();
      if (!confirm("确定删除该对比记录？方案快照将一并删除，不可恢复。")) return;
      await api(`/api/comparisons/${delBtn.dataset.cmpDel}`, { method: "DELETE" });
      await loadComparisons();
      toast("对比记录已删除", "success");
      return;
    }
    const li = ev.target.closest("li[data-cmp]");
    if (!li) return;
    try {
      const data = await api(`/api/comparisons/${li.dataset.cmp}`);
      showCmpResult(data);
    } catch (e) {
      toast("加载对比结果失败：" + e.message, "error");
    }
  });

  // ---- 编辑器 ----
  function normalPipes() { return S.pipes.filter((p) => !p.isValve); }
  function userNodes() { return S.nodes.filter((n) => n.kind !== "source"); }

  function openCmpEditor() {
    cmpDraft = {
      name: `${S.name}·方案对比`,
      baseline: 0,
      plans: [
        { name: "方案A", mpid: S.maintenancePipeId || "", protected: [] },
        { name: "方案B", mpid: "", protected: [] },
      ],
    };
    renderCmpEditor();
    openCmpModal("新建批量对比");
  }

  function collectCmpDraft() {
    // 把当前表单值读回草稿（增删行 / 提交前都要先收集）
    const body = $("cmp-modal-body");
    cmpDraft.name = body.querySelector("#cmp-name").value;
    const rows = body.querySelectorAll(".plan-row");
    rows.forEach((row, i) => {
      const plan = cmpDraft.plans[i];
      if (!plan) return;
      plan.name = row.querySelector(".plan-name").value;
      plan.mpid = row.querySelector(".plan-mpid").value;
      plan.protected = Array.from(row.querySelector(".plan-protected").selectedOptions)
        .map((o) => o.value);
      if (row.querySelector(".plan-base input").checked) cmpDraft.baseline = i;
    });
  }

  function renderCmpEditor() {
    const pipes = normalPipes();
    const users = userNodes();
    const pipeOpts = (sel) =>
      `<option value="">— 请选择 —</option>` +
      pipes.map((p) =>
        `<option value="${escapeHtml(p.id)}" ${p.id === sel ? "selected" : ""}>${escapeHtml(p.id)}（${escapeHtml(p.a)}↔${escapeHtml(p.b)}）</option>`
      ).join("");
    const userOpts = (sel) =>
      users.map((n) =>
        `<option value="${escapeHtml(n.id)}" ${sel.includes(n.id) ? "selected" : ""}>${escapeHtml(n.id)}·${n.households}户</option>`
      ).join("");

    $("cmp-modal-body").innerHTML = `
      <div class="cmp-form">
        <div class="row">
          <label class="blk" for="cmp-name">对比名称</label>
          <input type="text" id="cmp-name" maxlength="128" value="${escapeHtml(cmpDraft.name)}">
        </div>
        <div class="row">
          <label class="blk">方案快照（${CMP_MIN}～${CMP_MAX} 个；创建后拓扑与参数即被冻结，不受后续场景修改影响）</label>
          <div class="plan-grid">
            ${cmpDraft.plans.map((p, i) => `
              <div class="plan-row" data-idx="${i}">
                <label class="plan-base" title="设为基准方案">
                  <input type="radio" name="cmp-baseline" ${i === cmpDraft.baseline ? "checked" : ""}>
                  <div style="font-size:11px;color:var(--muted)">基准</div>
                </label>
                <div>
                  <label class="blk">方案名称</label>
                  <input type="text" class="plan-name" maxlength="64" value="${escapeHtml(p.name)}">
                </div>
                <div>
                  <label class="blk">待检修普通管段</label>
                  <select class="plan-mpid">${pipeOpts(p.mpid)}</select>
                </div>
                <div>
                  <label class="blk">必须保供节点（按住 Ctrl 多选）</label>
                  <select class="plan-protected" multiple>${userOpts(p.protected)}</select>
                </div>
                <button type="button" class="plan-del" title="删除该方案"
                  ${cmpDraft.plans.length <= CMP_MIN ? "disabled" : ""}>✕</button>
              </div>`).join("")}
          </div>
        </div>
        <div class="cmp-form-actions">
          <button type="button" id="cmp-add-plan"
            ${cmpDraft.plans.length >= CMP_MAX ? "disabled" : ""}>＋ 添加方案</button>
          <button type="button" id="cmp-submit" class="accent">开始批量求解</button>
          <span class="muted">将依次求解 ${cmpDraft.plans.length} 个方案，每个最长 10 秒。</span>
        </div>
      </div>`;

    $("cmp-add-plan").addEventListener("click", () => {
      collectCmpDraft();
      const n = cmpDraft.plans.length;
      if (n >= CMP_MAX) return;
      cmpDraft.plans.push({
        name: `方案${"ABCDEF"[n] || n + 1}`, mpid: "", protected: [],
      });
      renderCmpEditor();
    });
    $("cmp-modal-body").querySelectorAll(".plan-del").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        collectCmpDraft();
        const idx = Number(ev.target.closest(".plan-row").dataset.idx);
        cmpDraft.plans.splice(idx, 1);
        if (cmpDraft.baseline >= cmpDraft.plans.length) cmpDraft.baseline = 0;
        renderCmpEditor();
      });
    });
    $("cmp-submit").addEventListener("click", submitComparison);
  }

  async function submitComparison() {
    collectCmpDraft();
    const d = cmpDraft;
    // 前端预检（服务端仍会完整校验）
    const errs = [];
    const names = d.plans.map((p) => p.name.trim());
    if (!d.name.trim()) errs.push("请填写对比名称");
    if (names.some((n) => !n)) errs.push("每个方案都必须填写名称");
    if (new Set(names).size !== names.length) errs.push("方案名称不能重复");
    if (d.plans.some((p) => !p.mpid)) errs.push("每个方案都必须选择待检修普通管段");
    if (errs.length) { toast(errs.join("\n"), "error"); return; }

    const btn = $("cmp-submit");
    btn.disabled = true;
    btn.textContent = "求解中…";
    try {
      const data = await api(`/api/scenarios/${S.scenarioId}/comparisons`, {
        method: "POST",
        body: JSON.stringify({
          name: d.name.trim(),
          baseline_index: d.baseline,
          plans: d.plans.map((p, i) => ({
            name: names[i],
            maintenance_pipe_id: p.mpid,
            protected_node_ids: p.protected,
          })),
        }),
      });
      await loadComparisons();
      showCmpResult(data);
      toast("批量求解完成", "success");
    } catch (e) {
      toast("批量对比失败：\n" + e.message, "error");
      btn.disabled = false;
      btn.textContent = "开始批量求解";
    }
  }

  // ---- 结果视图 ----
  function showCmpResult(data) {
    const diffCell = (p) => {
      if (p.is_baseline) return '<span class="muted">基准方案</span>';
      const d = p.diff_vs_baseline;
      const nd = d.newly_disconnected_node_ids;
      const rs = d.restored_node_ids;
      const vc = d.valves_newly_closed, vr = d.valves_reopened;
      const lines = [];
      lines.push(nd.length
        ? `<span class="cmp-diff-neg">新增断供 ${d.newly_disconnected_households} 户：${nd.join(", ")}</span>`
        : "新增断供：无");
      lines.push(rs.length
        ? `<span class="cmp-diff-pos">恢复供水 ${d.restored_households} 户：${rs.join(", ")}</span>`
        : "恢复供水：无");
      const vparts = [];
      if (vc.length) vparts.push(`新增关闭 ${vc.join(", ")}`);
      if (vr.length) vparts.push(`重新开启 ${vr.join(", ")}`);
      lines.push("阀门变更：" + (vparts.join("；") || "无"));
      return lines.join("<br>");
    };

    $("cmp-modal-body").innerHTML = `
      <p class="cmp-summary">
        对比「${escapeHtml(data.name)}」 · 场景 #${data.scenario_id} ·
        基准方案「${escapeHtml(data.baseline_name)}」 ·
        创建于 ${data.created_at.replace("T", " ").replace("Z", "")} ·
        方案按名称排序
      </p>
      <div class="cmp-table-wrap">
        <table class="cmp-table">
          <thead><tr>
            <th>方案</th><th>求解状态</th><th>检修段</th><th>保供节点</th>
            <th>断供户数</th><th>关闭阀门</th><th>断供节点</th><th>供水节点</th>
            <th>与基准方案对比</th>
          </tr></thead>
          <tbody>
            ${data.plans.map((p) => `
              <tr>
                <td><strong>${escapeHtml(p.name)}</strong>${p.is_baseline ? '<span class="cmp-base-tag">基准</span>' : ""}</td>
                <td>${STATUS_TEXT[p.solve_status] || p.solve_status}</td>
                <td class="mono">${escapeHtml(p.maintenance_pipe_id)}</td>
                <td class="mono">${p.protected_node_ids.join(", ") || "—"}</td>
                <td class="mono">${p.disconnected_households} / ${p.total_households}</td>
                <td class="mono">${p.closed_valve_ids.join(", ") || "—"}（${p.closed_valve_count}）</td>
                <td class="mono">${p.disconnected_node_ids.join(", ") || "—"}</td>
                <td class="mono">${p.supplied_node_ids.join(", ") || "—"}</td>
                <td>${diffCell(p)}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
    openCmpModal(`批量对比结果 · ${data.name}`);
  }

  $("btn-cmp-new").addEventListener("click", async () => {
    if (S.nodes.length === 0) { toast("请先搭建或载入管网", "error"); return; }
    if (normalPipes().length === 0) {
      toast("当前管网没有普通管段，无法指定待检修段", "error");
      return;
    }
    if (S.scenarioId == null || S.dirty) {
      toast("检测到未保存修改，正在先保存场景…");
      const ok = await saveScenario();
      if (!ok) return;
    }
    openCmpEditor();
  });

  window.addEventListener("beforeunload", (e) => {
    if (S.dirty) { e.preventDefault(); e.returnValue = ""; }
  });

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
