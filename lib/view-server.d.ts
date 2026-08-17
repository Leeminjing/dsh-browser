import type { BrowserManager } from "./manager.js";
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
export declare class ViewServer {
    private opts;
    private server;
    private port;
    private sseClients;
    /** SSE 客户端的会话过滤（watch 页用 ?session= 订阅，只收到该会话的导航事件） */
    private sseSessions;
    /** 实时帧流客户端（/api/screencast） */
    private streamClients;
    private host;
    constructor(opts: ViewServerOptions);
    get baseUrl(): string;
    start(): Promise<void>;
    stop(): void;
    private sendJson;
    private readBody;
    private serveFile;
    private handle;
    private broadcast;
}
