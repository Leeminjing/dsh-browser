// ============================================================================
// Browser 工具注册（defineTool）：全部 13 条 spec 的可观察行为。
// 门控：站点权限 / 高风险确认 / 历史授权 / Developer Mode + full CDP。
// ============================================================================

import { defineTool, type ParameterSchemaSpec, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { BrowserManager } from "./manager.js";
import type { Gates } from "./gates.js";

export interface BrowserToolsDeps {
  manager: BrowserManager;
  gates: Gates;
  /** 共享视图服务基地址（用于绝对链接与截图 URL） */
  viewBase: string;
  /** 共享视图 URL 文本（供 open_view / navigate 使用） */
  viewUrlText: string;
}

type Renderable = { text: string };

interface ToolSpec {
  name: string;
  description: string;
  parameters: ParameterSchemaSpec;
  timeoutMs?: number;
  execute: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<Renderable>;
}

function buildTool(spec: ToolSpec) {
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string", required: true } },
      },
      render: (_args: unknown, value: Renderable) => [{ type: "text", text: value.text }],
    },
    timeoutMs: spec.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args: unknown, exec: ToolRunContext) {
      return spec.execute((args ?? {}) as Record<string, unknown>, exec);
    },
  });
}

export type ToolRegistrar = (tool: ReturnType<typeof defineTool>) => void;

/** 注册全部 browser_* 工具 */
export function applyBrowserTools(register: ToolRegistrar, deps: BrowserToolsDeps): void {
  const { manager, gates, viewBase } = deps;

  const hostOf = (url: string): string => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  };

  const normalizeUrl = (raw: string): string => {
    let url = raw.trim();
    if (!/^(https?|file):/i.test(url)) {
      if (/^localhost[:/]|^127\.|^\[::1\]/.test(url) || /^\d+\.\d+\.\d+\.\d+/.test(url)) {
        url = "http://" + url;
      } else {
        throw new Error(`无效的 URL: ${raw}`);
      }
    }
    return url;
  };

  const siteGate = async (exec: ToolRunContext): Promise<void> => {
    const r = await gates.ensureCurrentSiteAccess(exec.agent, exec.signal);
    if (r === "blocked") throw new Error("该网站已被阻止访问");
    if (r === "cancelled") throw new Error("未获得网站访问授权");
  };

  const fileUploadGuard = (type: string | undefined): void => {
    if (type === "file") {
      throw new Error(
        "网页要求上传文件，但内置浏览器不能自动完成文件上传（spec #8）。请用户手动上传，或改用其他工作流。",
      );
    }
  };

  const activeTabId = async (exec: ToolRunContext): Promise<string> => {
    // 记录本次浏览器操作归属的会话（用于把导航事件跨会话隔离，只弹对应会话的面板）
    manager.setActorSession(exec.agent?.id ?? "");
    await manager.ensure();
    const tab = manager.active();
    return tab ? tab.id : "";
  };

  // ---- 打开共享视图（spec #2）----
  register(
    buildTool({
      name: "browser_open_view",
      description:
        "返回内置浏览器共享视图的链接（用户可直接打开查看/操作同一页面；页面与 Agent 所见一致）。",
      parameters: {},
      execute: async () => ({
        text: `🔗 内置浏览器共享视图：**${deps.viewUrlText}**\n\n在浏览器中打开此地址即可实时看到并操作 Agent 正在使用的页面（同一内置浏览器，独立 profile）。`,
      }),
    }),
  );

  // ---- 导航（spec #4 / #5 HTTP 验证 / #6 权限 / #7 风险）----
  register(
    buildTool({
      name: "browser_navigate",
      description:
        "在内置浏览器中打开 URL（本地开发地址、file 页面或公开网页）。首次访问新网站会请求用户授权（spec #6）；敏感页面会请求确认（spec #7）。打开后用户可在共享视图实时看到。",
      parameters: {
        url: { type: "string", required: true, description: "完整 URL，如 http://localhost:3000 或 https://example.com" },
      },
      timeoutMs: 120_000,
      execute: async (args, exec) => {
        const url = normalizeUrl(String(args.url ?? ""));
        const host = hostOf(url);
        if (host) {
          const r = await gates.ensureSiteAccess(host, url, "navigation", exec.agent, exec.signal);
          if (r === "blocked") throw new Error(`该网站已被阻止访问: ${host}`);
          if (r === "cancelled") throw new Error("未获得网站访问授权");
        }
        const risk = await gates.guardRisk({ kind: "navigate", url }, host, url, exec.agent, exec.signal);
        if (!risk.ok) throw new Error(risk.reason);

        const tabId = await activeTabId(exec);
        const res = await manager.navigateTo(tabId, url);
        const statusLine = res.httpStatus ? `HTTP 验证返回 \`${res.httpStatus}\`` : "页面加载完成";
        return {
          text: `✅ 已在内置浏览器中打开：\n\n${res.url}\n\n${statusLine}${res.verified === false ? "（⚠️ 返回异常状态码）" : ""}\n\n共享视图：${deps.viewUrlText}`,
        };
      },
    }),
  );

  // ---- 点击（spec #5 / #7 / #8）----
  register(
    buildTool({
      name: "browser_click",
      description:
        "点击当前页面中的元素（按文字 / label / name / href 定位）。提交、购买、删除等敏感动作会请求用户确认（spec #7）。文件上传控件无法自动点击（spec #8）。",
      parameters: {
        query: { type: "string", required: true, description: "元素文字 / aria-label / name / id / href" },
      },
      execute: async (args, exec) => {
        await siteGate(exec);
        const query = String(args.query ?? "");
        const el = await manager.findElement("", query);
        if (!el) throw new Error(`页面上找不到可点击元素: ${query}`);
        fileUploadGuard(el.type);
        const tabId = await activeTabId(exec);
        const tab = manager.getTab(tabId);
        const host = hostOf(tab?.url ?? "");
        const risk = await gates.guardRisk(
          { kind: "click", elementText: el.text || el.name, element: { tag: el.tag, type: el.type, href: el.href } },
          host,
          tab?.url ?? "",
          exec.agent,
          exec.signal,
        );
        if (!risk.ok) throw new Error(risk.reason);
        const clicked = await manager.click(tabId, query);
        return { text: `已点击「${clicked.text || query}」。` };
      },
    }),
  );

  // ---- 输入（spec #5 / #8）----
  register(
    buildTool({
      name: "browser_type",
      description:
        "在页面输入框中输入文本（按 placeholder / label / name / id 定位；query 为 * 时聚焦第一个输入框）。文件上传控件无法自动填写（spec #8）。",
      parameters: {
        query: { type: "string", required: true, description: "输入框的 placeholder / label / name / id，或 * 表示第一个输入框" },
        text: { type: "string", required: true, description: "要输入的文本" },
      },
      execute: async (args, exec) => {
        await siteGate(exec);
        const query = String(args.query ?? "");
        const text = String(args.text ?? "");
        const el = await manager.findElement("", query);
        fileUploadGuard(el?.type);
        const tabId = await activeTabId(exec);
        await manager.type(tabId, query, text);
        return { text: `已在「${query === "*" ? "第一个输入框" : query}」输入：${text}` };
      },
    }),
  );

  // ---- 按键 ----
  register(
    buildTool({
      name: "browser_press",
      description: "发送键盘按键，如 Enter / Tab / Escape / ArrowDown。",
      parameters: {
        key: { type: "string", required: true, description: "按键名" },
      },
      execute: async (args, exec) => {
        await siteGate(exec);
        await manager.press(await activeTabId(exec), String(args.key ?? "Enter"));
        return { text: `已按键 ${args.key ?? "Enter"}。` };
      },
    }),
  );

  // ---- 等待 ----
  register(
    buildTool({
      name: "browser_wait",
      description: "等待指定毫秒（页面加载 / 动画 / 请求完成）。",
      parameters: {
        ms: { type: "number", required: true, description: "毫秒" },
      },
      timeoutMs: 120_000,
      execute: async (args) => {
        const ms = Math.min(Number(args.ms ?? 1000), 120_000);
        await new Promise((r) => setTimeout(r, ms));
        return { text: `已等待 ${ms}ms。` };
      },
    }),
  );

  // ---- 观察（spec #5 检查渲染状态）----
  register(
    buildTool({
      name: "browser_observe",
      description:
        "读取当前页面的渲染状态：URL、标题、正文文本与可交互元素列表（含坐标）。每个操作后都应观察验证（spec #5）。",
      parameters: {},
      execute: async (_args, exec) => {
        await siteGate(exec);
        const snap = await manager.snapshot(await activeTabId(exec));
        const els = snap.elements
          .slice(0, 15)
          .map((e) => `- [${e.index}] <${e.tag}>${e.type ? ` type=${e.type}` : ""}「${(e.text || e.name || "").slice(0, 40)}」`)
          .join("\n");
        return {
          text: `**当前页面状态**（${snap.url}）\n\n标题：${snap.title}\n\n正文摘要：\n${snap.text.slice(0, 300) || "（无文本）"}\n\n可交互元素：\n${els || "（无）"}`,
        };
      },
    }),
  );

  // ---- 截图（spec #5/#13 验证与最终状态）----
  register(
    buildTool({
      name: "browser_screenshot",
      description: "截取当前页面（共享视图与对话中均可见），用于验证操作结果与保留最终页面状态。",
      parameters: {},
      execute: async (_args, exec) => {
        await siteGate(exec);
        const shot = await manager.screenshot(await activeTabId(exec));
        return {
          text: `📸 当前页面截图：\n\n![内置浏览器截图](${viewBase}${shot.url})\n\n这是当前渲染状态；任务结束时页面会保留在浏览器中供你检查（spec #13）。`,
        };
      },
    }),
  );

  // ---- 后退/前进/刷新 ----
  register(
    buildTool({
      name: "browser_back",
      description: "浏览器后退。",
      parameters: {},
      execute: async (_args, exec) => {
        await siteGate(exec);
        manager.goBack(await activeTabId(exec));
        return { text: "已后退。" };
      },
    }),
  );
  register(
    buildTool({
      name: "browser_forward",
      description: "浏览器前进。",
      parameters: {},
      execute: async (_args, exec) => {
        await siteGate(exec);
        manager.goForward(await activeTabId(exec));
        return { text: "已前进。" };
      },
    }),
  );
  register(
    buildTool({
      name: "browser_reload",
      description: "刷新当前页面（修改代码后验证 bug 是否消失，spec #5）。",
      parameters: {},
      execute: async (_args, exec) => {
        await siteGate(exec);
        manager.reload(await activeTabId(exec));
        return { text: "已刷新页面。刷新后用 browser_observe / browser_screenshot 验证效果。" };
      },
    }),
  );

  // ---- 标签页 ----
  register(
    buildTool({
      name: "browser_new_tab",
      description: "新建一个内置浏览器标签页（共享同一独立 profile）。",
      parameters: {
        url: { type: "string", description: "可选，初始 URL" },
      },
      timeoutMs: 120_000,
      execute: async (args, exec) => {
        const url = args.url ? normalizeUrl(String(args.url)) : undefined;
        if (url) {
          const host = hostOf(url);
          const r = await gates.ensureSiteAccess(host, url, "navigation", exec.agent, exec.signal);
          if (r !== "ok") throw new Error(r === "blocked" ? "该网站已被阻止访问" : "未获得网站访问授权");
        }
        manager.setActorSession(exec.agent?.id ?? "");
        const tabId = await manager.newTab(url);
        return { text: `已新建标签页 ${tabId}${url ? `：${url}` : ""}。` };
      },
    }),
  );
  register(
    buildTool({
      name: "browser_switch_tab",
      description: "切换到指定标签页。",
      parameters: {
        tabId: { type: "string", required: true },
      },
      execute: async (args) => {
        manager.setActive(String(args.tabId));
        return { text: `已切换到 ${args.tabId}。` };
      },
    }),
  );
  register(
    buildTool({
      name: "browser_close_tab",
      description: "关闭指定标签页。",
      parameters: {
        tabId: { type: "string", required: true },
      },
      execute: async (args) => {
        await manager.closeTab(String(args.tabId));
        return { text: `已关闭 ${args.tabId}。` };
      },
    }),
  );

  // ---- 浏览历史（spec #11）----
  register(
    buildTool({
      name: "browser_read_history",
      description: "搜索内置浏览器的浏览历史（独立于用户 Chrome；读取需用户授权，spec #11）。",
      parameters: {
        query: { type: "string", description: "搜索关键词，可空" },
      },
      execute: async (args, exec) => {
        const r = await gates.ensureHistoryAccess(exec.agent, exec.signal);
        if (r !== "ok") throw new Error(r === "blocked" ? "浏览历史访问被拒绝" : "未获得浏览历史访问授权");
        const entries = manager.stores.searchHistory(args.query ? String(args.query) : undefined);
        if (entries.length === 0) return { text: "浏览历史为空（已获授权）。" };
        const lines = entries
          .slice(0, 20)
          .map((e) => `- ${e.title || e.url}  \`${e.url}\`  (${new Date(e.ts).toLocaleString()})`);
        return { text: `已获授权，最近 ${Math.min(entries.length, 20)} 条浏览历史：\n\n${lines.join("\n")}` };
      },
    }),
  );

  // ---- 页面标注（spec #10）----
  register(
    buildTool({
      name: "browser_read_annotations",
      description:
        "读取用户在页面上留下的标注（comments）。用户说「处理我在页面上的评论」时使用（spec #10）。",
      parameters: {
        url: { type: "string", description: "限定 URL，可空" },
      },
      execute: async (args) => {
        const anns = manager.stores.listAnnotations(args.url ? String(args.url) : undefined);
        if (anns.length === 0) return { text: "当前没有页面标注。" };
        const lines = anns
          .slice(0, 20)
          .map((x, i) => `${i + 1}. 「${x.comment}」\n   - 位置 (${x.x}, ${x.y}) @ ${x.url}`);
        return { text: `已读取 ${anns.length} 条页面标注：\n\n${lines.join("\n")}` };
      },
    }),
  );
  register(
    buildTool({
      name: "browser_add_annotation",
      description: "在页面上放置一条 Agent 标注（供用户查看/确认）。",
      parameters: {
        comment: { type: "string", required: true, description: "评论内容" },
        x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" },
        url: { type: "string", description: "可空，默认当前页面" },
      },
      execute: async (args) => {
        const tab = manager.active();
        const url = args.url ? String(args.url) : (tab?.url ?? "");
        if (!url) throw new Error("无法确定标注页面");
        const ann = manager.stores.addAnnotation({
          url,
          host: hostOf(url),
          x: Number(args.x ?? 0),
          y: Number(args.y ?? 0),
          w: Number(args.w ?? 0),
          h: Number(args.h ?? 0),
          comment: String(args.comment),
          createdBy: "agent",
        });
        return { text: `已添加标注「${ann.comment}」@ ${ann.url}` };
      },
    }),
  );
  register(
    buildTool({
      name: "browser_set_annotation_mode",
      description: "开启/关闭页面标注模式（用户可在共享视图或页面上框选区域写评论）。",
      parameters: {
        on: { type: "boolean", required: true },
      },
      execute: async (args, exec) => {
        await manager.setAnnotationMode(await activeTabId(exec), Boolean(args.on));
        return { text: args.on ? "已开启标注模式（用户可框选区域写评论）" : "已关闭标注模式" };
      },
    }),
  );

  // ---- Developer Mode：full CDP 深度调试（spec #12）----
  const cdpGate = async (exec: ToolRunContext): Promise<void> => {
    const tab = manager.active();
    if (!tab) throw new Error("没有打开的浏览器标签页");
    const url = tab.url;
    const host = hostOf(url);
    const gate = await gates.gateFullCdp(host, url, exec.agent, exec.signal);
    if (!gate.ok) throw new Error(gate.reason);
    await manager.cdpSession(tab.id);
  };

  register(
    buildTool({
      name: "browser_console_logs",
      description:
        "读取当前页面的 console 输出（需要 Developer Mode 开启且该网站已批准 full CDP，spec #12）。",
      parameters: {},
      execute: async (_args, exec) => {
        await cdpGate(exec);
        const logs = manager.consoleLogs(await activeTabId(exec)).slice(-30);
        return { text: `Console 输出（最近 ${logs.length} 条）：\n\n${logs.map((l) => `[${l.level}] ${l.message}`).join("\n") || "（无）"}` };
      },
    }),
  );
  register(
    buildTool({
      name: "browser_network_requests",
      description:
        "读取当前页面的网络请求（需要 Developer Mode 开启且该网站已批准 full CDP，spec #12）。",
      parameters: {},
      execute: async (_args, exec) => {
        await cdpGate(exec);
        const reqs = manager.networkRequests(await activeTabId(exec)).slice(-30);
        return { text: `Network 请求（最近 ${reqs.length} 条）：\n\n${reqs.map((r) => `[${r.status}] ${r.method} ${r.url} (${r.type})`).join("\n") || "（无）"}` };
      },
    }),
  );
  register(
    buildTool({
      name: "browser_performance_metrics",
      description: "读取当前页面的 JavaScript 性能指标（需要 Developer Mode + full CDP 批准，spec #12）。",
      parameters: {},
      execute: async (_args, exec) => {
        await cdpGate(exec);
        const metrics = await manager.performanceMetrics(await activeTabId(exec));
        return { text: `Performance 指标：\n\n${metrics.slice(0, 15).map((m) => `- ${m.name}: ${m.value}`).join("\n") || "（无）"}` };
      },
    }),
  );
  register(
    buildTool({
      name: "browser_evaluate",
      description: "在当前页面执行任意 JavaScript 并返回结果（full CDP，需要 Developer Mode + 网站批准，spec #12）。",
      parameters: {
        expression: { type: "string", required: true, description: "JS 表达式，如 document.title" },
      },
      execute: async (args, exec) => {
        await cdpGate(exec);
        const result = await manager.evaluate(await activeTabId(exec), String(args.expression));
        return { text: `执行结果：\n\n\`\`\`json\n${JSON.stringify(result, null, 2).slice(0, 3000)}\n\`\`\`` };
      },
    }),
  );
}
