[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$TestRoot,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-z0-9][a-z0-9-]{5,80}$')][string]$RunId,
    [ValidateRange(30,2592000)][int]$DurationSeconds=259200,
    [switch]$PrepareOnly,
    [switch]$Start
)
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
. (Join-Path $PSScriptRoot 'remote-endurance-common-v2.ps1')
$root=Assert-RemotePlainPath $TestRoot
if (!(Test-Path -LiteralPath $root -PathType Container)) { throw 'Prepare a new dedicated test directory before registration.' }
$taskName='Daping-Endurance-' + $RunId
$bootTaskName=$taskName + '-BootAudit'
if (!$PrepareOnly) {
    Import-Module (Join-Path $PSHOME 'Modules\ScheduledTasks\ScheduledTasks.psd1') -ErrorAction Stop
    foreach ($name in @($taskName,$bootTaskName)) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw "Refusing to replace an existing task: $name" }
    }
}
$required=@('tools\remote-endurance-common-v2.ps1','tools\remote-endurance-job-v2.cs',
    'tools\run-remote-endurance-v2.ps1','tools\get-remote-endurance-status-v2.ps1',
    'resources\runtime\node.exe','resources\mysql\bin\mysqld.exe',
    'workspace\backend\server.js','workspace\backend\scripts\endurance-test.cjs',
    'workspace\backend\scripts\endurance-mysql.cjs','workspace\backend\scripts\endurance-continuity.cjs',
    'workspace\backend\scripts\endurance-memory.cjs','workspace\backend\scripts\endurance-report-io.cjs',
    'workspace\backend\scripts\endurance-telemetry.cjs','workspace\backend\scripts\integration-test-utils.cjs',
    'workspace\backend\node_modules\ws\package.json','resources\frontend\index.html')
$manifest=@()
foreach ($relative in $required) {
    $file=Assert-RemotePlainPath (Join-Path $root $relative)
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing prepared payload: $relative" }
    $manifest += [pscustomobject]@{ path=$relative; size=(Get-Item -LiteralPath $file).Length; sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$output=Join-Path $root 'workspace\output'
if (!(Test-Path -LiteralPath $output)) { New-Item -ItemType Directory -Path $output | Out-Null }
Assert-RemotePlainPath $output | Out-Null
$owner=[ordered]@{ schema=2;owner='DapingRemoteEndurance';runId=$RunId;root=$root;durationSeconds=$DurationSeconds;
    createdAt=[DateTime]::UtcNow.ToString('o');taskName=$taskName;bootAuditTaskName=$bootTaskName;
    executionLimitSeconds=$DurationSeconds+21600;simulationOnly=$true;physicalPlcEnabled=$false;
    noAutomaticRetry=$true;manifest=$manifest }
Write-RemoteJson (Join-Path $root 'remote-endurance-owner.json') $owner -CreateNew
if ($PrepareOnly) { $owner | ConvertTo-Json -Depth 10; exit 0 }
$registeredMain=$false
try {
    $principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::FromSeconds($owner.executionLimitSeconds)) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $powerShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $runner=Join-Path $root 'tools\run-remote-endurance-v2.ps1'
    $action=New-ScheduledTaskAction -Execute $powerShell -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $runner + '" -TestRoot "' + $root + '"') -WorkingDirectory $root
    Register-ScheduledTask -TaskName $taskName -Action $action -Settings $settings -Principal $principal -Description 'Single claimed isolated endurance run. SSH/Codex disconnect does not stop it. No retry or boot resume.' | Out-Null
    $registeredMain=$true
    $check=Join-Path $root 'tools\get-remote-endurance-status-v2.ps1'
    $bootAction=New-ScheduledTaskAction -Execute $powerShell -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $check + '" -TestRoot "' + $root + '" -PersistObservation') -WorkingDirectory $root
    $bootSettings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::FromMinutes(2)) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $bootTaskName -Action $bootAction -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $bootSettings -Principal $principal -Description 'Record interruption on a future server boot; never restart the endurance test.' | Out-Null
    Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath (Join-Path $root 'task.xml') -Encoding UTF8
    Export-ScheduledTask -TaskName $bootTaskName | Set-Content -LiteralPath (Join-Path $root 'boot-audit-task.xml') -Encoding UTF8
    if ($Start) { Start-ScheduledTask -TaskName $taskName }
    [pscustomobject]@{ registered=$true;started=[bool]$Start;taskName=$taskName;bootAuditTaskName=$bootTaskName;root=$root;durationSeconds=$DurationSeconds;executionLimitSeconds=$owner.executionLimitSeconds } | ConvertTo-Json
} catch {
    # Neither task existed before this call. Roll back only tasks created here.
    if ($registeredMain) {
        foreach ($name in @($bootTaskName,$taskName)) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
        }
    }
    Write-RemoteJson (Join-Path $root 'registration-failure.json') @{ failedAt=[DateTime]::UtcNow.ToString('o');error=$_.Exception.Message }
    throw
}
