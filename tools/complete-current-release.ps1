[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ReleaseDirectory,
    [Parameter(Mandatory = $true)][string]$SourceUserDataDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$release = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
$source = (Resolve-Path -LiteralPath $SourceUserDataDirectory).Path
$unpacked = Join-Path $release 'win-unpacked'
$resources = Join-Path $unpacked 'resources'
$baseline = Join-Path $release 'installation-resource-baseline.json'
if (-not (Test-Path -LiteralPath $baseline)) { throw '只能续建已有安装资源基线的候选程序。' }
if (Test-Path -LiteralPath (Join-Path $resources 'backend/data')) { throw '候选程序混入运行数据，拒绝续建。' }
$originalTimings = Get-Content -LiteralPath (Join-Path $release 'build-timings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$collectorChecks = @($originalTimings.stages | Where-Object { $_.name -like '*独立采集服务*' -and $_.exitCode -eq 0 })
if ($collectorChecks.Count -eq 0) { throw '尚无成功的独立采集服务验证，必须先执行完整构建。' }
$desktop = Join-Path $project 'desktop'
$package = Get-Content -LiteralPath (Join-Path $desktop 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$node = (Get-Command node.exe).Source
$exe = Join-Path $unpacked "$($package.build.productName).exe"
$log = Join-Path $release '完整内容续建日志.txt'
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
    $stages.Add([ordered]@{ name = $Label; seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 3); exitCode = $code })
    if ($code -ne 0) { throw "$Label 失败：$code" }
}
try {
    Invoke-Stage '续建前验证候选安装资源未改变' @((Join-Path $PSScriptRoot 'package-resource-integrity.cjs'), '--verify', $unpacked, $baseline)
    Invoke-Stage '核对当前工程、历史、账号配置与模型音频资源' @((Join-Path $PSScriptRoot 'current-package-content-test.cjs'), $resources, $source, (Join-Path $release 'current-content-verification.json'))
    Invoke-Stage '完整内容首次运行与重启 MySQL 验证' @((Join-Path $PSScriptRoot 'packaged-mysql-smoke-test.cjs'), $exe)
    Invoke-Stage '完整内容 MySQL 项目迁移与回滚验证' @((Join-Path $PSScriptRoot 'packaged-project-bundle-mysql-test.cjs'), $exe)
    Invoke-Stage '确认完整内容测试未改写安装资源' @((Join-Path $PSScriptRoot 'package-resource-integrity.cjs'), '--verify', $unpacked, $baseline, (Join-Path $release 'installation-resource-verification.json'))
    $previousCompression = [Environment]::GetEnvironmentVariable('ELECTRON_BUILDER_COMPRESSION_LEVEL', 'Process')
    try {
        $env:ELECTRON_BUILDER_COMPRESSION_LEVEL = '1'
        Invoke-Stage '压缩已验证完整内容并生成 NSIS 安装包' @(
            (Join-Path $desktop 'node_modules/electron-builder/out/cli/cli.js'), '--projectDir', $desktop,
            '--prepackaged', $unpacked, '--win', 'nsis', '--x64', "--config.directories.output=$release", '--config.compression=normal'
        )
    } finally { [Environment]::SetEnvironmentVariable('ELECTRON_BUILDER_COMPRESSION_LEVEL', $previousCompression, 'Process') }
    $installerName = "热处理数字孪生大屏-安装包-$($package.version)-x64.exe"
    $installer = Get-Item -LiteralPath (Join-Path $release $installerName)
    if ($installer.Length -le 0) { throw '安装包为空。' }
    $hash = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath "$($installer.FullName).sha256.txt" -Encoding UTF8 -Value "$hash  $installerName"
    [ordered]@{
        version = $package.version; createdAt = (Get-Date).ToString('o'); installer = $installer.FullName
        size = $installer.Length; sha256 = $hash; mysqlBundled = $true; smokeTest = 'passed'
        includeHistory = $true; starterTemplate = $false; sourceUserDataDirectory = $source
        sourceUploadsDirectory = Join-Path $source 'uploads'; compressionLevel = '1'; buildLog = $log
        contentVerification = Join-Path $release 'current-content-verification.json'
        collectorServiceTest = 'passed-in-original-build'; windowsScmInstallTest = 'requires-elevation'
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $release 'release-manifest.json') -Encoding UTF8
    $success = $true
    Write-Host "完整内容安装包完成：$($installer.FullName)"
    Write-Host "大小：$([Math]::Round($installer.Length / 1MB, 1)) MB；SHA256：$hash"
} finally {
    $timer.Stop()
    [ordered]@{ success = $success; totalSeconds = [Math]::Round($timer.Elapsed.TotalSeconds, 3); stages = @($stages.ToArray()) } |
        ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $release 'completion-timings.json') -Encoding UTF8
}
