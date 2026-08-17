// ============================================================================
// dsh-browser 端到端冒烟：真实 Playwright 浏览器 + manager + view server + 演示站点
// 运行：node scripts/smoke.mjs（需要已安装 chromium：npx playwright install chromium）
// ============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserManager } from "../lib/manager.js";
import { BrowserStores } from "../lib/stores.js";
import { ViewServer } from "../lib/view-server.js";
import { Gates } from "../lib/gates.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-browser-smoke-"));

async function main() {
  console.log("[smoke] profile dir:", home);
  const stores = new BrowserStores({ dshHome: home });
  const manager = new BrowserManager({
    stores,
    profileDir: path.join(home, "profile"),
    shotsDir: path.join(home, "shots"),
    viewport: { width: 1280, height: 800 },
  });
  const gates = new Gates({
    stores,
    ask: async (q) => {
      console.log("[smoke] 模拟用户问答:", q.header, "→", q.options?.[0]?.label);
      return q.options?.[0]?.label ?? null; // 一律允许第一项
    },
    currentUrl: () => manager.active()?.url ?? "",
  });

  const view = new ViewServer({
    manager,
    stores,
    viewDir: path.join(root, "lib/view"),
    demoDir: path.join(root, "lib/demo-site"),
    shotsDir: path.join(home, "shots"),
    port: 9444,
  });
  await view.start();
  console.log("[smoke] view server:", view.baseUrl);

  // ---- 1. 导航到演示站点（spec #4）----
  await manager.ensure();
  console.log("[smoke] chromium 已启动");
  const url = view.baseUrl + "/demo/";
  const r = await gates.ensureSiteAccess("127.0.0.1:9444", url, "navigation");
  if (r !== "ok") throw new Error("站点授权失败: " + r);
  const nav = await manager.navigateTo("", url);
  console.log("[smoke] navigate →", nav.url, "| HTTP", nav.httpStatus, "| verified", nav.verified);

  // ---- 2. 快照（spec #5）----
  const snap = await manager.snapshot("");
  console.log("[smoke] snapshot 元素数:", snap.elements.length, "| 标题:", snap.title);
  if (snap.elements.length < 3) throw new Error("快照元素过少");

  // ---- 3. 点击 / 输入 / 创建（spec #5 闭环）----
  await manager.click("", "分析项目需求");
  await new Promise((r2) => setTimeout(r2, 400));
  await manager.click("", "新建任务");
  await new Promise((r2) => setTimeout(r2, 200));
  await manager.type("", "*", "复现：页面刷新后丢失状态");
  await manager.click("", "创建");
  await new Promise((r2) => setTimeout(r2, 500));
  const snap2 = await manager.snapshot("");
  const hasTask = snap2.text.includes("复现");
  console.log("[smoke] 任务创建后页面包含标题:", hasTask);
  if (!hasTask) throw new Error("任务未出现在页面上");

  // ---- 4. 截图（spec #5/#13）----
  const shot = await manager.screenshot("");
  if (!fs.existsSync(shot.file)) throw new Error("截图文件不存在");
  console.log("[smoke] 截图:", shot.url);

  // ---- 5. 用户坐标点击（spec #9）----
  await manager.clickAt("", 400, 300);
  console.log("[smoke] clickAt 完成");

  // ---- 6. Developer Mode + CDP（spec #12）----
  stores.setDevModeEnabled(true);
  stores.setSiteDecision("127.0.0.1:9444", "allow");
  const gate = await gates.gateFullCdp("127.0.0.1:9444", url);
  if (!gate.ok) throw new Error("CDP 门控失败: " + gate.reason);
  const metrics = await manager.performanceMetrics("");
  console.log("[smoke] performance metrics:", metrics.length);

  // ---- 7. 标注（spec #10，直接注入 overlay 验证不抛错）----
  await manager.setAnnotationMode("", true);
  const anns = stores.listAnnotations(url);
  console.log("[smoke] 标注模式已开启，现有标注:", anns.length);

  // ---- 8. 历史（spec #11）----
  console.log("[smoke] 历史条数:", stores.searchHistory().length);

  // ---- 9. 状态 ----
  const state = await manager.state();
  console.log("[smoke] tabs:", state.tabs.length, "| active:", state.activeTabId);

  await manager.dispose();
  view.stop();
  console.log("[smoke] ✅ 全部通过");
}

main().catch((err) => {
  console.error("[smoke] ❌ 失败:", err);
  process.exit(1);
});
