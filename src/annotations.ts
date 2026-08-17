// ============================================================================
// 页面标注（spec #10）：注入 overlay 到目标页面，用户框选区域写评论；
// 评论经页面 console（[cb-ann] 前缀）上报，由 manager 捕获解析。
// ============================================================================

import type { Annotation } from "./stores.js";

export const ANN_PREFIX = "[cb-ann]";

export function parseAnnotationPayload(
  message: string,
  urlOfPage: string,
): Omit<Annotation, "id" | "ts"> | null {
  if (!message.startsWith(ANN_PREFIX)) return null;
  try {
    const data = JSON.parse(message.slice(ANN_PREFIX.length));
    if (
      typeof data.url === "string" &&
      typeof data.comment === "string" &&
      typeof data.x === "number"
    ) {
      return {
        url: data.url || urlOfPage,
        host: safeHost(data.url || urlOfPage),
        x: data.x,
        y: data.y,
        w: data.w ?? 0,
        h: data.h ?? 0,
        comment: data.comment,
        createdBy: "user",
      };
    }
  } catch {
    /* 忽略非 JSON */
  }
  return null;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function buildOverlayScript(annotations: Annotation[]): string {
  const serialized = JSON.stringify(
    annotations.map((a) => ({ id: a.id, x: a.x, y: a.y, w: a.w, h: a.h, comment: a.comment })),
  );
  return OVERLAY_SCRIPT.replace("__CB_ANNOTATIONS__", serialized);
}

export function buildOverlayExitScript(): string {
  return `window.dispatchEvent(new CustomEvent('cb-exit-annotations'))`;
}

const OVERLAY_SCRIPT = `
(function () {
  if (window.__cbAnnotationOverlay) return;
  window.__cbAnnotationOverlay = true;

  const ANN_PREFIX = "[cb-ann]";
  const EXISTING = __CB_ANNOTATIONS__;

  const css = (el, s) => Object.assign(el.style, s);
  const make = (tag, cls, parent) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (parent) parent.appendChild(el);
    return el;
  };

  const bar = make("div", "cb-ann-bar");
  css(bar, {
    position: "fixed", top: "12px", right: "12px", zIndex: "2147483647",
    background: "rgba(15,23,42,.92)", color: "#fff", borderRadius: "10px",
    padding: "6px 10px", font: "13px/1.5 system-ui, sans-serif",
    boxShadow: "0 8px 24px rgba(0,0,0,.25)", display: "flex", gap: "8px",
    alignItems: "center", userSelect: "none",
  });
  const title = make("span", null, bar);
  title.textContent = "标注模式";
  const hint = make("span", null, bar);
  css(hint, { opacity: ".75", fontSize: "11px" });
  hint.textContent = "在页面上拖拽框选，然后写评论";
  const exitBtn = make("button", null, bar);
  css(exitBtn, {
    border: "0", background: "rgba(255,255,255,.15)", color: "#fff",
    borderRadius: "6px", padding: "3px 10px", cursor: "pointer",
  });
  exitBtn.textContent = "退出标注";
  document.documentElement.appendChild(bar);

  const canvas = make("div", "cb-ann-canvas");
  css(canvas, { position: "fixed", inset: "0", zIndex: "2147483646", pointerEvents: "none" });
  document.documentElement.appendChild(canvas);

  EXISTING.forEach((a) => {
    const pin = make("div", "cb-ann-pin");
    css(pin, {
      position: "absolute", left: a.x + "px", top: a.y + "px",
      width: Math.max(a.w, 24) + "px", height: Math.max(a.h, 24) + "px",
      border: "2px solid #0ea5e9", background: "rgba(14,165,233,.18)",
      borderRadius: "4px", cursor: "pointer", boxSizing: "border-box",
    });
    pin.title = a.comment;
    pin.addEventListener("click", (e) => {
      e.stopPropagation();
      showComment(a.comment, a.x, a.y);
    });
    canvas.appendChild(pin);
  });

  function showComment(text, x, y) {
    const box = make("div", "cb-ann-comment");
    css(box, {
      position: "fixed", left: Math.min(x, window.innerWidth - 260) + "px",
      top: Math.max(y - 60, 8) + "px", width: "240px", zIndex: "2147483647",
      background: "#0f172a", color: "#fff", borderRadius: "10px",
      padding: "10px 12px", font: "13px/1.5 system-ui, sans-serif",
      boxShadow: "0 12px 32px rgba(0,0,0,.35)", wordBreak: "break-word",
    });
    const p = make("div", null, box);
    p.textContent = text;
    const close = make("button", null, box);
    css(close, { marginTop: "8px", border: "0", background: "rgba(255,255,255,.15)", color: "#fff", borderRadius: "6px", padding: "3px 10px", cursor: "pointer" });
    close.textContent = "关闭";
    close.onclick = () => box.remove();
    document.documentElement.appendChild(box);
    setTimeout(() => { try { box.remove(); } catch {} }, 15000);
  }

  let dragging = false, startX = 0, startY = 0, sel = null, active = false;

  function begin() {
    active = true;
    canvas.style.pointerEvents = "auto";
    hint.textContent = "拖拽框选区域 → 写评论";
  }

  document.addEventListener("mousedown", (e) => {
    if (!active) return;
    if (e.target === canvas || e.target.classList?.contains("cb-ann-pin")) return;
    if (e.target.closest && e.target.closest(".cb-ann-bar, .cb-ann-comment, .cb-ann-input-box")) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    sel = make("div", "cb-ann-sel");
    css(sel, {
      position: "fixed", border: "2px dashed #0ea5e9", background: "rgba(14,165,233,.12)",
      zIndex: "2147483646", pointerEvents: "none", borderRadius: "4px",
    });
    canvas.appendChild(sel);
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging || !sel) return;
    const x = Math.min(startX, e.clientX), y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX), h = Math.abs(e.clientY - startY);
    Object.assign(sel.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
  });
  document.addEventListener("mouseup", (e) => {
    if (!dragging || !sel) { dragging = false; return; }
    dragging = false;
    const x = Math.min(startX, e.clientX), y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX), h = Math.abs(e.clientY - startY);
    sel.remove(); sel = null;
    if (w < 8 || h < 8) return;
    showInput(x, y, w, h);
  });

  function showInput(x, y, w, h) {
    const box = make("div", "cb-ann-input-box");
    css(box, {
      position: "fixed", left: Math.min(x, window.innerWidth - 280) + "px",
      top: Math.max(y - 90, 8) + "px", width: "260px", zIndex: "2147483647",
      background: "#ffffff", color: "#0f172a", borderRadius: "12px",
      padding: "12px", font: "13px/1.5 system-ui, sans-serif",
      boxShadow: "0 16px 40px rgba(0,0,0,.3)", border: "1px solid #e2e8f0",
    });
    const label = make("div", null, box);
    css(label, { fontWeight: "600", marginBottom: "6px" });
    label.textContent = "给这个区域写评论";
    const ta = make("textarea", null, box);
    css(ta, {
      width: "100%", boxSizing: "border-box", minHeight: "64px", border: "1px solid #cbd5e1",
      borderRadius: "8px", padding: "8px", font: "13px system-ui, sans-serif", resize: "vertical",
    });
    ta.placeholder = "例如：这个按钮点击后没有反应";
    ta.focus();
    const row = make("div", null, box);
    css(row, { display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "8px" });
    const cancel = make("button", null, row);
    css(cancel, { border: "0", background: "#f1f5f9", color: "#334155", borderRadius: "8px", padding: "5px 12px", cursor: "pointer" });
    cancel.textContent = "取消";
    const save = make("button", null, row);
    css(save, { border: "0", background: "#0d9488", color: "#fff", borderRadius: "8px", padding: "5px 12px", cursor: "pointer", fontWeight: "600" });
    save.textContent = "保存";
    cancel.onclick = () => box.remove();
    save.onclick = () => {
      const comment = ta.value.trim();
      if (!comment) { ta.focus(); return; }
      try {
        console.debug(ANN_PREFIX + JSON.stringify({ url: location.href, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), comment }));
      } catch (err) {
        console.debug(ANN_PREFIX + JSON.stringify({ url: location.href, x: 0, y: 0, w: 0, h: 0, comment: "（位置记录失败）" + comment }));
      }
      box.remove();
      active = false;
      hint.textContent = "在页面上拖拽框选，然后写评论";
      canvas.style.pointerEvents = "none";
    };
  }

  exitBtn.onclick = () => teardown();
  window.addEventListener("cb-exit-annotations", () => teardown());
  function teardown() {
    bar.remove();
    canvas.remove();
    active = false;
    try { window.__cbAnnotationOverlay = false; } catch {}
  }

  begin();
})();
`;
