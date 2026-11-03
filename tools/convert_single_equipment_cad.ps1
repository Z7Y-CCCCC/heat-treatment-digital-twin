param(
    [Parameter(Mandatory=$true)][string]$InputFile,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [Parameter(Mandatory=$true)][string]$AssetId
)
$ErrorActionPreference='Stop'
if($AssetId -notmatch '^[a-z0-9_]+$'){throw 'ASCII asset id required'}
$original=(Resolve-Path -LiteralPath $InputFile).Path
$outputRoot=[IO.Path]::GetFullPath($OutputDirectory)
if($outputRoot -eq [IO.Path]::GetDirectoryName($original)){throw 'Do not convert in the source directory'}
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$hash=(Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash
$copy=Join-Path $outputRoot ($AssetId+'.dwg');$dxf=Join-Path $outputRoot ($AssetId+'.dxf')
Copy-Item -LiteralPath $original -Destination $copy -Force
(Get-Item -LiteralPath $copy).IsReadOnly=$false
$app=$null;$doc=$null
try {
    # Separate owned automation instance, never the user's active CAD document.
    $app=New-Object -ComObject ZWCAD.Application.2026;$app.Visible=$false
    $blank=$app.ActiveDocument
    foreach($pair in @{FILEDIA=0;CMDDIA=0;CMDECHO=0;PROXYNOTICE=0;FONTALT='simplex.shx'}.GetEnumerator()){$blank.SetVariable($pair.Key,$pair.Value)}
    $doc=$app.Documents.Open($copy,$true)
    $count=$doc.ModelSpace.Count
    $doc.SaveAs($dxf,61)
    $record=@{id=$AssetId;source=[IO.Path]::GetFileName($original);source_path=$original;sha256=$hash;entities=$count;dxf=[IO.Path]::GetFileName($dxf)}
    ConvertTo-Json -InputObject @($record) -Depth 5 | Set-Content -LiteralPath (Join-Path $outputRoot 'sources.json') -Encoding utf8
    $record | ConvertTo-Json -Compress
} finally {
    if($doc){$doc.Close($false)}
    if($app){$app.Quit();[Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null}
    if((Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash -ne $hash){throw 'Original DWG unexpectedly changed'}
}
