// 快速诊断：/demo 路由 + HEAD 处理
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserStores } from "../lib/stores.js";
import { ViewServer } from "../lib/view-server.js";
import { BrowserManager } from "../lib/manager.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "cb-diag-"));
const stores = new BrowserStores({ dshHome: home });
const manager = new BrowserManager({
  stores,
  profileDir: path.join(home, "p"),
  shotsDir: path.join(home, "s"),
});
const view = new ViewServer({
  manager,
  stores,
  viewDir: path.join(root, "lib/view"),
  demoDir: path.join(root, "lib/demo-site"),
  shotsDir: path.join(home, "s"),
  port: 9455,
});
await view.start();
for (const u of ["/demo", "/demo/", "/demo/index.html", "/", "/app.js"]) {
  for (const m of ["GET", "HEAD"]) {
    const res = await fetch(view.baseUrl + u, { method: m });
    console.log(m, u, "→", res.status, res.headers.get("content-type"));
  }
}
console.log("demo dir:", fs.existsSync(path.join(root, "lib/demo-site/index.html")));
view.stop();
process.exit(0);
