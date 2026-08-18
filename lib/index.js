// ============================================================================
// dsh-browser — DeepSeek Harness 内置浏览器插件（宿主半边）
//   - 启动共享视图服务器（默认 http://127.0.0.1:9333）
//   - 懒启动 Playwright 内置浏览器（独立 profile，spec #3）
//   - 注册 browser_* 工具（全部 13 条 spec 行为）
// 启用：在 profile 的 cordis.patch.yml 中插入本插件；停用/卸载即移除工具（spec #1）。
// ============================================================================
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import "@deepseek-ai/dsh-user-questions"; // 提供 ctx.userQuestions 类型与运行时
import { BrowserManager } from "./manager.js";
import { BrowserStores } from "./stores.js";
import { Gates } from "./gates.js";
import { applyBrowserTools } from "./tools.js";
import { ViewServer } from "./view-server.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Cordis 插件元数据 */
export const name = "browser";
export const inject = ["tools", "userQuestions"];
/** 共享视图默认端口（可用 DSH_BROWSER_VIEW_PORT 覆盖） */
const DEFAULT_VIEW_PORT = Number(process.env.DSH_BROWSER_VIEW_PORT ?? 9333);
/**
 * 插件主体。启动时只绑定视图端口（轻量）；内置浏览器（Playwright）在
 * 第一次被工具/视图使用时才启动。
 */
export function apply(ctx) {
    const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
    const dataDir = path.join(dshHome, "browser");
    const profileDir = path.join(dataDir, "profile");
    const shotsDir = path.join(dataDir, "shots");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(shotsDir, { recursive: true });
    const stores = new BrowserStores({ dshHome });
    const manager = new BrowserManager({
        stores,
        profileDir,
        shotsDir,
        // 外部浏览器模式（路线 C）：设置后直接连接用户浏览器（--remote-debugging-port）并驱动面板内目标 iframe。
        // 未设置时也会在视图打开时自动探测/自动拉起调试浏览器（一键进入原生实时视图）。
        // 注意：外部模式无隔离 profile（spec #3），Agent 操作的是你的真实浏览器。
        cdpUrl: process.env.DSH_BROWSER_CDP_URL || undefined,
        guiUrl: process.env.DSH_BROWSER_GUI_URL || "http://127.0.0.1:3080",
        viewBase: `http://127.0.0.1:${DEFAULT_VIEW_PORT}`,
        noAutoLaunch: process.env.DSH_BROWSER_NO_AUTO_LAUNCH === "1",
    });
    // 用户问答（GUI 问题卡片）：权限 / 风险 / 历史 / CDP 批准都走这里
    // 注意：必须把调用方 agent 传给 userQuestions.ask —— web 部署的宿主 provider
    // （dsh-host-apiproxy）要求问答绑定 agent 所属会话，缺 agent 会直接拒绝（ASK_MISSING_AGENT）。
    const ask = async (q, signal, agent) => {
        try {
            const res = await ctx.userQuestions.ask({
                questions: [
                    {
                        id: q.id,
                        question: q.question,
                        ...(q.header ? { header: q.header } : {}),
                        ...(q.options ? { options: q.options } : {}),
                        multiSelect: false,
                    },
                ],
                signal,
                ...(agent ? { agent } : {}),
            });
            return res.answers.find((a) => a.id === q.id)?.selected?.[0] ?? null;
        }
        catch {
            return null; // 用户取消 / 无 UI provider → 视为拒绝（fail-closed）
        }
    };
    const gates = new Gates({
        stores,
        ask,
        currentUrl: () => manager.active()?.url ?? "",
    });
    // 共享视图服务器
    const viewServer = new ViewServer({
        manager,
        stores,
        viewDir: path.join(__dirname, "view"),
        demoDir: path.join(__dirname, "demo-site"),
        shotsDir,
        port: DEFAULT_VIEW_PORT,
    });
    void viewServer.start()
        .then(() => {
        console.log(`[dsh-browser] 共享视图已启动: ${viewServer.baseUrl}/`);
    })
        .catch((err) => {
        console.error("[dsh-browser] 共享视图启动失败:", err);
    });
    const viewBase = `http://127.0.0.1:${DEFAULT_VIEW_PORT}`;
    // 注册工具
    applyBrowserTools((tool) => ctx.tools.register(tool), {
        manager,
        gates,
        viewBase,
        viewUrlText: `${viewBase}/`,
    });
    // 清理（插件停用/卸载时）
    const dispose = () => {
        try {
            viewServer.stop();
        }
        catch {
            /* ignore */
        }
        void manager.dispose();
    };
    try {
        ctx.on("dispose", dispose);
    }
    catch {
        process.once("exit", dispose);
    }
}
//# sourceMappingURL=index.js.map