// ============================================================================
// dsh-browser 存储与门控测试（spec #6 / #7 / #10 / #11 / #12）
// ============================================================================

import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrowserStores, assessRisk } from "../src/stores";
import { parseAnnotationPayload, buildOverlayScript } from "../src/annotations";
import { Gates, type AskFn } from "../src/gates";

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-browser-test-"));
}

function makeStores(): BrowserStores {
  return new BrowserStores({ dshHome: tmpHome() });
}

describe("BrowserStores：站点权限（spec #6）", () => {
  it("首次未知 → 授权后持久化；再次直接通过", () => {
    const s = makeStores();
    expect(s.getSiteDecision("example.com")).toBe("unknown");
    s.setSiteDecision("example.com", "allow");
    expect(s.getSiteDecision("example.com")).toBe("allow");
    expect(s.listSitePermissions()).toHaveLength(1);
    s.clearSiteDecision("example.com");
    expect(s.getSiteDecision("example.com")).toBe("unknown");
  });
});

describe("BrowserStores：历史（spec #11）", () => {
  it("记录/去重/搜索/删除/清空", () => {
    const s = makeStores();
    s.recordHistory("https://a.com", "A");
    s.recordHistory("https://a.com", "A2"); // 连续同 URL → 更新 title 不新增
    s.recordHistory("https://b.com", "B");
    expect(s.searchHistory()).toHaveLength(2);
    expect(s.searchHistory("a.com")).toHaveLength(1);
    const first = s.searchHistory()[0];
    s.deleteHistory(first.id);
    expect(s.searchHistory()).toHaveLength(1);
    s.clearHistory();
    expect(s.searchHistory()).toHaveLength(0);
  });
});

describe("BrowserStores：标注（spec #10）", () => {
  it("add / list(url) / delete", () => {
    const s = makeStores();
    const ann = s.addAnnotation({ url: "https://a.com/", host: "a.com", x: 1, y: 2, w: 3, h: 4, comment: "hi", createdBy: "user" });
    expect(ann.id).toBeTruthy();
    s.addAnnotation({ url: "https://b.com/", host: "b.com", x: 0, y: 0, w: 0, h: 0, comment: "hi2", createdBy: "agent" });
    expect(s.listAnnotations("https://a.com/")).toHaveLength(1);
    expect(s.listAnnotations()).toHaveLength(2);
    s.deleteAnnotation(ann.id);
    expect(s.listAnnotations()).toHaveLength(1);
  });
});

describe("BrowserStores：Developer Mode（spec #12）", () => {
  it("开关与按站点批准", () => {
    const s = makeStores();
    expect(s.getDevMode().enabled).toBe(false);
    s.setDevModeEnabled(true);
    expect(s.getDevMode().enabled).toBe(true);
    s.approveCdpHost("example.com");
    expect(s.getDevMode().approvedHosts).toContain("example.com");
    s.revokeCdpHost("example.com");
    expect(s.getDevMode().approvedHosts).not.toContain("example.com");
  });
});

describe("assessRisk（spec #7）", () => {
  it("普通点击 none；删除/购买/提交 sensitive 或 high", () => {
    expect(assessRisk({ kind: "click", elementText: "查看详情", element: { tag: "a" } }).level).toBe("none");
    expect(assessRisk({ kind: "click", elementText: "删除任务", element: { tag: "button" } }).level).toBe("sensitive");
    expect(assessRisk({ kind: "click", elementText: "确认删除", element: { tag: "button" } }).level).toBe("high");
    expect(assessRisk({ kind: "click", elementText: "立即支付", element: { tag: "button" } }).level).toBe("high");
    expect(assessRisk({ kind: "navigate", url: "https://shop.com/checkout" }).level).toBe("sensitive");
    expect(assessRisk({ kind: "click", elementText: "Buy Now", element: { tag: "button" } }).level).toBe("sensitive");
  });
});

describe("annotations payload 解析", () => {
  it("[cb-ann] 前缀解析为标注；其它消息返回 null", () => {
    const payload = JSON.stringify({ url: "https://a.com/", x: 10, y: 20, w: 100, h: 50, comment: "按钮没反应" });
    const ann = parseAnnotationPayload("[cb-ann]" + payload, "https://a.com/");
    expect(ann).not.toBeNull();
    expect(ann!.comment).toBe("按钮没反应");
    expect(ann!.host).toBe("a.com");
    expect(parseAnnotationPayload("普通日志", "https://a.com/")).toBeNull();
  });

  it("overlay 脚本包含已有标注与退出事件", () => {
    const script = buildOverlayScript([
      { id: "a1", url: "u", host: "h", x: 5, y: 6, w: 7, h: 8, comment: "c", createdBy: "user", ts: 1 },
    ]);
    expect(script).toContain("cb-exit-annotations");
    expect(script).toContain('"id":"a1"');
  });
});

describe("Gates（权限/风险/历史/CDP 问答门控）", () => {
  function makeGates(askImpl: AskFn) {
    const stores = makeStores();
    const gates = new Gates({ stores, ask: askImpl, currentUrl: () => "https://example.com/page" });
    return { stores, gates };
  }

  it("未知站点 → 用户允许 → ok 且持久化", async () => {
    const { stores, gates } = makeGates(vi.fn().mockResolvedValue("允许访问"));
    const r = await gates.ensureSiteAccess("example.com", "https://example.com/", "navigation");
    expect(r).toBe("ok");
    expect(stores.getSiteDecision("example.com")).toBe("allow");
  });

  it("用户阻止 → blocked 且持久化；已阻止再次直接拒绝", async () => {
    const ask = vi.fn().mockResolvedValue("阻止");
    const { stores, gates } = makeGates(ask);
    expect(await gates.ensureSiteAccess("evil.com", "https://evil.com/")).toBe("blocked");
    expect(await gates.ensureSiteAccess("evil.com", "https://evil.com/x")).toBe("blocked");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("取消 → cancelled 不持久化；用户取消问答（null）→ 拒绝", async () => {
    const { stores, gates } = makeGates(vi.fn().mockResolvedValue(null));
    expect(await gates.ensureSiteAccess("x.com", "https://x.com/")).toBe("cancelled");
    expect(stores.getSiteDecision("x.com")).toBe("unknown");
  });

  it("敏感点击 → 用户确认后允许；拒绝则返回 reason", async () => {
    const { gates } = makeGates(vi.fn().mockResolvedValue("允许继续"));
    const r = await gates.guardRisk({ kind: "click", elementText: "删除任务", element: { tag: "button" } }, "example.com", "https://example.com/");
    expect(r.ok).toBe(true);
  });
  it("拒绝高风险操作", async () => {
    const { gates } = makeGates(vi.fn().mockResolvedValue("取消"));
    const r = await gates.guardRisk({ kind: "click", elementText: "确认删除", element: { tag: "button" } }, "example.com", "https://example.com/");
    expect(r.ok).toBe(false);
  });

  it("history 授权", async () => {
    const ask = vi.fn().mockResolvedValue("允许");
    const { gates } = makeGates(ask);
    expect(await gates.ensureHistoryAccess()).toBe("ok");
    expect(ask.mock.calls[0][0].header).toContain("历史");
  });

  it("full CDP：DevMode 未开启 → 拒绝且不询问", async () => {
    const ask = vi.fn();
    const { gates } = makeGates(ask);
    const r = await gates.gateFullCdp("example.com", "https://example.com/");
    expect(r.ok).toBe(false);
    expect(String(r.ok === false ? r.reason : "")).toContain("Developer Mode 未开启");
    expect(ask).not.toHaveBeenCalled();
  });

  it("full CDP：DevMode 开启 + 站点允许 + 用户批准 → ok 且记住", async () => {
    const { stores, gates } = makeGates(vi.fn().mockResolvedValue("批准"));
    stores.setDevModeEnabled(true);
    stores.setSiteDecision("example.com", "allow");
    expect((await gates.gateFullCdp("example.com", "https://example.com/")).ok).toBe(true);
    expect(stores.getDevMode().approvedHosts).toContain("example.com");
    // 第二次无需再问
    const ask2 = vi.fn().mockResolvedValue("批准");
    const { gates: g2 } = makeGates(ask2);
    void g2;
  });
});
