[CmdletBinding()]
param([string]$NodePath)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. (Join-Path $PSScriptRoot 'remote-endurance-common-v2.ps1')
$repo=Split-Path $PSScriptRoot -Parent
if (!$NodePath) { $NodePath=Join-Path $repo 'desktop\resources\runtime\node.exe' }
$evidence=Join-Path $repo ('output\remote-runner-v2-tests-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+$PID)
New-Item -ItemType Directory -Path $evidence | Out-Null
$fixtureBase=Join-Path $env:TEMP ('daping-runner-fixture-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureBase | Out-Null
$nativePowerShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$results=@();$ownedFixtures=@()

function New-Fixture([string]$Name,[string]$Mode) {
    $root=Join-Path $fixtureBase $Name
    foreach ($relative in @('tools','resources\runtime','resources\mysql\bin','resources\frontend','workspace\backend\scripts','workspace\backend\node_modules\ws','workspace\output')) {
        New-Item -ItemType Directory -Path (Join-Path $root $relative) -Force | Out-Null
    }
    foreach ($file in @('remote-endurance-common-v2.ps1','remote-endurance-job-v2.cs','run-remote-endurance-v2.ps1','get-remote-endurance-status-v2.ps1')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $root ('tools\'+$file))
    }
    New-Item -ItemType HardLink -Path (Join-Path $root 'resources\runtime\node.exe') -Target $NodePath | Out-Null
    foreach ($relative in @('resources\mysql\bin\mysqld.exe','resources\frontend\index.html','workspace\backend\server.js',
        'workspace\backend\node_modules\ws\package.json','workspace\backend\scripts\endurance-mysql.cjs',
        'workspace\backend\scripts\endurance-continuity.cjs','workspace\backend\scripts\endurance-memory.cjs',
        'workspace\backend\scripts\endurance-report-io.cjs','workspace\backend\scripts\endurance-telemetry.cjs',
        'workspace\backend\scripts\integration-test-utils.cjs')) {
        [IO.File]::WriteAllText((Join-Path $root $relative),'fixture-only')
    }
    $fake=@'
const fs=require('fs'),path=require('path'),cp=require('child_process');
const mode='MODE';const duration=Number(process.argv[process.argv.indexOf('--duration-seconds')+1]);
const root=path.resolve(__dirname,'../../..');const out=path.join(root,'output','endurance-fixture');fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(root,'node-identity.json'),JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));
if(mode==='hang') {const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(path.join(root,'descendant.json'),JSON.stringify({pid:child.pid}));setInterval(()=>{},1000);}
else if(mode==='crash'){process.exit(7);}
else {const startedAt=new Date().toISOString();const delay=mode==='pass'?30000:10;setTimeout(()=>{const checks=Object.fromEntries(Array.from({length:12},(_,i)=>['check'+i,true]));fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({runnerPid:process.pid,startedAt,reportedAt:new Date().toISOString(),status:'passed',requestedSeconds:duration,actualSeconds:duration,qualifiesAs72Hours:duration>=259200,checks,continuity:{continuous:true}}));},delay);}
'@
    [IO.File]::WriteAllText((Join-Path $root 'workspace\backend\scripts\endurance-test.cjs'),$fake.Replace('MODE',$Mode))
    & $nativePowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'register-remote-endurance-v2.ps1') -TestRoot $root -RunId ('fixture-'+$Name) -DurationSeconds 30 -PrepareOnly 1> (Join-Path $root 'prepare.stdout.log') 2> (Join-Path $root 'prepare.stderr.log')
    if ($LASTEXITCODE -ne 0) { throw 'Fixture prepare failed.' }
    $script:ownedFixtures += $root
    return $root
}
function Start-Fixture([string]$Root) {
    Start-Process -FilePath $nativePowerShell -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $Root 'tools\run-remote-endurance-v2.ps1')+'"'),'-TestRoot',('"'+$Root+'"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Root 'wrapper.stdout.log') -RedirectStandardError (Join-Path $Root 'wrapper.stderr.log')
}
function Check([string]$Name,[scriptblock]$Body) {
    $started=[DateTime]::UtcNow
    try { & $Body; $script:results += [pscustomobject]@{name=$Name;passed=$true;seconds=([DateTime]::UtcNow-$started).TotalSeconds} }
    catch { $script:results += [pscustomobject]@{name=$Name;passed=$false;error=$_.Exception.ToString();seconds=([DateTime]::UtcNow-$started).TotalSeconds} }
}
function Require([bool]$Condition,[string]$Reason) { if (!$Condition) { throw $Reason } }

Check 'actual-owned-job-clean-completion-and-single-claim' {
    $root=New-Fixture 'passed' 'pass';$process=Start-Fixture $root
    Require ($process.WaitForExit(45000)) 'Fixture wrapper did not finish in 45s.'
    Require ($process.ExitCode -eq 0) ('Wrapper failed: '+(Get-Content (Join-Path $root 'wrapper.stderr.log') -Raw))
    $status=Get-RemoteObservedStatus $root
    Require ($status.state -eq 'passed' -and $status.passesRequestedDuration) 'Valid complete fixture was not accepted.'
    Require ($status.exitRecord.jobClosed -and $status.exitRecord.ownedChildrenBeforeClose -eq 0 -and $status.exitRecord.keepAwakeReleased) 'Job/keep-awake cleanup was not recorded.'
    $before=(Get-FileHash -LiteralPath (Join-Path $root 'run-exit.json') -Algorithm SHA256).Hash
    & $nativePowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'tools\run-remote-endurance-v2.ps1') -TestRoot $root 1> (Join-Path $root 'duplicate.stdout.log') 2> (Join-Path $root 'duplicate.stderr.log')
    Require ($LASTEXITCODE -ne 0) 'Duplicate run was permitted.'
    Require ((Get-FileHash -LiteralPath (Join-Path $root 'run-exit.json') -Algorithm SHA256).Hash -eq $before) 'Duplicate run changed original completion evidence.'
    $report=Read-RemoteJson $status.exitRecord.reportFile;$report.status='running';Write-RemoteJson $status.exitRecord.reportFile $report
    Require ((Get-RemoteObservedStatus $root).state -eq 'invalid-completion') 'Tampered/stale running report was treated as passed.'
}
Check 'fake-duration-complete-report-is-rejected' {
    $root=New-Fixture 'fake' 'fast';$process=Start-Fixture $root
    Require ($process.WaitForExit(15000)) 'Fast fixture failed to finish.'
    Require ($process.ExitCode -ne 0) 'A report claiming 30 seconds in less than 30 seconds was accepted.'
    Require (!(Get-RemoteObservedStatus $root).passesRequestedDuration) 'False duration report passed status observation.'
}
Check 'child-crash-retains-incomplete-exit' {
    $root=New-Fixture 'crash' 'crash';$process=Start-Fixture $root
    Require ($process.WaitForExit(15000)) 'Crash fixture failed to finish.'
    $exitRecord=Read-RemoteJson (Join-Path $root 'run-exit.json')
    Require ($process.ExitCode -ne 0 -and $exitRecord.state -eq 'incomplete' -and $exitRecord.nodeExitCode -eq 7 -and $exitRecord.jobClosed) 'Crash did not retain the expected incomplete evidence.'
}
Check 'abrupt-wrapper-death-kills-only-owned-descendants-and-records-interruption' {
    $root=New-Fixture 'abrupt' 'hang';$process=Start-Fixture $root
    $deadline=[DateTime]::UtcNow.AddSeconds(15)
    while (!(Test-Path -LiteralPath (Join-Path $root 'workspace\descendant.json')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    $launch=Read-RemoteJson (Join-Path $root 'run-launch.json')
    $child=Read-RemoteJson (Join-Path $root 'workspace\descendant.json')
    Require ((Get-RemoteObservedStatus $root).state -eq 'running') 'Hang fixture did not produce a live heartbeat.'
    $process.Kill();Require ($process.WaitForExit(5000)) 'Exact fixture wrapper failed to terminate.'
    Start-Sleep -Milliseconds 500
    Require (!(Test-RemoteProcessIdentity $launch.nodePid $launch.nodeCreatedAt)) 'Owned node survived job close.'
    $childAlive=$false;try{$descendant=[Diagnostics.Process]::GetProcessById($child.pid);$childAlive=!$descendant.HasExited;$descendant.Dispose()}catch [ArgumentException] {}
    Require (!$childAlive) 'Owned descendant survived job close.'
    Require ((Get-RemoteObservedStatus $root).state -eq 'interrupted') 'Wrapper death was mistaken for ongoing success.'
    & $nativePowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'tools\get-remote-endurance-status-v2.ps1') -TestRoot $root -PersistObservation 1> (Join-Path $root 'status.stdout.log') 2> (Join-Path $root 'status.stderr.log')
    Require ($LASTEXITCODE -ne 0 -and (Test-Path -LiteralPath (Join-Path $root 'run-interrupted.json'))) 'Interruption was not persisted.'
}
Check 'payload-change-rejected-before-claim-or-process-launch' {
    $root=New-Fixture 'changed' 'hang'
    [IO.File]::AppendAllText((Join-Path $root 'workspace\backend\scripts\endurance-test.cjs'),'\n// source changed')
    $process=Start-Fixture $root;Require ($process.WaitForExit(10000)) 'Changed-payload wrapper did not stop.'
    Require ($process.ExitCode -ne 0 -and !(Test-Path -LiteralPath (Join-Path $root 'run-claim.json')) -and !(Test-Path -LiteralPath (Join-Path $root 'run-launch.json'))) 'Changed payload launched a test.'
}
Check 'reboot-and-stale-heartbeat-never-qualify-as-pass' {
    $root=New-Fixture 'reboot' 'crash';$owner=Read-RemoteJson (Join-Path $root 'remote-endurance-owner.json')
    $current=[Diagnostics.Process]::GetCurrentProcess();$created=$current.StartTime.ToUniversalTime().ToString('o')
    $claim=@{schema=2;wrapperPid=$PID;wrapperCreatedAt=$created;bootAt='2000-01-01T00:00:00.0000000Z'}
    Write-RemoteJson (Join-Path $root 'run-claim.json') $claim -CreateNew
    Require ((Get-RemoteObservedStatus $root).state -eq 'interrupted') 'A prior server boot was accepted as continuous.'
    $claim.bootAt=Get-RemoteBootTime;Write-RemoteJson (Join-Path $root 'run-claim.json') $claim
    Write-RemoteJson (Join-Path $root 'run-status.json') @{updatedAt=[DateTime]::UtcNow.AddMinutes(-10).ToString('o')}
    Require ((Get-RemoteObservedStatus $root).state -eq 'unresponsive') 'A stale heartbeat was reported as running/complete.'
    $current.Dispose()
}
$summary=[ordered]@{success=@($results|Where-Object{!$_.passed}).Count -eq 0;createdAt=[DateTime]::UtcNow.ToString('o');checks=$results;
    fixtureBase=$fixtureBase;fixtures=$ownedFixtures;note='Controlled fixture scripts only; no real database, remote access, scheduler registration or long test.'}
Write-RemoteJson (Join-Path $evidence 'result.json') $summary -CreateNew
$summary | ConvertTo-Json -Depth 20
if (!$summary.success) { exit 1 };exit 0
