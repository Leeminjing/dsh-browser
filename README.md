# dsh-browser — DeepSeek Harness 内置浏览器插件

给 **DeepSeek Harness（网页端）** 写的内置浏览器插件（模仿 Codex / ChatGPT Desktop 的内置 Browser）：
Agent 获得一组 `browser_*` 工具（导航/点击/输入/截图/观察/历史/标注/CDP 调试…），
同时提供一个**共享视图**页面（默认 `http://127.0.0.1:9333`）——用户和 Agent 操作的是**同一个内置浏览器**，
并可在 Harness 页面内通过「🌐 浏览器」按钮停靠查看（客户端插件）。

> 与桌面应用无关——这是给 **DeepSeek Harness 网页端** 的插件：
> 宿主半边（cordis 插件 + 工具） + 客户端半边（页面内停靠面板）。

---

## 1. 安装（两步）

### 1.1 把插件装进 web profile

```bash
# 在插件源码目录构建（产出 lib/）
cd dsh-browser
npm install
npm run build

# 安装到 Harness web profile（profile 目录见 $DSH_HOME/profiles/web）
cd $env:DSH_HOME\profiles\web
pnpm add file:C:\path\to\dsh-browser playwright
pnpm exec playwright install chromium        # 下载内置浏览器内核（~130MB，一次性）
```

> 更新插件后：**每次 `npm run build` 之后，若新增了静态文件（如 `demo-site/watch.html`），
> 需要把它们同步到 profile 的副本**（profile 里的包不是符号链接，已有文件的修改通常同步，
> 但新建文件不会）：
> `Copy-Item lib\demo-site\watch.html $env:DSH_HOME\profiles\web\node_modules\dsh-browser\lib\demo-site\`

### 1.2 在 profile 配置里启用插件

编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`，追加：

```yaml
- insert:
    - id: browser
      name: 'dsh-browser'
```

可选环境变量：`DSH_BROWSER_VIEW_PORT`（共享视图端口，默认 9333）。

### 1.3 重启

```bash
dsh web        # 重启 Harness（服务端插件在启动时加载）
```

重启后在对话输入 `@Browser 打开 http://localhost:3000`（或任何浏览器任务），
Agent 即可使用内置浏览器；右上角会话头部出现「🌐 浏览器」按钮，点击可在页面右侧停靠共享视图。

> 说明：插件启用/停用由 Harness 的插件体系管理（spec #1）——未安装/未启用时 `browser_*` 工具不存在，
> Agent 不会执行任何内置浏览器操作。

---

## 2. 架构

```
dsh-browser/
├─ src/
│  ├─ index.ts          cordis 插件主体（apply）：装配 stores/manager/gates/view/tools
│  ├─ manager.ts        Playwright 内置浏览器（独立持久化 profile、多标签、截图、
│  │                    文件上传拦截、console 捕获、CDPSession 深度调试）
│  ├─ gates.ts          门控：站点权限/高风险确认/历史授权/CDP 批准（走 GUI 用户问答）
│  ├─ stores.ts         持久化（权限/历史/标注/DevMode） + 高风险识别
│  ├─ annotations.ts    页面标注 overlay 注入 + [cb-ann] 上报解析
│  ├─ tools.ts          browser_* 工具注册（defineTool）
│  ├─ view-server.ts    共享视图 HTTP 服务器（SSE 实时事件 + REST API + 演示站点）
│  ├─ view/             共享视图页面（截图+点击叠加、标注、历史/权限/DEV 弹窗）
│  ├─ demo-site/        Caspian 风格演示站点（/demo，对应截图场景）+ watch.html（隐藏监听页：
│  │                    订阅 SSE，Agent 导航时 postMessage 通知 GUI 自动弹出共享视图面板）
│  └─ client/client.js  客户端插件：会话头部「🌐 浏览器」按钮 + 右侧停靠面板（iframe；分隔条可拖动，
│  │                    对话区与共享视图联动伸缩，面板关闭后对话区恢复全宽；
│  │                    Agent 操作浏览器时面板自动弹出）
├─ tests/               vitest 单元测试
└─ lib/                 构建产物（tsc + 静态资源复制）
```

---

## 3. 13 条 spec ↔ 实现对照

| # | Spec 行为 | 实现 |
|---|-----------|------|
| 1 | 启用行为：未安装不执行；@Browser/明确任务可调用 | 插件由 Harness 插件体系启用/停用（cordis 行 + 插件设置页）；未启用则 `browser_*` 工具不注册 |
| 2 | 共享视图：用户与 Agent 看到同一页面 | Playwright 单实例 + 共享视图页（SSE 实时刷新）；客户端面板停靠右侧；用户可点击/输入，Agent 同步可见 |
| 3 | 状态隔离：独立 profile，不继承 Chrome | `launchPersistentContext(DSH_HOME/browser/profile)`，cookie/localStorage 独立持久化；视图页可一键清除 |
| 4 | 打开页面：本地/file/公网 + HTTP 验证 | `browser_navigate`（URL 规范化 + HEAD/GET 验证，返回 `HTTP 200`）；`/demo` 演示站点 |
| 5 | 页面操作 + 再次观察验证 | navigate/click/type/press/observe/screenshot/reload 工具；描述中强制「操作后 observe/screenshot 验证」 |
| 6 | 网站权限：新网站请求授权；设置可管理 | `Gates.ensureSiteAccess` → GUI 问题卡片（允许/阻止/取消）→ 持久化；视图页「权限」弹窗可查看/移除 |
| 7 | 高风险动作二次确认 | `assessRisk` 关键词/URL 启发式 + `guardRisk` 问题卡片；拒绝即中止 |
| 8 | 文件上传不能自动完成 | `type=file` 拦截（点击/输入前检测）；`filechooser` 事件仅提示；视图页提供「用户手动上传」 |
| 9 | 用户手动介入：登录后继续 | 共享视图始终可操作（地址栏/点击/输入/上传）；Agent 每次从当前页面状态继续，不重建会话 |
| 10 | 页面标注：框选区域写评论 → Agent 处理 | overlay 注入 + `[cb-ann]` console 上报；`browser_read_annotations` 读取；视图页可标注 |
| 11 | 浏览历史：独立保存/搜索/删除；Agent 读取需授权 | `stores.recordHistory`（did-navigate）+ 视图页历史弹窗 + `browser_read_history`（授权后） |
| 12 | Developer Mode：full CDP 需开启 + 每站批准 | 视图页 DEV 开关 + `gateFullCdp` 每站批准；console/network/performance/evaluate 工具 |
| 13 | 任务结束保留最终页面状态 | 内置浏览器不关闭；`browser_screenshot` 附最终截图；共享视图停留在最终状态 |

---

## 4. 工具清单（Agent 侧）

`browser_open_view` / `browser_navigate` / `browser_click` / `browser_type` / `browser_press` /
`browser_wait` / `browser_observe` / `browser_screenshot` / `browser_back` / `browser_forward` /
`browser_reload` / `browser_new_tab` / `browser_switch_tab` / `browser_close_tab` /
`browser_read_history` / `browser_read_annotations` / `browser_add_annotation` /
`browser_set_annotation_mode` / `browser_console_logs` / `browser_network_requests` /
`browser_performance_metrics` / `browser_evaluate`

## 5. 演示流程

1. 重启 Harness 后，对话输入 **`启动 Caspian 并在内置浏览器打开`**（或 `@Browser 打开 http://127.0.0.1:9333/demo/`）
   → 首次访问 `127.0.0.1` 弹出网站授权（spec #6）→ 允许 → Agent 打开页面并报告 `HTTP 验证返回 200`。
2. 点右上角「🌐 浏览器」→ 右侧停靠共享视图，能看到 Agent 正在操作同一页面。
3. 让 Agent **点击/输入/截图**，观察共享视图实时变化（spec #2/#5）。
4. 在共享视图打开「标注」→ 框选区域写评论 → 让 Agent **处理页面上的评论**（spec #10）。
5. 让 Agent **查看浏览历史** → 触发历史授权（spec #11）。
6. 在演示站任务台点「删除」→ 触发高风险确认（spec #7）。
7. 视图页开启 **DEV** → 让 Agent **读取控制台日志/网络请求** → 首次需批准（spec #12）。

## 6. 已知边界（POC）

- 共享视图以「截图 + 点击叠加」为主（对任意站点可用）；部分允许嵌入的站点可切 iframe 模式。
- 高风险识别为启发式（关键词 + URL 片段）。
- 客户端停靠面板依赖 Harness 客户端插件加载机制；若未加载，直接打开 `http://127.0.0.1:9333/` 即可使用共享视图。
- 内置浏览器运行在 Harness 所在机器（本地 127.0.0.1）；远程部署时共享视图/截图需相应开放端口。
