// ============================================================================
// 共享视图服务器（spec #2 共享视图 / #9 用户介入 / #10 标注 / #11 历史 / #12 DevMode）
// 提供：视图页面（静态）、截图、SSE 实时事件、用户操作 API、演示站点。
// 用户与 Agent 操作同一个 BrowserManager —— 所见即所得。
// ============================================================================

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BrowserManager, ManagerEvent } from "./manager.js";
import type { BrowserStores } from "./stores.js";

export interface ViewServerOptions {
  manager: BrowserManager;
  stores: BrowserStores;
  viewDir: string;
  demoDir: string;
  shotsDir: string;
  port: number;
  host?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export class ViewServer {
  private server: http.Server | null = null;
  private port = 0;
  private sseClients = new Set<http.ServerResponse>();
  /** SSE 客户端的会话过滤（watch 页用 ?session= 订阅，只收到该会话的导航事件） */
  private sseSessions = new WeakMap<http.ServerResponse, string>();
  /** 实时帧流客户端（/api/screencast） */
  private streamClients = new Set<http.ServerResponse>();
  private host: string;

  constructor(private opts: ViewServerOptions) {
    this.host = opts.host ?? "127.0.0.1";
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    for (let attempt = 0; attempt < 20; attempt++) {
      const port = this.opts.port + attempt;
      const server = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, this.host, () => {
            server.removeListener("error", reject);
            resolve();
          });
        });
        this.server = server;
        this.port = port;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") continue;
        throw err;
      }
    }
    if (!this.server) throw new Error("无法绑定共享视图端口（9333 起 20 个端口均被占用）");
    this.opts.manager.onEvent((ev) => this.broadcast(ev));
    // 实时帧流：CDP screencast 帧 → 推给所有 /api/screencast 订阅者
    this.opts.manager.onScreencastFrame((frame) => {
      const msg = `data: ${JSON.stringify({ type: "frame", data: frame.data, meta: frame.meta })}\n\n`;
      for (const client of this.streamClients) {
        try {
          client.write(msg);
        } catch {
          this.streamClients.delete(client);
        }
      }
    });
  }

  stop(): void {
    try {
      this.server?.close();
    } catch {
      /* ignore */
    }
    this.server = null;
    this.streamClients.clear();
    void this.opts.manager.stopScreencast().catch(() => {});
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  }

  private readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
        if (raw.length > 10_000_000) reject(new Error("body too large"));
      });
      req.on("end", () => {
        try {
          resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
        } catch {
          reject(new Error("invalid json"));
        }
      });
      req.on("error", reject);
    });
  }

  private serveFile(res: http.ServerResponse, file: string): void {
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const method = req.method ?? "GET";
    const { manager, stores } = this.opts;

    // CORS：仅放行本地 DSH 网页 GUI（默认 http://127.0.0.1:3080），
    // 供客户端面板订阅 SSE / 读取状态（Agent 操作浏览器时自动弹出共享视图）。
    // 不放开通配，避免任意网站读取浏览状态。
    const origin = req.headers.origin;
    const allowOrigin =
      origin === "http://127.0.0.1:3080" || origin === "http://localhost:3080" ? origin : undefined;
    if (allowOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowOrigin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    try {
      const isGet = method === "GET" || method === "HEAD";
      // ---- 静态资源 ----
      if (isGet && (p === "/" || p === "/index.html")) return this.serveFile(res, path.join(this.opts.viewDir, "index.html"));
      if (isGet && p === "/styles.css") return this.serveFile(res, path.join(this.opts.viewDir, "styles.css"));
      if (isGet && p === "/app.js") return this.serveFile(res, path.join(this.opts.viewDir, "app.js"));
      if (isGet && p.startsWith("/shots/")) return this.serveFile(res, path.join(this.opts.shotsDir, path.basename(p)));
      if (isGet && p.startsWith("/demo")) {
        const rel =
          p === "/demo" || p === "/demo/" || p === "/demo/index.html"
            ? "index.html"
            : p.slice("/demo/".length);
        return this.serveFile(res, path.join(this.opts.demoDir, rel));
      }

      // ---- SSE 事件流 ----
      if (method === "GET" && p === "/api/events") {
        const session = url.searchParams.get("session");
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write("retry: 3000\n\n");
        this.sseClients.add(res);
        if (session) this.sseSessions.set(res, session);
        req.on("close", () => {
          this.sseClients.delete(res);
          this.sseSessions.delete(res);
        });
        return;
      }

      // ---- 实时帧流（CDP screencast）----
      if (method === "GET" && p === "/api/screencast") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write("retry: 3000\n\n");
        this.streamClients.add(res);
        // 第一个订阅者到达时启动帧流
        if (this.streamClients.size === 1) {
          manager.startScreencast().catch((err) => {
            console.error("[dsh-browser] screencast 启动失败（回退截图模式）:", err?.message ?? err);
          });
        }
        req.on("close", () => {
          this.streamClients.delete(res);
          if (this.streamClients.size === 0) void manager.stopScreencast().catch(() => {});
        });
        return;
      }

      // ---- API ----
      if (p === "/api/state" && method === "GET") {
        // 视图打开即尝试连接外部浏览器（配置了 CDP 地址或探测到调试端口）；
        // 失败时把错误带给视图展示。无调试浏览器时开销极小（连接拒绝即刻返回）。
        let externalError: string | null = null;
        try {
          await manager.tryConnectExternal();
          if (manager.external) await manager.refreshExternalTarget().catch(() => {});
        } catch (err) {
          externalError = (err as Error)?.message ?? String(err);
        }
        return this.sendJson(res, 200, {
          state: await manager.state(),
          external: manager.external,
          externalError,
          devMode: stores.getDevMode(),
          sites: stores.listSitePermissions(),
          annotations: stores.listAnnotations(),
          viewBase: this.baseUrl,
        });
      }

      if (p === "/api/screenshot" && method === "GET") {
        const silent = url.searchParams.get("noevent") === "1";
        const shot = await manager.screenshot(String(url.searchParams.get("tab") ?? ""), { silent });
        return this.serveFile(res, shot.file);
      }

      // 鼠标移动注入（hover 反馈；坐标按视口 CSS 像素）
      if (p === "/api/input" && method === "POST") {
        const body = await this.readBody(req);
        const tab = manager.active();
        if (!tab) return this.sendJson(res, 400, { ok: false, error: "没有打开的标签页" });
        await manager.mouseMove(tab.id, Number(body.x ?? 0), Number(body.y ?? 0));
        return this.sendJson(res, 200, { ok: true });
      }

      // 共享面板自适应：视口跟随面板尺寸（页面响应式重排，帧流铺满）
      if (p === "/api/resize" && method === "POST") {
        const body = await this.readBody(req);
        const w = Number(body.w ?? 0);
        const h = Number(body.h ?? 0);
        if (!(w >= 320 && h >= 240)) return this.sendJson(res, 400, { ok: false, error: "尺寸过小" });
        await manager.resizeViewport(w, h);
        return this.sendJson(res, 200, { ok: true });
      }

      if (p === "/api/navigate" && method === "POST") {
        const body = await this.readBody(req);
        const tabId = String(body.tab ?? "");
        const result = await manager.navigateTo(tabId, String(body.url ?? ""));
        return this.sendJson(res, 200, result);
      }

      if (p === "/api/click" && method === "POST") {
        const body = await this.readBody(req);
        await manager.clickAt(String(body.tab ?? ""), Number(body.x ?? 0), Number(body.y ?? 0));
        return this.sendJson(res, 200, { ok: true });
      }

      if (p === "/api/type" && method === "POST") {
        const body = await this.readBody(req);
        const tab = manager.active();
        if (!tab) return this.sendJson(res, 400, { ok: false, error: "没有打开的标签页" });
        await manager.type(tab.id, "*", String(body.text ?? ""));
        return this.sendJson(res, 200, { ok: true });
      }

      if (p === "/api/press" && method === "POST") {
        const body = await this.readBody(req);
        const tab = manager.active();
        if (!tab) return this.sendJson(res, 400, { ok: false, error: "没有打开的标签页" });
        await manager.press(tab.id, String(body.key ?? "Enter"));
        return this.sendJson(res, 200, { ok: true });
      }

      if (p === "/api/back" && method === "POST") {
        const tab = manager.active();
        if (tab) manager.goBack(tab.id);
        return this.sendJson(res, 200, { ok: true });
      }
      if (p === "/api/forward" && method === "POST") {
        const tab = manager.active();
        if (tab) manager.goForward(tab.id);
        return this.sendJson(res, 200, { ok: true });
      }
      if (p === "/api/reload" && method === "POST") {
        const tab = manager.active();
        if (tab) manager.reload(tab.id);
        return this.sendJson(res, 200, { ok: true });
      }

      if (p === "/api/tab/new" && method === "POST") {
        const body = await this.readBody(req);
        const tabId = await manager.newTab(body.url ? String(body.url) : undefined);
        return this.sendJson(res, 200, { tabId });
      }
      if (p === "/api/tab/close" && method === "POST") {
        const body = await this.readBody(req);
        await manager.closeTab(String(body.tabId ?? ""));
        return this.sendJson(res, 200, { ok: true });
      }
      if (p === "/api/tab/switch" && method === "POST") {
        const body = await this.readBody(req);
        manager.setActive(String(body.tabId ?? ""));
        return this.sendJson(res, 200, { ok: true });
      }

      // ---- 标注（spec #10）----
      if (p === "/api/annotate" && method === "POST") {
        const body = await this.readBody(req);
        const tab = manager.active();
        if (!tab) return this.sendJson(res, 400, { ok: false, error: "没有打开的标签页" });
        await manager.setAnnotationMode(tab.id, Boolean(body.on));
        return this.sendJson(res, 200, { ok: true });
      }
      if (p === "/api/annotation" && method === "POST") {
        const body = await this.readBody(req);
        const tab = manager.active();
        const url = body.url ? String(body.url) : (tab?.url ?? "");
        if (!url) return this.sendJson(res, 400, { ok: false, error: "无法确定标注页面" });
        const ann = stores.addAnnotation({
          url,
          host: safeHost(url),
          x: Number(body.x ?? 0),
          y: Number(body.y ?? 0),
          w: Number(body.w ?? 0),
          h: Number(body.h ?? 0),
          comment: String(body.comment ?? ""),
          createdBy: "user",
        });
        if (tab) manager.setAnnotationMode(tab.id, true).catch(() => {});
        return this.sendJson(res, 200, { ok: true, annotation: ann });
      }
      if (p === "/api/annotation" && method === "DELETE") {
        const body = await this.readBody(req);
        stores.deleteAnnotation(String(body.id ?? ""));
        return this.sendJson(res, 200, { ok: true });
      }

      // ---- 历史（spec #11）----
      if (p === "/api/history" && method === "GET") {
        return this.sendJson(res, 200, stores.searchHistory(url.searchParams.get("q") ?? undefined));
      }
      if (p === "/api/history" && method === "DELETE") {
        const body = await this.readBody(req);
        stores.deleteHistory(String(body.id ?? ""));
        return this.sendJson(res, 200, { ok: true });
      }
      if (p === "/api/history/clear" && method === "POST") {
        stores.clearHistory();
        return this.sendJson(res, 200, { ok: true });
      }

      // ---- Developer Mode（spec #12）----
      if (p === "/api/devmode" && method === "POST") {
        const body = await this.readBody(req);
        stores.setDevModeEnabled(Boolean(body.enabled));
        return this.sendJson(res, 200, stores.getDevMode());
      }
      if (p === "/api/devmode/host" && method === "DELETE") {
        const body = await this.readBody(req);
        stores.revokeCdpHost(String(body.host ?? ""));
        return this.sendJson(res, 200, stores.getDevMode());
      }

      // ---- 站点权限（spec #6）----
      if (p === "/api/sites" && method === "GET") {
        return this.sendJson(res, 200, stores.listSitePermissions());
      }
      if (p === "/api/sites" && method === "DELETE") {
        const body = await this.readBody(req);
        stores.clearSiteDecision(String(body.host ?? ""));
        return this.sendJson(res, 200, { ok: true });
      }

      // ---- 用户手动上传（spec #8/#9 介入路径）----
      if (p === "/api/upload" && method === "POST") {
        const body = await this.readBody(req);
        const tab = manager.active();
        if (!tab) return this.sendJson(res, 400, { ok: false, error: "没有打开的标签页" });
        const files = Array.isArray(body.files)
          ? (body.files as Array<{ name?: string; mimeType?: string; base64?: string }>)
              .filter((f) => f && typeof f.base64 === "string")
              .map((f) => ({ name: f.name ?? "file", mimeType: f.mimeType ?? "application/octet-stream", base64: f.base64! }))
          : [];
        await manager.provideUpload(tab.id, files);
        return this.sendJson(res, 200, { ok: true, note: "文件已由用户手动提供" });
      }

      // ---- 清除隔离 profile 数据（spec #3）----
      if (p === "/api/clear-profile" && method === "POST") {
        await manager.ensure();
        const context = (manager as unknown as { context?: { clearCookies(): Promise<void> } }).context;
        await context?.clearCookies();
        const state = await manager.state();
        for (const t of state.tabs) {
          const tab = manager.getTab(t.id);
          if (tab) {
            await tab.page
              .evaluate(() => {
                try {
                  localStorage.clear();
                  sessionStorage.clear();
                } catch {
                  /* ignore */
                }
              })
              .catch(() => {});
          }
        }
        return this.sendJson(res, 200, { ok: true, note: "已清除内置浏览器的登录态与站点数据" });
      }

      res.writeHead(404);
      res.end("Not Found");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendJson(res, 500, { ok: false, error: message });
    }
  }

  private broadcast(ev: ManagerEvent): void {
    const frame = `data: ${JSON.stringify(ev)}\n\n`;
    const actor = (ev as { actorSession?: string }).actorSession;
    for (const client of this.sseClients) {
      // 带会话过滤的客户端（watch 页）只收匹配会话的导航事件
      const want = this.sseSessions.get(client);
      if (want !== undefined && actor !== want) continue;
      try {
        client.write(frame);
      } catch {
        this.sseClients.delete(client);
        this.sseSessions.delete(client);
      }
    }
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
