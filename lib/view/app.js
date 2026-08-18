// ============================================================================
// 内置浏览器共享视图（前端逻辑）
//  - SSE 实时刷新（Agent 操作 → 用户同步可见）
//  - 截图 + 点击叠加层（用户手动操作页面，spec #9）
//  - 标注模式（框选区域写评论，spec #10）
//  - 历史 / 站点权限 / Developer Mode / 手动上传
// ============================================================================

const $ = (s) => document.querySelector(s);
const api = {
  get: async (p) => (await fetch(p)).json(),
  post: async (p, body) => {
    const res = await fetch(p, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return res.json();
  },
  del: async (p, body) => {
    const res = await fetch(p, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return res.json();
  },
};

const state = {
  tabs: [],
  activeTabId: null,
  devMode: { enabled: false, approvedHosts: [] },
  annotations: [],
  annotateMode: false,
  iframeMode: false,
  external: false,
  shotTs: 0,
};

// ---- 外部浏览器模式（路线 C）----
// 面板 #live-frame 就是 Agent 正在驱动的真实页面（原生渲染、实时同步）。
// 强制 iframe 模式、禁标签页 UI；iframe 的文档由宿主负责导航，本页不要改它的 src。
function applyExternalMode() {
  if (!state.external) return;
  state.iframeMode = true;
  $("#stage").classList.add("iframe");
  const btn = $("#btn-frame");
  if (btn) {
    btn.disabled = true;
    btn.classList.add("active");
  }
  const strip = $("#tab-strip");
  if (strip) strip.style.display = "none";
  const nt = $("#btn-new-tab");
  if (nt) nt.style.display = "none";
  const back = $("#btn-back");
  const fwd = $("#btn-forward");
  if (back) back.style.display = "none";
  if (fwd) fwd.style.display = "none";
  let badge = document.getElementById("external-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "external-badge";
    $("#toolbar").appendChild(badge);
  }
  badge.textContent = "外部浏览器模式 · 直连你的浏览器（无隔离）";
}

// ---- 自适应缩放（视口跟随面板，contain + 居中）----
// 宿主会把浏览器视口调整为与共享面板一致（/api/resize），页面响应式重排，
// 帧流 1:1 铺满面板。舞台原始尺寸取自帧元数据（deviceWidth/Height）；
// 仅当面板与视口比例不完全一致时等比缩放并居中（不拉伸变形）。
let stageW = 1280;
let stageH = 800;
let viewScale = 1;

function applyScale() {
  const wrap = $("#stage-wrap");
  const stage = $("#stage");
  if (!wrap || !stage) return;
  const wrapW = wrap.clientWidth;
  const wrapH = wrap.clientHeight;
  viewScale = Math.min(wrapW / stageW, wrapH / stageH);
  stage.style.width = stageW + "px";
  stage.style.height = stageH + "px";
  if (viewScale < 1) {
    // 等比缩小并居中：视觉内容铺满尽可能大的区域（不拉伸变形）
    stage.style.transform = `scale(${viewScale})`;
    stage.style.transformOrigin = "top left";
    stage.style.margin = "0";
    stage.style.left = Math.max(0, Math.round((wrapW - stageW * viewScale) / 2)) + "px";
    stage.style.top = Math.max(0, Math.round((wrapH - stageH * viewScale) / 2)) + "px";
  } else {
    stage.style.transform = "";
    stage.style.transformOrigin = "";
    stage.style.margin = "0 auto";
    stage.style.left = "auto";
    stage.style.top = "auto";
  }
}
window.addEventListener("resize", applyScale);

// 面板尺寸变化 → 通知宿主把浏览器视口调整为同样尺寸（响应式重排 + 帧流 1:1 铺满）
let resizeTimer = null;
function reportPanelSize() {
  const wrap = $("#stage-wrap");
  if (!wrap) return;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  if (w < 320 || h < 240) return;
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    void api.post("/api/resize", { w, h }).catch(() => {});
  }, 250);
}
if (typeof ResizeObserver !== "undefined") {
  const wrapObs = new ResizeObserver(reportPanelSize);
  wrapObs.observe($("#stage-wrap"));
  reportPanelSize();
}

function toast(text, kind) {
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = text;
  $("#toast-root").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ---- 状态同步 ----
async function refreshState() {
  const data = await api.get("/api/state");
  state.tabs = data.state.tabs;
  state.activeTabId = data.state.activeTabId;
  state.devMode = data.devMode;
  state.annotations = data.annotations;
  if (data.external !== state.external) {
    state.external = !!data.external;
    applyExternalMode();
  }
  renderTabs();
  renderAddress();
  renderDevBadge();
  renderAnnotations();
  applyScale();
  reportPanelSize();
  if (state.external) return; // 外部模式：面板 iframe 即实时视图，无需截图/占位切换
  if (state.tabs.length === 0) {
    $("#placeholder").classList.add("show");
    $("#shot").style.display = "none";
  } else {
    $("#placeholder").classList.remove("show");
    $("#shot").style.display = "block";
    await refreshShot();
  }
}

// 截图刷新：带 noevent（不触发 shot 事件，避免截图→事件→再截图死循环）并做 300ms 防抖。
// 实时帧流（screencast）开启时跳过截图刷新（帧流自带持续更新）。
let shotTimer = null;
let streaming = false;
function refreshShot() {
  if (streaming || state.tabs.length === 0) return;
  if (shotTimer) clearTimeout(shotTimer);
  shotTimer = setTimeout(() => {
    shotTimer = null;
    state.shotTs = Date.now();
    const tab = state.activeTabId ?? state.tabs[0].id;
    $("#shot").src = `/api/screenshot?tab=${encodeURIComponent(tab)}&t=${state.shotTs}&noevent=1`;
  }, 300);
}

// ---- 实时帧流（CDP screencast，Codex 式实时共享视图）----
// 帧走 SSE 到达，直接渲染到 #shot；断线自动回退截图模式。
function connectStream() {
  let es = null;
  try {
    es = new EventSource("/api/screencast");
  } catch (e) {
    return;
  }
  es.addEventListener("open", () => {
    streaming = true;
    // 帧流开始后确保视口与面板一致（浏览器可能仍停留在初始 1280×800）
    reportPanelSize();
  });
  es.addEventListener("message", (ev) => {
    try {
      const d = JSON.parse(ev.data);
      if (d.type === "frame" && typeof d.data === "string") {
        // 舞台尺寸跟随帧元数据（宿主已把视口调整为面板尺寸）
        const m = d.meta || {};
        if (Number(m.deviceWidth) > 0 && Number(m.deviceHeight) > 0) {
          stageW = Number(m.deviceWidth);
          stageH = Number(m.deviceHeight);
          applyScale();
        }
        $("#shot").src = "data:image/jpeg;base64," + d.data;
      }
    } catch (e) {
      /* ignore */
    }
  });
  es.addEventListener("error", () => {
    streaming = false;
    // 回退截图模式：立即刷新一次
    void refreshState().catch(() => {});
  });
}

// ---- 标签页 ----
function renderTabs() {
  const strip = $("#tab-strip");
  strip.innerHTML = "";
  for (const t of state.tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (t.id === state.activeTabId ? " active" : "");
    el.textContent = (t.title || "新标签页").slice(0, 12);
    el.title = t.url || t.title;
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "✕";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      void api.post("/api/tab/close", { tabId: t.id }).then(refreshState);
    });
    el.appendChild(x);
    el.addEventListener("click", () => {
      void api.post("/api/tab/switch", { tabId: t.id }).then(refreshState);
    });
    strip.appendChild(el);
  }
}

function renderAddress() {
  const active = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0];
  if (document.activeElement !== $("#address")) {
    $("#address").value = active?.url ?? "";
  }
  $("#btn-back").disabled = !active?.canGoBack;
  $("#btn-forward").disabled = !active?.canGoForward;
}

function renderDevBadge() {
  const devBtn = $("#btn-devmode");
  if (devBtn) {
    devBtn.classList.toggle("on", state.devMode.enabled);
    devBtn.textContent = state.devMode.enabled ? "DEV ON" : "DEV";
  }
}

// ---- 标注（spec #10）----
function renderAnnotations() {
  const layer = $("#annotations-layer");
  layer.innerHTML = "";
  const active = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0];
  if (!active) return;
  const url = active.url.split("#")[0];
  for (const a of state.annotations.filter((x) => x.url.split("#")[0] === url)) {
    const pin = document.createElement("div");
    pin.className = "ann-pin" + (a.createdBy === "agent" ? " agent" : "");
    pin.style.left = a.x + "px";
    pin.style.top = a.y + "px";
    pin.style.width = Math.max(a.w, 24) + "px";
    pin.style.height = Math.max(a.h, 24) + "px";
    pin.title = a.comment;
    pin.addEventListener("click", (e) => {
      e.stopPropagation();
      showAnnTip(a);
    });
    layer.appendChild(pin);
  }
}

function showAnnTip(a) {
  const tip = document.createElement("div");
  tip.className = "ann-tip";
  tip.style.left = Math.min(a.x, 1000) + "px";
  tip.style.top = Math.max(a.y - 50, 4) + "px";
  tip.textContent = a.comment;
  const del = document.createElement("span");
  del.className = "c";
  del.textContent = "删除";
  del.addEventListener("click", async () => {
    await api.del("/api/annotation", { id: a.id });
    tip.remove();
    await refreshState();
  });
  tip.appendChild(del);
  $("#annotations-layer").appendChild(tip);
  setTimeout(() => tip.remove(), 12000);
}

function toggleAnnotate() {
  state.annotateMode = !state.annotateMode;
  const btn = $("#btn-annotate");
  if (btn) btn.classList.toggle("active", state.annotateMode);
  void api.post("/api/annotate", { on: state.annotateMode });
  toast(state.annotateMode ? "标注模式：在页面上拖拽框选区域 → 写评论" : "标注模式已关闭", state.annotateMode ? "ok" : undefined);
}

// 截图上的点击（spec #9 用户手动操作；坐标按缩放比换算回原生）
// 点击后自动聚焦底部输入栏：选中字段后直接打字、回车即发送到该字段
let clickMode = false;
$("#shot").addEventListener("click", (e) => {
  if (state.annotateMode) return;
  const rect = e.target.getBoundingClientRect();
  const x = (e.clientX - rect.left) / viewScale;
  const y = (e.clientY - rect.top) / viewScale;
  void api.post("/api/click", { x, y }).then(() => refreshShot());
});
$("#shot").addEventListener("mousemove", (e) => {
  if (state.annotateMode) return;
  const rect = e.target.getBoundingClientRect();
  const x = (e.clientX - rect.left) / viewScale;
  const y = (e.clientY - rect.top) / viewScale;
  $("#shot").title = `点击坐标 (${Math.round(x)}, ${Math.round(y)})`;
  // hover 直通（节流 ~25/s）：注入鼠标移动，页面 hover 效果会随帧流实时显示
  const now = Date.now();
  if (now - lastHoverTs > 40) {
    lastHoverTs = now;
    void api.post("/api/input", { x: Math.round(x), y: Math.round(y) });
  }
});
let lastHoverTs = 0;

// ---- 键盘直通（直接操作页面）----
// 点击页面（截图）后，键盘按键直接转发给内置浏览器当前聚焦的字段：
// 可打印字符走防抖批量 type，功能键（回车/Tab/退格/方向键）走 press。
// 当焦点在底部输入栏/地址栏等输入框内时不拦截，正常输入。
let typeBuffer = "";
let flushTimer = null;
function flushPageType() {
  if (!typeBuffer) return;
  const text = typeBuffer;
  typeBuffer = "";
  void api.post("/api/type", { text }).then(refreshShot);
}
function pressPageKey(key) {
  void api.post("/api/press", { key }).then(refreshShot);
}
window.addEventListener("keydown", (e) => {
  const ae = document.activeElement;
  const inField = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
  if (inField || state.annotateMode || state.iframeMode) return;
  if (e.isComposing || e.keyCode === 229) return; // IME 组合中不转发
  if (e.ctrlKey || e.metaKey || e.altKey) return; // 保留快捷键
  if (e.key.length === 1) {
    typeBuffer += e.key;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushPageType, 120); // 防抖 120ms：打字响应快又不逐键发请求
    e.preventDefault();
    return;
  }
  if (e.key === "Backspace") {
    if (typeBuffer.length > 0) {
      typeBuffer = typeBuffer.slice(0, -1);
    } else {
      pressPageKey("Backspace");
    }
    e.preventDefault();
    return;
  }
  if (["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "Home", "End"].includes(e.key)) {
    if (typeBuffer) flushPageType();
    pressPageKey(e.key);
    e.preventDefault();
    return;
  }
});

// 标注框选（在截图叠加层上拖拽；坐标统一换算为原生坐标系）
let dragging = false, sx = 0, sy = 0;
$("#shot").addEventListener("mousedown", (e) => {
  if (!state.annotateMode) return;
  const rect = e.target.getBoundingClientRect();
  sx = (e.clientX - rect.left) / viewScale;
  sy = (e.clientY - rect.top) / viewScale;
  dragging = true;
  const box = $("#sel-box");
  box.style.display = "block";
  box.style.left = sx + "px";
  box.style.top = sy + "px";
  box.style.width = "0px";
  box.style.height = "0px";
});
$("#shot").addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const rect = e.target.getBoundingClientRect();
  const x = (e.clientX - rect.left) / viewScale, y = (e.clientY - rect.top) / viewScale;
  const box = $("#sel-box");
  box.style.left = Math.min(sx, x) + "px";
  box.style.top = Math.min(sy, y) + "px";
  box.style.width = Math.abs(x - sx) + "px";
  box.style.height = Math.abs(y - sy) + "px";
});
$("#shot").addEventListener("mouseup", (e) => {
  if (!dragging) return;
  dragging = false;
  const rect = e.target.getBoundingClientRect();
  const x = (e.clientX - rect.left) / viewScale, y = (e.clientY - rect.top) / viewScale;
  const box = $("#sel-box");
  box.style.display = "none";
  const w = Math.abs(x - sx), h = Math.abs(y - sy);
  if (w < 8 || h < 8) return;
  showAnnInput(Math.min(sx, x), Math.min(sy, y), w, h);
});

function showAnnInput(x, y, w, h) {
  const box = document.createElement("div");
  box.className = "ann-input";
  box.style.left = Math.min(x, 980) + "px";
  box.style.top = Math.max(y - 100, 4) + "px";
  const ta = document.createElement("textarea");
  ta.placeholder = "给这个区域写评论…";
  const row = document.createElement("div");
  row.className = "row";
  const cancel = document.createElement("button");
  cancel.className = "cancel";
  cancel.textContent = "取消";
  const save = document.createElement("button");
  save.className = "save";
  save.textContent = "保存";
  row.appendChild(cancel);
  row.appendChild(save);
  box.appendChild(ta);
  box.appendChild(row);
  $("#stage").appendChild(box);
  ta.focus();
  cancel.onclick = () => box.remove();
  save.onclick = async () => {
    const comment = ta.value.trim();
    if (!comment) return;
    await api.post("/api/annotation", { x, y, w, h, comment });
    box.remove();
    toast("标注已保存（spec #10）", "ok");
    await refreshState();
  };
}

// ---- 弹窗 ----
function openModal(title, buildBody) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal";
  const h = document.createElement("h3");
  h.textContent = title;
  const body = document.createElement("div");
  body.className = "body";
  buildBody(body, close);
  function close() {
    backdrop.remove();
  }
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  modal.appendChild(h);
  modal.appendChild(body);
  backdrop.appendChild(modal);
  $("#modal-root").appendChild(backdrop);
}

// 历史（spec #11）
$("#btn-history")?.addEventListener("click", () => {
  openModal("浏览历史（独立 profile）", (body, close) => {
    const search = document.createElement("input");
    search.className = "search";
    search.placeholder = "搜索历史…";
    const list = document.createElement("div");
    body.appendChild(search);
    body.appendChild(list);
    const render = async (q) => {
      const entries = await api.get("/api/history" + (q ? `?q=${encodeURIComponent(q)}` : ""));
      list.innerHTML = "";
      if (entries.length === 0) {
        list.innerHTML = '<div class="empty">暂无历史记录</div>';
        return;
      }
      for (const e of entries.slice(0, 50)) {
        const row = document.createElement("div");
        row.className = "row";
        const a = document.createElement("a");
        a.className = "mono";
        a.textContent = `${e.title || e.url}  (${new Date(e.ts).toLocaleString()})`;
        a.style.color = "#0369a1";
        a.style.cursor = "pointer";
        a.style.textDecoration = "none";
        a.addEventListener("click", async () => {
          await api.post("/api/navigate", { url: e.url });
          close();
          await refreshState();
        });
        const del = document.createElement("button");
        del.textContent = "删除";
        del.addEventListener("click", async () => {
          await api.del("/api/history", { id: e.id });
          render(search.value);
        });
        row.appendChild(a);
        row.appendChild(del);
        list.appendChild(row);
      }
    };
    search.addEventListener("input", () => void render(search.value));
    const clear = document.createElement("button");
    clear.className = "danger";
    clear.textContent = "清空历史";
    clear.style.marginTop = "8px";
    clear.addEventListener("click", async () => {
      await api.post("/api/history/clear");
      render("");
    });
    body.appendChild(clear);
    void render("");
  });
});

// 站点权限（spec #6）
$("#btn-sites")?.addEventListener("click", () => {
  openModal("站点权限", (body) => {
    const list = document.createElement("div");
    body.appendChild(list);
    const render = async () => {
      const sites = await api.get("/api/sites");
      list.innerHTML = "";
      if (sites.length === 0) {
        list.innerHTML = '<div class="empty">暂无记录。智能体首次访问新网站时会请求你的授权（spec #6）。</div>';
        return;
      }
      for (const s of sites) {
        const row = document.createElement("div");
        row.className = "row";
        const left = document.createElement("span");
        left.className = "mono";
        left.innerHTML = `${s.host} <span style="color:${s.decision === "allow" ? "#059669" : "#dc2626"}">[${s.decision === "allow" ? "允许" : "阻止"}]</span>`;
        const del = document.createElement("button");
        del.textContent = "移除";
        del.addEventListener("click", async () => {
          await api.del("/api/sites", { host: s.host });
          render();
        });
        row.appendChild(left);
        row.appendChild(del);
        list.appendChild(row);
      }
    };
    void render();
  });
});

// Developer Mode（spec #12）
$("#btn-devmode")?.addEventListener("click", () => {
  openModal("Developer Mode", (body) => {
    const render = () => {
      body.innerHTML = "";
      const row = document.createElement("div");
      row.className = "row";
      const label = document.createElement("span");
      label.textContent = "Developer Mode（full CDP 深度调试）";
      const sw = document.createElement("label");
      sw.className = "switch";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = state.devMode.enabled;
      const slider = document.createElement("span");
      slider.className = "slider";
      sw.appendChild(input);
      sw.appendChild(slider);
      input.addEventListener("change", async () => {
        const res = await api.post("/api/devmode", { enabled: input.checked });
        state.devMode = res;
        renderDevBadge();
        render();
      });
      row.appendChild(label);
      row.appendChild(sw);
      body.appendChild(row);
      const tip = document.createElement("p");
      tip.style.cssText = "font-size:12px;color:var(--muted);margin:8px 0;line-height:1.6";
      tip.textContent = "开启后，Agent 可观察 console / network / runtime errors / 性能；但对每个网站使用 full CDP 时仍会单独请求批准（spec #12）。";
      body.appendChild(tip);
      const hosts = document.createElement("div");
      const ht = document.createElement("p");
      ht.style.cssText = "font-weight:600;margin:8px 0 4px";
      ht.textContent = "已批准 full CDP 的网站";
      hosts.appendChild(ht);
      if (state.devMode.approvedHosts.length === 0) {
        hosts.innerHTML += '<div class="empty">暂无</div>';
      }
      for (const host of state.devMode.approvedHosts) {
        const r2 = document.createElement("div");
        r2.className = "row";
        const l2 = document.createElement("span");
        l2.className = "mono";
        l2.textContent = host;
        const revoke = document.createElement("button");
        revoke.textContent = "撤销";
        revoke.addEventListener("click", async () => {
          await api.del("/api/devmode/host", { host });
          state.devMode.approvedHosts = state.devMode.approvedHosts.filter((h) => h !== host);
          render();
        });
        r2.appendChild(l2);
        r2.appendChild(revoke);
        hosts.appendChild(r2);
      }
      body.appendChild(hosts);
      const clear = document.createElement("button");
      clear.className = "danger";
      clear.textContent = "清除内置浏览器的登录态与站点数据（spec #3 隔离 profile）";
      clear.style.marginTop = "12px";
      clear.addEventListener("click", async () => {
        await api.post("/api/clear-profile");
        toast("已清除隔离 profile 数据", "ok");
      });
      body.appendChild(clear);
    };
    render();
  });
});

// ---- 工具栏 ----
$("#btn-new-tab").addEventListener("click", async () => {
  await api.post("/api/tab/new", {});
  await refreshState();
});
$("#btn-back").addEventListener("click", async () => {
  await api.post("/api/back");
  await refreshState();
});
$("#btn-forward").addEventListener("click", async () => {
  await api.post("/api/forward");
  await refreshState();
});
$("#btn-reload").addEventListener("click", async () => {
  await api.post("/api/reload");
  await refreshState();
});
$("#address").addEventListener("keydown", async (e) => {
  if (e.key === "Enter") {
    const url = $("#address").value.trim();
    if (!url) return;
    await api.post("/api/navigate", { url });
    await refreshState();
  }
});
$("#btn-annotate")?.addEventListener("click", toggleAnnotate);

// ---- 手动输入 / 按键 / 上传 ----
$("#btn-type")?.addEventListener("click", async () => {
  const text = $("#type-input").value;
  if (!text) return;
  await api.post("/api/type", { text });
  $("#type-input").value = "";
  await refreshShot();
});
$("#type-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#btn-type").click();
});
document.querySelectorAll(".key").forEach((btn) => {
  btn.addEventListener("click", async () => {
    await api.post("/api/press", { key: btn.dataset.key });
    await refreshShot();
  });
});
$("#file-input")?.addEventListener("change", async (e) => {
  const files = [...e.target.files];
  if (files.length === 0) return;
  const encoded = await Promise.all(
    files.map(
      (f) =>
        new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({
              name: f.name,
              mimeType: f.type || "application/octet-stream",
              base64: String(reader.result).split(",")[1],
            });
          reader.readAsDataURL(f);
        }),
    ),
  );
  const res = await api.post("/api/upload", { files: encoded });
  toast(res.ok ? "文件已由用户手动提供（spec #8/#9）" : "上传失败：" + (res.error ?? ""), res.ok ? "ok" : "warn");
  e.target.value = "";
});
$("#btn-frame")?.addEventListener("click", () => {
  state.iframeMode = !state.iframeMode;
  $("#stage").classList.toggle("iframe", state.iframeMode);
  const active = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0];
  $("#live-frame").src = state.iframeMode && active ? active.url : "about:blank";
  const btn = $("#btn-frame");
  if (btn) btn.classList.toggle("active", state.iframeMode);
  toast(state.iframeMode ? "iframe 模式：可原生滚动/输入（仅限允许嵌入的站点）" : "已切回截图模式", undefined);
});

// ---- SSE 实时事件（Agent 操作 → 视图同步刷新）----
// 注意：不要因 "shot" 事件刷新截图——视图页自己的截图请求会触发 shot 事件，
// 若响应则形成「截图→事件→再截图」死循环（曾一次堆积数万张 PNG）。
// 截图仅在导航/标签状态变化时刷新（带 noevent，宿主重启后生效）。
function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = async (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === "state" || data.type === "navigated") {
        await refreshState();
      }
      if (data.type === "annotation") {
        toast(`📌 收到标注：「${data.annotation.comment}」`, "ok");
      }
      if (data.type === "upload-blocked") {
        toast("页面要求上传文件：内置浏览器不能自动上传，请用下方「上传文件」手动选择（spec #8）", "warn");
      }
    } catch {
      /* ignore */
    }
  };
}

// ---- 启动 ----
refreshState().then(() => {
  connectEvents();
  // 外部模式：面板 iframe 即实时视图，不需要截图帧流
  if (!state.external) connectStream();
}).catch((err) => toast("加载失败：" + err.message, "warn"));
