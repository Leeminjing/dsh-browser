// ============================================================================
// dsh-browser 客户端半边（浏览器面板）
// 通过 ModuleLoader 以 CJS factory 加载：
//   - 会话头部动作区注入「🌐 浏览器」切换按钮
//   - shell.overlay 注入可停靠、可拖拽伸缩的浏览器分栏（与聊天同一页面）
// 拖拽用 Pointer Events + setPointerCapture：指针划过 iframe 也不会丢事件。
// 面板内容全部来自共享视图服务（:9333）。
// ============================================================================

window.__ModuleLoader__.load({
  id: "dsh-browser",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");

    // 共享视图地址：默认 127.0.0.1:9333（与宿主 apply 的 DSH_BROWSER_VIEW_PORT 一致）
    var VIEW_URL = "http://127.0.0.1:9333/";

    var TOGGLE_EVENT = "dsh-browser:toggle";
    var WIDTH_KEY = "dsh-browser.panel.width";

    // 面板宽度范围（占视口比例）
    var MIN_W = 0.24;
    var MAX_W = 0.76;
    var DEFAULT_W = 0.5;
    // 对话区最小保留宽度（px）：面板再宽也不能把聊天挤没
    var CHAT_MIN_PX = 360;

    /** 对话区根元素：`[data-conversation-scroll]` 的父节点（DSH 会话布局根，占满内容区宽度） */
    function chatRootEl() {
      var nodes = document.querySelectorAll("[data-conversation-scroll]");
      for (var i = 0; i < nodes.length; i++) {
        var p = nodes[i].parentElement;
        if (p && p.getClientRects().length > 0) return p;
      }
      return nodes.length ? nodes[0].parentElement : null;
    }

    /** 面板容器的真实 DOM 节点（用于设置共享 CSS 变量） */
    function panelWrapEl() {
      return document.querySelector("[data-dsh-browser-panel]");
    }

    /** 面板实际像素宽度：与面板 `min-width: 320px` 保持一致，避免分隔条被 iframe 盖住 */
    function panelWidthPx(ratio) {
      return Math.max(Math.round(ratio * window.innerWidth), 320);
    }

    /**
     * 让对话区与面板联动伸缩：面板占据视口右侧 ratio 比例（右停靠）。
     * 用同一个 `--dsh-browser-panel-px` 变量驱动：面板宽度 / 分隔条位置 / 对话区 margin-right，
     * 三者永远精确对齐；窗口 resize 时只需重新计算该变量，无需 React 重渲染。
     */
    function applyChatWidth(ratio) {
      var panelPx = panelWidthPx(ratio);
      var wrap = panelWrapEl();
      if (wrap) wrap.style.setProperty("--dsh-browser-panel-px", panelPx + "px");
      var root = chatRootEl();
      if (root) root.style.marginRight = panelPx + "px";
    }
    function clearChatWidth() {
      var wrap = panelWrapEl();
      if (wrap) wrap.style.removeProperty("--dsh-browser-panel-px");
      var root = chatRootEl();
      if (root) root.style.removeProperty("margin-right");
    }

    /** 有效面板宽度比例：同时约束面板下限（MIN_W）与对话区最小可见宽度（CHAT_MIN_PX） */
    function effectiveWidth(w) {
      var root = chatRootEl();
      var parentW = window.innerWidth;
      if (root && root.parentElement) {
        // 对话区根节点的直接父级可能是 0 宽度的布局包裹层（不可见），
        // 必须向上找第一个可见的祖先容器来测量可用宽度
        var el = root.parentElement;
        while (el && el !== document.body) {
          var r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            parentW = r.width;
            break;
          }
          el = el.parentElement;
        }
      }
      var maxPanelPx = Math.max(0, parentW - CHAT_MIN_PX);
      var maxW = Math.min(MAX_W, maxPanelPx / window.innerWidth);
      var candidate = Math.max(MIN_W, Math.min(maxW, w));
      return Math.min(MAX_W, candidate);
    }
    function clampW(w) {
      return effectiveWidth(w);
    }
    function loadWidth() {
      try {
        var v = parseFloat(window.localStorage.getItem(WIDTH_KEY) || "");
        if (!isNaN(v) && v >= MIN_W && v <= MAX_W) return clampW(v);
      } catch (e) {}
      return DEFAULT_W;
    }
    function saveWidth(w) {
      try {
        window.localStorage.setItem(WIDTH_KEY, String(w));
      } catch (e) {}
    }

    /**
     * 浏览器分栏：右侧停靠，左侧边缘为可拖拽分隔条。
     * 覆盖层本身 pointer-events:none，只有面板与分隔条可交互 → 聊天区
     * 其余部分始终可用；拖动分隔条即可伸缩「聊天 / 共享视图」宽度。
     */
    function BrowserPanel() {
      var openState = react.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var openRef = react.useRef(open);
      openRef.current = open;
      /** 打开面板的归属会话：切到其它会话时自动收起（跨会话隔离） */
      var ownerRef = react.useRef(null);
      var widthState = react.useState(loadWidth);
      var width = widthState[0];
      var setWidth = widthState[1];
      var widthRef = react.useRef(width);
      widthRef.current = width;
      var dragRef = react.useRef(null);
      var [dragging, setDragging] = react.useState(false);

      react.useEffect(function () {
        // 头部按钮点击：开合面板，并记录归属会话（打开时）
        var onToggle = function (e) {
          var sid = (e && e.detail && e.detail.sessionId) || null;
          setOpen(function (o) {
            var next = !o;
            ownerRef.current = next ? sid : null;
            return next;
          });
        };
        // 会话级监听器（自动弹出）：打开面板并记录归属会话
        var onShow = function (e) {
          ownerRef.current = (e && e.detail && e.detail.sessionId) || null;
          setOpen(true);
        };
        // 会话切换：当激活的会话与面板归属会话不一致时，自动收起（跨会话隔离）
        var onSessionActive = function (e) {
          var sid = e && e.detail ? e.detail.sessionId : null;
          if (openRef.current && sid && sid !== ownerRef.current) {
            ownerRef.current = null;
            setOpen(false);
          }
        };
        window.addEventListener(TOGGLE_EVENT, onToggle);
        window.addEventListener("dsh-browser:show", onShow);
        window.addEventListener("dsh-browser:session-active", onSessionActive);
        return function () {
          window.removeEventListener(TOGGLE_EVENT, onToggle);
          window.removeEventListener("dsh-browser:show", onShow);
          window.removeEventListener("dsh-browser:session-active", onSessionActive);
        };
      }, []);

      // 对话区与面板联动伸缩：打开时压缩对话列宽（含消息列与输入框），关闭/卸载时恢复
      react.useEffect(function () {
        if (!open) {
          clearChatWidth();
          return undefined;
        }
        applyChatWidth(widthRef.current);
        var lastRoot = chatRootEl();
        var onResize = function () { applyChatWidth(widthRef.current); };
        window.addEventListener("resize", onResize);
        var mo = null;
        if (window.MutationObserver) {
          mo = new window.MutationObserver(function () {
            var root = chatRootEl();
            if (root && root !== lastRoot) {
              lastRoot = root;
              applyChatWidth(widthRef.current);
            }
          });
          mo.observe(document.body, { childList: true, subtree: true });
        }
        return function () {
          window.removeEventListener("resize", onResize);
          if (mo) mo.disconnect();
          clearChatWidth();
        };
      }, [open]);

      // 面板宽度变化时实时同步对话区宽度
      react.useEffect(function () {
        if (!open) return undefined;
        applyChatWidth(width);
      }, [open, width]);

      // ---- 拖拽分隔条 ----
      // 处理器只创建一次（挂在 ref 上，避免 re-render 导致 window 监听器身份失配）。
      // 拖拽期间同时监听 window 级 pointermove/pointerup：指针划过 iframe（capture 重定向）
      // 或聊天区（window 监听）都不会丢事件；即使 setPointerCapture 失败也能正常拖。
      var dragHandlersRef = react.useRef(null);
      if (!dragHandlersRef.current) {
        dragHandlersRef.current = {
          move: function (e) {
            if (!dragRef.current) return;
            var dx = e.clientX - dragRef.current.startX;
            var w = clampW(dragRef.current.startW - dx / window.innerWidth);
            widthRef.current = w;
            setWidth(w);
            applyChatWidth(w);
          },
          end: function () {
            window.removeEventListener("pointermove", dragHandlersRef.current.move);
            window.removeEventListener("pointerup", dragHandlersRef.current.end);
            window.removeEventListener("pointercancel", dragHandlersRef.current.end);
            if (!dragRef.current) return;
            dragRef.current = null;
            setDragging(false);
            saveWidth(widthRef.current);
          },
        };
      }
      var onDividerPointerDown = function (e) {
        e.preventDefault();
        dragRef.current = { startX: e.clientX, startW: widthRef.current };
        setDragging(true);
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
        window.addEventListener("pointermove", dragHandlersRef.current.move);
        window.addEventListener("pointerup", dragHandlersRef.current.end);
        window.addEventListener("pointercancel", dragHandlersRef.current.end);
      };

      if (!open) return null;

      var wPct = (width * 100).toFixed(1) + "%";

      return react.createElement(
        "div",
        { "data-dsh-browser-panel": "", style: { position: "fixed", inset: "0", zIndex: 2147483600, pointerEvents: "none" } },
        // 拖拽分隔条（聊天与共享视图之间的可伸缩边界）
        // 命中区 30px 宽、以面板真实左缘（--dsh-browser-panel-px）为中心：
        // 左半 15px 完全落在聊天区一侧（不会被面板内 iframe 截获），右半压住面板边缘
        react.createElement("div", {
          onPointerDown: onDividerPointerDown,
          onPointerMove: dragHandlersRef.current.move,
          onPointerUp: dragHandlersRef.current.end,
          onPointerCancel: dragHandlersRef.current.end,
          title: "拖动调整聊天 / 浏览器宽度",
          style: {
            position: "absolute",
            left: "calc(100% - var(--dsh-browser-panel-px, 50%))",
            top: "0",
            bottom: "0",
            width: "30px",
            transform: "translateX(-50%)",
            cursor: "col-resize",
            pointerEvents: "auto",
            zIndex: 1,
            touchAction: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          },
        }, react.createElement("div", {
          style: {
            width: "4px",
            height: dragging ? "40%" : "72px",
            borderRadius: "4px",
            background: dragging ? "#4d6bfe" : "rgba(28,36,51,.16)",
            transition: "height .12s, background .12s",
            boxShadow: "0 0 0 1px rgba(255,255,255,.6)",
          },
        })),
        react.createElement(
          "div",
          {
            style: {
              position: "absolute",
              right: "0",
              top: "0",
              bottom: "0",
              width: "var(--dsh-browser-panel-px, " + wPct + ")",
              minWidth: "320px",
              background: "#fff",
              boxShadow: "-10px 0 32px rgba(15,23,42,.18)",
              pointerEvents: "auto",
              display: "flex",
              flexDirection: "column",
              fontFamily: "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
            },
          },
          react.createElement(
            "div",
            {
              style: {
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "7px 12px", background: "#f8fafc", color: "#1c2433",
                borderBottom: "1px solid #e4e8ef",
                fontSize: 13, fontWeight: 600, flexShrink: 0, gap: 8,
              },
            },
            react.createElement(
              "span",
              { style: { whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 6 } },
              react.createElement("span", { style: { fontSize: 14 } }, "🌐"),
              "内置浏览器（共享视图）",
            ),
            react.createElement(
              "div",
              { style: { display: "flex", gap: 6, alignItems: "center" } },
              react.createElement(
                "a",
                {
                  href: VIEW_URL,
                  target: "_blank",
                  rel: "noreferrer",
                  style: {
                    background: "#eef1f6", color: "#4d6bfe", textDecoration: "none",
                    borderRadius: 6, padding: "3px 9px", fontSize: 12, cursor: "pointer",
                    border: "1px solid #e4e8ef", transition: "background .12s",
                  },
                  onMouseEnter: function (e) { e.currentTarget.style.background = "#e3e8f2"; },
                  onMouseLeave: function (e) { e.currentTarget.style.background = "#eef1f6"; },
                },
                "新窗口",
              ),
              react.createElement(
                "button",
                {
                  onClick: function () { ownerRef.current = null; setOpen(false); },
                  title: "收起",
                  style: {
                    background: "#eef1f6", border: "1px solid #e4e8ef", color: "#5b6474",
                    borderRadius: 6, padding: "3px 9px", cursor: "pointer", fontSize: 12,
                    transition: "background .12s",
                  },
                  onMouseEnter: function (e) { e.currentTarget.style.background = "#e3e8f2"; },
                  onMouseLeave: function (e) { e.currentTarget.style.background = "#eef1f6"; },
                },
                "收起",
              ),
            ),
          ),
          react.createElement("iframe", {
            src: VIEW_URL,
            style: { flex: "1", border: "0", width: "100%", minHeight: "0" },
            title: "内置浏览器（共享视图）",
          }),
        ),
      );
    }

    /** 会话头部动作区按钮：点击开合面板；同时作为本会话的自动弹出监听器 */
    function BrowserToggle(props) {
      var sessionId = props && props.sessionId ? String(props.sessionId) : "";

      // 跨会话隔离：本组件挂在会话级插槽（header.actions），props.sessionId 即当前会话 id。
      // 1) 挂载/会话切换时广播 dsh-browser:session-active，全局面板据此在切会话时自动收起；
      // 2) 注入隐藏 iframe 加载监听页并带上 ?session=，视图服务器只向该会话转发匹配的导航事件，
      //    收到后派发带会话 id 的 dsh-browser:show，面板只在归属会话打开。
      react.useEffect(function () {
        if (!sessionId) return undefined;
        window.dispatchEvent(new CustomEvent("dsh-browser:session-active", { detail: { sessionId } }));
        var VIEW_ORIGIN = VIEW_URL;
        try {
          VIEW_ORIGIN = new URL(VIEW_URL).origin;
        } catch (e) {}
        var frame = null;
        var onMessage = function (ev) {
          if (!ev || !ev.data || ev.data.type !== "dsh-browser:show") return;
          if (typeof ev.origin === "string" && ev.origin !== VIEW_ORIGIN) return;
          window.dispatchEvent(new CustomEvent("dsh-browser:show", { detail: { sessionId } }));
        };
        window.addEventListener("message", onMessage);
        try {
          frame = document.createElement("iframe");
          frame.src = VIEW_URL + "demo/watch.html?session=" + encodeURIComponent(sessionId);
          frame.setAttribute("style", "display:none;width:0;height:0;border:0");
          frame.setAttribute("title", "dsh-browser watch");
          document.body.appendChild(frame);
        } catch (e) {
          frame = null;
        }
        return function () {
          window.removeEventListener("message", onMessage);
          if (frame) {
            try { frame.remove(); } catch (e) {}
            frame = null;
          }
        };
      }, [sessionId]);

      return react.createElement(
        "button",
        {
          onClick: function () {
            window.dispatchEvent(new CustomEvent(TOGGLE_EVENT, { detail: { sessionId } }));
          },
          title: "打开/收起内置浏览器共享视图（聊天与视图宽度可拖动伸缩）",
          style: {
            display: "inline-flex", alignItems: "center", gap: 4,
            border: "1px solid var(--dsw-alias-border-l2, #e2e8f0)",
            background: "var(--dsw-alias-fill-l2, #f8fafc)",
            color: "var(--dsw-alias-label-primary, #0f172a)",
            borderRadius: 8, padding: "3px 9px", fontSize: 12, cursor: "pointer",
          },
        },
        react.createElement("span", { style: { fontSize: 14 } }, "🌐"),
        react.createElement("span", null, "浏览器"),
      );
    }

    /** 客户端插件主体：注入头部按钮 + 可伸缩共享视图分栏 */
    function apply(ctx) {
      ctx.slots.inject("conversation.session.header.actions", function () {
        return ctx.slots.register(
          { name: "conversation.session.header.actions", id: "dsh-browser-toggle", order: 15 },
          BrowserToggle,
        );
      });
      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register(
          { name: "shell.overlay", id: "dsh-browser-panel", order: 10 },
          BrowserPanel,
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
