[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$TestRoot)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. (Join-Path $PSScriptRoot 'remote-endurance-common-v2.ps1')
$owned=Get-RemoteOwnedRoot $TestRoot
$root=$owned.root;$owner=$owned.owner
foreach ($entry in $owner.manifest) {
    $file=Assert-RemotePlainPath (Join-Path $root $entry.path)
    if ((Get-Item -LiteralPath $file).Length -ne $entry.size -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.sha256) {
        throw "Prepared source/runtime changed since task registration: $($entry.path)"
    }
}
$wrapper=[Diagnostics.Process]::GetCurrentProcess()
$claim=[ordered]@{schema=2;owner=$owner.owner;runId=$owner.runId;root=$root;startedAt=[DateTime]::UtcNow.ToString('o');
    wrapperPid=$PID;wrapperCreatedAt=$wrapper.StartTime.ToUniversalTime().ToString('o');bootAt=Get-RemoteBootTime;
    requestedSeconds=$owner.durationSeconds;nodePid=$null;nodeCreatedAt=$null}
# Permanent one-run claim: duplicate clicks, task retries and reboots never reset
# time or overwrite a previous failure. A new run requires a new root and task.
Write-RemoteJson (Join-Path $root 'run-claim.json') $claim -CreateNew
$job=$null;$nodeProcess=$null;$awake=$false;$nodeExitCode=$null;$finalReport=$null;$ownedChildren=$null
$jobClosed=$false;$state='incomplete';$failure=$null;$exitCode=1
$clock=[Diagnostics.Stopwatch]::StartNew()
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'remote-endurance-job-v2.cs')
    $job=[DapingOwnedJobV2]::new()
    if ([DapingOwnedJobV2]::SetThreadExecutionState([uint32]2147483649) -eq 0) { throw 'Could not request temporary system keep-awake.' }
    $awake=$true
    $workspace=Join-Path $root 'workspace';$resources=Join-Path $root 'resources'
    # This wrapper is an independent scheduled process. All inherited business
    # environment paths are removed before starting its suspended owned child.
    foreach ($key in @('DB_TYPE','SQLITE_FILE','SQLITE_RECOVERY_TEMPLATE','SQLITE_UPGRADE_TEMPLATE','SQLITE_TEMPLATE_FILE',
        'MYSQL_HOST','MYSQL_PORT','MYSQL_USER','MYSQL_PASSWORD','MYSQL_DATABASE','DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME',
        'SITE_BACKUP_MIRROR_DIR','BACKUP_STORAGE_DIR','ADMIN_API_TOKEN','LICENSE_FILE')) {
        [Environment]::SetEnvironmentVariable($key,$null,'Process')
    }
    $baseData=Join-Path $workspace 'output\runner-owned-data'
    $mapping=@{APP_DATA_DIR=$baseData;UPLOADS_DIR=(Join-Path $baseData 'uploads');DB_BACKUP_DIR=(Join-Path $baseData 'backups');
        DB_RECOVERY_DIR=(Join-Path $baseData 'recovery');SITE_BACKUP_DIR=(Join-Path $baseData 'site-backups');
        SITE_IMPORT_DIR=(Join-Path $baseData 'site-imports');DATA_SOURCE_BACKUP_DIR=(Join-Path $baseData 'data-source-backups');
        FRONTEND_DIST=(Join-Path $resources 'frontend');NODE_ENV='test';LICENSE_ENFORCE='false';}
    foreach ($key in $mapping.Keys) { [Environment]::SetEnvironmentVariable($key,$mapping[$key],'Process') }
    $env:PATH=(Join-Path $resources 'runtime')+';'+$env:PATH
    $node=Join-Path $resources 'runtime\node.exe'
    $test=Join-Path $workspace 'backend\scripts\endurance-test.cjs'
    $arguments='"'+$test+'" --database-type mysql --mysql-runtime-dir "'+(Join-Path $resources 'mysql')+'" --duration-seconds '+$owner.durationSeconds
    $nodeProcess=$job.Start($node,$arguments,$workspace,(Join-Path $root 'endurance.stdout.log'),(Join-Path $root 'endurance.stderr.log'))
    $claim.nodePid=$nodeProcess.Id;$claim.nodeCreatedAt=$nodeProcess.StartTime.ToUniversalTime().ToString('o')
    Write-RemoteJson (Join-Path $root 'run-launch.json') $claim -CreateNew
    $nextHeartbeat=-1.0
    do {
        if ($clock.Elapsed.TotalSeconds -ge $nextHeartbeat) {
            $report=$null;$readFailure=$null
            try { $report=Get-RemoteRunReport $root $nodeProcess.Id ([DateTime]::Parse($claim.startedAt)) $owner.durationSeconds }
            catch { $readFailure=$_.Exception.Message }
            $heartbeat=[ordered]@{ schema=2;runId=$owner.runId;state='running';updatedAt=[DateTime]::UtcNow.ToString('o');
                wrapperPid=$PID;wrapperCreatedAt=$claim.wrapperCreatedAt;nodePid=$nodeProcess.Id;nodeCreatedAt=$claim.nodeCreatedAt;
                bootAt=$claim.bootAt;wrapperElapsedSeconds=$clock.Elapsed.TotalSeconds;reportFile=$null;report=$null;reportReadError=$readFailure }
            if ($report) { $heartbeat.reportFile=$report.file;$heartbeat.report=$report.value }
            Write-RemoteJson (Join-Path $root 'run-status.json') $heartbeat
            $nextHeartbeat=$clock.Elapsed.TotalSeconds+30
        }
        if ($clock.Elapsed.TotalSeconds -gt $owner.executionLimitSeconds-120) {
            # Give STOP/finally cleanup up to 120 seconds before the task limit.
            $report=Get-RemoteRunReport $root $nodeProcess.Id ([DateTime]::Parse($claim.startedAt)) $owner.durationSeconds
            if ($report) { [IO.File]::WriteAllText((Join-Path ([IO.Path]::GetDirectoryName($report.file)) 'STOP'),'Wrapper safety deadline reached.') }
            $failure='Wrapper safety deadline reached; no completed run can be claimed.'
            if (!$nodeProcess.WaitForExit(90000)) { throw $failure }
        }
    } while (!$nodeProcess.WaitForExit(1000))
    $nodeExitCode=$nodeProcess.ExitCode
    $finalReport=Get-RemoteRunReport $root $nodeProcess.Id ([DateTime]::Parse($claim.startedAt)) $owner.durationSeconds
    if (!$failure -and $nodeExitCode -eq 0 -and $finalReport -and
        (Test-RemoteFinalReport $finalReport.value $owner.durationSeconds $clock.Elapsed.TotalSeconds)) {
        $state='passed';$exitCode=0
    } else {
        $state='failed';if (!$failure) { $failure='Child exit code or final duration/continuity/checks did not prove a complete pass.' }
        if (!$finalReport -or $finalReport.value.status -eq 'incomplete') { $state='incomplete' }
    }
} catch {
    $failure=$_.Exception.ToString();$state='incomplete';$exitCode=1
    $_ | Out-String | Add-Content -LiteralPath (Join-Path $root 'wrapper-errors.log') -Encoding UTF8
} finally {
    if ($job) {
        try {
            $ownedChildren=$job.ActiveProcesses
            if ($ownedChildren -ne 0 -and $state -eq 'passed') { $state='failed';$exitCode=1;$failure='The child left owned descendants alive; the job is closing them.' }
        } catch { $state='incomplete';$exitCode=1;$failure='Could not verify owned job cleanup: '+$_.Exception.Message }
        $job.Dispose();$jobClosed=$true
    }
    if ($awake) { [DapingOwnedJobV2]::SetThreadExecutionState([uint32]2147483648) | Out-Null }
    $record=[ordered]@{schema=2;runId=$owner.runId;state=$state;finishedAt=[DateTime]::UtcNow.ToString('o');wrapperPid=$PID;
        nodePid=$claim.nodePid;nodeCreatedAt=$claim.nodeCreatedAt;nodeExitCode=$nodeExitCode;wrapperExitCode=$exitCode;
        requestedSeconds=$owner.durationSeconds;elapsedSeconds=$clock.Elapsed.TotalSeconds;bootAt=$claim.bootAt;
        reportFile=$null;jobClosed=$jobClosed;ownedChildrenBeforeClose=$ownedChildren;keepAwakeReleased=[bool]$awake;error=$failure}
    if ($finalReport) { $record.reportFile=$finalReport.file }
    Write-RemoteJson (Join-Path $root 'run-exit.json') $record -CreateNew
    Write-RemoteJson (Join-Path $root 'run-status.json') $record
    if ($nodeProcess) { $nodeProcess.Dispose() };$wrapper.Dispose()
}
exit $exitCode
