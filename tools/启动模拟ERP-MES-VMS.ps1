param([ValidateRange(1,65535)][int]$Port = 19090)
$ErrorActionPreference = 'Stop'
$scriptFile = Join-Path $PSScriptRoot 'mock-external-systems.cjs'
if (-not (Test-Path -LiteralPath $scriptFile -PathType Leaf)) { throw "找不到模拟接口脚本：$scriptFile" }
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
if (-not $node) { throw '本机没有找到 Node.js。请先安装 Node.js 22 或更新版本，再运行。' }
Write-Host '此窗口是模拟接口服务；测试接入时请保持窗口开启。'
Write-Host "浏览器工作台：http://127.0.0.1:$Port"
Write-Host '停止服务：在本窗口按 Ctrl+C。'
& $node.Source $scriptFile --port $Port
if ($LASTEXITCODE -ne 0) { throw "模拟接口启动失败（代码 $LASTEXITCODE）。请查看上面的提示。" }
