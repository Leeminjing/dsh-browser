// ============================================================================
// BrowserManager：用 Playwright 驱动一个「内置浏览器」。
//   - 独立持久化 profile（persist userDataDir，spec #3 状态隔离）
//   - 多标签页（共享同一 context → 共享 cookie/localStorage）
//   - 导航 / 点击 / 输入 / 快照 / 截图 / 键盘
//   - 文件上传拦截（spec #8）、对话框自动处理、console 捕获（含标注上报）
//   - Developer Mode：CDPSession 深度调试（console/network/performance，spec #12）
// ============================================================================
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildOverlayExitScript, buildOverlayScript, parseAnnotationPayload } from "./annotations.js";
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
const FIND_ELEMENT_SCRIPT = (query) => `
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
const FOCUS_INPUT_SCRIPT = (query) => `
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
    opts;
    context = null;
    tabs = new Map();
    activeId = null;
    seq = 0;
    listeners = [];
    /** 当前发起浏览器操作的会话（由工具调用设置，用于把导航事件归属到具体会话） */
    actorSession = "";
    /** 实时帧流（CDP screencast）：与 DevMode 门控的 cdpSession 相互独立 */
    streamCdp = null;
    streamTabId = null;
    streamFrameListeners = [];
    /** 当前视口尺寸（共享面板自适应；新标签页沿用同一尺寸） */
    viewportSize = { width: 1280, height: 800 };
    /** 外部浏览器模式的 CDP 连接（connectOverCDP；dispose 时仅断开，不关闭用户浏览器） */
    connectedBrowser = null;
    /** 外部模式：目标帧变化后刷新标签状态（adoptPage 内挂载） */
    syncTabNav = null;
    /** 自动探测到的外部浏览器 CDP 地址（start-external.ps1 启动的调试端口） */
    autoCdpUrl = null;
    constructor(opts) {
        this.opts = opts;
    }
    /** 是否外部浏览器模式（配置了 CDP 地址，或自动探测/自动拉起成功） */
    get isExternalMode() {
        return !!this.opts.cdpUrl || !!this.autoCdpUrl;
    }
    /** 外部模式已实际连接并驱动用户浏览器内的共享面板 iframe（无隔离 profile） */
    get external() {
        return this.isExternalMode && this.tabs.size > 0 && this.active()?.external === true;
    }
    /** 浏览器实例是否已建立（隔离浏览器已启动，或外部浏览器已连接） */
    get connected() {
        return !!this.context;
    }
    /** 自动探测本机是否有带调试端口的浏览器（start-external.ps1 用 9222） */
    async probeExternal() {
        for (const port of [9222, 9223, 9224]) {
            try {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 800);
                const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctrl.signal });
                clearTimeout(timer);
                if (res.ok)
                    return `http://127.0.0.1:${port}`;
            }
            catch {
                /* 无响应，试下一个端口 */
            }
        }
        return null;
    }
    /**
     * 视图打开时调用：若配置了 DSH_BROWSER_CDP_URL 或探测到带调试端口的浏览器，
     * 则进入外部浏览器模式（原生实时视图）；否则什么都不做（保持内置隔离模式，绝不弹窗）。
     */
    async tryConnectExternal() {
        if (this.context)
            return;
        const url = this.opts.cdpUrl ?? (await this.probeExternal());
        if (!url)
            return;
        this.autoCdpUrl = url;
        await this.ensure();
        await this.refreshExternalTarget();
    }
    /** 本机是否有可自动重启的浏览器（Chrome/Edge） */
    get canRelaunchBrowser() {
        try {
            return this.findBrowserExe() !== null;
        }
        catch {
            return false;
        }
    }
    findBrowserExe(uaHint) {
        const candidates = [
            `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
            `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ];
        // 用户正在用的浏览器（UA 含 Edg/ 为 Edge，否则 Chrome）优先
        if (uaHint && /Edg\//i.test(uaHint)) {
            const edge = candidates.find((p) => !!p && existsSync(p) && p.includes("Edge"));
            if (edge)
                return edge;
        }
        const chrome = candidates.find((p) => !!p && existsSync(p) && p.includes("Chrome"));
        if (chrome)
            return chrome;
        return candidates.find((p) => !!p && existsSync(p)) ?? null;
    }
    /**
     * 自动重启浏览器以启用外部原生模式（实时 iframe）：
     * 关掉当前浏览器（保留 profile）→ 带 --remote-debugging-port 重启并恢复所有窗口 →
     * 打开 GUI（?dsh-browser=open 自动展开面板）→ 插件探测端口并连接。
     * 只在用户从面板确认后调用（会暂时关闭其浏览器窗口）。
     * @param uaHint 视图页的 navigator.userAgent，用于判定用户实际使用的浏览器（Chrome/Edge）
     */
    async relaunchBrowserForExternal(uaHint) {
        if (this.external)
            return false; // 已连接外部浏览器，无需重启
        try {
            const { spawn, execSync } = await import("node:child_process");
            const exe = this.findBrowserExe(uaHint);
            if (!exe)
                return false;
            const name = exe.includes("Chrome") ? "chrome.exe" : "msedge.exe";
            const gui = this.opts.guiUrl ?? "http://127.0.0.1:3080";
            // 0) 先释放内置隔离浏览器（若有）：关闭其进程、清空状态，
            //    否则 ensure() 会因 context 已存在而跳过外部连接分支。
            if (this.context && !this.isExternalMode) {
                try {
                    await this.context.close();
                }
                catch {
                    /* ignore */
                }
                this.context = null;
                this.tabs.clear();
                this.activeId = null;
                this.streamCdp = null;
                this.streamTabId = null;
            }
            // 1) 关闭当前浏览器全部实例（profile 保留；--restore-last-session 会恢复窗口）
            try {
                execSync(`taskkill /IM ${name} /F`, { stdio: "ignore", windowsHide: true });
            }
            catch {
                /* 可能本来就没在跑 */
            }
            await new Promise((r) => setTimeout(r, 900));
            // 2) 带调试端口重启，恢复上次窗口 + 打开 GUI（自动展开面板）
            const p = spawn(exe, ["--remote-debugging-port=9222", "--restore-last-session", "--no-first-run", "--no-default-browser-check", `${gui}?dsh-browser=open`], { detached: true, stdio: "ignore" });
            p.unref();
            // 3) 轮询等待 CDP 就绪（最长 ~15s）
            for (let i = 0; i < 30; i++) {
                const url = await this.probeExternal();
                if (url) {
                    this.autoCdpUrl = url;
                    break;
                }
                await new Promise((r) => setTimeout(r, 500));
            }
            return !!this.autoCdpUrl;
        }
        catch {
            return false;
        }
    }
    /**
     * 外部模式：重新扫描目标帧（面板 #live-frame）并给共享视图帧打「本窗口」标记。
     * 每次 /api/state 都会调用——新窗口的面板是异步出现的，需持续补齐。
     */
    async refreshExternalTarget() {
        const tab = this.active();
        if (!tab || !tab.external)
            return;
        if (!tab.targetFrame) {
            const live = tab.page
                .frames()
                .find((f) => {
                const pf = f.parentFrame();
                return pf !== null && pf.url().includes(":9333");
            });
            if (live)
                tab.targetFrame = live;
        }
        // 标记共享视图帧：只有被标记的窗口才显示外部模式原生视图
        for (const f of tab.page.frames()) {
            try {
                if (f.url().includes(":9333"))
                    await f.evaluate(() => { window.__dshExternal = true; });
            }
            catch {
                /* 帧分离/跨域失败可忽略 */
            }
        }
        await this.syncTabNav?.(tab);
    }
    onEvent(cb) {
        this.listeners.push(cb);
    }
    emit(ev) {
        for (const cb of this.listeners)
            cb(ev);
    }
    /** 记录当前由哪个会话发起浏览器操作（exec.agent.id）。 */
    setActorSession(sessionId) {
        this.actorSession = sessionId;
    }
    get stores() {
        return this.opts.stores;
    }
    // ---- 实时帧流（Codex 式共享视图：CDP screencast）----
    onScreencastFrame(cb) {
        this.streamFrameListeners.push(cb);
    }
    emitFrame(frame) {
        for (const cb of this.streamFrameListeners) {
            try {
                cb(frame);
            }
            catch {
                /* ignore */
            }
        }
    }
    /** 开始对指定标签页做 CDP screencast 实时帧流（无 DevMode 依赖） */
    async startScreencast(tabId) {
        // 外部模式：面板 iframe 本身就是实时原生视图，无需截图帧流
        if (this.isExternalMode)
            return;
        await this.ensure();
        const tab = this.tabs.get(tabId ?? "") ?? this.active();
        if (!tab)
            throw new Error("没有打开的浏览器标签页");
        if (this.streamTabId === tab.id && this.streamCdp)
            return;
        await this.stopScreencast();
        const cdp = await this.context.newCDPSession(tab.page);
        this.streamCdp = cdp;
        this.streamTabId = tab.id;
        cdp.on("Page.screencastFrame", (params) => {
            const p = params;
            if (!p.data)
                return;
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
                void cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => { });
            }
        });
        try {
            await cdp.send("Page.enable");
            // 帧分辨率 = 视口 CSS 尺寸 × DPR（2）：页面按 DPR2 渲染（超采样），
            // 面板显示时 2x→1x 降采样 → 在高 DPI 屏（DPR2 显示器）上文字依然锐利。
            // 帧元数据 deviceWidth/Height 仍是 CSS 尺寸，视图侧坐标换算不受影响。
            const vp = this.viewportSize;
            const dpr = 2;
            await cdp.send("Page.startScreencast", {
                format: "jpeg",
                // quality 85：截图帧是 JPEG 有损编码，太低会让文字边缘发糊
                quality: 85,
                maxWidth: Math.max(320, vp.width * dpr),
                maxHeight: Math.max(240, vp.height * dpr),
                everyNthFrame: 1,
            });
        }
        catch (err) {
            this.streamCdp = null;
            this.streamTabId = null;
            try {
                cdp.detach();
            }
            catch {
                /* ignore */
            }
            throw err;
        }
    }
    async stopScreencast() {
        const cdp = this.streamCdp;
        this.streamCdp = null;
        this.streamTabId = null;
        if (cdp) {
            try {
                await cdp.send("Page.stopScreencast");
            }
            catch {
                /* ignore */
            }
            try {
                cdp.detach();
            }
            catch {
                /* ignore */
            }
        }
    }
    /** 共享面板自适应：调整当前标签页视口尺寸 → 页面响应式重排，帧流 1:1 铺满面板 */
    async resizeViewport(width, height) {
        // 外部模式：视口由用户浏览器自身决定，无需（也不能）调整
        if (this.isExternalMode)
            return;
        // 浏览器尚未启动时不做任何事（保留占位页；首个标签页打开后会随面板尺寸调整）
        if (!this.context)
            return;
        const tab = this.active();
        if (!tab)
            return;
        const w = Math.max(320, Math.min(4096, Math.round(width)));
        const h = Math.max(240, Math.min(4096, Math.round(height)));
        const cur = tab.page.viewportSize();
        if (cur && Math.abs(cur.width - w) < 2 && Math.abs(cur.height - h) < 2)
            return;
        this.viewportSize = { width: w, height: h };
        await tab.page.setViewportSize({ width: w, height: h });
        // 帧流尺寸跟随新视口（重启 screencast，maxWidth/maxHeight 取新尺寸）
        if (this.streamCdp && this.streamTabId === tab.id) {
            await this.startScreencast(tab.id).catch(() => { });
        }
        this.pushState();
    }
    /** 只注入鼠标移动（hover 反馈）；坐标按视口 CSS 像素 */
    async mouseMove(tabId, x, y) {
        const t = this.tabs.get(tabId) ?? this.active();
        if (!t)
            return;
        if (t.targetFrame) {
            const off = await this.frameOffset(t.targetFrame);
            await t.page.mouse.move(off.x + x, off.y + y);
        }
        else {
            await t.page.mouse.move(x, y);
        }
    }
    async ensure() {
        if (this.context)
            return;
        // 动态导入 playwright：缺失时给出清晰错误，不影响 harness 启动
        let chromium;
        try {
            chromium = (await import("playwright")).chromium;
        }
        catch {
            throw new Error("内置浏览器依赖 playwright 未安装。请在 profile 中运行 `pnpm add playwright && pnpm exec playwright install chromium` 后重启。");
        }
        // ---- 外部浏览器模式（路线 C）：直接连接用户浏览器（--remote-debugging-port）----
        const externalUrl = this.opts.cdpUrl ?? this.autoCdpUrl;
        if (externalUrl) {
            const browser = await chromium.connectOverCDP(externalUrl);
            this.connectedBrowser = browser;
            const context = browser.contexts()[0] ?? (await browser.newContext());
            this.context = context;
            // 找到承载共享视图面板的页面（含 :9333 帧的标签页；也可能是独立打开的共享视图标签页）
            let guiPage = null;
            for (const page of context.pages()) {
                const frames = page.frames();
                if (frames.some((f) => f.url().includes(":9333")) || page.url().includes(":9333")) {
                    guiPage = page;
                    break;
                }
            }
            if (!guiPage) {
                // 面板可能尚未加载（新窗口还在打开中）：先认领第一个标签页，目标帧稍后补齐
                const first = context.pages()[0];
                if (first)
                    guiPage = first;
            }
            if (!guiPage) {
                throw new Error(`外部浏览器模式：在 ${externalUrl} 上没有可用的标签页。` +
                    "请用 --remote-debugging-port 启动浏览器后打开 DSH GUI（共享视图面板会自动出现），再重试。");
            }
            const tab = await this.adoptPage(guiPage);
            tab.external = true;
            // 目标帧 = 面板 #live-frame（:9333 页面的 iframe 子帧）
            const live = guiPage
                .frames()
                .find((f) => {
                const pf = f.parentFrame();
                return pf !== null && pf.url().includes(":9333");
            });
            if (live)
                tab.targetFrame = live;
            await this.syncTabNav?.(tab);
            this.pushState();
            return;
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
    async adoptPage(page) {
        const tab = {
            id: `tab_${++this.seq}`,
            page,
            title: (await page.title()) || "新标签页",
            url: await page.url(),
            loading: false,
            canGoBackCache: false,
            fwdStack: [],
            external: false,
            cdpEnabled: false,
            cdpBuffers: { consoleLogs: [], network: [] },
            pendingRequests: new Map(),
        };
        this.tabs.set(tab.id, tab);
        this.activeId = tab.id;
        const syncNavState = async () => {
            // 外部模式：url/title 来自目标帧（面板 iframe），而非 GUI 页面本身
            if (tab.targetFrame) {
                try {
                    tab.url = await tab.targetFrame.url();
                    tab.title = (await tab.targetFrame.title()) || tab.title;
                }
                catch {
                    /* 帧已分离 */
                }
            }
            else {
                tab.url = await page.url();
                tab.title = (await page.title()) || tab.title;
            }
            try {
                const hist = tab.targetFrame
                    ? (await tab.targetFrame.evaluate(() => window.history.length > 1))
                    : (await page.evaluate(() => window.history.length > 1));
                tab.canGoBackCache = hist;
            }
            catch {
                tab.canGoBackCache = false;
            }
        };
        /** 外部模式：目标帧变化后刷新标签状态（导航 / 重新挂载） */
        this.syncTabNav = async (t) => {
            await syncNavState();
            this.pushState();
        };
        page.on("framenavigated", (frame) => {
            // 外部模式：只响应目标帧（面板 iframe）的导航；普通模式：只响应主页面导航
            if (!tab.external && frame !== page.mainFrame())
                return;
            if (tab.external && (!tab.targetFrame || frame !== tab.targetFrame))
                return;
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
            const entry = {
                id: this.uid("c"),
                level: msg.type(),
                message: text.slice(0, 2000),
                url: tab.url,
                ts: Date.now(),
            };
            tab.cdpBuffers.consoleLogs.push(entry);
            if (tab.cdpBuffers.consoleLogs.length > MAX_BUFFER)
                tab.cdpBuffers.consoleLogs.shift();
            this.emit({ type: "console-log", tabId: tab.id, entry });
        });
        page.on("dialog", (dialog) => {
            void dialog.dismiss().catch(() => { });
        });
        page.on("filechooser", (fc) => {
            // spec #8：不自动完成上传。若用户（通过视图页）已提供文件，则填充；否则仅提示。
            if (tab.pendingFileChooser) {
                const { files, resolve } = tab.pendingFileChooser;
                tab.pendingFileChooser = undefined;
                fc.setFiles(files.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: f.buffer })))
                    .then(() => resolve())
                    .catch(() => resolve());
            }
            else {
                this.emit({ type: "upload-blocked", tabId: tab.id, url: tab.url });
            }
        });
        page.on("download", (dl) => {
            void dl.cancel().catch(() => { });
        });
        page.on("popup", (popup) => {
            void popup.close().catch(() => { });
        });
        page.on("close", () => {
            this.tabs.delete(tab.id);
            if (this.streamTabId === tab.id)
                void this.stopScreencast();
            if (this.activeId === tab.id)
                this.activeId = this.tabs.keys().next().value ?? null;
            this.pushState();
        });
        return tab;
    }
    pushState() {
        void this.state().then((s) => this.emit({ type: "state", state: s }));
    }
    pushShot(tabId) {
        this.emit({ type: "shot", tabId, ts: Date.now() });
    }
    async state() {
        const tabs = [];
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
    async newTab(url) {
        if (this.isExternalMode) {
            throw new Error("外部浏览器模式（路线 C）：Agent 只驱动共享面板内的目标页面，不支持开新标签页。");
        }
        await this.ensure();
        const page = await this.context.newPage();
        await page.setViewportSize(this.viewportSize).catch(() => { });
        const tab = await this.adoptPage(page);
        if (url)
            await this.navigateTo(tab.id, url);
        if (this.streamCdp)
            void this.startScreencast(tab.id);
        return tab.id;
    }
    async closeTab(tabId) {
        if (this.isExternalMode)
            throw new Error("外部浏览器模式：不支持关闭用户浏览器标签页。");
        const tab = this.tabs.get(tabId);
        if (tab) {
            await tab.page.close().catch(() => { });
            this.tabs.delete(tabId);
            if (this.activeId === tabId)
                this.activeId = this.tabs.keys().next().value ?? null;
            this.pushState();
        }
    }
    setActive(tabId) {
        if (this.tabs.has(tabId)) {
            this.activeId = tabId;
            // 实时帧流跟随活动标签
            if (this.streamCdp)
                void this.startScreencast(tabId);
            this.pushState();
        }
    }
    active() {
        return this.activeId ? this.tabs.get(this.activeId) : this.tabs.values().next().value;
    }
    getTab(tabId) {
        return this.tabs.get(tabId);
    }
    // ---- 外部模式（路线 C）：目标帧坐标映射 ----
    /** 目标帧在当前顶层页面视口内的偏移（沿 frameElement 链逐级相加） */
    async frameOffset(frame) {
        let x = 0;
        let y = 0;
        let f = frame;
        while (f) {
            const r = await f.evaluate(() => {
                const fe = window.frameElement;
                if (!fe)
                    return null;
                const rect = fe.getBoundingClientRect();
                return { x: rect.x, y: rect.y };
            }).catch(() => null);
            if (!r)
                break;
            x += r.x;
            y += r.y;
            f = f.parentFrame();
        }
        return { x, y };
    }
    /** 工具执行目标：外部模式 → 目标帧；普通模式 → 主页面 */
    target(tab) {
        return tab.targetFrame ?? tab.page;
    }
    // ---- 导航 ----
    async navigateTo(tabId, url) {
        const tab = this.tabs.get(tabId) ?? this.active() ?? (await this.ensureTab());
        await this.ensure();
        tab.loading = true;
        // 外部模式：导航目标帧（面板 iframe），页面在面板中原生渲染
        if (tab.targetFrame) {
            await tab.targetFrame.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        }
        else if (tab.external) {
            throw new Error("外部浏览器模式：共享面板尚未就绪（正在等待外部浏览器窗口打开面板），请稍后重试。");
        }
        else {
            await tab.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        }
        let httpStatus = null;
        const currentUrl = tab.targetFrame ? tab.targetFrame.url() : await tab.page.url();
        if (/^https?:/i.test(url)) {
            try {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 10_000);
                let res;
                try {
                    res = await fetch(currentUrl, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
                }
                catch {
                    res = await fetch(currentUrl, { method: "GET", redirect: "follow", signal: ctrl.signal });
                }
                clearTimeout(timer);
                httpStatus = res.status;
            }
            catch {
                httpStatus = null;
            }
        }
        tab.url = currentUrl;
        tab.title = (tab.targetFrame ? await tab.targetFrame.title().catch(() => "") : await tab.page.title()) || tab.title;
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
    async ensureTab() {
        await this.ensure();
        const existing = this.active();
        if (existing)
            return existing;
        const page = await this.context.newPage();
        await page.setViewportSize(this.viewportSize).catch(() => { });
        return this.adoptPage(page);
    }
    goBack(tabId) {
        const t = this.tabs.get(tabId) ?? this.active();
        if (t) {
            void (async () => {
                const prev = await t.page.url();
                try {
                    await t.page.goBack({ waitUntil: "domcontentloaded" });
                    const now = await t.page.url();
                    if (now !== prev)
                        t.fwdStack.push(prev);
                    this.pushState();
                }
                catch {
                    /* 无可后退 */
                }
            })();
        }
    }
    goForward(tabId) {
        const t = this.tabs.get(tabId) ?? this.active();
        if (t) {
            void (async () => {
                const next = t.fwdStack.pop();
                if (next) {
                    try {
                        await t.page.goto(next, { waitUntil: "domcontentloaded" });
                        this.pushState();
                    }
                    catch {
                        /* ignore */
                    }
                }
                else {
                    try {
                        await t.page.goForward({ waitUntil: "domcontentloaded" });
                        this.pushState();
                    }
                    catch {
                        /* ignore */
                    }
                }
            })();
        }
    }
    reload(tabId) {
        const t = this.tabs.get(tabId) ?? this.active();
        if (!t)
            return;
        // 外部模式：刷新目标帧（面板 iframe）
        void (async () => {
            try {
                if (t.targetFrame) {
                    // Frame 无 reload API：同 URL 重新 goto 即刷新
                    const cur = t.targetFrame.url();
                    if (cur && cur !== "about:blank")
                        await t.targetFrame.goto(cur, { waitUntil: "domcontentloaded" });
                    else
                        await t.targetFrame.evaluate(() => location.reload()).catch(() => { });
                }
                else {
                    await t.page.reload({ waitUntil: "domcontentloaded" });
                }
            }
            catch {
                /* ignore */
            }
            this.pushState();
        })();
    }
    // ---- 页面操作 ----
    async findElement(tabId, query) {
        const t = this.tabs.get(tabId) ?? this.active();
        if (!t)
            throw new Error("没有打开的浏览器标签页");
        return (await this.target(t).evaluate(FIND_ELEMENT_SCRIPT(query)));
    }
    async click(tabId, query) {
        const t = this.tabs.get(tabId) ?? this.active();
        if (!t)
            throw new Error("没有打开的浏览器标签页");
        const el = await this.findElement(tabId, query);
        if (!el)
            throw new Error(`页面上找不到可点击元素: ${query}`);
        if (el.disabled)
            throw new Error(`元素「${query}」当前处于禁用状态`);
        // 外部模式：元素坐标是帧内局部坐标，需映射到顶层页面视口坐标
        if (t.targetFrame) {
            const off = await this.frameOffset(t.targetFrame);
            await t.page.mouse.click(off.x + el.x + el.w / 2, off.y + el.y + el.h / 2);
        }
        else {
            await t.page.mouse.click(el.x + el.w / 2, el.y + el.h / 2);
        }
        // 视图同步：点击可能改变页面内容/触发导航，发 state 让共享视图刷新（视图页忽略 shot 事件，故不能用 pushShot）
        this.pushState();
        return el;
    }
    /** 按视口坐标点击（用户/视图页操作，spec #9） */
    async clickAt(tabId, x, y) {
        const t = this.tabs.get(tabId) ?? this.active();
        if (!t)
            throw new Error("没有打开的浏览器标签页");
        if (t.targetFrame) {
            const off = await this.frameOffset(t.targetFrame);
            await t.page.mouse.click(off.x + x, off.y + y);
        }
        else {
            await t.page.mouse.click(x, y);
        }
        this.pushShot(tabId);
    }
    async type(tabId, query, text) {
        const t = this.tabs.get(tabId) ?? this.active();
        if (!t)
            throw new Error("没有打开的浏览器标签页");
        const target = this.target(t);
        let el = null;
        if (query !== "*") {
            el = await this.findElement(tabId, query);
            if (!el)
                throw new Error(`页面上找不到输入框: ${query}`);
            if (el.disabled)
                throw new Error(`输入框「${query}」当前处于禁用状态`);
            if (el.type === "file") {
                throw new Error("网页要求上传文件，但内置浏览器不能自动完成文件上传（spec #8）。");
            }
            await target.evaluate(FOCUS_INPUT_SCRIPT(query));
        }
        else {
            // * → 优先输入到「当前已聚焦」的可见输入框（用户点击哪个字段就输入到哪）；
            // 否则聚焦第一个可见输入框（跳过隐藏元素，如登录页残留输入框）
            await target.evaluate(`(() => {
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
        })()`);
        }
        // 瞬时注入文本（不经逐字键盘事件，减少输入延迟；触发 input 事件，兼容受控表单）。
        // 焦点已落在目标帧内，page.keyboard 的 CDP Input 事件会路由到聚焦的帧。
        await t.page.keyboard.insertText(text);
        // 视图同步：输入内容后刷新共享视图
        this.pushState();
        return el ?? { index: 0, tag: "input", role: "", text: "", name: "", href: "", type: "", value: "", disabled: false, x: 0, y: 0, w: 0, h: 0 };
    }
    async press(tabId, key) {
        const t = this.tabs.get(tabId) ?? this.active();
        if (!t)
            throw new Error("没有打开的浏览器标签页");
        await t.page.keyboard.press(key);
        // 视图同步：按键（如 Enter 提交/导航）后刷新共享视图
        this.pushState();
    }
    async snapshot(tabId) {
        const t = this.tabs.get(tabId) ?? this.active();
        if (!t)
            throw new Error("没有打开的浏览器标签页");
        const data = (await this.target(t).evaluate(SNAPSHOT_SCRIPT));
        return { ...data, at: Date.now() };
    }
    /** 截图并保存到 shots 目录，返回可访问 URL（spec #5/#13 验证与最终状态）。
     *  silent 用于视图页自身的轮询刷新：不发 "shot" 事件，避免「截图→事件→再截图」死循环。
     *  外部模式：截取目标帧所在区域（clip = 帧在顶层页面视口内的位置与尺寸）。 */
    async screenshot(tabId, opts) {
        const t = this.tabs.get(tabId) ?? this.active();
        if (!t)
            throw new Error("没有打开的浏览器标签页");
        const ts = Date.now();
        let buffer;
        if (t.targetFrame) {
            const off = await this.frameOffset(t.targetFrame);
            const box = (await t.targetFrame.evaluate(() => {
                const de = document.documentElement;
                return { w: de.clientWidth, h: de.clientHeight };
            }));
            buffer = await t.page.screenshot({ type: "png", clip: { x: off.x, y: off.y, width: box.w, height: box.h } });
        }
        else {
            buffer = await t.page.screenshot({ type: "png" });
        }
        mkdirSync(this.opts.shotsDir, { recursive: true });
        const file = join(this.opts.shotsDir, `shot_${ts}.png`);
        writeFileSync(file, buffer);
        this.pruneShots();
        if (!opts?.silent)
            this.emit({ type: "shot", tabId, ts });
        return { file, url: `/shots/shot_${ts}.png`, ts };
    }
    /** 截图保留策略：只保留最近 MAX_SHOTS 张，防止磁盘无限增长 */
    static MAX_SHOTS = 200;
    pruneShots() {
        try {
            const shots = readdirSync(this.opts.shotsDir)
                .filter((f) => f.endsWith(".png"))
                .map((f) => ({ f, t: statSync(join(this.opts.shotsDir, f)).mtimeMs }))
                .sort((a, b) => b.t - a.t);
            for (const old of shots.slice(BrowserManager.MAX_SHOTS)) {
                try {
                    unlinkSync(join(this.opts.shotsDir, old.f));
                }
                catch {
                    /* ignore */
                }
            }
        }
        catch {
            /* ignore */
        }
    }
    // ---- 标注（spec #10）----
    async setAnnotationMode(tabId, on) {
        const t = this.tabs.get(tabId) ?? this.active();
        if (!t)
            throw new Error("没有打开的浏览器标签页");
        if (on) {
            const anns = this.opts.stores.listAnnotations(t.url);
            await this.target(t).evaluate(buildOverlayScript(anns));
        }
        else {
            await this.target(t).evaluate(buildOverlayExitScript());
        }
    }
    listAnnotations(url) {
        return this.opts.stores.listAnnotations(url);
    }
    // ---- 用户手动上传（spec #8 / #9 的介入路径）----
    async provideUpload(tabId, files) {
        const t = this.tabs.get(tabId) ?? this.active();
        if (!t)
            throw new Error("没有打开的浏览器标签页");
        await new Promise((resolve) => {
            let timer;
            // 完成回调：无论 filechooser 是否填充，都清理 pending 状态，避免陈旧文件残留
            const done = () => {
                if (timer)
                    clearTimeout(timer);
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
    async cdpSession(tabId) {
        const t = this.tabs.get(tabId) ?? this.active();
        if (!t)
            throw new Error("没有打开的浏览器标签页");
        if (t.cdp)
            return t.cdp;
        const cdp = await this.context.newCDPSession(t.page);
        t.cdp = cdp;
        await cdp.send("Runtime.enable");
        await cdp.send("Log.enable");
        await cdp.send("Network.enable");
        await cdp.send("Page.enable");
        await cdp.send("Performance.enable");
        t.cdpEnabled = true;
        cdp.on("Runtime.consoleAPICalled", (params) => {
            const args = (params.args ?? []).map((a) => a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : a.description ?? "");
            const entry = {
                id: this.uid("c"),
                level: String(params.type ?? "log"),
                message: args.join(" ").slice(0, 2000),
                url: t.url,
                ts: Date.now(),
            };
            t.cdpBuffers.consoleLogs.push(entry);
            if (t.cdpBuffers.consoleLogs.length > MAX_BUFFER)
                t.cdpBuffers.consoleLogs.shift();
            this.emit({ type: "console-log", tabId, entry });
        });
        cdp.on("Log.entryAdded", (params) => {
            const e = params.entry;
            const entry = {
                id: this.uid("c"),
                level: e.level ?? "log",
                message: (e.text ?? "").slice(0, 2000),
                url: e.url ?? t.url,
                ts: Date.now(),
            };
            t.cdpBuffers.consoleLogs.push(entry);
            if (t.cdpBuffers.consoleLogs.length > MAX_BUFFER)
                t.cdpBuffers.consoleLogs.shift();
            this.emit({ type: "console-log", tabId, entry });
        });
        cdp.on("Network.requestWillBeSent", (params) => {
            const req = params.request;
            const requestId = String(params.requestId ?? "");
            if (req)
                t.pendingRequests.set(requestId, { method: req.method ?? "GET", url: req.url ?? "" });
        });
        cdp.on("Network.responseReceived", (params) => {
            const res = params.response;
            const requestId = String(params.requestId ?? "");
            const meta = t.pendingRequests.get(requestId) ?? { method: "GET", url: res?.url ?? "" };
            if (t.pendingRequests.size > 2000)
                t.pendingRequests.clear();
            const entry = {
                id: this.uid("n"),
                method: meta.method,
                url: meta.url,
                status: res?.status ?? 0,
                type: String(params.type ?? "other"),
                ts: Date.now(),
            };
            t.cdpBuffers.network.push(entry);
            if (t.cdpBuffers.network.length > MAX_BUFFER)
                t.cdpBuffers.network.shift();
            this.emit({ type: "network-request", tabId, entry });
        });
        return cdp;
    }
    consoleLogs(tabId) {
        const t = this.tabs.get(tabId) ?? this.active();
        return t?.cdpBuffers.consoleLogs ?? [];
    }
    networkRequests(tabId) {
        const t = this.tabs.get(tabId) ?? this.active();
        return t?.cdpBuffers.network ?? [];
    }
    async performanceMetrics(tabId) {
        const cdp = await this.cdpSession(tabId);
        const res = (await cdp.send("Performance.getMetrics"));
        return res.metrics ?? [];
    }
    async evaluate(tabId, expression) {
        const t = this.tabs.get(tabId) ?? this.active();
        if (!t)
            throw new Error("没有打开的浏览器标签页");
        const result = await this.target(t).evaluate(`(async () => { return ${expression} })()`);
        // 视图同步：JS 可能修改 DOM / 触发导航
        this.pushState();
        return result;
    }
    async dispose() {
        await this.stopScreencast().catch(() => { });
        if (this.isExternalMode) {
            // 外部模式：只断开 CDP 连接，绝不动用户浏览器（context.close 会关掉用户所有标签页）
            try {
                await this.connectedBrowser?.close();
            }
            catch {
                /* ignore */
            }
            this.connectedBrowser = null;
            this.context = null;
            this.tabs.clear();
            this.activeId = null;
            return;
        }
        try {
            await this.context?.close();
        }
        catch {
            /* ignore */
        }
        this.context = null;
        this.tabs.clear();
        this.activeId = null;
    }
    uid(prefix) {
        return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }
}
//# sourceMappingURL=manager.js.map