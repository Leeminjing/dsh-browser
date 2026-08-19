# ============================================================================
# 一键启用「原生实时视图」（实时 iframe，路线 C）
#  - 关闭你当前正在用的浏览器（Edge/Chrome），带 --remote-debugging-port=9222 重启
#  - 保留 profile、自动恢复所有窗口（--restore-last-session）
#  - 打开 DSH GUI（?dsh-browser=open 自动展开浏览器面板）
# 之后点「🌐 浏览器」就是原生实时视图，无需再做任何操作。
# 用法：双击 start-external.cmd，或 PowerShell 运行 .\start-external.ps1
# ============================================================================
$ErrorActionPreference = "Stop"

$edgePaths = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$chromePaths = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)

$edge = $edgePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
$chrome = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
$edgeRunning = [bool](tasklist /FI "IMAGENAME eq msedge.exe" /NH 2>$null | Select-String "msedge.exe")
$chromeRunning = [bool](tasklist /FI "IMAGENAME eq chrome.exe" /NH 2>$null | Select-String "chrome.exe")

$exe = $null
if ($edgeRunning -and $edge) { $exe = $edge }
elseif ($chromeRunning -and $chrome) { $exe = $chrome }
elseif ($edge) { $exe = $edge }
elseif ($chrome) { $exe = $chrome }
if (-not $exe) { throw "找不到 Chrome 或 Edge，请先安装浏览器。" }

$name = if ($exe -match "Edge") { "Edge" } else { "Chrome" }
$procName = if ($exe -match "Edge") { "msedge" } else { "chrome" }

Write-Host ""
Write-Host "  正在重启 $name（保留 profile、恢复所有窗口）并开启调试端口 9222 ..."
if ($procName -eq "msedge") { Stop-Process -Name msedge -Force -ErrorAction SilentlyContinue }
else { Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 1000

Start-Process $exe -ArgumentList `
  "--remote-debugging-port=9222", `
  "--restore-last-session", `
  "--no-first-run", `
  "--no-default-browser-check", `
  "http://127.0.0.1:3080/?dsh-browser=open"

Write-Host "  ✅ 完成：$name 已带调试端口启动，窗口会自动恢复。"
Write-Host "     在浏览器里打开 DSH GUI，点「🌐 浏览器」即可使用原生实时视图（和 Trae 一样）。"
Write-Host ""
