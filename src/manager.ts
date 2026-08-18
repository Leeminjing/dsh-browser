// ============================================================================
// BrowserManager：用 Playwright 驱动一个「内置浏览器」。
//   - 独立持久化 profile（persist userDataDir，spec #3 状态隔离）
//   - 多标签页（共享同一 context → 共享 cookie/localStorage）
//   - 导航 / 点击 / 输入 / 快照 / 截图 / 键盘
//   - 文件上传拦截（spec #8）、对话框自动处理、console 捕获（含标注上报）
//   - Developer Mode：CDPSession 深度调试（console/network/performance，spec #12）
// ============================================================================

import type { BrowserContext, CDPSession, Page } from "playwright";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Annotation, BrowserStores } from "./stores.js";
import { buildOverlayExitScript, buildOverlayScript, parseAnnotationPayload } from "./annotations.js";

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}
export interface PageElement {
  index: number;
  tag: string;
  role: string;
  text: string;
  name: string;
  href: string;
  type: string;
  value: string;
  disabled: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
  at: number;
}
export interface ConsoleLogEntry {
  id: string;
  level: string;
  message: string;
  url: string;
  ts: number;
}
export interface NetworkRequestEntry {
  id: string;
  method: string;
  url: string;
  status: number;
  type: string;
  ts: number;
}
export interface BrowserState {
  tabs: TabInfo[];
  activeTabId: string | null;
}

export type ManagerEvent =
  | { type: "state"; state: BrowserState }
  | { type: "shot"; tabId: string; ts: number }
  | { type: "annotation"; annotation: Annotation }
  | { type: "upload-blocked"; tabId: string; url: string }
  | { type: "navigated"; tabId: string; url: string; title: string; actorSession?: string }
  | { type: "console-log"; tabId: string; entry: ConsoleLogEntry }
  | { type: "network-request"; tabId: string; entry: NetworkRequestEntry };

/** CDP screencast 单帧（base64 JPEG + 视口元数据） */
export interface ScreencastFrame {
  data: string;
  meta: {
    pageScaleFactor: number;
    deviceWidth: number;
    deviceHeight: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
    offsetTop: number;
    offsetBottom: number;
  };
}

interface Tab {
  id: string;
  page: Page;
  title: string;
  url: string;
  loading: boolean;
  /** 页面 history.length > 1（可后退） */
  canGoBackCache: boolean;
  /** 前进栈（goBack 后记录的 URL；playwright 1.62 已移除 canGoForward） */
  fwdStack: string[];
  cdp?: CDPSession;
  cdpEnabled: boolean;
  cdpBuffers: { consoleLogs: ConsoleLogEntry[]; network: NetworkRequestEntry[] };
  pendingFileChooser?: { files: Array<{ name: string; mimeType: string; buffer: Buffer }>; resolve: () => void };
  /** requestId → {method, url}（Network 事件关联用） */
  pendingRequests: Map<string, { method: string; url: string }>;
}

export interface BrowserManagerOptions {
  stores: BrowserStores;
  profileDir: string;
  shotsDir: string;
  viewport?: { width: number; height: number };
  headless?: boolean;
  onEvent?: (ev: ManagerEvent) => void;
}

const MAX_BUFFER = 500;
const SNAPSHOT_SCRIPT = `
  (() => {
    const seen = new Set();
    const els = [];
    const all = document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[tabindex]:not([tabindex="-1"])');
    let idx = 0;
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.bottom < 0 || r.top > innerHeight) continue;
      const tag = el.tagName.toLowerCase();
      const text = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.title || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
      const name = (el.getAttribute('name') || el.getAttribute('id') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim();
      const href = el.getAttribute && el.getAttribute('href') ? el.getAttribute('href') : '';
      const role = el.getAttribute('role') || '';
      const type = el.getAttribute && el.getAttribute('type') ? el.getAttribute('type') : '';
      const key = tag + '|' + text + '|' + name + '|' + href;
      if (seen.has(key) && text === '' && name === '') continue;
      seen.add(key);
      els.push({
        index: idx++,
        tag, role, text, name, href, type,
        value: el.value !== undefined ? String(el.value) : '',
        disabled: !!el.disabled,
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)
      });
    }
    return {
      url: location.href,
      title: document.title,
      text: (document.body ? document.body.innerText : '').trim().replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000),
      elements: els
    };
  })()
`;

const FIND_ELEMENT_SCRIPT = (query: string) => `
  (() => {
    const q = ${JSON.stringify(query)};
    const ql = q.toLowerCase();
    const all = document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[tabindex]:not([tabindex="-1"])');
    for (const el of all) {
      const text = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.title || '').trim().replace(/\\s+/g, ' ');
      const name = (el.getAttribute('name') || el.getAttribute('id') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim();
      const href = el.getAttribute('href') || '';
      if ((text.toLowerCase() === ql || (text.toLowerCase().includes(ql) && text.length < 80)
          || name.toLowerCase() === ql || href === q || href.endsWith(q))) {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return {
          index: 0, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '',
          text, name, href, type: el.getAttribute('type') || '',
          value: el.value !== undefined ? String(el.value) : '',
          disabled: !!el.disabled,
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)
        };
      }
    }
    return null;
  })()
`;

const FOCUS_INPUT_SCRIPT = (query: string) => `
  (() => {
    const q = ${JSON.stringify(query)};
    const ql = q.toLowerCase();
    const all = document.querySelectorAll('input,textarea,select,[contenteditable="true"]');
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue; // 跳过隐藏/不可见元素（如登录页残留输入框）
      const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ');
      const name = (el.getAttribute('name') || el.getAttribute('id') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim();
      if (text.toLowerCase() === ql || text.toLowerCase().includes(ql) || name.toLowerCase() === ql || name.toLowerCase().includes(ql)) {
        el.focus();
        return true;
      }
    }
    return false;
  })()
`;

export class BrowserManager {
  private context: BrowserContext | null = null;
  private tabs = new Map<string, Tab>();
  private activeId: string | null = null;
  private seq = 0;
  private listeners: Array<(ev: ManagerEvent) => void> = [];
  /** 当前发起浏览器操作的会话（由工具调用设置，用于把导航事件归属到具体会话） */
  private actorSession = "";
  /** 实时帧流（CDP screencast）：与 DevMode 门控的 cdpSession 相互独立 */
  private streamCdp: CDPSession | null = null;
  private streamTabId: string | null = null;
  private streamFrameListeners: Array<(frame: ScreencastFrame) => void> = [];
  /** 当前视口尺寸（共享面板自适应；新标签页沿用同一尺寸） */
  private viewportSize: { width: number; height: number } = { width: 1280, height: 800 };

  constructor(private opts: BrowserManagerOptions) {}

  onEvent(cb: (ev: ManagerEvent) => void): void {
    this.listeners.push(cb);
  }
  private emit(ev: ManagerEvent): void {
    for (const cb of this.listeners) cb(ev);
  }

  /** 记录当前由哪个会话发起浏览器操作（exec.agent.id）。 */
  setActorSession(sessionId: string): void {
    this.actorSession = sessionId;
  }

  get stores(): BrowserStores {
    return this.opts.stores;
  }

  // ---- 实时帧流（Codex 式共享视图：CDP screencast）----

  onScreencastFrame(cb: (frame: ScreencastFrame) => void): void {
    this.streamFrameListeners.push(cb);
  }
  private emitFrame(frame: ScreencastFrame): void {
    for (const cb of this.streamFrameListeners) {
      try {
        cb(frame);
      } catch {
        /* ignore */
      }
    }
  }

  /** 开始对指定标签页做 CDP screencast 实时帧流（无 DevMode 依赖） */
  async startScreencast(tabId?: string): Promise<void> {
    await this.ensure();
    const tab = this.tabs.get(tabId ?? "") ?? this.active();
    if (!tab) throw new Error("没有打开的浏览器标签页");
    if (this.streamTabId === tab.id && this.streamCdp) return;
    await this.stopScreencast();
    const cdp = await this.context!.newCDPSession(tab.page);
    this.streamCdp = cdp;
    this.streamTabId = tab.id;
    cdp.on("Page.screencastFrame", (params) => {
      const p = params as { data?: string; sessionId?: number; metadata?: Partial<ScreencastFrame["meta"]> };
      if (!p.data) return;
      const m = p.metadata ?? {};
      this.emitFrame({
        data: p.data,
        meta: {
          pageScaleFactor: Number(m.pageScaleFactor ?? 1),
          deviceWidth: Number(m.deviceWidth ?? 1280),
          deviceHeight: Number(m.deviceHeight ?? 800),
          scrollOffsetX: Number(m.scrollOffsetX ?? 0),
          scrollOffsetY: Number(m.scrollOffsetY ?? 0),
          offsetTop: Number(m.offsetTop ?? 0),
          offsetBottom: Number(m.offsetBottom ?? 0),
        },
      });
      // 必须 ACK，否则浏览器停止推帧
      if (typeof p.sessionId === "number") {
        void cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
      }
    });
    try {
      await cdp.send("Page.enable");
      // maxWidth/maxHeight 跟随当前视口：帧像素 = 视口 CSS 像素（1:1），面板铺满
      const vp = this.viewportSize;
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 70,
        maxWidth: Math.max(320, vp.width),
        maxHeight: Math.max(240, vp.height),
        everyNthFrame: 1,
      });
    } catch (err) {
      this.streamCdp = null;
      this.streamTabId = null;
      try {
        cdp.detach();
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  async stopScreencast(): Promise<void> {
    const cdp = this.streamCdp;
    this.streamCdp = null;
    this.streamTabId = null;
    if (cdp) {
      try {
        await cdp.send("Page.stopScreencast");
      } catch {
        /* ignore */
      }
      try {
        cdp.detach();
      } catch {
        /* ignore */
      }
    }
  }

  /** 共享面板自适应：调整当前标签页视口尺寸 → 页面响应式重排，帧流 1:1 铺满面板 */
  async resizeViewport(width: number, height: number): Promise<void> {
    // 浏览器尚未启动时不做任何事（保留占位页；首个标签页打开后会随面板尺寸调整）
    if (!this.context) return;
    const tab = this.active();
    if (!tab) return;
    const w = Math.max(320, Math.min(4096, Math.round(width)));
    const h = Math.max(240, Math.min(4096, Math.round(height)));
    const cur = tab.page.viewportSize();
    if (cur && Math.abs(cur.width - w) < 2 && Math.abs(cur.height - h) < 2) return;
    this.viewportSize = { width: w, height: h };
    await tab.page.setViewportSize({ width: w, height: h });
    // 帧流尺寸跟随新视口（重启 screencast，maxWidth/maxHeight 取新尺寸）
    if (this.streamCdp && this.streamTabId === tab.id) {
      await this.startScreencast(tab.id).catch(() => {});
    }
    this.pushState();
  }

  /** 只注入鼠标移动（hover 反馈）；坐标按视口 CSS 像素 */
  async mouseMove(tabId: string, x: number, y: number): Promise<void> {
    const t = this.tabs.get(tabId) ?? this.active();
    if (!t) return;
    await t.page.mouse.move(x, y);
  }

  async ensure(): Promise<void> {
    if (this.context) return;
    // 动态导入 playwright：缺失时给出清晰错误，不影响 harness 启动
    let chromium: typeof import("playwright").chromium;
    try {
      chromium = (await import("playwright")).chromium;
    } catch {
      throw new Error(
        "内置浏览器依赖 playwright 未安装。请在 profile 中运行 `pnpm add playwright && pnpm exec playwright install chromium` 后重启。",
      );
    }
    const context = await chromium.launchPersistentContext(this.opts.profileDir, {
      headless: this.opts.headless ?? true,
      viewport: this.opts.viewport ?? { width: 1280, height: 800 },
      // DPR 2：截图 2x（2560×1600），在高分屏/缩放显示下共享视图依然清晰
      deviceScaleFactor: 2,
      acceptDownloads: false,
      locale: "zh-CN",
    });
    this.context = context;
    const initial = context.pages()[0] ?? (await context.newPage());
    await this.adoptPage(initial);
    // 默认拒绝所有站点权限请求（地理位置/通知等）
    await context.clearPermissions();
  }

  private async adoptPage(page: Page): Promise<Tab> {
    const tab: Tab = {
      id: `tab_${++this.seq}`,
      page,
      title: (await page.title()) || "新标签页",
      url: await page.url(),
      loading: false,
      canGoBackCache: false,
      fwdStack: [],
      cdpEnabled: false,
      cdpBuffers: { consoleLogs: [], network: [] },
      pendingRequests: new Map(),
    };
    this.tabs.set(tab.id, tab);
    this.activeId = tab.id;

    const syncNavState = async () => {
      tab.url = await page.url();
      tab.title = (await page.title()) || tab.title;
      try {
        tab.canGoBackCache = (await page.evaluate(() => window.history.length > 1)) as boolean;
      } catch {
        tab.canGoBackCache = false;
      }
    };

    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      void (async () => {
        await syncNavState();
        this.opts.stores.recordHistory(tab.url, tab.title);
        this.emit({ type: "navigated", tabId: tab.id, url: tab.url, title: tab.title, actorSession: this.actorSession });
        this.pushState();
        this.pushShot(tab.id);
      })();
    });
    page.on("load", () => {
      void (async () => {
        await syncNavState();
        tab.loading = false;
        tab.fwdStack = [];
        this.pushState();
      })();
    });
    page.on("domcontentloaded", () => {
      tab.loading = true;
    });
    page.on("console", (msg) => {
      const text = msg.text();
      const ann = parseAnnotationPayload(text, tab.url);
      if (ann) {
        const saved = this.opts.stores.addAnnotation(ann);
        this.emit({ type: "annotation", annotation: saved });
        return;
      }
      const entry: ConsoleLogEntry = {
        id: this.uid("c"),
        level: msg.type(),
        message: text.slice(0, 2000),
        url: tab.url,
        ts: Date.now(),
      };
      tab.cdpBuffers.consoleLogs.push(entry);
      if (tab.cdpBuffers.consoleLogs.length > MAX_BUFFER) tab.cdpBuffers.consoleLogs.shift();
      this.emit({ type: "console-log", tabId: tab.id, entry });
    });
    page.on("dialog", (dialog) => {
      void dialog.dismiss().catch(() => {});
    });
    page.on("filechooser", (fc) => {
      // spec #8：不自动完成上传。若用户（通过视图页）已提供文件，则填充；否则仅提示。
      if (tab.pendingFileChooser) {
        const { files, resolve } = tab.pendingFileChooser;
        tab.pendingFileChooser = undefined;
        fc.setFiles(files.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: f.buffer })))
          .then(() => resolve())
          .catch(() => resolve());
      } else {
        this.emit({ type: "upload-blocked", tabId: tab.id, url: tab.url });
      }
    });
    page.on("download", (dl) => {
      void dl.cancel().catch(() => {});
    });
    page.on("popup", (popup) => {
      void popup.close().catch(() => {});
    });
    page.on("close", () => {
      this.tabs.delete(tab.id);
      if (this.streamTabId === tab.id) void this.stopScreencast();
      if (this.activeId === tab.id) this.activeId = this.tabs.keys().next().value ?? null;
      this.pushState();
    });
    return tab;
  }

  private pushState(): void {
    void this.state().then((s) => this.emit({ type: "state", state: s }));
  }
  private pushShot(tabId: string): void {
    this.emit({ type: "shot", tabId, ts: Date.now() });
  }

  async state(): Promise<BrowserState> {
    const tabs: TabInfo[] = [];
    for (const t of this.tabs.values()) {
      tabs.push({
        id: t.id,
        url: t.url,
        title: t.title,
        loading: t.loading,
        canGoBack: t.canGoBackCache,
        canGoForward: t.fwdStack.length > 0,
      });
    }
    return { tabs, activeTabId: this.activeId };
  }

  // ---- 标签页 ----
  async newTab(url?: string): Promise<string> {
    await this.ensure();
    const page = await this.context!.newPage();
    await page.setViewportSize(this.viewportSize).catch(() => {});
    const tab = await this.adoptPage(page);
    if (url) await this.navigateTo(tab.id, url);
    if (this.streamCdp) void this.startScreencast(tab.id);
    return tab.id;
  }
  async closeTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (tab) {
      await tab.page.close().catch(() => {});
      this.tabs.delete(tabId);
      if (this.activeId === tabId) this.activeId = this.tabs.keys().next().value ?? null;
      this.pushState();
    }
  }
  setActive(tabId: string): void {
    if (this.tabs.has(tabId)) {
      this.activeId = tabId;
      // 实时帧流跟随活动标签
      if (this.streamCdp) void this.startScreencast(tabId);
      this.pushState();
    }
  }

  active(): Tab | undefined {
    return this.activeId ? this.tabs.get(this.activeId) : this.tabs.values().next().value;
  }
  getTab(tabId: string): Tab | undefined {
    return this.tabs.get(tabId);
  }

  // ---- 导航 ----
  async navigateTo(tabId: string, url: string): Promise<{ url: string; title: string; httpStatus: number | null; verified: boolean }> {
    const tab = this.tabs.get(tabId) ?? this.active() ?? (await this.ensureTab());
    await this.ensure();
    const page = tab.page;
    tab.loading = true;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    let httpStatus: number | null = null;
    if (/^https?:/i.test(url)) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10_000);
        let res: Response;
        try {
          res = await fetch(await page.url(), { method: "HEAD", redirect: "follow", signal: ctrl.signal });
        } catch {
          res = await fetch(await page.url(), { method: "GET", redirect: "follow", signal: ctrl.signal });
        }
        clearTimeout(timer);
        httpStatus = res.status;
      } catch {
        httpStatus = null;
      }
    }
    tab.url = await page.url();
    tab.title = (await page.title()) || tab.title;
    tab.loading = false;
    tab.fwdStack = [];
    this.opts.stores.recordHistory(tab.url, tab.title);
    this.pushState();
    this.pushShot(tabId);
    return {
      url: tab.url,
      title: tab.title,
      httpStatus,
      verified: httpStatus === null || (httpStatus >= 200 && httpStatus < 400),
    };
  }

  private async ensureTab(): Promise<Tab> {
    await this.ensure();
    const existing = this.active();
    if (existing) return existing;
    const page = await this.context!.newPage();
    await page.setViewportSize(this.viewportSize).catch(() => {});
    return this.adoptPage(page);
  }

  goBack(tabId: string): void {
    const t = this.tabs.get(tabId) ?? this.active();
    if (t) {
      void (async () => {
        const prev = await t.page.url();
        try {
          await t.page.goBack({ waitUntil: "domcontentloaded" });
          const now = await t.page.url();
          if (now !== prev) t.fwdStack.push(prev);
          this.pushState();
        } catch {
          /* 无可后退 */
        }
      })();
    }
  }
  goForward(tabId: string): void {
    const t = this.tabs.get(tabId) ?? this.active();
    if (t) {
      void (async () => {
        const next = t.fwdStack.pop();
        if (next) {
          try {
            await t.page.goto(next, { waitUntil: "domcontentloaded" });
            this.pushState();
          } catch {
            /* ignore */
          }
        } else {
          try {
            await t.page.goForward({ waitUntil: "domcontentloaded" });
            this.pushState();
          } catch {
            /* ignore */
          }
        }
      })();
    }
  }
  reload(tabId: string): void {
    const t = this.tabs.get(tabId) ?? this.active();
    if (t) void t.page.reload({ waitUntil: "domcontentloaded" });
  }

  // ---- 页面操作 ----
  async findElement(tabId: string, query: string): Promise<PageElement | null> {
    const t = this.tabs.get(tabId) ?? this.active();
    if (!t) throw new Error("没有打开的浏览器标签页");
    return (await t.page.evaluate(FIND_ELEMENT_SCRIPT(query))) as PageElement | null;
  }

  async click(tabId: string, query: string): Promise<PageElement> {
    const t = this.tabs.get(tabId) ?? this.active();
    if (!t) throw new Error("没有打开的浏览器标签页");
    const el = await this.findElement(tabId, query);
    if (!el) throw new Error(`页面上找不到可点击元素: ${query}`);
    if (el.disabled) throw new Error(`元素「${query}」当前处于禁用状态`);
    await t.page.mouse.click(el.x + el.w / 2, el.y + el.h / 2);
    // 视图同步：点击可能改变页面内容/触发导航，发 state 让共享视图刷新（视图页忽略 shot 事件，故不能用 pushShot）
    this.pushState();
    return el;
  }

  /** 按视口坐标点击（用户/视图页操作，spec #9） */
  async clickAt(tabId: string, x: number, y: number): Promise<void> {
    const t = this.tabs.get(tabId) ?? this.active();
    if (!t) throw new Error("没有打开的浏览器标签页");
    await t.page.mouse.click(x, y);
    this.pushShot(tabId);
  }

  async type(tabId: string, query: string, text: string): Promise<PageElement> {
    const t = this.tabs.get(tabId) ?? this.active();
    if (!t) throw new Error("没有打开的浏览器标签页");
    let el: PageElement | null = null;
    if (query !== "*") {
      el = await this.findElement(tabId, query);
      if (!el) throw new Error(`页面上找不到输入框: ${query}`);
      if (el.disabled) throw new Error(`输入框「${query}」当前处于禁用状态`);
      if (el.type === "file") {
        throw new Error("网页要求上传文件，但内置浏览器不能自动完成文件上传（spec #8）。");
      }
      await t.page.evaluate(FOCUS_INPUT_SCRIPT(query));
    } else {
      // * → 优先输入到「当前已聚焦」的可见输入框（用户点击哪个字段就输入到哪）；
      // 否则聚焦第一个可见输入框（跳过隐藏元素，如登录页残留输入框）
      await t.page.evaluate(
        `(() => {
          const ae = document.activeElement;
          const isField = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
          if (isField) {
            const r = ae.getBoundingClientRect();
            if (r.width > 2 && r.height > 2) return true;
          }
          const els = [...document.querySelectorAll('input,textarea,[contenteditable="true"]')];
          const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2; }) || null;
          if (el) el.focus();
          return !!el;
        })()`,
      );
    }
    // 瞬时注入文本（不经逐字键盘事件，减少输入延迟；触发 input 事件，兼容受控表单）
    await t.page.keyboard.insertText(text);
    // 视图同步：输入内容后刷新共享视图
    this.pushState();
    return el ?? { index: 0, tag: "input", role: "", text: "", name: "", href: "", type: "", value: "", disabled: false, x: 0, y: 0, w: 0, h: 0 };
  }

  async press(tabId: string, key: string): Promise<void> {
    const t = this.tabs.get(tabId) ?? this.active();
    if (!t) throw new Error("没有打开的浏览器标签页");
    await t.page.keyboard.press(key);
    // 视图同步：按键（如 Enter 提交/导航）后刷新共享视图
    this.pushState();
  }

  async snapshot(tabId: string): Promise<PageSnapshot> {
    const t = this.tabs.get(tabId) ?? this.active();
    if (!t) throw new Error("没有打开的浏览器标签页");
    const data = (await t.page.evaluate(SNAPSHOT_SCRIPT)) as PageSnapshot;
    return { ...data, at: Date.now() };
  }

  /** 截图并保存到 shots 目录，返回可访问 URL（spec #5/#13 验证与最终状态）。
   *  silent 用于视图页自身的轮询刷新：不发 "shot" 事件，避免「截图→事件→再截图」死循环。 */
  async screenshot(tabId: string, opts?: { silent?: boolean }): Promise<{ file: string; url: string; ts: number }> {
    const t = this.tabs.get(tabId) ?? this.active();
    if (!t) throw new Error("没有打开的浏览器标签页");
    const ts = Date.now();
    const buffer = await t.page.screenshot({ type: "png" });
    mkdirSync(this.opts.shotsDir, { recursive: true });
    const file = join(this.opts.shotsDir, `shot_${ts}.png`);
    writeFileSync(file, buffer);
    this.pruneShots();
    if (!opts?.silent) this.emit({ type: "shot", tabId, ts });
    return { file, url: `/shots/shot_${ts}.png`, ts };
  }

  /** 截图保留策略：只保留最近 MAX_SHOTS 张，防止磁盘无限增长 */
  private static readonly MAX_SHOTS = 200;
  private pruneShots(): void {
    try {
      const shots = readdirSync(this.opts.shotsDir)
        .filter((f) => f.endsWith(".png"))
        .map((f) => ({ f, t: statSync(join(this.opts.shotsDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const old of shots.slice(BrowserManager.MAX_SHOTS)) {
        try {
          unlinkSync(join(this.opts.shotsDir, old.f));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  // ---- 标注（spec #10）----
  async setAnnotationMode(tabId: string, on: boolean): Promise<void> {
    const t = this.tabs.get(tabId) ?? this.active();
    if (!t) throw new Error("没有打开的浏览器标签页");
    if (on) {
      const anns = this.opts.stores.listAnnotations(t.url);
      await t.page.evaluate(buildOverlayScript(anns));
    } else {
      await t.page.evaluate(buildOverlayExitScript());
    }
  }

  listAnnotations(url?: string): Annotation[] {
    return this.opts.stores.listAnnotations(url);
  }

  // ---- 用户手动上传（spec #8 / #9 的介入路径）----
  async provideUpload(tabId: string, files: Array<{ name: string; mimeType: string; base64: string }>): Promise<void> {
    const t = this.tabs.get(tabId) ?? this.active();
    if (!t) throw new Error("没有打开的浏览器标签页");
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // 完成回调：无论 filechooser 是否填充，都清理 pending 状态，避免陈旧文件残留
      const done = () => {
        if (timer) clearTimeout(timer);
        t.pendingFileChooser = undefined;
        resolve();
      };
      t.pendingFileChooser = {
        files: files.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: Buffer.from(f.base64, "base64") })),
        resolve: done,
      };
      // 若 filechooser 已打开，Playwright 的 filechooser 事件会立刻触发 setFiles
      timer = setTimeout(done, 8000);
    });
  }

  // ---- Developer Mode：CDP 深度调试（spec #12）----
  async cdpSession(tabId: string): Promise<CDPSession> {
    const t = this.tabs.get(tabId) ?? this.active();
    if (!t) throw new Error("没有打开的浏览器标签页");
    if (t.cdp) return t.cdp;
    const cdp = await this.context!.newCDPSession(t.page);
    t.cdp = cdp;
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Network.enable");
    await cdp.send("Page.enable");
    await cdp.send("Performance.enable");
    t.cdpEnabled = true;

    cdp.on("Runtime.consoleAPICalled", (params) => {
      const args = (params.args ?? []).map((a: { value?: unknown; description?: string }) =>
        a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : a.description ?? "",
      );
      const entry: ConsoleLogEntry = {
        id: this.uid("c"),
        level: String(params.type ?? "log"),
        message: args.join(" ").slice(0, 2000),
        url: t.url,
        ts: Date.now(),
      };
      t.cdpBuffers.consoleLogs.push(entry);
      if (t.cdpBuffers.consoleLogs.length > MAX_BUFFER) t.cdpBuffers.consoleLogs.shift();
      this.emit({ type: "console-log", tabId, entry });
    });
    cdp.on("Log.entryAdded", (params) => {
      const e = params.entry as { level?: string; text?: string; url?: string };
      const entry: ConsoleLogEntry = {
        id: this.uid("c"),
        level: e.level ?? "log",
        message: (e.text ?? "").slice(0, 2000),
        url: e.url ?? t.url,
        ts: Date.now(),
      };
      t.cdpBuffers.consoleLogs.push(entry);
      if (t.cdpBuffers.consoleLogs.length > MAX_BUFFER) t.cdpBuffers.consoleLogs.shift();
      this.emit({ type: "console-log", tabId, entry });
    });
    cdp.on("Network.requestWillBeSent", (params) => {
      const req = params.request as { method?: string; url?: string } | undefined;
      const requestId = String(params.requestId ?? "");
      if (req) t.pendingRequests.set(requestId, { method: req.method ?? "GET", url: req.url ?? "" });
    });
    cdp.on("Network.responseReceived", (params) => {
      const res = params.response as { status?: number; url?: string } | undefined;
      const requestId = String(params.requestId ?? "");
      const meta = t.pendingRequests.get(requestId) ?? { method: "GET", url: res?.url ?? "" };
      if (t.pendingRequests.size > 2000) t.pendingRequests.clear();
      const entry: NetworkRequestEntry = {
        id: this.uid("n"),
        method: meta.method,
        url: meta.url,
        status: res?.status ?? 0,
        type: String(params.type ?? "other"),
        ts: Date.now(),
      };
      t.cdpBuffers.network.push(entry);
      if (t.cdpBuffers.network.length > MAX_BUFFER) t.cdpBuffers.network.shift();
      this.emit({ type: "network-request", tabId, entry });
    });
    return cdp;
  }

  consoleLogs(tabId: string): ConsoleLogEntry[] {
    const t = this.tabs.get(tabId) ?? this.active();
    return t?.cdpBuffers.consoleLogs ?? [];
  }
  networkRequests(tabId: string): NetworkRequestEntry[] {
    const t = this.tabs.get(tabId) ?? this.active();
    return t?.cdpBuffers.network ?? [];
  }
  async performanceMetrics(tabId: string): Promise<Array<{ name: string; value: number }>> {
    const cdp = await this.cdpSession(tabId);
    const res = (await cdp.send("Performance.getMetrics")) as { metrics?: Array<{ name: string; value: number }> };
    return res.metrics ?? [];
  }
  async evaluate(tabId: string, expression: string): Promise<unknown> {
    const t = this.tabs.get(tabId) ?? this.active();
    if (!t) throw new Error("没有打开的浏览器标签页");
    const result = await t.page.evaluate(`(async () => { return ${expression} })()`);
    // 视图同步：JS 可能修改 DOM / 触发导航
    this.pushState();
    return result;
  }

  async dispose(): Promise<void> {
    await this.stopScreencast().catch(() => {});
    try {
      await this.context?.close();
    } catch {
      /* ignore */
    }
    this.context = null;
    this.tabs.clear();
    this.activeId = null;
  }

  private uid(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
