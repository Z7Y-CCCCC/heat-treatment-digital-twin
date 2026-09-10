[CmdletBinding()]
param(
    [string]$MySqlHost = '127.0.0.1',
    [int]$MySqlPort = 3307,
    [string]$MySqlUser = 'root',
    [string]$MySqlPassword = 'root',
    [string]$MySqlDatabase = 'dongtai_daping',
    [int]$BackendPort = 3001,
    [int]$FrontendPort = 3423,
    [switch]$BackendOnly
)

$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $projectDir 'backend'
$frontendDir = Join-Path $projectDir 'frontend'
$tmpDir = Join-Path $projectDir 'tmp'
$unityDir = Join-Path $projectDir 'unity-client\Builds\Windows'
$unityExe = Join-Path $unityDir 'HeatTreatmentDigitalTwin.exe'
$adminHostDir = Join-Path $unityDir 'AdminHost'
$adminHostExe = Join-Path $adminHostDir 'HeatTreatmentAdminHost.exe'
$adminHostProjectDir = Join-Path $projectDir 'native-admin-host'
$adminHostBuildScript = Join-Path $projectDir 'desktop\scripts\build-native-admin-host.cjs'
$origin = "http://127.0.0.1:$BackendPort"
$frontendOrigin = "http://127.0.0.1:$FrontendPort"
$webSocketUrl = "ws://127.0.0.1:$BackendPort/ws"
$backendOut = Join-Path $tmpDir 'native-dev-backend.out.log'
$backendErr = Join-Path $tmpDir 'native-dev-backend.err.log'
$frontendOut = Join-Path $tmpDir 'native-dev-frontend.out.log'
$frontendErr = Join-Path $tmpDir 'native-dev-frontend.err.log'
$unityLog = Join-Path $tmpDir 'native-dev-unity.log'

New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
$node = Get-Command node -ErrorAction Stop

# The backend-only workflow must not touch the embedded AdminHost.  Its DLLs can
# be locked by a running Unity window, and rebuilding it is unrelated to starting
# the Node service.  Only the full Unity workflow needs this freshness check.
if (-not $BackendOnly) {
    $adminHostSources = Get-ChildItem $adminHostProjectDir -File -ErrorAction SilentlyContinue | Where-Object {
        $_.Extension -in @('.cs', '.csproj')
    }
    $adminHostNeedsBuild = -not (Test-Path $adminHostExe)
    if (-not $adminHostNeedsBuild -and $adminHostSources) {
        $adminHostTimestamp = (Get-Item $adminHostExe).LastWriteTimeUtc
        $adminHostNeedsBuild = ($adminHostSources | Where-Object { $_.LastWriteTimeUtc -gt $adminHostTimestamp }).Count -gt 0
    }
    if ($adminHostNeedsBuild) {
        Write-Host 'Building Unity embedded admin host...'
        & $node.Source $adminHostBuildScript
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $adminHostExe)) {
            throw 'Unity embedded admin host build failed.'
        }
    }
}

function Read-BackendHealth {
    try {
        return Invoke-RestMethod -Uri "$origin/api/health" -TimeoutSec 2
    } catch {
        return $null
    }
}

function Test-AdminPage([string]$url) {
    try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
        return $response.StatusCode -eq 200 -and $response.Content -notmatch 'Cannot GET /admin'
    } catch {
        return $false
    }
}

function Test-OriginalWebDatabase($health) {
    if (-not $health) { return $false }
    $config = $health.db.config
    return $health.db.connected -eq $true `
        -and $health.db.type -eq 'mysql' `
        -and $config.host -eq $MySqlHost `
        -and [int]$config.port -eq $MySqlPort `
        -and $config.database -eq $MySqlDatabase
}

function Assert-OriginalWebDatabase($health) {
    if (-not $health) { throw 'Backend health check did not respond.' }
    if (-not (Test-OriginalWebDatabase $health)) {
        throw "Port $BackendPort is occupied by a backend that is not connected to the original Web MySQL database (expected $MySqlHost`:$MySqlPort/$MySqlDatabase)."
    }
}

function Invoke-WithProcessEnvironment($values, [scriptblock]$action) {
    $previous = @{}
    try {
        foreach ($entry in $values.GetEnumerator()) {
            $previous[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
            [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, 'Process')
        }
        & $action
    } finally {
        foreach ($entry in $previous.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
        }
    }
}

$health = Read-BackendHealth
$backendProcess = $null
if ($health) {
    Assert-OriginalWebDatabase $health
    Write-Host "Reusing backend at $origin (original Web MySQL)."
} else {
    $shutdownToken = "native-dev-$PID-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    $backendEnvironment = @{
        NODE_ENV = 'development'
        HOST = '127.0.0.1'
        PORT = $BackendPort
        APP_DATA_DIR = (Join-Path $backendDir 'data')
        UPLOADS_DIR = (Join-Path $backendDir 'uploads')
        FRONTEND_DIST = (Join-Path $projectDir 'frontend\dist')
        # The native-dev frontend uses a dedicated local port. Register that
        # exact origin so credentialed admin-auth requests pass the same
        # loopback/origin checks as the default Vite ports.
        CORS_ALLOWED_ORIGINS = $frontendOrigin
        ENABLE_CORS = 'true'
        DB_TYPE = 'mysql'
        MYSQL_HOST = $MySqlHost
        MYSQL_PORT = $MySqlPort
        MYSQL_USER = $MySqlUser
        MYSQL_PASSWORD = $MySqlPassword
        MYSQL_DATABASE = $MySqlDatabase
        DESKTOP_SHUTDOWN_TOKEN = $shutdownToken
    }
    Invoke-WithProcessEnvironment $backendEnvironment {
        $script:backendProcess = Start-Process `
            -FilePath $node.Source `
            -ArgumentList 'server.js' `
            -WorkingDirectory $backendDir `
            -WindowStyle Hidden `
            -RedirectStandardOutput $backendOut `
            -RedirectStandardError $backendErr `
            -PassThru
    }

    $deadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 300
        if ($backendProcess.HasExited) {
            throw "Backend exited with code $($backendProcess.ExitCode). See $backendErr"
        }
        $health = Read-BackendHealth
    } while (-not (Test-OriginalWebDatabase $health) -and (Get-Date) -lt $deadline)
    Assert-OriginalWebDatabase $health
    Write-Host "Backend started at $origin (PID $($backendProcess.Id))."
}

$factory = Invoke-RestMethod -Uri "$origin/api/config" -TimeoutSec 10
$devices = @(
    foreach ($workshop in @($factory.workshops)) {
        foreach ($line in @($workshop.lines)) { @($line.devices) }
        @($workshop.devices)
    }
)
$pointCount = (@($devices | ForEach-Object { @($_.dataPoints) }) | Measure-Object).Count
Write-Host "Loaded original Web configuration: $($devices.Count) devices, $pointCount PLC data points."

$frontendProcess = $null
$adminUrl = "$origin/admin"
if (Test-AdminPage "$frontendOrigin/admin") {
    $adminUrl = "$frontendOrigin/admin"
    Write-Host "Reusing frontend at $frontendOrigin."
} elseif (Test-AdminPage $adminUrl) {
    Write-Host "Using backend-hosted frontend at $origin."
} else {
    $viteEntry = Join-Path $frontendDir 'node_modules\vite\bin\vite.js'
    if (-not (Test-Path $viteEntry)) {
        throw "后台 API 已启动，但没有可用的管理页面。请先在 $frontendDir 执行 npm install。"
    }
    $frontendProcess = Start-Process `
        -FilePath $node.Source `
        -ArgumentList @($viteEntry, '--host', '127.0.0.1', '--port', [string]$FrontendPort) `
        -WorkingDirectory $frontendDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $frontendOut `
        -RedirectStandardError $frontendErr `
        -PassThru

    $frontendDeadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 300
        if ($frontendProcess.HasExited) {
            throw "Frontend exited with code $($frontendProcess.ExitCode). See $frontendErr"
        }
    } while (-not (Test-AdminPage "$frontendOrigin/admin") -and (Get-Date) -lt $frontendDeadline)
    if (-not (Test-AdminPage "$frontendOrigin/admin")) {
        throw "Frontend startup timed out. See $frontendErr"
    }
    $adminUrl = "$frontendOrigin/admin"
    Write-Host "Frontend started at $frontendOrigin (PID $($frontendProcess.Id))."
}

if (-not $BackendOnly) {
    if (-not (Test-Path $unityExe)) {
        throw "Unity development player is missing. Run desktop\scripts\build-unity-client.cjs first: $unityExe"
    }
    $existingUnity = Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq [IO.Path]::GetFullPath($unityExe)
    } | Select-Object -First 1
    if ($existingUnity) {
        Write-Host "Unity development player is already running (PID $($existingUnity.ProcessId)); no duplicate was started."
    } else {
        $noProxy = @($env:NO_PROXY, 'localhost', '127.0.0.1') | Where-Object { $_ } | Select-Object -Unique
        $unityEnvironment = @{
            NO_PROXY = ($noProxy -join ',')
            HTTP_PROXY = ''
            HTTPS_PROXY = ''
            ALL_PROXY = ''
            DIGITAL_TWIN_BACKEND_HTTP_URL = $origin
            DIGITAL_TWIN_BACKEND_WEBSOCKET_URL = $webSocketUrl
            DIGITAL_TWIN_ADMIN_URL = $adminUrl
            DIGITAL_TWIN_ADMIN_HOST_PATH = $adminHostExe
            DIGITAL_TWIN_ADMIN_FIXED_RUNTIME = (Join-Path $adminHostDir 'WebView2Runtime')
            DIGITAL_TWIN_MAXIMIZE_WINDOW = 'false'
        }
        Invoke-WithProcessEnvironment $unityEnvironment {
            $script:unityProcess = Start-Process `
                -FilePath $unityExe `
                -ArgumentList @(
                    '-force-d3d11',
                    '-screen-fullscreen', '0',
                    '-screen-width', '1600',
                    '-screen-height', '900',
                    '-logFile', $unityLog
                ) `
                -WorkingDirectory $unityDir `
                -PassThru
        }
        Write-Host "Unity development player started (PID $($unityProcess.Id)); log: $unityLog"
    }
}

[pscustomobject]@{
    BackendUrl = $origin
    AdminUrl = $adminUrl
    Database = "$MySqlHost`:$MySqlPort/$MySqlDatabase"
    DeviceCount = $devices.Count
    DataPointCount = $pointCount
    BackendPid = if ($backendProcess) { $backendProcess.Id } else { $null }
    FrontendPid = if ($frontendProcess) { $frontendProcess.Id } else { $null }
    UnityPid = if ($unityProcess) { $unityProcess.Id } elseif ($existingUnity) { $existingUnity.ProcessId } else { $null }
}
