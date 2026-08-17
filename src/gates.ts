// ============================================================================
// 门控服务：把 spec #6（网站权限）、#7（高风险确认）、#11（历史授权）、
// #12（Developer Mode + full CDP 批准）转成「暂停 Agent → 用户问答 → 继续」。
// ============================================================================

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { BrowserStores } from "./stores.js";
import { assessRisk, type RiskInput } from "./stores.js";

export interface AskQuestion {
  id: string;
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
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

export class Gates {
  constructor(private deps: GateDeps) {}

  private hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  }

  /**
   * spec #6：访问站点前检查权限；未知站点 → 请求用户授权。
   */
  async ensureSiteAccess(host: string, url: string, kind: "navigation" | "history" | "cdp" = "navigation", agent?: Agent, signal?: AbortSignal): Promise<AccessResult> {
    if (!host) return "ok";
    const decision = this.deps.stores.getSiteDecision(host);
    if (decision === "allow") return "ok";
    if (decision === "block") return "blocked";

    const detail =
      kind === "navigation"
        ? `智能体想要访问新网站 ${host}。允许后，内置浏览器将可以打开并操作该网站的页面。`
        : kind === "history"
          ? `智能体想要读取浏览历史（${host} 相关记录）。浏览历史属于你的隐私数据，需要授权。`
          : `智能体想要对 ${host} 使用 full CDP 调试（console/network/performance）。需在 Developer Mode 开启且你批准该网站后才可以。`;

    const choice = await this.deps.ask(
      {
        id: `perm-${host}-${Date.now()}`,
        header: kind === "navigation" ? "网站访问许可" : kind === "history" ? "浏览历史授权" : "Full CDP 批准",
        question: detail,
        options:
          kind === "navigation"
            ? [
                { label: "允许访问", description: "记住此决定，之后可直接使用该网站" },
                { label: "阻止", description: "记住此决定，之后拒绝访问该网站" },
                { label: "取消", description: "本次不访问，不改变设置" },
              ]
            : [
                { label: "允许", description: "记住此决定" },
                { label: "拒绝", description: "记住此决定" },
                { label: "取消", description: "本次不允许" },
              ],
      },
      signal,
      agent,
    );

    if (choice === "允许访问" || choice === "允许") {
      this.deps.stores.setSiteDecision(host, "allow");
      return "ok";
    }
    if (choice === "阻止" || choice === "拒绝") {
      this.deps.stores.setSiteDecision(host, "block");
      return "blocked";
    }
    return "cancelled";
  }

  /** 检查（并在必要时请求）当前标签页站点的访问权限 */
  async ensureCurrentSiteAccess(agent?: Agent, signal?: AbortSignal): Promise<AccessResult> {
    const url = this.deps.currentUrl();
    if (!url || url.startsWith("about:") || url.startsWith("data:")) return "ok";
    return this.ensureSiteAccess(this.hostOf(url), url, "navigation", agent, signal);
  }

  /**
   * spec #7：即使网站已允许，敏感动作（提交/购买/删除/权限变更等）仍需二次确认。
   */
  async guardRisk(input: RiskInput, host: string, url: string, agent?: Agent, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }> {
    const assessment = assessRisk(input);
    if (assessment.level === "none") return { ok: true };
    const label = assessment.level === "high" ? "高风险操作（可能不可撤销）" : "敏感操作";
    const choice = await this.deps.ask(
      {
        id: `risk-${host}-${Date.now()}`,
        header: label,
        question: `智能体想执行：${input.kind === "click" ? `点击「${input.elementText ?? "元素"}」` : input.kind === "navigate" ? `导航到 ${input.url}` : input.kind}。\n\n${assessment.description}。站点 ${host} 已允许访问，但此动作可能产生重要外部影响，需要你确认。`,
        options: [
          { label: "允许继续", description: "执行该操作" },
          { label: "取消", description: "停止该操作" },
        ],
      },
      signal,
      agent,
    );
    if (choice === "允许继续") return { ok: true };
    return { ok: false, reason: `用户拒绝了该高风险操作（${assessment.description}）` };
  }

  /** spec #11：读取浏览历史需授权 */
  async ensureHistoryAccess(agent?: Agent, signal?: AbortSignal): Promise<AccessResult> {
    return this.ensureSiteAccess("browser-history", "browser://history", "history", agent, signal);
  }

  /**
   * spec #12：Developer Mode 必须开启；针对该网站需批准（且网站本身已允许访问）。
   */
  async gateFullCdp(host: string, url: string, agent?: Agent, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }> {
    const dm = this.deps.stores.getDevMode();
    if (!dm.enabled) {
      return { ok: false, reason: "Developer Mode 未开启。请在内置浏览器视图的 DEV 设置中开启后再试。" };
    }
    const access = await this.ensureSiteAccess(host, url, "cdp", agent, signal);
    if (access !== "ok") {
      return { ok: false, reason: access === "blocked" ? "该网站未获得访问授权" : "full CDP 批准已取消" };
    }
    if (!dm.approvedHosts.includes(host)) {
      const choice = await this.deps.ask(
        {
          id: `cdp-${host}-${Date.now()}`,
          header: "Full CDP 批准",
          question: `Developer Mode 已开启。智能体想要对 ${host} 使用 full CDP 访问（读取 console / network / runtime errors / 性能数据）。批准后该网站将记住此授权，可在视图页 DEV 设置中撤销。`,
          options: [
            { label: "批准", description: "允许对该网站使用 full CDP" },
            { label: "拒绝", description: "不允许" },
          ],
        },
        signal,
        agent,
      );
      if (choice !== "批准") return { ok: false, reason: "该网站未获得 full CDP 访问批准" };
      this.deps.stores.approveCdpHost(host);
    }
    return { ok: true };
  }
}
