[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$RunnerDirectory)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($RunnerDirectory).TrimEnd('\')
$config = Get-Content -LiteralPath (Join-Path $root 'release-environment.json') -Raw | ConvertFrom-Json
$listener = Join-Path $root 'bin\Runner.Listener.exe'
if (-not (Test-Path -LiteralPath $listener)) { throw 'Runner installation is incomplete.' }
$nameBytes = [Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant())
$hash = [Security.Cryptography.SHA256]::Create()
$id = -join ($hash.ComputeHash($nameBytes) | ForEach-Object { $_.ToString('x2') })
$mutex = New-Object Threading.Mutex($false, "Local\DigitalTwinReleaseRunner-$id")
if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); return }
try {
    $env:UNITY_EDITOR_PATH = $config.unityEditor
    $env:DESKTOP_MYSQL_RUNTIME_SOURCE = $config.mysqlRuntime
    if ($config.publicKey) { $env:LICENSE_ISSUER_PUBLIC_KEY_FILE = $config.publicKey }
    Push-Location -LiteralPath $root
    try {
        while (-not (Test-Path -LiteralPath (Join-Path $root 'stop.flag'))) {
            $running = @(Get-CimInstance Win32_Process -Filter "Name = 'Runner.Listener.exe'" |
                Where-Object { $_.ExecutablePath -ieq $listener })
            if ($running.Count) { return }
            & .\run.cmd
            Start-Sleep -Seconds 15
        }
    } finally { Pop-Location }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
