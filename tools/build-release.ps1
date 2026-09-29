[CmdletBinding()]
param(
    [string]$DatabaseHost = '127.0.0.1',
    [int]$DatabasePort = 3307,
    [string]$DatabaseUser = 'root',
    [string]$DatabasePassword = 'root',
    [string]$DatabaseName = 'dongtai_daping',
    [switch]$IncludeHistory,
    [switch]$RefreshDependencies,
    [switch]$ForceUnityBuild,
    [switch]$StarterTemplate,
    [switch]$SkipSmokeTest
)

# Keep the command-line and double-click entry points on the same release path.
# The shared script creates a distinct output directory, captures logs, performs
# the isolated bundled-MySQL smoke test and writes SHA-256 + release metadata.
$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$entryPoint = Join-Path $projectDirectory '生成安装包.ps1'
& $entryPoint @PSBoundParameters -NoPause
if (-not $?) { exit 1 }
