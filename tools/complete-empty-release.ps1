[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ReleaseDirectory,
    [string]$CollectorSmokeResult,
    [string]$MysqlSmokeResult
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$release = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
$allowed = [IO.Path]::GetFullPath((Join-Path $project '安装包')).TrimEnd('\') + '\'
if (-not $release.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw '候选目录必须在本项目安装包目录内。' }
if (Test-Path -LiteralPath (Join-Path $release 'release-manifest.json')) { throw '不能覆盖已交付 Release。' }
$desktop = Join-Path $project 'desktop'
$package = Get-Content -LiteralPath (Join-Path $desktop 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$unpacked = Join-Path $release 'win-unpacked'
$resources = Join-Path $unpacked 'resources'
$exe = Join-Path $unpacked "$($package.build.productName).exe"
if (-not (Test-Path -LiteralPath $exe)) { throw '缺少已构建候选程序。' }
# This command only finishes a successfully prepared candidate, not a build.
$prior = Get-Content -LiteralPath (Join-Path $release 'build-timings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($name in @('build:frontend','build:unity','build:admin-host','prepare:resources','生成可验证的 Windows x64 程序目录')) {
    if (@($prior.stages | Where-Object { $_.name -eq $name -and $_.exitCode -eq 0 }).Count -ne 1) { throw "候选程序尚未完成：$name" }
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$baseline = Join-Path $release "installation-resource-baseline-$stamp.json"
$verification = Join-Path $release "installation-resource-verification-$stamp.json"
$plugin = Join-Path $release "collector-plugin-$stamp"
if ($CollectorSmokeResult) {
    $collectorEvidence = Get-Content -LiteralPath $CollectorSmokeResult -Raw -Encoding UTF8 | ConvertFrom-Json
    $plugin = [IO.Path]::GetFullPath((Split-Path -Parent $collectorEvidence.source))
    if (-not $plugin.StartsWith($release.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '采集验证资源不属于当前候选目录。' }
}
$log = Join-Path $release "空系统续建日志-$stamp.txt"
$node = (Get-Command node.exe).Source
$stages = New-Object 'System.Collections.Generic.List[object]'
$timer = [Diagnostics.Stopwatch]::StartNew()
$success = $false
function Invoke-Stage {
    param([string]$Label, [string[]]$Arguments)
    Write-Host "`n[$Label]"
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $node @Arguments 2>&1 | ForEach-Object { Write-Host $_; $_ } | Out-File -LiteralPath $log -Append -Encoding UTF8
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previous; $watch.Stop() }
    $stages.Add([ordered]@{name=$Label;seconds=[Math]::Round($watch.Elapsed.TotalSeconds,3);exitCode=$code})
    if ($code -ne 0) { throw "$Label 失败：$code" }
}
try {
    Invoke-Stage '核对空系统安装资源' @((Join-Path $desktop 'scripts/verify-empty-install.cjs'), $resources)
    if (-not $CollectorSmokeResult) { Invoke-Stage '生成独立可选采集插件' @((Join-Path $desktop 'scripts/prepare-collector-plugin.cjs'), $resources, $plugin) }
    Invoke-Stage '记录候选资源基线' @((Join-Path $PSScriptRoot 'package-resource-integrity.cjs'), '--snapshot', $unpacked, $baseline)
    if ($CollectorSmokeResult) {
        Invoke-Stage '重新校验已通过采集服务测试的资源及证据' @((Join-Path $PSScriptRoot 'verify-release-smoke-evidence.cjs'), $CollectorSmokeResult, (Join-Path $plugin 'resources'), 'collector')
    } else { Invoke-Stage '独立采集服务验证' @((Join-Path $PSScriptRoot 'collector-service-smoke-test.cjs'), (Join-Path $plugin 'resources')) }
    if ($MysqlSmokeResult) {
        Invoke-Stage '重新校验已通过 MySQL 首启重启测试的资源及证据' @((Join-Path $PSScriptRoot 'verify-release-smoke-evidence.cjs'), $MysqlSmokeResult, $resources, 'mysql')
    } else { Invoke-Stage '空系统随包 MySQL 首启重启验证' @((Join-Path $PSScriptRoot 'packaged-mysql-smoke-test.cjs'), $exe) }
    Invoke-Stage '随包 MySQL 项目迁移回滚验证' @((Join-Path $PSScriptRoot 'packaged-project-bundle-mysql-test.cjs'), $exe)
    Invoke-Stage '确认运行验证未改写安装资源' @((Join-Path $PSScriptRoot 'package-resource-integrity.cjs'), '--verify', $unpacked, $baseline, $verification)
    $previousCompression = [Environment]::GetEnvironmentVariable('ELECTRON_BUILDER_COMPRESSION_LEVEL', 'Process')
    try {
        $env:ELECTRON_BUILDER_COMPRESSION_LEVEL = '1'
        Invoke-Stage '压缩已验证空系统并生成 NSIS 安装包' @(
            (Join-Path $desktop 'node_modules/electron-builder/out/cli/cli.js'), '--projectDir', $desktop,
            '--prepackaged', $unpacked, '--win', 'nsis', '--x64', "--config.directories.output=$release", '--config.compression=normal'
        )
    } finally { [Environment]::SetEnvironmentVariable('ELECTRON_BUILDER_COMPRESSION_LEVEL', $previousCompression, 'Process') }
    $installerName = "热处理数字孪生大屏-安装包-$($package.version)-x64.exe"
    $installer = Get-Item -LiteralPath (Join-Path $release $installerName)
    if ($installer.Length -le 0) { throw '安装包为空。' }
    $hash = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath "$($installer.FullName).sha256.txt" -Encoding UTF8 -Value "$hash  $installerName"
    $pluginName = "HeatTreatmentCollector-Plugin-$($package.version)-x64.zip"
    $pluginPath = Join-Path $release $pluginName
    Invoke-Stage '单独压缩采集插件' @((Join-Path $desktop 'scripts/archive-collector-plugin.cjs'), $plugin, $pluginPath)
    [ordered]@{
        version=$package.version;createdAt=(Get-Date).ToString('o');installer=$installer.FullName;size=$installer.Length;sha256=$hash
        mysqlBundled=$true;collectorBundled=$false;smokeTest='passed';includeHistory=$false;starterTemplate=$false;emptySystem=$true;contentPolicy='empty-v1'
        collectorPlugin=[ordered]@{file=$pluginName;size=(Get-Item -LiteralPath $pluginPath).Length;sha256=(Get-FileHash -LiteralPath $pluginPath -Algorithm SHA256).Hash.ToLowerInvariant();smokeTest='passed'}
        sourceUserDataDirectory=$null;sourceUploadsDirectory=$null;compressionLevel='1';buildLog=$log
        preparedBuildLog=(Join-Path $release 'build-timings.json');resourceBaseline=$baseline;resourceVerification=$verification
        collectorSmokeEvidence=$CollectorSmokeResult;mysqlSmokeEvidence=$MysqlSmokeResult
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $release 'release-manifest.json') -Encoding UTF8
    $success = $true
    Write-Host "空系统安装包完成：$($installer.FullName)"
    Write-Host "大小：$([Math]::Round($installer.Length / 1MB,1)) MB；SHA256：$hash"
} finally {
    $timer.Stop()
    [ordered]@{success=$success;totalSeconds=[Math]::Round($timer.Elapsed.TotalSeconds,3);stages=@($stages.ToArray())} |
        ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $release "completion-timings-$stamp.json") -Encoding UTF8
}
