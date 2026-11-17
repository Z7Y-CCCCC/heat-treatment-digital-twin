[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ArchivePath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSha256,
    [Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$ExpectedVersion,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedCommit,
    [switch]$VerifyOnly
)
# The NSIS installer embeds an immutable, same-build ZIP. Never download a
# plugin at install time or pick up a previous runtime/cache from this machine.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$archive=[IO.File]::Open($ArchivePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
$zip=$null
try {
    $sha=[Security.Cryptography.SHA256]::Create()
    try {$digest=([BitConverter]::ToString($sha.ComputeHash($archive))).Replace('-','').ToLowerInvariant()} finally {$sha.Dispose()}
    if($digest -ne $ExpectedSha256){throw '采集插件压缩包校验失败；未停止服务或修改数据。'}
    $archive.Position=0
    $zip=[IO.Compression.ZipArchive]::new($archive,[IO.Compression.ZipArchiveMode]::Read,$true)
    $names=@{};$total=0L
    foreach($entry in $zip.Entries){
        $name=$entry.FullName.TrimEnd('/')
        if(-not $name -or $name -match '[:\\]' -or $name.StartsWith('/') -or ($name.Split('/') | Where-Object {$_ -in @('','.','..')})) {throw '采集插件包含非法压缩路径。'}
        if($names.ContainsKey($name)){throw '采集插件包含重复压缩路径。'}
        $names[$name]=$true
        if((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000){throw '采集插件不能包含链接。'}
        $total += $entry.Length
        if($total -gt 6GB -or $names.Count -gt 20000){throw '采集插件超出安装资源上限。'}
    }
    $manifestEntry=$zip.GetEntry('plugin-manifest.json')
    if(-not $manifestEntry -or $manifestEntry.Length -gt 8MB){throw '缺少有效的采集插件清单。'}
    $reader=[IO.StreamReader]::new($manifestEntry.Open(),[Text.Encoding]::UTF8)
    try {$manifest=$reader.ReadToEnd() | ConvertFrom-Json} finally {$reader.Dispose()}
    if($manifest.product -ne 'collector-plugin' -or $manifest.version -ne $ExpectedVersion -or $manifest.buildSourceCommit -ne $ExpectedCommit){throw '主程序和采集插件的版本或源码提交不一致。'}
    if($VerifyOnly){[pscustomobject]@{success=$true;version=$ExpectedVersion;commit=$ExpectedCommit;entries=$names.Count}|ConvertTo-Json -Compress;return}
    if(-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw '安装采集服务需要 Windows 管理员授权。'}
    # An administrator-only Program Files sibling, not a user-writable temp
    # directory, holds executable extraction. Keep failure evidence for repair.
    $programFiles=[Environment]::GetFolderPath('ProgramFiles')
    $stage=Join-Path $programFiles ('HeatTreatmentCollectorPayload-'+[Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
    foreach($entry in $zip.Entries){
        $target=[IO.Path]::GetFullPath((Join-Path $stage $entry.FullName))
        if(-not $target.StartsWith($stage+'\',[StringComparison]::OrdinalIgnoreCase)){throw '采集插件压缩路径越界。'}
        if($entry.FullName.EndsWith('/')){New-Item -ItemType Directory -Path $target -Force|Out-Null;continue}
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force|Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$target,$false)
    }
} finally {if($zip){$zip.Dispose()};$archive.Dispose()}
if($VerifyOnly){exit 0}
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $stage 'Install-CollectorPlugin.ps1') -SkipUserDataImport
if($LASTEXITCODE -ne 0){throw '独立采集插件安装失败；请保留安装记录及原工程。'}
$installed=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'HeatTreatmentCollectorPlugin'
$installedManifest=Get-Content -LiteralPath (Join-Path $installed 'plugin-manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($installedManifest.version -ne $ExpectedVersion -or $installedManifest.buildSourceCommit -ne $ExpectedCommit){throw '安装后采集服务版本核对失败。'}
foreach($file in $manifest.files){
    if($file.path -in @('Install-CollectorPlugin.ps1','安装采集插件.cmd')){continue}
    $target=Join-Path $installed $file.path
    if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256){throw '安装后的采集程序文件与本次构建不一致。'}
}
Write-Output "采集服务已安装并逐文件核对：$ExpectedVersion / $ExpectedCommit。已有机器级工程未覆盖；用户级旧工程需通过项目迁移显式导入。"

# Delete only the exact, newly created and verified staging sibling on success.
$resolved=[IO.Path]::GetFullPath($stage)
if([IO.Path]::GetDirectoryName($resolved) -ne $programFiles -or [IO.Path]::GetFileName($resolved) -notmatch '^HeatTreatmentCollectorPayload-[a-f0-9]{32}$'){throw 'Unsafe staging cleanup path'}
if((Get-Item -LiteralPath $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked staging cleanup rejected'}
Remove-Item -LiteralPath $resolved -Recurse -Force
