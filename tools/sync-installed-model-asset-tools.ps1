[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$PlanPath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$PlanSha256,
    [switch]$ValidateOnly
)

# An explicit code-only repair of the currently configured collector service.
# Not an installer, release build, asset import, data migration or redirect.
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
$serviceName = 'HeatTreatmentCollector'
$resources = [IO.Path]::GetFullPath('C:\Program Files\HeatTreatmentCollectorPlugin\resources')
$configFile = 'C:\ProgramData\HeatTreatmentDigitalTwin\collector-service.json'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputRoot = Join-Path $workspace 'output'
$allowed = @(
    'backend/routes/modelAssetBundles.js',
    'backend/services/modelAssetBundle.js',
    'backend/services/modelAssetCollection.js',
    'backend/services/modelDuplicates.js',
    'backend/services/modelAssetUpdates.js'
)

function Hash-File([string]$File) { (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
function Under-Root([string]$File, [string]$Root) {
    $path = [IO.Path]::GetFullPath($File)
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escaped its explicitly reviewed root' }
    return $path
}
function Check-Path([string]$File, [string]$Root, [bool]$MayBeMissing = $false) {
    $path = Under-Root $File $Root
    $exists = Test-Path -LiteralPath $path
    if (-not $exists -and -not $MayBeMissing) { throw 'Expected a reviewed existing file' }
    if ($exists -and (Get-Item -LiteralPath $path -Force).PSIsContainer) { throw 'Expected a file, not a directory' }
    $current = if ($exists) { $path } else { [IO.Path]::GetDirectoryName($path) }
    # Check every existing ancestor, including the root and its ancestors. A
    # lexical containment check alone is not enough for Windows junctions.
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if (((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked synchronization path rejected' }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
    return $path
}
function Assert-Original($Record) {
    $target = Check-Path (Join-Path $resources ([string]$Record.relative)) $resources ($null -eq $Record.beforeSha256)
    if ($null -eq $Record.beforeSha256) {
        if (Test-Path -LiteralPath $target) { throw 'A new target appeared after review; no overwrite allowed' }
    } elseif ((Hash-File $target) -ne $Record.beforeSha256) { throw 'Original code changed after review; no overwrite allowed' }
}
function Assert-Protected {
    if ((Hash-File $configFile) -ne $plan.configSha256) { throw 'Service configuration changed; no redirect or overwrite allowed' }
    foreach ($record in @($plan.protectedFiles)) {
        if ($null -eq $record) { continue }
        $target = Check-Path (Join-Path $resources ([string]$record.relative)) $resources
        if ((Hash-File $target) -ne $record.sha256) { throw 'A protected dependency, template or asset changed' }
    }
}
function Write-RunJson([string]$File, $Value) {
    $file = Check-Path $File $run $true
    [IO.File]::WriteAllText($file, ($Value | ConvertTo-Json -Depth 12), $utf8)
}
function Status([string]$Stage) { Write-RunJson $statusFile @{stage=$Stage;service=$serviceName;utc=[DateTime]::UtcNow.ToString('o')} }
function Assert-ServiceIdentity {
    $service = Get-CimInstance Win32_Service -Filter "Name='HeatTreatmentCollector'"
    $expectedExe = Join-Path $resources 'collector-service\HeatTreatmentCollector.exe'
    if ($null -eq $service -or $service.PathName -cne ('"' + $expectedExe + '" --config "' + $configFile + '"')) { throw 'The reviewed service executable/configuration changed' }
    return $service
}
function Stop-ExactService {
    $null = Assert-ServiceIdentity
    $service = Get-Service -Name $serviceName -ErrorAction Stop
    if ($service.Status -ne 'Stopped') {
        Stop-Service -Name $serviceName -ErrorAction Stop
        $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(90))
    }
}
function Start-ExactService {
    $null = Assert-ServiceIdentity
    $service = Get-Service -Name $serviceName -ErrorAction Stop
    if ($service.Status -eq 'StopPending') { $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(90)) }
    if ($service.Status -eq 'Stopped') { Start-Service -Name $serviceName -ErrorAction Stop }
    $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(180))
}
function Wait-Healthy([int]$Seconds = 180) {
    $end = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $end) {
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3001/api/health' -TimeoutSec 8
            if ($health.status -eq 'ok' -and $health.db.connected -eq $true -and $health.runtime.role -eq 'collector' -and $health.runtime.owner -eq 'windows-service' -and $health.runtime.serviceName -eq $serviceName) { return $health }
        } catch { }
        Start-Sleep -Seconds 2
    }
    throw 'The same collector service and database did not become healthy before the deadline'
}
function Publish-Code([string]$Source, [string]$Target, [bool]$NewFile) {
    $target = Check-Path $Target $resources $NewFile
    $temporary = Check-Path ($target + '.code-sync-' + [Guid]::NewGuid().ToString('N')) $resources $true
    $retired = Check-Path ($target + '.code-sync-retired-' + [Guid]::NewGuid().ToString('N')) $resources $true
    try {
        # CreateNew prevents an unrelated concurrent file from being overwritten.
        $input = [IO.File]::OpenRead($Source)
        try {
            $output = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $input.CopyTo($output); $output.Flush($true) } finally { $output.Dispose() }
        } finally { $input.Dispose() }
        if ($NewFile) { [IO.File]::Move($temporary, $target) }
        else { [IO.File]::Replace($temporary, $target, $retired) }
    } finally {
        foreach ($candidate in @($temporary, $retired)) {
            # Delete only our exact bounded siblings, never recursive paths.
            $safe = Check-Path $candidate $resources $true
            if (Test-Path -LiteralPath $safe) { Remove-Item -LiteralPath $safe -Force }
        }
    }
}
function Restore-Code($Record, [string]$BackupRoot) {
    $target = Check-Path (Join-Path $resources ([string]$Record.relative)) $resources $true
    # Never roll back an unrelated concurrent code change. An unsuccessful
    # publication may already be unchanged; that needs no rollback write.
    if ($null -eq $Record.beforeSha256) {
        if (Test-Path -LiteralPath $target) {
            if ((Hash-File $target) -ne $Record.afterSha256) { throw 'New code changed concurrently; rollback did not delete it' }
            $safe = Check-Path $target $resources
            Remove-Item -LiteralPath $safe -Force
        }
    } else {
        if (-not (Test-Path -LiteralPath $target)) { throw 'Original target disappeared; rollback stopped' }
        $current = Hash-File $target
        if ($current -eq $Record.beforeSha256) { return }
        if ($current -ne $Record.afterSha256) { throw 'Code changed concurrently; rollback did not overwrite it' }
        $original = Check-Path (Join-Path $BackupRoot ([string]$Record.relative)) $run
        if ((Hash-File $original) -ne $Record.beforeSha256) { throw 'Rollback backup changed; restoration stopped' }
        Publish-Code $original $target $false
    }
    Assert-Original $Record
}

$PlanPath = Check-Path $PlanPath $outputRoot
if ((Hash-File $PlanPath) -ne $PlanSha256) { throw 'Synchronization plan changed after review' }
$plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($plan.version -ne 1 -or $plan.feature -ne 'model-asset-tools' -or $plan.serviceName -ne $serviceName) { throw 'Only the explicitly reviewed model asset tools repair is supported' }
$run = Under-Root ([string]$plan.directory) $outputRoot
if (-not (Test-Path -LiteralPath $run -PathType Container) -or [IO.Path]::GetDirectoryName($PlanPath) -ne $run) { throw 'Plan must be in its existing, exclusively owned run directory' }
$resultFile = Join-Path $run 'result.json'
$statusFile = Join-Path $run 'status.json'
if (Test-Path -LiteralPath $resultFile) { throw 'Repair run was already completed or attempted; use a freshly reviewed plan' }
$records = @($plan.files)
if ($records.Count -ne $allowed.Count -or @($records.relative | Select-Object -Unique).Count -ne $allowed.Count) { throw 'The exact five-file code allowlist is required' }
if ($plan.configSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Reviewed service configuration hash is required' }
$config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ([IO.Path]::GetFullPath([string]$config.resourcesRoot) -ne $resources -or $config.serviceName -ne $serviceName -or $config.backendOrigin -ne 'http://127.0.0.1:3001' -or $config.port -ne 3001) { throw 'Active service destination differs; nothing will be redirected' }
foreach ($record in $records) {
    if ($allowed -cnotcontains [string]$record.relative -or $record.afterSha256 -notmatch '^[a-f0-9]{64}$' -or ($null -ne $record.beforeSha256 -and $record.beforeSha256 -notmatch '^[a-f0-9]{64}$')) { throw 'Unapproved code target or invalid hash in plan' }
    Assert-Original $record
    $staged = Check-Path ([string]$record.staged) $run
    if ((Hash-File $staged) -ne $record.afterSha256) { throw 'Reviewed staged code changed' }
}
foreach ($record in @($plan.protectedFiles)) {
    if ($null -eq $record) { continue }
    $relative = [string]$record.relative
    # Only read-only installed program dependencies, factory templates, model
    # and motion files can be protected. No site database/credentials are read.
    if ($relative -notmatch '^(backend/(routes|services|middleware|defaults|assets/(models|motions))/[^\\:]+|backend/server\.js|shared/[^/\\:]+)$' -or $relative.Split('/') -contains '..' -or $relative.Split('/') -contains '.' -or $allowed -contains $relative -or $record.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid protected file path or hash' }
}
Assert-Protected
$beforeService = Assert-ServiceIdentity
if ($beforeService.State -ne 'Running') { throw 'The reviewed Windows service is not running' }
if ($ValidateOnly) { Write-Output 'Five-file code plan, staged hashes, current service and protected files validated; no writes or restart performed'; exit 0 }
if (-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Windows administrator consent is required for this code-only service repair' }

$backup = Under-Root (Join-Path $run 'backup') $run
if (Test-Path -LiteralPath $backup) { throw 'Backup directory already exists; use a fresh reviewed repair run' }
$changed = @()
$stopRequested = $false
try {
    Status 'backing-up-code'
    New-Item -ItemType Directory -Path $backup -ErrorAction Stop | Out-Null
    foreach ($record in $records) {
        if ($null -eq $record.beforeSha256) { continue }
        $file = Under-Root (Join-Path $backup ([string]$record.relative)) $run
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($file)) -Force | Out-Null
        $file = Check-Path $file $run $true
        Copy-Item -LiteralPath (Join-Path $resources ([string]$record.relative)) -Destination $file -ErrorAction Stop
        if ((Hash-File $file) -ne $record.beforeSha256) { throw 'Backup integrity check failed before service stop' }
    }
    Status 'stopping-service'
    $stopRequested = $true
    Stop-ExactService
    Assert-Protected
    foreach ($record in $records) { Assert-Original $record }
    Status 'publishing-approved-code'
    foreach ($record in $records) {
        $staged = Check-Path ([string]$record.staged) $run
        if ((Hash-File $staged) -ne $record.afterSha256) { throw 'Staged code changed before publication' }
        Assert-Original $record
        $changed += $record
        Publish-Code $staged (Join-Path $resources ([string]$record.relative)) ($null -eq $record.beforeSha256)
        if ((Hash-File (Join-Path $resources ([string]$record.relative))) -ne $record.afterSha256) { throw 'Published code checksum mismatch' }
    }
    Assert-Protected
    Status 'restarting-service'
    Start-ExactService
    $health = Wait-Healthy
    Assert-Protected
    foreach ($record in $records) { if ((Hash-File (Join-Path $resources ([string]$record.relative))) -ne $record.afterSha256) { throw 'Published code changed during startup' } }
    $afterService = Get-CimInstance Win32_Service -Filter "Name='HeatTreatmentCollector'"
    Write-RunJson $resultFile @{success=$true;service=$serviceName;state=$afterService.State;oldServicePid=$beforeService.ProcessId;servicePid=$afterService.ProcessId;backendPid=$health.components.backend.processId;files=@($records|ForEach-Object{@{relative=$_.relative;sha256=$_.afterSha256}});serviceConfigurationUnchanged=$true;protectedFilesUnchanged=$true;databaseConfigurationWritten=$false;uploadsWritten=$false;assetsWritten=$false;plcBindingsWritten=$false;historyApiVerified=$false}
    # Actual authenticated history UI/API verification belongs to the caller,
    # not to this unauthenticated health check. Never report fabricated success.
    Status 'complete-awaiting-authenticated-api-verification'
} catch {
    $original = $_.Exception.Message
    $rollbackError = $null
    try {
        if ($changed.Count -gt 0) {
            Status 'rolling-back-code'
            Stop-ExactService
            for ($index = $changed.Count - 1; $index -ge 0; $index--) { Restore-Code $changed[$index] $backup }
        }
    } catch { $rollbackError = $_.Exception.Message }
    if ($stopRequested) {
        try { Start-ExactService; $null = Wait-Healthy }
        catch { $rollbackError = "$rollbackError; service recovery: $($_.Exception.Message)" }
    }
    Write-RunJson $resultFile @{success=$false;error=$original;rollbackError=$rollbackError;changedFiles=@($changed.relative);databaseConfigurationWritten=$false;uploadsWritten=$false;assetsWritten=$false;plcBindingsWritten=$false;historyApiVerified=$false}
    Status 'failed'
    throw $original
}
