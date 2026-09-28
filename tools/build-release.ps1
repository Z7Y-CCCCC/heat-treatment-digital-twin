param(
    [switch]$IncludeSiteData,
    [switch]$SkipSmokeTest
)

$ErrorActionPreference = 'Stop'
$projectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$desktopDir = Join-Path $projectDir 'desktop'
$package = Get-Content -LiteralPath (Join-Path $desktopDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$releaseName = "v$($package.version)-$stamp"
$outputFolder = -join @([char]0x5B89, [char]0x88C5, [char]0x5305)
$releaseDir = Join-Path (Join-Path $projectDir $outputFolder) $releaseName
$relativeOutput = "../$outputFolder/$releaseName"
if (Test-Path -LiteralPath $releaseDir) { throw "Release directory already exists: $releaseDir" }

foreach ($command in @('node.exe', 'npm.cmd', 'dotnet.exe')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Missing build tool: $command"
    }
}

$unityVersionLine = Get-Content -LiteralPath (Join-Path $projectDir 'unity-client/ProjectSettings/ProjectVersion.txt') |
    Where-Object { $_ -match '^m_EditorVersion:\s*(.+)$' } | Select-Object -First 1
if (-not $unityVersionLine) { throw 'Cannot read Unity project version.' }
$unityVersion = ($unityVersionLine -split ':', 2)[1].Trim()
$unityEditor = Join-Path 'C:\Program Files' "Unity $unityVersion\Editor\Unity.exe"
if (-not (Test-Path -LiteralPath $unityEditor) -and -not $env:UNITY_EDITOR_PATH) {
    throw "Unity $unityVersion is missing. Install it or set UNITY_EDITOR_PATH."
}

$nativeOutput = Join-Path $projectDir 'unity-client/Builds/Windows/HeatTreatmentDigitalTwin.exe'
$runningClient = Get-CimInstance Win32_Process -Filter "Name='HeatTreatmentDigitalTwin.exe'" |
    Where-Object { $_.ExecutablePath -eq $nativeOutput }
if ($runningClient) {
    throw 'The development Unity client is running. Exit it normally before packaging.'
}

if ($IncludeSiteData) {
    Write-Warning 'Site configuration and uploads will be bundled. Review credentials and private data before distribution.'
    Remove-Item Env:DESKTOP_TEMPLATE_EMPTY -ErrorAction SilentlyContinue
} else {
    Write-Host 'Building with the built-in starter template; local configuration and uploads are excluded.'
    $env:DESKTOP_TEMPLATE_EMPTY = '1'
    Remove-Item Env:DESKTOP_TEMPLATE_SOURCE_DB -ErrorAction SilentlyContinue
}

Write-Host "Building release: $releaseDir"
Push-Location $projectDir
try {
    & npm.cmd --prefix $desktopDir run dist -- "--config.directories.output=$relativeOutput"
    if ($LASTEXITCODE -ne 0) { throw "Packaging failed with exit code $LASTEXITCODE" }

    $installer = @(Get-ChildItem -LiteralPath $releaseDir -File -Filter '*-x64.exe')
    if ($installer.Count -ne 1) { throw "Expected one installer in $releaseDir, found $($installer.Count)." }
    $unpacked = Join-Path (Join-Path $releaseDir 'win-unpacked') "$($package.build.productName).exe"
    if (-not (Test-Path -LiteralPath $unpacked)) {
        throw "Unpacked executable not found: $unpacked"
    }

    if (-not $SkipSmokeTest) {
        & node.exe 'tools/packaged-desktop-smoke-test.cjs' $unpacked
        if ($LASTEXITCODE -ne 0) { throw 'Packaged application smoke test failed.' }
    }

    $hash = Get-FileHash -LiteralPath $installer[0].FullName -Algorithm SHA256
    Write-Host "Installer: $($installer[0].FullName)"
    Write-Host "Size: $([math]::Round($installer[0].Length / 1MB, 1)) MB"
    Write-Host "SHA-256: $($hash.Hash)"
} finally {
    Pop-Location
}
