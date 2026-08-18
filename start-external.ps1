# ============================================================================
# 一键启动「外部浏览器模式」（路线 C）
#  - 用独立 profile 启动带调试端口的 Chrome/Edge（不影响你平时的浏览器）
#  - 自动打开 DSH GUI；插件会自动探测本调试端口并进入外部模式
# 用法：双击 start-external.cmd，或 PowerShell 运行 .\start-external.ps1
# ============================================================================
$ErrorActionPreference = "Stop"
$port = 9222
$profile = Join-Path $env:TEMP "dsh-browser-external"
$gui = "http://127.0.0.1:3080"

$candidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { throw "找不到 Chrome 或 Edge，请先安装浏览器。" }
$name = if ($exe -match "Chrome") { "Chrome" } else { "Edge" }

Start-Process $exe -ArgumentList "--remote-debugging-port=$port", "--user-data-dir=$profile", "--no-first-run", "--no-default-browser-check", $gui

Write-Host ""
Write-Host "  ✅ 已用 $name 启动外部浏览器（调试端口 $port，独立 profile）"
Write-Host "     窗口里已打开 DSH GUI：$gui"
Write-Host ""
Write-Host "  接下来只需："
Write-Host "    1) 重启 harness（新终端运行：dsh web）"
Write-Host "    2) 刷新 GUI，面板出现橙色徽标「外部浏览器模式」即生效"
Write-Host ""
