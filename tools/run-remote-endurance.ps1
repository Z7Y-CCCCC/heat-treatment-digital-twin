[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$TestRoot, [int]$DurationSeconds=259200)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = (Resolve-Path -LiteralPath $TestRoot).Path
$workspace = Join-Path $root 'workspace'
$resources = Join-Path $root 'program\resources'
$node = Join-Path $resources 'runtime\node.exe'
if ($DurationSeconds -lt 30) { throw 'Use at least 30 seconds to include recovery checks.' }
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class DapingTestAwake { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }'
$exitCode = 1
try {
    [DapingTestAwake]::SetThreadExecutionState([uint32]2147483649) | Out-Null
    Set-Location -LiteralPath $workspace
    $env:PATH = (Join-Path $resources 'runtime') + ';' + $env:PATH
    $env:FRONTEND_DIST = Join-Path $resources 'frontend'
    @{startedAt=(Get-Date).ToUniversalTime().ToString('o');wrapperPid=$PID;durationSeconds=$DurationSeconds;workspace=$workspace} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'run-launch.json') -Encoding UTF8
    $ErrorActionPreference = 'Continue'
    & $node (Join-Path $workspace 'backend\scripts\endurance-test.cjs') --database-type mysql --mysql-runtime-dir (Join-Path $resources 'mysql') --duration-seconds $DurationSeconds 1> (Join-Path $root 'endurance.stdout.log') 2> (Join-Path $root 'endurance.stderr.log')
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
} finally {
    [DapingTestAwake]::SetThreadExecutionState([uint32]2147483648) | Out-Null
    @{finishedAt=(Get-Date).ToUniversalTime().ToString('o');exitCode=$exitCode} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'run-exit.json') -Encoding UTF8
}
exit $exitCode
