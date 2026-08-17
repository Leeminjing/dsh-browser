import type { Agent } from "@deepseek-ai/dsh-agent";
import type { BrowserStores } from "./stores.js";
import { type RiskInput } from "./stores.js";
export interface AskQuestion {
    id: string;
    question: string;
    header?: string;
    options?: Array<{
        label: string;
        description?: string;
    }>;
}
/**
 * 发起一次 GUI 用户问答。`agent` 必须传给 `userQuestions.ask`：
 * web 部署的宿主 provider（dsh-host-apiproxy）要求问答必须绑定 agent 所属会话，
 * 否则直接拒绝（ASK_MISSING_AGENT），所有门控都会静默失败。
 */
export type AskFn = (q: AskQuestion, signal?: AbortSignal, agent?: Agent) => Promise<string | null>;
export interface GateDeps {
    stores: BrowserStores;
    ask: AskFn;
    /** 当前标签页 URL（供「站点权限」检查使用） */
    currentUrl: () => string;
}
export type AccessResult = "ok" | "blocked" | "cancelled";
export declare class Gates {
    private deps;
    constructor(deps: GateDeps);
    private hostOf;
    /**
     * spec #6：访问站点前检查权限；未知站点 → 请求用户授权。
     */
    ensureSiteAccess(host: string, url: string, kind?: "navigation" | "history" | "cdp", agent?: Agent, signal?: AbortSignal): Promise<AccessResult>;
    /** 检查（并在必要时请求）当前标签页站点的访问权限 */
    ensureCurrentSiteAccess(agent?: Agent, signal?: AbortSignal): Promise<AccessResult>;
    /**
     * spec #7：即使网站已允许，敏感动作（提交/购买/删除/权限变更等）仍需二次确认。
     */
    guardRisk(input: RiskInput, host: string, url: string, agent?: Agent, signal?: AbortSignal): Promise<{
        ok: true;
    } | {
        ok: false;
        reason: string;
    }>;
    /** spec #11：读取浏览历史需授权 */
    ensureHistoryAccess(agent?: Agent, signal?: AbortSignal): Promise<AccessResult>;
    /**
     * spec #12：Developer Mode 必须开启；针对该网站需批准（且网站本身已允许访问）。
     */
    gateFullCdp(host: string, url: string, agent?: Agent, signal?: AbortSignal): Promise<{
        ok: true;
    } | {
        ok: false;
        reason: string;
    }>;
}
