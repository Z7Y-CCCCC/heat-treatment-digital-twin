[CmdletBinding()]
param(
    [string]$DatabaseHost = '127.0.0.1',
    [int]$DatabasePort = 3307,
    [string]$DatabaseUser = 'root',
    [string]$DatabasePassword = 'root',
    [string]$DatabaseName = 'dongtai_daping',
    [switch]$IncludeHistory,
    [switch]$RefreshDependencies,
    [switch]$ForceUnityBuild,
    [switch]$StarterTemplate,
    [switch]$SkipSmokeTest,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectDirectory = $PSScriptRoot
$desktopDirectory = Join-Path $projectDirectory 'desktop'
$outputRoot = Join-Path $projectDirectory '安装包'
$outputDirectory = Join-Path $outputRoot ("release-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$packageFile = Join-Path $desktopDirectory 'package.json'
$unityVersionFile = Join-Path $projectDirectory 'unity-client\ProjectSettings\ProjectVersion.txt'

function Resolve-RequiredCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Names,

        [Parameter(Mandatory = $true)]
        [string]$InstallHint
    )

    foreach ($name in $Names) {
        $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { return $command.Source }
    }
    throw $InstallHint
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,

        [Parameter(Mandatory = $true)]
        [string]$Executable,

        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList
    )

    Write-Host "`n[$Label]" -ForegroundColor Cyan
    if ($script:transcriptStarted) {
        Stop-Transcript | Out-Null
        $script:transcriptStarted = $false
    }
    $exitCode = -1
    $stageTimer = [Diagnostics.Stopwatch]::StartNew()
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 wraps native stderr lines (including harmless
        # Vite/electron-builder warnings) as ErrorRecord objects.  Do not let
        # those records abort the pipeline; the native exit code remains the
        # authoritative success/failure signal.
        $ErrorActionPreference = 'Continue'
        & $Executable @ArgumentList 2>&1 |
            ForEach-Object { Write-Host $_; $_ } |
            Out-File -FilePath $script:buildLogPath -Append -Encoding UTF8 -ErrorAction Stop
        $exitCode = $LASTEXITCODE
    } finally {
        $stageTimer.Stop()
        $stageSeconds = [Math]::Round($stageTimer.Elapsed.TotalSeconds, 3)
        $script:buildStages.Add([ordered]@{ name = $Label; seconds = $stageSeconds; exitCode = $exitCode })
        $ErrorActionPreference = $previousErrorActionPreference
        try {
            Start-Transcript -LiteralPath $script:buildLogPath -Append | Out-Null
            $script:transcriptStarted = $true
        } catch {
            Write-Host "无法继续写入 PowerShell 构建日志：$($_.Exception.Message)" -ForegroundColor Yellow
        }
        Write-Host "[$Label] 耗时 $stageSeconds 秒" -ForegroundColor Cyan
    }
    if ($exitCode -ne 0) {
        throw "$Label 失败（退出码 $exitCode）。"
    }
}

function Ensure-NodeDependencies {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Directory,

        [Parameter(Mandatory = $true)]
        [string]$Label,

        [Parameter(Mandatory = $true)]
        [string]$NpmExecutable
    )

    $nodeModules = Join-Path $Directory 'node_modules'
    $dependencyStateScript = Join-Path $desktopDirectory 'scripts\dependency-state.cjs'
    if ((Test-Path -LiteralPath $nodeModules) -and -not $RefreshDependencies) {
        & $node $dependencyStateScript 'check' $Directory
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[$Label] 依赖锁文件、安装记录和 Node 运行时未变化，直接复用。"
            return
        }
        Write-Host "[$Label] 依赖或运行时变化，或尚无成功安装记录，重新安装后建立记录。"
    }

    $installCommand = if (Test-Path -LiteralPath (Join-Path $Directory 'package-lock.json')) { 'ci' } else { 'install' }
    Invoke-CheckedCommand -Label "$Label 依赖安装" -Executable $NpmExecutable -ArgumentList @(
        '--prefix',
        $Directory,
        $installCommand
    )
    & $node $dependencyStateScript 'record' $Directory
    if ($LASTEXITCODE -ne 0) { throw "$Label 依赖安装状态记录失败。" }
}

function Resolve-UnityEditor {
    if (-not (Test-Path -LiteralPath $unityVersionFile)) {
        throw "缺少 Unity 版本文件：$unityVersionFile"
    }

    $versionLine = Get-Content -LiteralPath $unityVersionFile | Where-Object {
        $_ -match '^m_EditorVersion:\s*'
    } | Select-Object -First 1
    if (-not $versionLine) {
        throw "无法从 $unityVersionFile 读取 Unity 编辑器版本。"
    }

    $version = ($versionLine -replace '^m_EditorVersion:\s*', '').Trim()
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($env:UNITY_EDITOR_PATH) {
        $candidates.Add([IO.Path]::GetFullPath($env:UNITY_EDITOR_PATH))
    }
    $candidates.Add("C:\Program Files\Unity $version\Editor\Unity.exe")
    $candidates.Add("C:\Program Files\Unity Hub\Editor\$version\Editor\Unity.exe")
    $candidates.Add("C:\Program Files\Unity\Hub\Editor\$version\Editor\Unity.exe")

    if (Test-Path -LiteralPath 'C:\Program Files') {
        Get-ChildItem -LiteralPath 'C:\Program Files' -Directory -Filter 'Unity*' -ErrorAction SilentlyContinue |
            ForEach-Object { $candidates.Add((Join-Path $_.FullName 'Editor\Unity.exe')) }
    }

    $editor = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $editor) {
        throw "未找到 Unity $version。请安装对应编辑器，或先设置 UNITY_EDITOR_PATH 指向 Unity.exe。"
    }
    return $editor
}

function Assert-ApplicationIsClosed {
    $running = Get-Process -Name 'HeatTreatmentDigitalTwin', 'HeatTreatmentAdminHost' -ErrorAction SilentlyContinue
    if ($running) {
        $processList = ($running | ForEach-Object { "$($_.ProcessName) (PID $($_.Id))" }) -join '、'
        throw "打包前请先关闭正在运行的调试程序：$processList"
    }
}

$buildFailed = $false
$buildStartedAt = (Get-Date).ToString('o')
$buildTimer = [Diagnostics.Stopwatch]::StartNew()
$buildStages = New-Object 'System.Collections.Generic.List[object]'
$transcriptStarted = $false
$buildLogPath = $null

try {

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw '此脚本仅支持在 Windows 开发电脑上生成安装包。'
}
if (-not (Test-Path -LiteralPath $packageFile)) {
    throw "脚本必须放在项目根目录运行，当前找不到：$packageFile"
}

New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$buildLogPath = Join-Path $outputDirectory ("构建日志-{0}.txt" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
try {
    Start-Transcript -LiteralPath $buildLogPath -Force | Out-Null
    $transcriptStarted = $true
} catch {
    Write-Host "无法启动 PowerShell 构建日志：$($_.Exception.Message)" -ForegroundColor Yellow
}

$node = Resolve-RequiredCommand -Names @('node.exe', 'node') -InstallHint '未找到 Node.js，请先安装 Node.js 22.12 或更高版本。'
$npm = Resolve-RequiredCommand -Names @('npm.cmd', 'npm') -InstallHint '未找到 npm，请重新安装包含 npm 的 Node.js。'
$null = Resolve-RequiredCommand -Names @('dotnet.exe', 'dotnet') -InstallHint '未找到 .NET SDK，请先安装支持 .NET 8 的 SDK。'
$unityEditor = Resolve-UnityEditor
$desktopPackage = Get-Content -Raw -LiteralPath $packageFile -Encoding UTF8 | ConvertFrom-Json
$version = [string]$desktopPackage.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw "无法从 $packageFile 读取安装包版本。"
}

Assert-ApplicationIsClosed

Write-Host '热处理数字孪生大屏：安装包构建' -ForegroundColor Green
Write-Host "项目目录：$projectDirectory"
Write-Host "软件版本：$version"
Write-Host "Unity：$unityEditor"
$unityBuildMode = if ($ForceUnityBuild) { '强制重新生成' } else { '源码未变化时复用缓存' }
Write-Host "Unity 构建：$unityBuildMode"
Write-Host "配置数据库：$DatabaseHost`:$DatabasePort/$DatabaseName"
$historyText = if ($IncludeHistory) { '包含' } else { '不包含，仅交付现场配置' }
Write-Host "运行历史：$historyText"
Write-Host "构建日志：$buildLogPath"

Ensure-NodeDependencies -Directory (Join-Path $projectDirectory 'backend') -Label '后端' -NpmExecutable $npm
Ensure-NodeDependencies -Directory (Join-Path $projectDirectory 'frontend') -Label '前端' -NpmExecutable $npm
Ensure-NodeDependencies -Directory $desktopDirectory -Label '桌面端' -NpmExecutable $npm

$environmentNames = @(
    'UNITY_EDITOR_PATH',
    'DESKTOP_MYSQL_HOST',
    'DESKTOP_MYSQL_PORT',
    'DESKTOP_MYSQL_USER',
    'DESKTOP_MYSQL_PASSWORD',
    'DESKTOP_MYSQL_DATABASE',
    'DESKTOP_TEMPLATE_INCLUDE_HISTORY',
    'DESKTOP_TEMPLATE_EMPTY',
    'DESKTOP_TEMPLATE_SOURCE_DB',
    'DESKTOP_TEMPLATE_SOURCE_UPLOADS',
    'DESKTOP_FORCE_UNITY_REBUILD'
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

try {
    $env:UNITY_EDITOR_PATH = $unityEditor
    $env:DESKTOP_MYSQL_HOST = $DatabaseHost
    $env:DESKTOP_MYSQL_PORT = [string]$DatabasePort
    $env:DESKTOP_MYSQL_USER = $DatabaseUser
    $env:DESKTOP_MYSQL_PASSWORD = $DatabasePassword
    $env:DESKTOP_MYSQL_DATABASE = $DatabaseName
    $env:DESKTOP_TEMPLATE_INCLUDE_HISTORY = if ($IncludeHistory) { 'true' } else { 'false' }
    $env:DESKTOP_TEMPLATE_EMPTY = if ($StarterTemplate) { 'true' } else { 'false' }
    Remove-Item Env:DESKTOP_TEMPLATE_SOURCE_DB -ErrorAction SilentlyContinue
    Remove-Item Env:DESKTOP_TEMPLATE_SOURCE_UPLOADS -ErrorAction SilentlyContinue
    $env:DESKTOP_FORCE_UNITY_REBUILD = if ($ForceUnityBuild) { 'true' } else { 'false' }

    $installerName = "热处理数字孪生大屏-安装包-$version-x64.exe"
    foreach ($buildStep in @('build:frontend', 'build:unity', 'build:admin-host', 'build:collector-service', 'prepare:resources')) {
        Invoke-CheckedCommand -Label $buildStep -Executable $npm -ArgumentList @('--prefix', $desktopDirectory, 'run', $buildStep)
    }
    $builderCli = Join-Path $desktopDirectory 'node_modules/electron-builder/out/cli/cli.js'
    Invoke-CheckedCommand -Label '生成可验证的 Windows x64 程序目录' -Executable $node -ArgumentList @(
        $builderCli,
        '--projectDir', $desktopDirectory,
        '--dir', '--win', '--x64',
        "--config.directories.output=$outputDirectory",
        '--config.compression=normal'
    )
} finally {
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
}

$unpacked = Join-Path (Join-Path $outputDirectory 'win-unpacked') "$($desktopPackage.build.productName).exe"
if (-not (Test-Path -LiteralPath $unpacked)) { throw "缺少解包验证程序：$unpacked" }
if (-not $SkipSmokeTest) {
    Invoke-CheckedCommand -Label '独立采集服务：无 Unity 采集、重启持久化与安全停库验证' -Executable $node -ArgumentList @(
        (Join-Path $projectDirectory 'tools/collector-service-smoke-test.cjs'),
        (Join-Path $outputDirectory 'win-unpacked/resources')
    )
    Invoke-CheckedCommand -Label '首次运行随包 MySQL 验证' -Executable $node -ArgumentList @(
        (Join-Path $projectDirectory 'tools/packaged-mysql-smoke-test.cjs'),
        $unpacked
    )
    Invoke-CheckedCommand -Label '随包 MySQL 项目迁移与回滚验证' -Executable $node -ArgumentList @(
        (Join-Path $projectDirectory 'tools/packaged-project-bundle-mysql-test.cjs'),
        $unpacked
    )
} else {
    Write-Warning '本次已明确跳过首次运行和项目迁移 MySQL 验证，不应宣称已通过新电脑验证。'
}

$previousCompressionLevel = [Environment]::GetEnvironmentVariable('ELECTRON_BUILDER_COMPRESSION_LEVEL', 'Process')
$effectiveCompressionLevel = if ([string]::IsNullOrWhiteSpace($previousCompressionLevel)) { '1' } else { $previousCompressionLevel }
if ($effectiveCompressionLevel -notmatch '^[0-9]$') {
    throw 'ELECTRON_BUILDER_COMPRESSION_LEVEL 必须为 0 到 9 的单个数字。'
}
try {
    $env:ELECTRON_BUILDER_COMPRESSION_LEVEL = $effectiveCompressionLevel
    Write-Host "ZIP 压缩级别：$effectiveCompressionLevel（默认 1，可通过 ELECTRON_BUILDER_COMPRESSION_LEVEL 覆盖）"
    Invoke-CheckedCommand -Label '压缩已验证的程序并生成 NSIS 安装包' -Executable $node -ArgumentList @(
        $builderCli,
        '--projectDir', $desktopDirectory,
        '--prepackaged', (Join-Path $outputDirectory 'win-unpacked'),
        '--win', 'nsis', '--x64',
        "--config.directories.output=$outputDirectory",
        '--config.compression=normal'
    )
} finally {
    [Environment]::SetEnvironmentVariable('ELECTRON_BUILDER_COMPRESSION_LEVEL', $previousCompressionLevel, 'Process')
}
$installerPath = Join-Path $outputDirectory $installerName
if (-not (Test-Path -LiteralPath $installerPath)) {
    throw "构建命令已结束，但没有找到预期安装包：$installerPath"
}
$installer = Get-Item -LiteralPath $installerPath
if ($installer.Length -le 0) { throw "安装包文件为空：$installerPath" }

$hash = Get-FileHash -LiteralPath $installerPath -Algorithm SHA256
$checksumPath = "$installerPath.sha256.txt"
Set-Content -LiteralPath $checksumPath -Encoding UTF8 -Value "$($hash.Hash.ToLowerInvariant())  $installerName"
$releaseManifest = [ordered]@{
    version = $version
    createdAt = (Get-Date).ToString('o')
    installer = $installerPath
    size = $installer.Length
    sha256 = $hash.Hash.ToLowerInvariant()
    mysqlBundled = $true
    smokeTest = if ($SkipSmokeTest) { 'skipped' } else { 'passed' }
    includeHistory = [bool]$IncludeHistory
    starterTemplate = [bool]$StarterTemplate
    compressionLevel = $effectiveCompressionLevel
    buildLog = $buildLogPath
}
$releaseManifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outputDirectory 'release-manifest.json') -Encoding UTF8

Write-Host "`n安装包生成完成。" -ForegroundColor Green
Write-Host "安装包：$installerPath"
Write-Host "文件大小：$([Math]::Round($installer.Length / 1MB, 1)) MB"
Write-Host "SHA-256：$($hash.Hash)"
Write-Host "校验文件：$checksumPath"

} catch {
    $buildFailed = $true
    Write-Host "`n==================== 构建失败 ====================" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkYellow
    Write-Host "====================================================" -ForegroundColor Red
} finally {
    $buildTimer.Stop()
    try {
        if (Test-Path -LiteralPath $outputDirectory) {
            $timingPath = Join-Path $outputDirectory 'build-timings.json'
            $timingReport = [ordered]@{
                startedAt = $buildStartedAt
                success = -not $buildFailed
                totalSeconds = [Math]::Round($buildTimer.Elapsed.TotalSeconds, 3)
                stages = @($buildStages.ToArray())
            }
            $timingJson = $timingReport | ConvertTo-Json -Depth 5
            $timingJson | Set-Content -LiteralPath $timingPath -Encoding UTF8
            $timingCache = Join-Path $desktopDirectory '.cache'
            New-Item -ItemType Directory -Force -Path $timingCache | Out-Null
            $timingJson | Set-Content -LiteralPath (Join-Path $timingCache 'build-timings.json') -Encoding UTF8
            Write-Host "构建耗时记录：$timingPath" -ForegroundColor Cyan
        }
    } catch {
        Write-Warning "无法保存构建耗时报告：$($_.Exception.Message)"
    }
    if ($transcriptStarted) {
        try { Stop-Transcript | Out-Null } catch { }
    }
    Write-Host ''
    if ($buildLogPath) {
        Write-Host "构建日志已保留：$buildLogPath" -ForegroundColor Cyan
    }
    if (-not $NoPause) {
        Read-Host '按回车键关闭此窗口'
    }
}

if ($buildFailed) { exit 1 }
