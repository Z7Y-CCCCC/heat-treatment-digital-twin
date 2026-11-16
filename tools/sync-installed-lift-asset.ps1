[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$PlanPath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$PlanSha256,
    [switch]$ValidateOnly
)

# Explicit, single-model live asset synchronization. Not an installer/build.
# Never writes service configuration, databases, uploads, PLC or layout settings.
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
$serviceName = 'HeatTreatmentCollector'
$resources = [IO.Path]::GetFullPath('C:\Program Files\HeatTreatmentCollectorPlugin\resources')
$configFile = 'C:\ProgramData\HeatTreatmentDigitalTwin\collector-service.json'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputRoot = Join-Path $workspace 'output'
$allowed = @(
    'backend/assets/models/cad_lifting_load_table_111400.glb',
    'backend/assets/models/cad_lifting_load_table_111400_metadata.json',
    'backend/assets/motions/cad_lifting_load_table_111400.json',
    'shared/motionPackages.json',
    'backend/assets/models/cad_general_20261103_v1/11.14.00_升降备料台.glb',
    'backend/assets/models/cad_general_20261103_v1/metadata/lifting_staging_table.json',
    'backend/assets/models/cad_general_20261103_v1/manifest.json'
)

function Hash-File([string]$File) { (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
function Under-Root([string]$File, [string]$Root) {
    $path = [IO.Path]::GetFullPath($File)
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Path escaped its explicit root: $path" }
    return $path
}
function Check-Target([string]$File) {
    $path = Under-Root $File $resources
    $current = Get-Item -LiteralPath $path -Force
    if ($current.PSIsContainer) { throw 'Expected an existing asset file' }
    while ($null -ne $current -and $current.FullName.Length -ge $resources.Length) {
        if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Linked service target rejected: $($current.FullName)" }
        $current = if ($current.PSIsContainer) { $current.Parent } else { $current.Directory }
    }
    return $path
}

$PlanPath = Under-Root $PlanPath $outputRoot
if ((Hash-File $PlanPath) -ne $PlanSha256) { throw 'Synchronization plan changed after review' }
$plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($plan.modelId -ne 'cad_lifting_load_table_111400' -or $plan.serviceName -ne $serviceName) { throw 'Only the explicitly approved lift asset/service is supported' }
$run = Under-Root ([string]$plan.directory) $outputRoot
$resultFile = Join-Path $run 'result.json'
$statusFile = Join-Path $run 'status.json'
$records = @($plan.files)
if ($records.Count -ne $allowed.Count -or @($records.relative | Select-Object -Unique).Count -ne $allowed.Count) { throw 'The exact single-model file allowlist is required' }
$config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ([IO.Path]::GetFullPath([string]$config.resourcesRoot) -ne $resources -or $config.serviceName -ne $serviceName -or $config.backendOrigin -ne 'http://127.0.0.1:3001') { throw 'Active service configuration changed; nothing will be redirected' }
$configHash = Hash-File $configFile
$rigFile = Join-Path $resources 'backend\assets\motions\cad_lifting_load_table_111400.glb'
if ((Hash-File $rigFile) -ne $plan.rigSha256) { throw 'Existing motion rig differs; synchronization stopped' }
foreach ($record in $records) {
    if ($allowed -notcontains [string]$record.relative) { throw 'Unapproved target in synchronization plan' }
    $target = Check-Target (Join-Path $resources ([string]$record.relative))
    $staged = Under-Root ([string]$record.staged) $run
    if ((Hash-File $target) -ne $record.beforeSha256 -or (Hash-File $staged) -ne $record.afterSha256) { throw "Asset changed after staging: $($record.relative)" }
}
if ($ValidateOnly) { Write-Output 'Single-model plan, original assets, staged hashes and service destination validated; no writes/restart performed'; exit 0 }
if (-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Windows administrator consent is required for the live service asset update' }

function Status([string]$Stage) {
    [IO.File]::WriteAllText($statusFile, (@{ stage=$Stage; service=$serviceName; utc=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json), $utf8)
}
function Wait-Healthy([string]$ExpectedSource, [int]$Seconds = 180) {
    $end = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $end) {
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3001/api/health' -TimeoutSec 8
            if ($health.status -eq 'ok' -and $health.db.connected -eq $true -and $health.runtime.role -eq 'collector' -and $health.runtime.owner -eq 'windows-service') {
                $client = [Net.WebClient]::new()
                try { $bytes = $client.DownloadData('http://127.0.0.1:3001/assets/models/cad_lifting_load_table_111400.glb?asset-sync=' + [Guid]::NewGuid().ToString('N')) } finally { $client.Dispose() }
                $sha = [Security.Cryptography.SHA256]::Create()
                try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
                if ($hash -eq $ExpectedSource) { return $health }
            }
        } catch { }
        Start-Sleep -Seconds 2
    }
    throw 'Authoritative service did not return healthy and the expected model bytes within the deadline'
}
function Stop-ExactService {
    $service = Get-Service -Name $serviceName
    if ($service.Status -ne 'Stopped') { Stop-Service -Name $serviceName -ErrorAction Stop; $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(90)) }
}
function Start-ExactService {
    $service = Get-Service -Name $serviceName
    if ($service.Status -eq 'Stopped') { Start-Service -Name $serviceName -ErrorAction Stop }
    $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(180))
}
function Replace-Asset([string]$Source, [string]$Target) {
    $Target = Check-Target $Target
    $temporary = Under-Root ($Target + '.asset-sync-' + [Guid]::NewGuid().ToString('N')) $resources
    # Windows PowerShell 5.1 may coerce a null String argument to an invalid
    # empty backup path. An explicit, bounded sibling path avoids that overload issue.
    $retired = Under-Root ($Target + '.asset-sync-retired-' + [Guid]::NewGuid().ToString('N')) $resources
    try { Copy-Item -LiteralPath $Source -Destination $temporary; [IO.File]::Replace($temporary, $Target, $retired) }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        if (Test-Path -LiteralPath $retired) { Remove-Item -LiteralPath $retired -Force }
    }
}

$beforeService = Get-CimInstance Win32_Service -Filter "Name='HeatTreatmentCollector'"
if ($beforeService.State -ne 'Running' -or $beforeService.PathName -notlike '*HeatTreatmentCollectorPlugin\resources\collector-service\HeatTreatmentCollector.exe*') { throw 'The approved running Windows service is not in the expected state/location' }
$backup = Join-Path $run 'backup'
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach ($record in $records) {
    $file = Under-Root (Join-Path $backup ([string]$record.relative)) $run
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($file)) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $resources ([string]$record.relative)) -Destination $file
    if ((Hash-File $file) -ne $record.beforeSha256) { throw 'Backup integrity check failed before service stop' }
}

$changed = @()
$stopped = $false
$stopRequested = $false
try {
    Status 'stopping-service'
    $stopRequested = $true
    Stop-ExactService
    $stopped = $true
    # Do not overwrite a concurrent update which occurred while the service stopped.
    foreach ($record in $records) { if ((Hash-File (Join-Path $resources ([string]$record.relative))) -ne $record.beforeSha256) { throw 'Concurrent service asset update detected; no overwrite is allowed' } }
    Status 'publishing-approved-assets'
    foreach ($record in $records) {
        $target = Join-Path $resources ([string]$record.relative)
        $changed += $record
        Replace-Asset ([string]$record.staged) $target
        if ((Hash-File $target) -ne $record.afterSha256) { throw 'Published asset checksum mismatch' }
    }
    if ((Hash-File $rigFile) -ne $plan.rigSha256 -or (Hash-File $configFile) -ne $configHash) { throw 'Untouched motion rig or service configuration changed' }
    Status 'restarting-service'
    Start-ExactService
    $health = Wait-Healthy ([string]$plan.sourceSha256)
    $afterService = Get-CimInstance Win32_Service -Filter "Name='HeatTreatmentCollector'"
    $result = @{ success=$true; service=$serviceName; state=$afterService.State; oldServicePid=$beforeService.ProcessId; servicePid=$afterService.ProcessId; backendPid=$health.components.backend.processId; sourceSha256=$plan.sourceSha256; rigSha256=$plan.rigSha256; clipSha256=$plan.clipSha256; files=@($records | ForEach-Object { @{relative=$_.relative; sha256=$_.afterSha256} }); databaseConfigurationWritten=$false; uploadsWritten=$false; plcBindingsWritten=$false; serviceConfigurationUnchanged=((Hash-File $configFile) -eq $configHash) }
    [IO.File]::WriteAllText($resultFile, ($result | ConvertTo-Json -Depth 12), $utf8)
    Status 'complete'
} catch {
    $original = $_.Exception.Message
    $rollbackError = $null
    try {
        if ($changed.Count -gt 0) {
            Status 'rolling-back'
            Stop-ExactService
            foreach ($record in $changed) {
                $originalFile = Join-Path $backup ([string]$record.relative)
                if ((Hash-File $originalFile) -ne $record.beforeSha256) { throw 'Rollback backup changed; refusing to publish it' }
                Replace-Asset $originalFile (Join-Path $resources ([string]$record.relative))
            }
            foreach ($record in $changed) { if ((Hash-File (Join-Path $resources ([string]$record.relative))) -ne $record.beforeSha256) { throw 'Rollback checksum mismatch' } }
        }
    } catch { $rollbackError = $_.Exception.Message }
    # Restore service operation even if restoring an asset backup failed.
    if ($stopRequested) {
        try {
            $service = Get-Service -Name $serviceName
            if ($service.Status -eq 'StopPending') { $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(90)) }
            Start-ExactService
            $null = Wait-Healthy ([string]$plan.oldSourceSha256)
        } catch { $rollbackError = "$rollbackError; service recovery: $($_.Exception.Message)" }
    }
    [IO.File]::WriteAllText($resultFile, (@{success=$false; error=$original; rollbackError=$rollbackError; changedFiles=@($changed.relative); databaseConfigurationWritten=$false; uploadsWritten=$false} | ConvertTo-Json -Depth 8), $utf8)
    Status 'failed'
    throw $original
}
