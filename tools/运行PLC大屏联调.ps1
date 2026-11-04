param([ValidateRange(5,100)][int]$Samples = 12, [switch]$LowLatency)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env:PLC_SIMULATOR_DIR = Join-Path (Split-Path -Parent $root) 'PLC仿真调试器'
$env:PYTHONUTF8 = '1'
$env:LATENCY_SAMPLES = [string]$Samples
$env:LATENCY_FAST = $(if ($LowLatency) { '1' } else { '0' })
$env:PLC_STABILITY_MS = '20000'
if (-not $env:PLAYWRIGHT_MODULE) {
    $cache = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
    $modules = @(Get-ChildItem -LiteralPath $cache -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'node_modules\playwright' } |
        Where-Object { Test-Path -LiteralPath (Join-Path $_ 'package.json') })
    if (-not $modules.Count) { throw '缺少 Playwright；请安装后设置 PLAYWRIGHT_MODULE 为模块绝对路径。' }
    $env:PLAYWRIGHT_MODULE = $modules[0]
}
if (-not $env:BROWSER_EXECUTABLE) {
    foreach ($candidate in @('C:\Program Files\Google\Chrome\Application\chrome.exe','C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')) {
        if (Test-Path -LiteralPath $candidate) { $env:BROWSER_EXECUTABLE = $candidate; break }
    }
    if (-not $env:BROWSER_EXECUTABLE) { throw '找不到 Chrome/Edge；请设置 BROWSER_EXECUTABLE。' }
}
Push-Location -LiteralPath $root
try {
    foreach ($script in @('tools/audit-current-live-bindings.cjs','backend/scripts/plc-integration-test.cjs',
        'backend/scripts/plc-simulator-protocol-integration-test.cjs','tools/component-data-delivery-test.cjs',
        'tools/low-latency-cache-test.cjs','tools/plc-unity-latency-test.cjs')) {
        Write-Host "=== $script ==="
        & node $script
        if ($LASTEXITCODE -ne 0) { throw "联调失败：$script；保留 output 中的失败证据。" }
    }
    $reference = Get-ChildItem -LiteralPath (Join-Path $root 'output') -Directory -Filter 'current-binding-inventory-*' |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    & node tools/current-project-interface-latency-test.cjs (Join-Path $reference.FullName 'active-reference.json')
    if ($LASTEXITCODE -ne 0) { throw '当前工程接口副本联调失败；请查看 output 中的结果。' }
    Write-Host '联调完成。正式工程未改写；所有进程、接口、数据库均在隔离测试中运行。'
} finally { Pop-Location }
