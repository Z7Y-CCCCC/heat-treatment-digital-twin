[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$TestRoot)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root=(Resolve-Path -LiteralPath $TestRoot).Path
$statusFile=Join-Path $root 'deployment-status.json'
function Record-Stage([string]$stage,[string]$detail='') {
    @{stage=$stage;detail=$detail;updatedAt=(Get-Date).ToUniversalTime().ToString('o');pid=$PID} | ConvertTo-Json | Set-Content -LiteralPath $statusFile -Encoding UTF8
}
try {
    Record-Stage 'waiting-for-upload'
    $installer=Join-Path $root 'DapingSetup.exe'
    $deadline=(Get-Date).AddHours(12)
    do {
        if (Test-Path -LiteralPath (Join-Path $root 'CANCEL-DEPLOYMENT')) { throw 'Deployment cancelled by operator.' }
        if ((Test-Path -LiteralPath $installer) -and (Get-Item -LiteralPath $installer).Length -eq 579827413) { break }
        if ((Get-Date) -gt $deadline) { throw 'Installer upload did not finish within 12 hours.' }
        Start-Sleep -Seconds 15
    } while ($true)
    Record-Stage 'checking-installer'
    if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne '3e1e57de5b1ffdcb8765189f65f5dea0e7bc5085a3ae60fc8553f23eef65ade1') { throw 'Installer hash mismatch.' }
    $program=Join-Path $root 'program'
    if (Test-Path -LiteralPath $program) { throw 'Program directory already exists; refusing to overwrite.' }
    Record-Stage 'installing'
    $installation=Start-Process -FilePath $installer -ArgumentList @('/S',"/D=$program") -WindowStyle Hidden -Wait -PassThru
    if ($installation.ExitCode -ne 0) { throw "Installer exit code: $($installation.ExitCode)" }
    Record-Stage 'preparing-workspace'
    & (Join-Path $root 'remote-endurance-bootstrap.ps1') -TestRoot $root 1> (Join-Path $root 'bootstrap.log')
    Record-Stage 'short-preflight'
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'run-remote-endurance.ps1') -TestRoot $root -DurationSeconds 60
    if ($LASTEXITCODE -ne 0) { throw 'Remote short preflight failed; inspect its report before retrying.' }
    $shortDir=Join-Path $root 'short-preflight'
    New-Item -ItemType Directory -Path $shortDir | Out-Null
    foreach ($name in @('endurance.stdout.log','endurance.stderr.log','run-launch.json','run-exit.json')) { Copy-Item -LiteralPath (Join-Path $root $name) -Destination (Join-Path $shortDir $name) }
    $preflightReport=Get-ChildItem -LiteralPath (Join-Path $root 'workspace\output') -Directory -Filter 'endurance-*' | Sort-Object CreationTime -Descending | Select-Object -First 1
    $preflight=Get-Content -LiteralPath (Join-Path $preflightReport.FullName 'report.json') -Raw | ConvertFrom-Json
    if ($preflight.status -ne 'passed' -or $preflight.requestedSeconds -ne 60) { throw 'Short report did not prove a 60-second pass.' }
    Record-Stage 'long-test-running' "Short preflight passed: $($preflightReport.FullName)"
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'run-remote-endurance.ps1') -TestRoot $root -DurationSeconds 259200
    if ($LASTEXITCODE -ne 0) { throw 'Long test did not pass; preserve and inspect the final report.' }
    Record-Stage 'completed'
} catch {
    Record-Stage 'failed' $_.Exception.Message
    $_ | Out-String | Add-Content -LiteralPath (Join-Path $root 'deployment-errors.log')
    exit 1
}
