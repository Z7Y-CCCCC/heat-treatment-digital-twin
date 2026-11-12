param([string]$UnityPath='C:\Program Files\Unity 2022.3.34f1c1\Editor\Unity.exe')
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$run=Join-Path $root ('output\playwright\linkage-simplification-20261111\validation-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $run | Out-Null
Write-Output "VALIDATING $run"
function Check-Native([string]$name,[scriptblock]$command) {
    # Windows PowerShell represents native stderr warnings as ErrorRecords.
    # A successful Vite warning is not a failed build; use the actual exit code.
    $previousPreference=$ErrorActionPreference
    try {$ErrorActionPreference='Continue'; & $command *> (Join-Path $run ($name+'.log')); $code=$LASTEXITCODE}
    finally {$ErrorActionPreference=$previousPreference}
    if($code -ne 0){throw "$name failed; inspect $run\$name.log"}
    Write-Output "PASS $name"
}
function Check-Unity([string]$method,[string]$name,[bool]$quit) {
    $log=Join-Path $run ($name+'.log')
    $arguments=@('-batchmode','-force-d3d11','-projectPath',('"'+(Join-Path $root 'unity-client')+'"'),'-executeMethod',$method,'-logFile',('"'+$log+'"'))
    if($quit){$arguments+='-quit'}
    $p=Start-Process -FilePath $UnityPath -ArgumentList $arguments -WindowStyle Hidden -PassThru
    if(!$p.WaitForExit(900000)){Stop-Process -Id $p.Id -ErrorAction SilentlyContinue;throw "$name timed out; owned process stopped"}
    $p.Refresh();if($p.ExitCode -ne 0){throw "$name failed; inspect $log"}
    Write-Output "PASS $name"
}
if(!(Test-Path -LiteralPath $UnityPath)){throw 'Unity 2022.3 editor path is required'}
$previousCheck=$env:ADAPTIVE_TRANSFER_CHECK_DIR;$previousBuild=$env:DIGITAL_TWIN_UNITY_BUILD_DIR
Push-Location $root
try {
    Check-Native 'fixtures' {node tools/generate-adaptive-transfer-fixtures.mjs $run}
    Push-Location (Join-Path $root 'frontend')
    try {
        Check-Native 'frontend-tests' {node --experimental-test-module-mocks --test --test-concurrency=2 tests/*.test.mjs}
        Check-Native 'frontend-build' {node node_modules/vite/bin/vite.js build --outDir (Join-Path $run 'frontend-stage')}
    } finally {Pop-Location}
    Check-Native 'native-tests' {dotnet run --project tools/native-runtime-tests}
    Check-Native 'backend-tests' {node backend/scripts/bidirectional-transfer-test.cjs}
    $env:ADAPTIVE_TRANSFER_CHECK_DIR=$run
    Check-Unity 'HeatTreatment.DigitalTwin.Editor.AdaptiveTransferGraphicsValidation.Run' 'unity-graphics' $false
    Check-Unity 'HeatTreatment.DigitalTwin.Editor.BidirectionalTransferValidation.Validate' 'unity-legacy-transfer' $true
    Check-Native 'engine-parity' {node --experimental-test-module-mocks tools/compare-adaptive-transfer-engines.mjs $run}
    $env:DIGITAL_TWIN_UNITY_BUILD_DIR=Join-Path $run 'unity-stage'
    Check-Unity 'HeatTreatment.DigitalTwin.Editor.ProjectBootstrap.BuildWindowsClient' 'unity-build' $true
    Check-Native 'staged-native' {node tools/adaptive-transfer-native-test.cjs $run}
    Write-Output "ALL PASSED: $run"
} finally {
    $env:ADAPTIVE_TRANSFER_CHECK_DIR=$previousCheck;$env:DIGITAL_TWIN_UNITY_BUILD_DIR=$previousBuild
    Pop-Location
}
