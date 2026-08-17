// 复制静态资源（视图页面 / 客户端插件 / 演示站点）到 lib 与包根目录
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
};

copyDir(path.join(root, "src/view"), path.join(root, "lib/view"));
copyDir(path.join(root, "src/demo-site"), path.join(root, "lib/demo-site"));
fs.mkdirSync(path.join(root, "client"), { recursive: true });
fs.copyFileSync(
  path.join(root, "src/client/client.js"),
  path.join(root, "client/client.js"),
);
console.log("[dsh-browser] assets copied → lib/view, lib/demo-site, client/");
