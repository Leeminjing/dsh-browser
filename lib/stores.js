// ============================================================================
// dsh-browser 持久化存储（spec #3 状态隔离 / #6 权限 / #10 标注 / #11 历史 / #12 DevMode）
// 数据落在 DSH_HOME/browser/ 下，与用户 Chrome 完全隔离。
// ============================================================================
import * as fs from "node:fs";
import * as path from "node:path";
function defaults() {
    return {
        sitePermissions: [],
        history: [],
        annotations: [],
        devMode: { enabled: false, approvedHosts: [] },
    };
}
/** 纯逻辑存储：JSON 文件 + 原子写入。 */
export class BrowserStores {
    dir;
    file;
    data;
    constructor(opts) {
        this.dir = path.join(opts.dshHome, "browser");
        this.file = path.join(this.dir, "state.json");
        this.data = this.load();
    }
    load() {
        try {
            if (fs.existsSync(this.file)) {
                const raw = JSON.parse(fs.readFileSync(this.file, "utf-8"));
                const d = defaults();
                return {
                    sitePermissions: raw.sitePermissions ?? d.sitePermissions,
                    history: raw.history ?? d.history,
                    annotations: raw.annotations ?? d.annotations,
                    devMode: { ...d.devMode, ...(raw.devMode ?? {}) },
                };
            }
        }
        catch {
            /* 损坏回退默认 */
        }
        return defaults();
    }
    save() {
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const tmp = this.file + ".tmp";
            fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf-8");
            fs.renameSync(tmp, this.file);
        }
        catch (err) {
            console.error("[dsh-browser] 存储写入失败:", err);
        }
    }
    // ---- 站点权限（spec #6）----
    getSiteDecision(host) {
        const entry = [...this.data.sitePermissions].reverse().find((p) => p.host === host);
        return entry ? entry.decision : "unknown";
    }
    setSiteDecision(host, decision) {
        this.data.sitePermissions = this.data.sitePermissions.filter((p) => p.host !== host);
        this.data.sitePermissions.push({ host, decision, ts: Date.now() });
        this.save();
    }
    clearSiteDecision(host) {
        this.data.sitePermissions = this.data.sitePermissions.filter((p) => p.host !== host);
        this.save();
    }
    listSitePermissions() {
        return this.data.sitePermissions;
    }
    // ---- 浏览历史（spec #11）----
    recordHistory(url, title) {
        if (!url || url.startsWith("about:") || url.startsWith("devtools:"))
            return;
        const last = this.data.history[this.data.history.length - 1];
        if (last && last.url === url) {
            last.title = title || last.title;
            last.ts = Date.now();
            this.save();
            return;
        }
        this.data.history.push({ id: this.uid("h"), url, title: title || url, ts: Date.now() });
        if (this.data.history.length > 2000)
            this.data.history.splice(0, this.data.history.length - 2000);
        this.save();
    }
    searchHistory(query) {
        const q = (query ?? "").trim().toLowerCase();
        const list = [...this.data.history].reverse();
        if (!q)
            return list;
        return list.filter((h) => h.url.toLowerCase().includes(q) || h.title.toLowerCase().includes(q));
    }
    deleteHistory(id) {
        this.data.history = this.data.history.filter((h) => h.id !== id);
        this.save();
    }
    clearHistory() {
        this.data.history = [];
        this.save();
    }
    // ---- 页面标注（spec #10）----
    addAnnotation(a) {
        const ann = { ...a, id: this.uid("a"), ts: Date.now() };
        this.data.annotations.push(ann);
        if (this.data.annotations.length > 500)
            this.data.annotations.splice(0, this.data.annotations.length - 500);
        this.save();
        return ann;
    }
    listAnnotations(url) {
        const list = [...this.data.annotations].reverse();
        if (!url)
            return list;
        const u = url.split("#")[0];
        return list.filter((a) => a.url.split("#")[0] === u);
    }
    deleteAnnotation(id) {
        this.data.annotations = this.data.annotations.filter((a) => a.id !== id);
        this.save();
    }
    // ---- Developer Mode（spec #12）----
    getDevMode() {
        return this.data.devMode;
    }
    setDevModeEnabled(enabled) {
        this.data.devMode.enabled = enabled;
        this.save();
    }
    approveCdpHost(host) {
        if (!this.data.devMode.approvedHosts.includes(host)) {
            this.data.devMode.approvedHosts.push(host);
            this.save();
        }
    }
    revokeCdpHost(host) {
        this.data.devMode.approvedHosts = this.data.devMode.approvedHosts.filter((h) => h !== host);
        this.save();
    }
    uid(prefix) {
        return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }
}
const SENSITIVE_WORDS = [
    "提交", "确认提交", "购买", "支付", "付款", "下单", "结账", "删除", "移除", "注销",
    "授权", "修改权限", "更改权限", "重置密码", "修改密码", "转账", "发送款项", "退款",
    "submit", "confirm", "purchase", "buy", "checkout", "pay", "place order", "delete",
    "remove", "deactivate", "revoke", "grant", "reset password", "change password",
    "transfer", "send payment", "refund",
];
const HIGH_WORDS = [
    "确认删除", "永久删除", "立即支付", "立即购买", "确认支付",
    "delete permanently", "confirm purchase", "confirm payment", "irreversible", "不可撤销",
];
const SENSITIVE_URL_PARTS = [
    "/checkout", "/payment", "/pay", "/delete", "/remove", "/admin/permissions",
    "/settings/permissions", "/billing", "/transfer", "/reset-password",
];
const norm = (s) => (s ?? "").toLowerCase().trim();
export function assessRisk(a) {
    const text = norm(a.elementText);
    const url = norm(a.url);
    const type = norm(a.element?.type);
    for (const w of HIGH_WORDS) {
        if (text.includes(w))
            return { level: "high", description: `「${a.elementText}」是不可撤销操作` };
    }
    if (a.kind === "navigate" && url) {
        for (const p of SENSITIVE_URL_PARTS) {
            if (url.includes(p))
                return { level: "sensitive", description: `导航到敏感页面 ${a.url}` };
        }
    }
    if (a.kind === "download" || a.element?.download) {
        return { level: "sensitive", description: "触发文件下载" };
    }
    if (a.kind === "submit" || (a.kind === "click" && (type === "submit" || norm(a.element?.tag) === "button"))) {
        if (a.formMethod === "post" || type === "submit") {
            for (const w of SENSITIVE_WORDS) {
                if (text.includes(w))
                    return { level: "sensitive", description: `「${a.elementText}」是敏感操作（提交类）` };
            }
        }
    }
    if (a.kind === "click" || a.kind === "type" || a.kind === "submit") {
        for (const w of SENSITIVE_WORDS) {
            if (text.includes(w))
                return { level: "sensitive", description: `「${a.elementText}」是敏感操作` };
        }
    }
    return { level: "none", description: "" };
}
//# sourceMappingURL=stores.js.map