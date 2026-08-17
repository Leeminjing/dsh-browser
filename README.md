# dsh-browser

[中文](README.zh.md) | **English**

A **built-in browser plugin for DeepSeek Harness (Web)** — inspired by the built-in Browser in Codex / ChatGPT Desktop.

The agent gets a full set of `browser_*` tools (navigate / click / type / screenshot / observe / history / annotations / CDP debugging…), while you get a **shared view** (default `http://127.0.0.1:9333`) — you and the agent operate the **same built-in browser** in real time. A docked panel can be toggled inside the Harness page via the **🌐 Browser** button.

> Web-only: the host half (Cordis plugin + tools) runs server-side; the client half (dockable panel) runs in the Harness page.

---

## 1. Install

```bash
dsh plugin --profile web add github:Leeminjing/dsh-browser
pnpm exec playwright install chromium    # browser kernel (~130 MB, one-time)
```

Then restart the harness (`dsh web`). The plugin row is mounted automatically by the bundle patch (`dsh.bundle.patch` → `cordis.patch.yml`); no manual config needed.

> Dev install (from a local checkout): `npm install && npm run build`, then `pnpm add file:C:\path\to\dsh-browser playwright` and enable the row in `$DSH_HOME/profiles/web/cordis.patch.yml`:
> ```yaml
> - insert:
>     - id: browser
>       name: 'dsh-browser'
> ```

Optional env var: `DSH_BROWSER_VIEW_PORT` (shared-view port, default 9333).

Then in any conversation ask the agent to open a URL (e.g. `@Browser 打开 http://localhost:3000`). A **🌐 Browser** button appears in the session header — click it to dock the shared view on the right.

> Enabled/disabled state is managed by the Harness plugin system (spec #1) — when disabled, `browser_*` tools are not registered and the agent cannot touch the built-in browser.

---

## 2. Architecture

```
dsh-browser/
├─ src/
│  ├─ index.ts          Cordis plugin body (apply): wires stores / manager / gates / view / tools
│  ├─ manager.ts        Playwright built-in browser (persistent profile, multi-tab, screenshots,
│  │                    upload interception, console capture, CDPSession deep debugging)
│  ├─ gates.ts          Gating: site permission / high-risk confirm / history auth / CDP approval
│  │                    (via GUI question cards — agent-scoped, works on the web deployment)
│  ├─ stores.ts         Persistence (permissions / history / annotations / DevMode) + risk detection
│  ├─ annotations.ts    Page-annotation overlay injection + [cb-ann] report parsing
│  ├─ tools.ts          browser_* tool registration (defineTool)
│  ├─ view-server.ts    Shared-view HTTP server (SSE live events + REST API + demo site)
│  ├─ view/             Shared-view page (screenshot + click overlay, annotations, history/perms/DEV modals)
│  ├─ demo-site/        Caspian-style demo site (/demo) + watch.html (hidden listener: subscribes to SSE,
│  │                    postMessages the GUI to auto-open the panel when the agent navigates)
│  └─ client/client.js  Client plugin: session-header 🌐 button + right-docked resizable panel (iframe;
│                       divider drag syncs the conversation column; panel auto-opens on agent navigation
│                       and is scoped per session)
├─ tests/               vitest unit tests
└─ lib/                 build output (tsc + static asset copy)
```

---

## 3. Feature ↔ spec mapping

| # | Behavior | Implementation |
|---|----------|----------------|
| 1 | Not installed → nothing executes; callable via @Browser / explicit tasks | Enabled/disabled by the Harness plugin system; tools unregistered when off |
| 2 | Shared view: user and agent see the same page | Single Playwright instance + shared-view page (SSE live refresh); docked client panel; user can click/type, agent stays in sync |
| 3 | State isolation: independent profile, no Chrome inheritance | `launchPersistentContext(DSH_HOME/browser/profile)`; cookie/localStorage persisted separately; one-click clear in the view |
| 4 | Open pages: local / file / public + HTTP verification | `browser_navigate` (URL normalization + HEAD/GET verify, reports `HTTP 200`); `/demo` demo site |
| 5 | Page actions + re-observe verification | navigate/click/type/press/observe/screenshot/reload tools; tool descriptions mandate verify-after-action |
| 6 | Site permission: new sites ask; manageable in settings | `Gates.ensureSiteAccess` → GUI question card (allow/block/cancel) → persisted; view "Permissions" modal |
| 7 | High-risk actions need confirmation | `assessRisk` keyword/URL heuristics + `guardRisk` question card; reject aborts |
| 8 | File uploads cannot be automated | `type=file` interception; `filechooser` event only notifies; the view provides manual upload |
| 9 | Human takeover: continue after login | Shared view is always operable (address bar / click / type / upload); agent continues from the current page |
| 10 | Page annotations: select area → comment → agent handles | Overlay injection + `[cb-ann]` console report; `browser_read_annotations`; annotate from the view |
| 11 | History: isolated save/search/delete; agent reads with permission | `stores.recordHistory` on navigation + view history modal + `browser_read_history` (after approval) |
| 12 | Developer Mode: full CDP needs toggle + per-site approval | DEV toggle in the view + `gateFullCdp` per-site approval; console/network/performance/evaluate tools |
| 13 | Keep the final page state when the task ends | Browser stays open; `browser_screenshot` captures the final state; shared view stays on it |

---

## 4. Agent tools

`browser_open_view` / `browser_navigate` / `browser_click` / `browser_type` / `browser_press` /
`browser_wait` / `browser_observe` / `browser_screenshot` / `browser_back` / `browser_forward` /
`browser_reload` / `browser_new_tab` / `browser_switch_tab` / `browser_close_tab` /
`browser_read_history` / `browser_read_annotations` / `browser_add_annotation` /
`browser_set_annotation_mode` / `browser_console_logs` / `browser_network_requests` /
`browser_performance_metrics` / `browser_evaluate`

## 5. Quick demo

1. After restarting the harness, ask: **"open the demo site in the built-in browser"** (or `@Browser 打开 http://127.0.0.1:9333/demo/`)
   → the first visit to a new host raises a **site-permission card** (spec #6) → **Allow** → the agent opens the page and reports `HTTP 200`.
2. Click **🌐 Browser** in the session header → the shared view docks on the right and mirrors the agent's actions live (spec #2/#5).
3. Let the agent **click / type / screenshot** — the view refreshes in real time.
4. Open **Annotate** in the view → select an area and write a comment → ask the agent to **handle the comment** (spec #10).
5. Ask the agent to **read the browsing history** → history approval card (spec #11).
6. Click **Delete** on the demo task board → high-risk confirmation (spec #7).
7. Turn on **DEV** in the view → ask the agent to **read console logs / network requests** → approve full CDP (spec #12).

## 6. Known limitations (POC)

- The shared view is screenshot + click-overlay based (works on any site); embeddable sites can switch to iframe mode.
- Risk detection is heuristic (keywords + URL fragments).
- The docked panel depends on the Harness client-plugin loader; if it is not loaded, open `http://127.0.0.1:9333/` directly.
- The browser runs on the harness machine (localhost); remote deployments must expose the shared view / screenshots accordingly.
- The shared browser itself is a single global instance; the **panel UI and auto-open are isolated per session** (auto-pop only in the acting session; the panel closes when you switch sessions).
