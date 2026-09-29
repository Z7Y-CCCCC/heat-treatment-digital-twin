$ErrorActionPreference = 'Stop'
$root = 'C:\DapingTest\run-20260929'
$statusFile = Join-Path $root 'deployment-status.json'
@{stage='long-test-running';detail='Starting 72-hour test (259200 seconds)';updatedAt=(Get-Date).ToUniversalTime().ToString('o');pid=$PID} | ConvertTo-Json | Set-Content -LiteralPath $statusFile -Encoding UTF8

$ErrorActionPreference = 'Continue'
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'run-remote-endurance.ps1') -TestRoot $root -DurationSeconds 259200
$exitCode = $LASTEXITCODE

$ErrorActionPreference = 'Stop'
if ($exitCode -eq 0) {
    @{stage='completed';detail='72-hour test completed successfully';updatedAt=(Get-Date).ToUniversalTime().ToString('o');pid=$PID} | ConvertTo-Json | Set-Content -LiteralPath $statusFile -Encoding UTF8
} else {
    @{stage='failed';detail="Long test ended with exit code $exitCode";updatedAt=(Get-Date).ToUniversalTime().ToString('o');pid=$PID} | ConvertTo-Json | Set-Content -LiteralPath $statusFile -Encoding UTF8
}
exit $exitCode
