param([string]$UnityPath='C:\Program Files\Unity 2022.3.34f1c1\Editor\Unity.exe')
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if(-not(Test-Path -LiteralPath $UnityPath)){throw 'Unity editor is required'}
$run=Join-Path $root ('output\configuration-refresh-validation-'+(Get-Date -Format 'yyyyMMddTHHmmss')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $run|Out-Null
$fixture=$null;$editor=$null;$info=$null
$previous=$env:CONFIGURATION_REFRESH_FIXTURE_INFO
try {
    $stdout=Join-Path $run 'fixture.stdout';$stderr=Join-Path $run 'fixture.stderr'
    $node=(Get-Command node -ErrorAction Stop).Source
    $fixture=Start-Process -FilePath $node -ArgumentList ('"'+(Join-Path $root 'tools\configuration-refresh-fixture.cjs')+'"') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $deadline=[DateTime]::UtcNow.AddSeconds(20)
    do {
        $line=Get-Content -LiteralPath $stdout -ErrorAction SilentlyContinue|Select-Object -First 1
        if($line){break}
        if($fixture.HasExited -or [DateTime]::UtcNow -gt $deadline){throw "Fixture did not start: $stderr"}
        Start-Sleep -Milliseconds 100
    }while($true)
    $startup=$line|ConvertFrom-Json
    $infoFile=[IO.Path]::GetFullPath($startup.file)
    if(-not $infoFile.StartsWith((Join-Path $root 'output')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected fixture path'}
    $info=Get-Content -LiteralPath $infoFile -Raw|ConvertFrom-Json
    $origin=[Uri]$info.origin
    if($info.pid -ne $fixture.Id -or -not $origin.IsLoopback -or $origin.Scheme -ne 'http'){throw 'Unexpected fixture owner/origin'}
    $env:CONFIGURATION_REFRESH_FIXTURE_INFO=$infoFile
    $log=Join-Path $run 'unity.log'
    $arguments='-batchmode -force-d3d11 -projectPath "'+(Join-Path $root 'unity-client')+'" -executeMethod HeatTreatment.DigitalTwin.Editor.ConfigurationRefreshValidation.Run -logFile "'+$log+'"'
    $editor=Start-Process -FilePath $UnityPath -ArgumentList $arguments -WindowStyle Hidden -PassThru
    if(-not $editor.WaitForExit(600000)){throw "Owned validation editor timed out: $log"}
    $editor.Refresh()
    $report=Join-Path $info.directory 'unity-configuration-refresh-result.json'
    if($editor.ExitCode -ne 0 -or -not(Test-Path -LiteralPath $report)){throw "Unity validation failed: $log"}
    $result=Get-Content -LiteralPath $report -Raw|ConvertFrom-Json
    if(-not $result.success -or $result.errors.Count -ne 0){throw "Configuration refresh checks failed: $report"}
    Write-Output "PASS: $($result.checks.Count) actual-engine checks; no live DB/PLC writes. Report: $report"
} finally {
    $env:CONFIGURATION_REFRESH_FIXTURE_INFO=$previous
    # Stop only children owned by this invocation, never the user's application.
    if($editor -and -not $editor.HasExited){Stop-Process -Id $editor.Id -ErrorAction SilentlyContinue}
    if($fixture -and -not $fixture.HasExited){
        if($info){try {Invoke-RestMethod -Method Post -Uri ($info.origin+'/fixture/close') -TimeoutSec 3|Out-Null}catch{}}
        if(-not $fixture.WaitForExit(5000)){Stop-Process -Id $fixture.Id -ErrorAction SilentlyContinue}
    }
}
