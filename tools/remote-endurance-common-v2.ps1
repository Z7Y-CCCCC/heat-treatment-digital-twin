Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Write-RemoteJson([string]$Path, $Value, [switch]$CreateNew) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 30))
    if ($CreateNew) {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        return
    }
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        Write-RemoteJson -Path $temporary -Value $Value -CreateNew
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, $null) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}

function Read-RemoteJson([string]$Path) {
    Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Assert-RemotePlainPath([string]$Path) {
    if ($Path -notmatch '^[A-Za-z]:\\' -or $Path.Contains('"') -or $Path.Contains("`n") -or $Path.Contains("`r")) {
        throw 'A local absolute Windows path without command-line control characters is required.'
    }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $current = $full
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Linked path is not an owned test location: $current" }
        }
        $parent = [IO.Directory]::GetParent($current)
        if (!$parent) { break }; $current = $parent.FullName
    }
    return $full
}

function Get-RemoteOwnedRoot([string]$TestRoot) {
    $root = Assert-RemotePlainPath $TestRoot
    $owner = Read-RemoteJson (Join-Path $root 'remote-endurance-owner.json')
    if ($owner.schema -ne 2 -or $owner.owner -ne 'DapingRemoteEndurance' -or
        $owner.root -ne $root -or $owner.runId -notmatch '^[a-z0-9][a-z0-9-]{5,80}$' -or
        $owner.durationSeconds -lt 30 -or $owner.durationSeconds -gt 2592000) {
        throw 'This directory does not have a valid dedicated remote-endurance owner marker.'
    }
    foreach ($relative in @('workspace', 'resources', 'workspace\output')) {
        Assert-RemotePlainPath (Join-Path $root $relative) | Out-Null
    }
    return [pscustomobject]@{ root=$root; owner=$owner }
}

function Get-RemoteBootTime {
    Import-Module (Join-Path $PSHOME 'Modules\CimCmdlets\CimCmdlets.psd1') -ErrorAction Stop
    return (Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 15).LastBootUpTime.ToUniversalTime().ToString('o')
}

function Test-RemoteProcessIdentity([int]$ProcessId, [string]$CreatedAt) {
    try {
        $process = [Diagnostics.Process]::GetProcessById($ProcessId)
        try { return $process.StartTime.ToUniversalTime().ToString('o') -eq $CreatedAt } finally { $process.Dispose() }
    } catch [ArgumentException] { return $false }
}

function Get-RemoteRunReport([string]$Root, [int]$RunnerId, [DateTime]$StartedAt, [int]$DurationSeconds) {
    $reports = @()
    $output = Join-Path $Root 'workspace\output'
    if (!(Test-Path -LiteralPath $output)) { return $null }
    foreach ($directory in @(Get-ChildItem -LiteralPath $output -Directory -Filter 'endurance-*')) {
        Assert-RemotePlainPath $directory.FullName | Out-Null
        $file = Join-Path $directory.FullName 'report.json'
        if (!(Test-Path -LiteralPath $file)) { continue }
        $report = Read-RemoteJson $file
        if ($report.runnerPid -eq $RunnerId -and $report.requestedSeconds -eq $DurationSeconds -and
            [DateTime]::Parse($report.startedAt).ToUniversalTime() -ge $StartedAt.ToUniversalTime().AddSeconds(-2)) {
            $reports += [pscustomobject]@{ file=$file; value=$report }
        }
    }
    if ($reports.Count -gt 1) { throw 'More than one report matches this exact runner identity.' }
    if ($reports.Count -eq 1) { return $reports[0] }
    return $null
}

function Test-RemoteFinalReport($Report, [int]$DurationSeconds, [double]$WrapperElapsedSeconds) {
    if (!$Report -or $Report.status -ne 'passed' -or $Report.requestedSeconds -ne $DurationSeconds -or
        $Report.actualSeconds -lt $DurationSeconds -or $WrapperElapsedSeconds -lt $DurationSeconds -or
        !$Report.continuity.continuous) { return $false }
    $checks = @($Report.checks.PSObject.Properties)
    if ($checks.Count -lt 12 -or @($checks | Where-Object { $_.Value -ne $true }).Count -gt 0) { return $false }
    if ($DurationSeconds -ge 259200 -and !$Report.qualifiesAs72Hours) { return $false }
    return $true
}

function Get-RemoteObservedStatus([string]$TestRoot) {
    $owned = Get-RemoteOwnedRoot $TestRoot
    $root = $owned.root; $owner = $owned.owner
    $result = [ordered]@{ schema=2; owner=$owner.owner; runId=$owner.runId; root=$root; observedAt=[DateTime]::UtcNow.ToString('o'); state='prepared'; passesRequestedDuration=$false }
    $exitFile = Join-Path $root 'run-exit.json'
    if (Test-Path -LiteralPath $exitFile) {
        $exitRecord = Read-RemoteJson $exitFile
        $result.state = $exitRecord.state; $result.exitRecord = $exitRecord
        if ($exitRecord.state -eq 'passed') {
            $report = Read-RemoteJson $exitRecord.reportFile
            if (!$exitRecord.jobClosed -or $exitRecord.ownedChildrenBeforeClose -ne 0 -or $exitRecord.nodeExitCode -ne 0 -or
                !(Test-RemoteFinalReport $report $owner.durationSeconds $exitRecord.elapsedSeconds)) {
                $result.state = 'invalid-completion'; $result.reason = 'Exit record and authoritative report disagree.'
            } else { $result.passesRequestedDuration = $true; $result.report = $report }
        }
        return [pscustomobject]$result
    }
    $claimFile = Join-Path $root 'run-claim.json'
    if (!(Test-Path -LiteralPath $claimFile)) { return [pscustomobject]$result }
    $claim = Read-RemoteJson $claimFile
    $boot = Get-RemoteBootTime
    $result.claim = $claim; $result.currentBootAt = $boot
    if ($boot -ne $claim.bootAt -or !(Test-RemoteProcessIdentity $claim.wrapperPid $claim.wrapperCreatedAt)) {
        $result.state = 'interrupted'; $result.reason = 'Server rebooted or the exact wrapper process ended without a valid final exit record.'
        return [pscustomobject]$result
    }
    $result.state = 'starting'
    $statusFile = Join-Path $root 'run-status.json'
    if (Test-Path -LiteralPath $statusFile) {
        $heartbeat = Read-RemoteJson $statusFile
        $result.heartbeat = $heartbeat
        $result.heartbeatAgeSeconds = ([DateTime]::UtcNow - [DateTime]::Parse($heartbeat.updatedAt).ToUniversalTime()).TotalSeconds
        $result.state = 'running'
        if ($result.heartbeatAgeSeconds -gt 180) { $result.state = 'unresponsive'; $result.reason = 'Wrapper heartbeat is more than 180 seconds old; this is not a pass.' }
    }
    return [pscustomobject]$result
}
