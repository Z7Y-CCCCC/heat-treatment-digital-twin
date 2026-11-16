# Function-level isolation tests: this harness never executes the repair entry
# point, requests elevation, or controls a real Windows service.
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'sync-installed-model-asset-tools.ps1'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if (@($parseErrors).Count) { throw ($parseErrors | Out-String) }
$functions = @($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]}, $false))
foreach ($function in $functions) { Invoke-Expression $function.Extent.Text }
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputRoot = Join-Path $workspace 'output'
$run = Under-Root (Join-Path $outputRoot ('asset-tools-sync-unit-' + [Guid]::NewGuid().ToString('N'))) $outputRoot
$resources = Join-Path $run 'mock-installed-resources'
$backup = Join-Path $run 'backup'
$configFile = Join-Path $run 'mock-collector-service.json'
$utf8 = [Text.UTF8Encoding]::new($false)
$serviceName = 'HeatTreatmentCollector'
$resultFile = Join-Path $run 'result.json'
$statusFile = Join-Path $run 'status.json'
New-Item -ItemType Directory -Path (Join-Path $resources 'backend/services') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $backup 'backend/services') -Force | Out-Null
[IO.File]::WriteAllText($configFile, '{"fixture":true}', $utf8)
$plan = @{configSha256=(Hash-File $configFile);protectedFiles=@()}
$script:count = 0
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "FAIL: $Message" }; $script:count++; Write-Output "PASS: $Message" }
function Reject([scriptblock]$Action, [string]$Message) { $rejected=$false; try { $null=& $Action } catch { $rejected=$true }; Assert $rejected $Message }
function File([string]$Name, [string]$Text) {
    $file = Under-Root (Join-Path $run $Name) $run
    [IO.File]::WriteAllText($file,$Text,$utf8)
    return $file
}

Assert (@($parseErrors).Count -eq 0) 'PowerShell syntax parses cleanly'
Reject { Under-Root (Join-Path $run '../escape.js') $run } 'Escaped paths are rejected'
Reject { Under-Root $run $run } 'Root itself cannot be deleted or replaced'
Reject { Check-Path (Join-Path $resources 'backend/services') $resources } 'Directories cannot be file targets'
Reject { Check-Path (Join-Path $resources 'backend/services/missing.js') $resources } 'Missing existing targets are rejected'
$newTarget = Join-Path $resources 'backend/services/modelAssetUpdates.js'
$staged = File 'new-code.js' 'new tested code'
$newRecord = @{relative='backend/services/modelAssetUpdates.js';beforeSha256=$null;afterSha256=(Hash-File $staged)}
Assert-Original $newRecord
Publish-Code $staged $newTarget $true
Assert ((Hash-File $newTarget) -eq $newRecord.afterSha256) 'New code publishes without overwriting another file'
Reject { Publish-Code $staged $newTarget $true } 'CreateNew publication refuses an existing new target'
Restore-Code $newRecord $backup
Assert (-not (Test-Path -LiteralPath $newTarget)) 'Rollback removes only the checksum-matching newly created code'
Publish-Code $staged $newTarget $true
[IO.File]::WriteAllText($newTarget,'unrelated concurrent change',$utf8)
Reject { Restore-Code $newRecord $backup } 'Rollback preserves concurrently changed new code'
Assert ([IO.File]::ReadAllText($newTarget) -eq 'unrelated concurrent change') 'Concurrent new file contents remain unchanged'

$existing = Join-Path $resources 'backend/services/modelAssetBundle.js'
$oldBytes = File 'old-code.js' 'old tested code'
Copy-Item -LiteralPath $oldBytes -Destination $existing
Copy-Item -LiteralPath $oldBytes -Destination (Join-Path $backup 'backend/services/modelAssetBundle.js')
$record = @{relative='backend/services/modelAssetBundle.js';beforeSha256=(Hash-File $existing);afterSha256=(Hash-File $staged)}
Assert-Original $record
Publish-Code $staged $existing $false
Assert ((Hash-File $existing) -eq $record.afterSha256) 'Existing code replaces atomically'
Reject { Assert-Original $record } 'A stale original checksum stops publication'
Restore-Code $record $backup
Assert ((Hash-File $existing) -eq $record.beforeSha256) 'Existing code rollback restores its verified backup'
Restore-Code $record $backup
Assert ((Hash-File $existing) -eq $record.beforeSha256) 'No-op rollback does not rewrite already unchanged code'
Publish-Code $staged $existing $false
[IO.File]::WriteAllText($existing,'another concurrent update',$utf8)
Reject { Restore-Code $record $backup } 'Existing code rollback refuses concurrent changes'
Assert ([IO.File]::ReadAllText($existing) -eq 'another concurrent update') 'Concurrent existing code remains unchanged'
Assert-Protected
$plan.protectedFiles = @(@{relative='backend/services/modelAssetBundle.js';sha256=(Hash-File $existing)})
Assert-Protected
[IO.File]::WriteAllText($existing,'protected changed',$utf8)
Reject { Assert-Protected } 'Protected dependency changes fail the repair gate'
$plan.protectedFiles=@()
[IO.File]::WriteAllText($configFile,'{"fixture":"changed"}',$utf8)
Reject { Assert-Protected } 'Configuration changes fail without overwrite or redirect'
Write-RunJson $resultFile @{success=$true;tests=$script:count;isolated=$true}
Assert ((Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json).isolated -eq $true) 'Results are written only in the owned isolated directory'
Assert (-not @(Get-ChildItem -LiteralPath (Join-Path $resources 'backend/services') -Filter '*.code-sync-*').Count) 'Atomic publication leaves no temporary code files'

Write-Output "Isolated code-sync tests passed: $script:count; evidence: $run"
