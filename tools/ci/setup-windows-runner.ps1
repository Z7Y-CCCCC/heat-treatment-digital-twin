[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [string]$Repository = 'Z7Y-CCCCC/heat-treatment-digital-twin',
    [string]$RunnerDirectory = (Join-Path $env:USERPROFILE 'actions-runners\digital-twin'),
    [string]$RunnerName = "$env:COMPUTERNAME-digital-twin",
    [string]$UnityEditorPath = $env:UNITY_EDITOR_PATH,
    [string]$MysqlRuntimeSource = $env:DESKTOP_MYSQL_RUNTIME_SOURCE
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitOperatingSystem) {
    throw '需要 Windows x64。'
}
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Repository 应为 owner/repo。' }
if ($RunnerName -notmatch '^[A-Za-z0-9_.-]+$') { throw 'RunnerName 只能包含字母、数字、点、下划线和连字符。' }
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
$runnerRoot = [IO.Path]::GetFullPath($RunnerDirectory).TrimEnd('\')
if ($runnerRoot -eq [IO.Path]::GetPathRoot($runnerRoot).TrimEnd('\') -or
    $runnerRoot -eq $repoRoot -or $runnerRoot.StartsWith($repoRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'RunnerDirectory 必须是仓库外的专用目录，不能是磁盘根目录。'
}
$unityVersion = ((Get-Content -LiteralPath (Join-Path $repoRoot 'unity-client\ProjectSettings\ProjectVersion.txt') |
    Where-Object { $_ -match '^m_EditorVersion:' } | Select-Object -First 1) -replace '^m_EditorVersion:\s*', '').Trim()
if (-not $UnityEditorPath) {
    $UnityEditorPath = @(
        "C:\Program Files\Unity $unityVersion\Editor\Unity.exe",
        "C:\Program Files\Unity Hub\Editor\$unityVersion\Editor\Unity.exe",
        "C:\Program Files\Unity\Hub\Editor\$unityVersion\Editor\Unity.exe"
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $UnityEditorPath -or -not (Test-Path -LiteralPath $UnityEditorPath -PathType Leaf)) { throw "缺少 Unity $unityVersion；请设置 -UnityEditorPath。" }
$UnityEditorPath = [IO.Path]::GetFullPath($UnityEditorPath)
$installedVersion = (Get-Item -LiteralPath $UnityEditorPath).VersionInfo.ProductVersion
if (($installedVersion -split '_')[0] -ne $unityVersion) { throw "Unity 版本不匹配：需要 $unityVersion，实际 $installedVersion。" }
if (-not $MysqlRuntimeSource) { $MysqlRuntimeSource = 'C:\Program Files\MySQL\MySQL Server 9.2' }
$MysqlRuntimeSource = [IO.Path]::GetFullPath($MysqlRuntimeSource)
foreach ($file in @('bin\mysqld.exe', 'bin\mysql.exe', 'bin\mysqladmin.exe', 'bin\mysqldump.exe', 'LICENSE', 'README', 'lib', 'share')) {
    if (-not (Test-Path -LiteralPath (Join-Path $MysqlRuntimeSource $file))) { throw "MySQL 运行时缺少 $file；请设置 -MysqlRuntimeSource。" }
}
foreach ($command in @('node', 'npm.cmd', 'dotnet', 'git', 'gh', 'curl.exe', 'tar.exe')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "缺少命令：$command" }
}
$nodeVersion = & node --version
if ($LASTEXITCODE -ne 0 -or [version]($nodeVersion.TrimStart('v')) -lt [version]'22.12.0') { throw '需要 Node.js 22.12.0 或更高版本。' }
$sdks = & dotnet --list-sdks
if ($LASTEXITCODE -ne 0 -or -not ($sdks -match '^8\.')) { throw '需要 .NET 8 SDK。' }
Write-Host "预检通过：Windows x64 / Node $nodeVersion / .NET 8 / Unity $unityVersion / MySQL 运行文件。"
Write-Host 'Unity 许可证与 WebView2 实际启动能力将在发布构建及 smoke test 中验证。请使用已登录桌面的专用构建账户。'
if ($CheckOnly) { return }

function Invoke-GitHubJson([string[]]$Arguments) {
    # Capture stderr too: never write a registration token or API payload to the console.
    $response = & gh @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'GitHub API 请求失败。请确认 gh auth login 已完成，并具有该仓库的 Actions runner 管理权限。' }
    try { return (($response -join "`n") | ConvertFrom-Json) } catch { throw 'GitHub API 没有返回有效 JSON。' }
}
$repoInfo = Invoke-GitHubJson @('api', "repos/$Repository")
if (-not $repoInfo.permissions.admin) { throw '注册 runner 需要该仓库管理员权限；当前 gh 登录账户不满足要求。' }
$repoUrl = "https://github.com/$Repository"
$configFile = Join-Path $runnerRoot '.runner'
if (Test-Path -LiteralPath $configFile) {
    $configured = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    if ($configured.gitHubUrl.TrimEnd('/') -ine $repoUrl -or $configured.agentName -ne $RunnerName) {
        throw '该目录已配置为其它仓库或 runner 名称，请使用原参数或另外的专用目录。'
    }
    $null = Invoke-GitHubJson @('api', "repos/$Repository/actions/runners/$($configured.agentId)")
} else {
    $existing = Invoke-GitHubJson @('api', "repos/$Repository/actions/runners?per_page=100", '--paginate', '--slurp')
    if (@($existing | ForEach-Object { $_.runners } | Where-Object { $_.name -eq $RunnerName }).Count -gt 0) {
        throw '远端已有同名 runner，但本机目录未配置。请恢复原目录，或使用不同 RunnerName；不会覆盖已有 runner。'
    }
    if (Test-Path -LiteralPath $runnerRoot) {
        if (@(Get-ChildItem -LiteralPath $runnerRoot -Force).Count -gt 0) { throw '未配置的 RunnerDirectory 必须为空，避免覆盖其他文件。' }
    } else { New-Item -ItemType Directory -Path $runnerRoot -Force | Out-Null }
    $downloads = Invoke-GitHubJson @('api', "repos/$Repository/actions/runners/downloads")
    $download = $downloads | Where-Object { $_.os -eq 'win' -and $_.architecture -eq 'x64' } | Select-Object -First 1
    if (-not $download -or $download.filename -notmatch '^actions-runner-win-x64-[0-9.]+\.zip$' -or
        $download.download_url -notmatch '^https://github\.com/actions/runner/releases/download/v[0-9.]+/actions-runner-win-x64-[0-9.]+\.zip$' -or
        $download.sha256_checksum -notmatch '^[a-fA-F0-9]{64}$') { throw 'GitHub 未返回带 SHA256 校验的官方 Windows runner 下载信息。' }
    $archive = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N') + '-runner.zip')
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $download.download_url -OutFile $archive
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $download.sha256_checksum) { throw 'Runner 下载 SHA256 校验失败。' }
        Expand-Archive -LiteralPath $archive -DestinationPath $runnerRoot
    } finally { if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force } }
    $registration = Invoke-GitHubJson @('api', '--method', 'POST', "repos/$Repository/actions/runners/registration-token")
    $oldToken = [Environment]::GetEnvironmentVariable('ACTIONS_RUNNER_INPUT_TOKEN', 'Process')
    try {
        $env:ACTIONS_RUNNER_INPUT_TOKEN = $registration.token
        Push-Location -LiteralPath $runnerRoot
        try {
            & .\config.cmd --unattended --url $repoUrl --name $RunnerName --labels digital-twin-release --work _work
            if ($LASTEXITCODE -ne 0) { throw 'Runner 配置失败。请查看上方配置程序提示。' }
        } finally { Pop-Location }
    } finally {
        [Environment]::SetEnvironmentVariable('ACTIONS_RUNNER_INPUT_TOKEN', $oldToken, 'Process')
        $registration = $null
    }
}

function Get-OwnedListener {
    $listener = Join-Path $runnerRoot 'bin\Runner.Listener.exe'
    @(Get-CimInstance Win32_Process -Filter "Name = 'Runner.Listener.exe'" | Where-Object { $_.ExecutablePath -ieq $listener })
}
if (@(Get-OwnedListener).Count -gt 0) { Write-Host "Runner 已运行：$RunnerName（不重复启动）。"; return }
if (-not (Test-Path -LiteralPath (Join-Path $runnerRoot 'run.cmd'))) { throw '缺少 run.cmd，runner 安装不完整。' }
$env:UNITY_EDITOR_PATH = $UnityEditorPath
$env:DESKTOP_MYSQL_RUNTIME_SOURCE = $MysqlRuntimeSource
Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', ('""{0}""' -f (Join-Path $runnerRoot 'run.cmd'))) -WorkingDirectory $runnerRoot -WindowStyle Hidden | Out-Null
for ($attempt = 0; $attempt -lt 15; $attempt++) {
    Start-Sleep -Seconds 1
    if (@(Get-OwnedListener).Count -gt 0) { Write-Host "Runner 已在当前用户会话后台启动：$RunnerName；标签 digital-twin-release。"; return }
}
throw "Runner 未成功启动，请检查 $runnerRoot\_diag 下日志。"
