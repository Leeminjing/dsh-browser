import type { CDPSession, Frame, Page } from "playwright";
import type { Annotation, BrowserStores } from "./stores.js";
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
export type ManagerEvent = {
    type: "state";
    state: BrowserState;
} | {
    type: "shot";
    tabId: string;
    ts: number;
} | {
    type: "annotation";
    annotation: Annotation;
} | {
    type: "upload-blocked";
    tabId: string;
    url: string;
} | {
    type: "navigated";
    tabId: string;
    url: string;
    title: string;
    actorSession?: string;
} | {
    type: "console-log";
    tabId: string;
    entry: ConsoleLogEntry;
} | {
    type: "network-request";
    tabId: string;
    entry: NetworkRequestEntry;
};
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
    /** 外部浏览器模式（路线 C）：Agent 直接驱动面板内 iframe 的目标帧 */
    targetFrame?: Frame;
    /** 是否外部浏览器模式（无 Playwright 隔离 profile，直接操作用户浏览器） */
    external: boolean;
    cdp?: CDPSession;
    cdpEnabled: boolean;
    cdpBuffers: {
        consoleLogs: ConsoleLogEntry[];
        network: NetworkRequestEntry[];
    };
    pendingFileChooser?: {
        files: Array<{
            name: string;
            mimeType: string;
            buffer: Buffer;
        }>;
        resolve: () => void;
    };
    /** requestId → {method, url}（Network 事件关联用） */
    pendingRequests: Map<string, {
        method: string;
        url: string;
    }>;
}
export interface BrowserManagerOptions {
    stores: BrowserStores;
    profileDir: string;
    shotsDir: string;
    viewport?: {
        width: number;
        height: number;
    };
    headless?: boolean;
    /** 外部浏览器模式（路线 C）：设为用户浏览器 CDP 地址（如 http://127.0.0.1:9222）。
     *  直接连接用户浏览器并驱动共享视图面板内的目标 iframe——原生渲染、实时同步，无隔离。 */
    cdpUrl?: string;
    /** 共享视图基础地址（标记/识别帧用） */
    viewBase?: string;
    /** GUI 地址（自动重启浏览器后打开；默认 http://127.0.0.1:3080） */
    guiUrl?: string;
    onEvent?: (ev: ManagerEvent) => void;
}
export declare class BrowserManager {
    private opts;
    private context;
    private tabs;
    private activeId;
    private seq;
    private listeners;
    /** 当前发起浏览器操作的会话（由工具调用设置，用于把导航事件归属到具体会话） */
    private actorSession;
    /** 实时帧流（CDP screencast）：与 DevMode 门控的 cdpSession 相互独立 */
    private streamCdp;
    private streamTabId;
    private streamFrameListeners;
    /** 当前视口尺寸（共享面板自适应；新标签页沿用同一尺寸） */
    private viewportSize;
    /** 外部浏览器模式的 CDP 连接（connectOverCDP；dispose 时仅断开，不关闭用户浏览器） */
    private connectedBrowser;
    /** 外部模式：目标帧变化后刷新标签状态（adoptPage 内挂载） */
    private syncTabNav;
    /** 自动探测到的外部浏览器 CDP 地址（start-external.ps1 启动的调试端口） */
    private autoCdpUrl;
    constructor(opts: BrowserManagerOptions);
    /** 是否外部浏览器模式（配置了 CDP 地址，或自动探测/自动拉起成功） */
    private get isExternalMode();
    /** 外部模式已实际连接并驱动用户浏览器内的共享面板 iframe（无隔离 profile） */
    get external(): boolean;
    /** 浏览器实例是否已建立（隔离浏览器已启动，或外部浏览器已连接） */
    get connected(): boolean;
    /** 自动探测本机是否有带调试端口的浏览器（start-external.ps1 用 9222） */
    private probeExternal;
    /**
     * 视图打开时调用：若配置了 DSH_BROWSER_CDP_URL 或探测到带调试端口的浏览器，
     * 则进入外部浏览器模式（原生实时视图）；否则什么都不做（保持内置隔离模式，绝不弹窗）。
     */
    tryConnectExternal(): Promise<void>;
    /** 本机是否有可自动重启的浏览器（Chrome/Edge） */
    get canRelaunchBrowser(): boolean;
    private findBrowserExe;
    /**
     * 自动重启浏览器以启用外部原生模式（实时 iframe）：
     * 优先重启用户「正在运行的」浏览器（tasklist 判定），保留默认 profile，带 --remote-debugging-port 重启
     * 并恢复所有窗口 → 打开 GUI（?dsh-browser=open 自动展开面板）→ 轮询验证调试端口真的起来。
     * 只在用户从面板确认后调用（会暂时关闭其浏览器窗口）。
     */
    relaunchBrowserForExternal(uaHint?: string): Promise<{
        ok: boolean;
        error?: string;
    }>;
    /**
     * 外部模式：重新扫描目标帧（面板 #live-frame）并给共享视图帧打「本窗口」标记。
     * 每次 /api/state 都会调用——新窗口的面板是异步出现的，需持续补齐。
     */
    refreshExternalTarget(): Promise<void>;
    onEvent(cb: (ev: ManagerEvent) => void): void;
    private emit;
    /** 记录当前由哪个会话发起浏览器操作（exec.agent.id）。 */
    setActorSession(sessionId: string): void;
    get stores(): BrowserStores;
    onScreencastFrame(cb: (frame: ScreencastFrame) => void): void;
    private emitFrame;
    /** 开始对指定标签页做 CDP screencast 实时帧流（无 DevMode 依赖） */
    startScreencast(tabId?: string): Promise<void>;
    stopScreencast(): Promise<void>;
    /** 共享面板自适应：调整当前标签页视口尺寸 → 页面响应式重排，帧流 1:1 铺满面板 */
    resizeViewport(width: number, height: number): Promise<void>;
    /** 只注入鼠标移动（hover 反馈）；坐标按视口 CSS 像素 */
    mouseMove(tabId: string, x: number, y: number): Promise<void>;
    ensure(): Promise<void>;
    private adoptPage;
    private pushState;
    private pushShot;
    state(): Promise<BrowserState>;
    newTab(url?: string): Promise<string>;
    closeTab(tabId: string): Promise<void>;
    setActive(tabId: string): void;
    active(): Tab | undefined;
    getTab(tabId: string): Tab | undefined;
    /** 目标帧在当前顶层页面视口内的偏移（沿 frameElement 链逐级相加） */
    private frameOffset;
    /** 工具执行目标：外部模式 → 目标帧；普通模式 → 主页面 */
    private target;
    navigateTo(tabId: string, url: string): Promise<{
        url: string;
        title: string;
        httpStatus: number | null;
        verified: boolean;
    }>;
    private ensureTab;
    goBack(tabId: string): void;
    goForward(tabId: string): void;
    reload(tabId: string): void;
    findElement(tabId: string, query: string): Promise<PageElement | null>;
    click(tabId: string, query: string): Promise<PageElement>;
    /** 按视口坐标点击（用户/视图页操作，spec #9） */
    clickAt(tabId: string, x: number, y: number): Promise<void>;
    type(tabId: string, query: string, text: string): Promise<PageElement>;
    press(tabId: string, key: string): Promise<void>;
    snapshot(tabId: string): Promise<PageSnapshot>;
    /** 截图并保存到 shots 目录，返回可访问 URL（spec #5/#13 验证与最终状态）。
     *  silent 用于视图页自身的轮询刷新：不发 "shot" 事件，避免「截图→事件→再截图」死循环。
     *  外部模式：截取目标帧所在区域（clip = 帧在顶层页面视口内的位置与尺寸）。 */
    screenshot(tabId: string, opts?: {
        silent?: boolean;
    }): Promise<{
        file: string;
        url: string;
        ts: number;
    }>;
    /** 截图保留策略：只保留最近 MAX_SHOTS 张，防止磁盘无限增长 */
    private static readonly MAX_SHOTS;
    private pruneShots;
    setAnnotationMode(tabId: string, on: boolean): Promise<void>;
    listAnnotations(url?: string): Annotation[];
    provideUpload(tabId: string, files: Array<{
        name: string;
        mimeType: string;
        base64: string;
    }>): Promise<void>;
    cdpSession(tabId: string): Promise<CDPSession>;
    consoleLogs(tabId: string): ConsoleLogEntry[];
    networkRequests(tabId: string): NetworkRequestEntry[];
    performanceMetrics(tabId: string): Promise<Array<{
        name: string;
        value: number;
    }>>;
    evaluate(tabId: string, expression: string): Promise<unknown>;
    dispose(): Promise<void>;
    private uid;
}
export {};
