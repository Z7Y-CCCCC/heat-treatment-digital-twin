param(
    [Parameter(Mandatory=$true)][string]$InputDirectory,
    [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference='Stop'
$items=@(
    @{file='10.13.00(料车总图).dwg';id='transfer_cart'},
    @{file='11.14.00升降备料台.dwg';id='lifting_staging_table'},
    @{file='11.22.00固定备料台.dwg';id='fixed_staging_table'},
    @{file='11.58.00HT 风冷台.dwg';id='air_cooling_table'},
    @{file='47.10.00水冷槽总图.dwg';id='water_cooling_tank'},
    @{file='回火炉.dwg';id='tempering_furnace'},
    @{file='清洗机总图.dwg';id='washing_machine'}
)
$inputRoot=(Resolve-Path -LiteralPath $InputDirectory).Path
$outputRoot=[IO.Path]::GetFullPath($OutputDirectory)
if($outputRoot.StartsWith($inputRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Output must be separate from original drawings'}
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$app=$null;$report=@()
try {
    # New automation instance only. Never attach to or close the user's CAD session.
    $app=New-Object -ComObject ZWCAD.Application.2026
    $app.Visible=$false
    $blank=$app.ActiveDocument
    foreach($pair in @{FILEDIA=0;CMDDIA=0;CMDECHO=0;PROXYNOTICE=0;FONTALT='simplex.shx'}.GetEnumerator()){
        $blank.SetVariable($pair.Key,$pair.Value)
    }
    foreach($item in $items){
        $original=Join-Path $inputRoot $item.file
        $hash=(Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash
        $copy=Join-Path $outputRoot ($item.id+'.dwg')
        $dxf=Join-Path $outputRoot ($item.id+'.dxf')
        if(Test-Path -LiteralPath $copy){(Get-Item -LiteralPath $copy).IsReadOnly=$false}
        Copy-Item -LiteralPath $original -Destination $copy -Force
        (Get-Item -LiteralPath $copy).IsReadOnly=$false
        $doc=$null
        try {
            $doc=$app.Documents.Open($copy,$true)
            $entities=$doc.ModelSpace.Count
            $doc.SaveAs($dxf,61) # 2013 ASCII DXF; source copy is never saved back.
            $report+=[PSCustomObject]@{id=$item.id;source=$item.file;sha256=$hash;entities=$entities;dxf=(Split-Path -Leaf $dxf)}
            Write-Output ($item.id+': '+$entities+' entities')
        } finally {if($doc){$doc.Close($false)}}
        if((Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash -ne $hash){throw 'Original drawing changed unexpectedly'}
    }
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outputRoot 'sources.json') -Encoding utf8
} finally {if($app){$app.Quit();[Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null}}
