[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$TestRoot)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = (Resolve-Path -LiteralPath $TestRoot).Path
$resources = Join-Path $root 'program\resources'
$workspace = Join-Path $root 'workspace'
if (Test-Path -LiteralPath $workspace) { throw 'Workspace already exists; inspect it before reuse.' }
foreach ($required in @('backend','shared','runtime\node.exe','mysql\bin\mysqld.exe','backend-dependencies.tar')) {
    if (!(Test-Path -LiteralPath (Join-Path $resources $required))) { throw "Missing installed resource: $required" }
}
New-Item -ItemType Directory -Path $workspace | Out-Null
Copy-Item -LiteralPath (Join-Path $resources 'backend') -Destination (Join-Path $workspace 'backend') -Recurse
Copy-Item -LiteralPath (Join-Path $resources 'shared') -Destination (Join-Path $workspace 'shared') -Recurse
$modules = Join-Path $workspace 'backend\node_modules'
New-Item -ItemType Directory -Path $modules -Force | Out-Null
& tar.exe -xf (Join-Path $resources 'backend-dependencies.tar') -C $modules
if ($LASTEXITCODE -ne 0) { throw 'Dependency extraction failed.' }
$scripts = Join-Path $workspace 'backend\scripts'
New-Item -ItemType Directory -Path $scripts -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $root 'test-payload') -Filter '*.cjs' -File | Copy-Item -Destination $scripts
$hashes = @('server.js','services\projectBundle.js','services\dashboardDocuments.js') | ForEach-Object {
    $installedHash = (Get-FileHash -LiteralPath (Join-Path $resources "backend\$_") -Algorithm SHA256).Hash
    $workspaceHash = (Get-FileHash -LiteralPath (Join-Path $workspace "backend\$_") -Algorithm SHA256).Hash
    if ($installedHash -ne $workspaceHash) { throw "Copied production module differs: $_" }
    [pscustomobject]@{path=$_;sha256=$workspaceHash}
}
$hashes | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'tested-production-hashes.json') -Encoding UTF8
& (Join-Path $resources 'runtime\node.exe') --version
if ($LASTEXITCODE -ne 0) { throw 'Packaged Node runtime could not start.' }
Write-Output "Prepared isolated test workspace: $workspace"
