[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('Publish','Retire','Complete','Rollback','Remove')][string]$Action,
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [string]$PreparedRoot,
    [Parameter(Mandatory=$true)][string]$ManifestFile,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256,
    [string]$UninstallerFilename = 'Uninstall 热处理数字孪生大屏.exe',
    [switch]$InstallerLog
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'installer-process.ps1')
Initialize-InstallerOutput -ForNsis:$InstallerLog
$recordName='program-directory-rollback.json'
function Assert-AbsoluteProgramPath([string]$Value) {
    if($Value -notmatch '^[a-zA-Z]:[\\/]'){throw '程序目录必须使用本机绝对路径。'}
    $absolute=[IO.Path]::GetFullPath($Value)
    if($absolute.TrimEnd('\') -eq [IO.Path]::GetPathRoot($absolute).TrimEnd('\')){throw '拒绝操作磁盘根目录。'}
    $full=$absolute.TrimEnd('\')
    foreach($forbidden in @($env:SystemRoot,$env:ProgramFiles,${env:ProgramFiles(x86)},$env:ProgramW6432,$env:ProgramData,$env:USERPROFILE)) {
        if($forbidden -and $full -eq [IO.Path]::GetFullPath($forbidden).TrimEnd('\')){throw '拒绝操作系统、用户、Program Files 或数据根目录。'}
    }
    if(Test-Path -LiteralPath (Join-Path $full '.git')){throw '拒绝操作源码工作区。'}
    $ancestor=$full
    while($ancestor){
        if(Test-Path -LiteralPath (Join-Path $ancestor '.git')) { throw '拒绝操作源码工作区及其子目录。' }
        if(Test-Path -LiteralPath $ancestor){
            if((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw '程序目录及其父目录不能是链接或重解析点。'}
        }
        $parent=[IO.Path]::GetDirectoryName($ancestor)
        if($parent -eq $ancestor){break}; $ancestor=$parent
    }
    $serviceConfig=Join-Path $env:ProgramData 'HeatTreatmentDigitalTwin\collector-service.json'
    if(Test-Path -LiteralPath $serviceConfig){
        $live=Get-Content -LiteralPath $serviceConfig -Raw -Encoding UTF8|ConvertFrom-Json
        if($live.root){
            $data=[IO.Path]::GetFullPath([string]$live.root).TrimEnd('\')
            if(($data+'\').StartsWith($full+'\',[StringComparison]::OrdinalIgnoreCase) -or
                ($full+'\').StartsWith($data+'\',[StringComparison]::OrdinalIgnoreCase)){throw '程序目录与现场数据目录重叠，已拒绝修改。'}
        }
    }
    return $full
}
function Assert-RelativeProgramPath([string]$Name) {
    if (-not $Name -or $Name.StartsWith('/') -or $Name -match '[<>:"\\|?*\x00-\x1f]') { throw '程序清单含非法路径。' }
    foreach ($segment in $Name.Split('/')) {
        if ($segment -in @('','.','..') -or $segment.EndsWith('.') -or $segment.EndsWith(' ') -or
            $segment -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw '程序清单含越界或 Windows 别名路径。' }
    }
}
function Assert-Manifest($Manifest) {
    if($Manifest.schema -ne 1 -or $Manifest.product -ne 'display' -or $Manifest.entries.Count -lt 1 -or $Manifest.entries.Count -gt 20000){throw '程序文件清单无效。'}
    $seen=@{}
    foreach($entry in $Manifest.entries){
        $name=[string]$entry.path
        if(-not $name -or $name -match '[:\\]' -or $name.StartsWith('/') -or ($name.Split('/')|Where-Object{$_ -in @('','.','..')})) {throw '程序清单含越界路径。'}
        if($seen.ContainsKey($name)){throw '程序清单含重复路径。'}; $seen[$name]=$true
    }
}
function Assert-Tree([string]$Directory,$Manifest,[switch]$AllowMissing,[string]$Uninstaller=$UninstallerFilename) {
    $checked=Assert-AbsoluteProgramPath $Directory
    if(-not (Test-Path -LiteralPath $checked -PathType Container)){throw '程序目录不存在。'}
    Assert-Manifest $Manifest
    $allowed=@{}; $allowedDirectories=@{}
    foreach($directory in $Manifest.directories){
        if($directory -match '[:\\]' -or $directory.StartsWith('/') -or ($directory.Split('/')|Where-Object{$_ -in @('','.','..')})){throw '程序目录清单含越界路径。'}
        $allowedDirectories[[string]$directory]=$true
    }
    foreach($entry in $Manifest.entries){
        $allowed[[string]$entry.path]=$entry
        $parent=([string][IO.Path]::GetDirectoryName([string]$entry.path)).Replace('\','/')
        while($parent){$allowedDirectories[$parent]=$true; $parent=([string][IO.Path]::GetDirectoryName($parent)).Replace('\','/')}
    }
    if($Uninstaller -match '[/\\:]' -or $Uninstaller -notmatch '^Uninstall .+\.exe$'){throw '卸载器文件名无效。'}
    foreach($extra in @('uninstallerIcon.ico',$Uninstaller,$recordName)){$allowed[$extra]=$null}
    $stack=[Collections.Generic.Stack[string]]::new(); $stack.Push($checked)
    $prefix=$checked+'\'; $actual=@{}; $actualDirectories=@{}; $paths=[Collections.Generic.List[string]]::new()
    while($stack.Count){
        foreach($item in [IO.DirectoryInfo]::new($stack.Pop()).GetFileSystemInfos()){
            if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw '程序目录含链接，拒绝递归处理。'}
            $relative=$item.FullName.Substring($prefix.Length).Replace('\','/')
            if($item -is [IO.DirectoryInfo]){
                if(-not $allowedDirectories.ContainsKey($relative)){throw ('程序目录含未列入清单的目录：'+$relative+'；未清理现场内容。')}
                $actualDirectories[$relative]=$true
                $stack.Push($item.FullName)
            }else{
                if(-not $allowed.ContainsKey($relative)){throw ('程序目录含用户新增文件：'+$relative+'；未删除。')}
                $entry=$allowed[$relative]
                if($entry){
                    if($item.Length -ne [long]$entry.size){throw ('程序文件已修改：'+$relative+'；拒绝清理。')}
                    if($entry.sha256 -and (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256){throw ('程序配置或文件摘要变化：'+$relative+'；拒绝清理。')}
                }
                $actual[$relative]=$true; $paths.Add($item.FullName)
            }
        }
    }
    if(-not $AllowMissing){
        foreach($entry in $Manifest.entries){if(-not $actual.ContainsKey([string]$entry.path)){throw ('程序解压不完整：'+$entry.path)}}
        foreach($directory in $Manifest.directories){if(-not $actualDirectories.ContainsKey([string]$directory)){throw ('程序目录解压不完整：'+$directory)}}
    }
    return ,$paths.ToArray()
}
function Delete-VerifiedTree([string]$Directory,$Manifest,[string]$Uninstaller=$UninstallerFilename) {
    # The exact absolute target and all children are checked before deletion.
    # Never follow reparse points, delete live data or launch another shell.
    $checked=Assert-AbsoluteProgramPath $Directory
    $files=Assert-Tree $checked $Manifest -AllowMissing -Uninstaller $Uninstaller
    foreach($file in $files){
        $attrs=[IO.File]::GetAttributes($file)
        if($attrs -band [IO.FileAttributes]::ReadOnly){[IO.File]::SetAttributes($file,$attrs -band (-bnot [IO.FileAttributes]::ReadOnly))}
    }
    [IO.Directory]::Delete($checked,$true)
    if(Test-Path -LiteralPath $checked){throw '程序文件尚未清理完成；不会报告卸载成功。'}
}
function Read-PreviousRecord([string]$Previous,[string]$Target) {
    $recordFile=Assert-AbsoluteProgramPath ($Previous+'.cleanup-record.json')
    if (-not (Test-Path -LiteralPath $recordFile)) { $recordFile=Join-Path $Previous $recordName }
    if((Get-Item -LiteralPath $recordFile).Length -gt 8MB){throw '升级回退记录过大。'}
    $record=Get-Content -LiteralPath $recordFile -Raw -Encoding UTF8|ConvertFrom-Json
    if($record.version -ne 1 -or [IO.Path]::GetFullPath([string]$record.target).TrimEnd('\') -ne $Target){throw '回退记录与目标目录不一致。'}
    Assert-Manifest $record.manifest
    return $record
}
try {
    $target=Assert-AbsoluteProgramPath $InstallRoot
    if((Get-Item -LiteralPath $ManifestFile).Length -gt 8MB -or
        (Get-FileHash -LiteralPath $ManifestFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ManifestSha256){throw '程序清单摘要不一致。'}
    $manifest=Get-Content -LiteralPath $ManifestFile -Raw -Encoding UTF8|ConvertFrom-Json; Assert-Manifest $manifest
    $previous=Assert-AbsoluteProgramPath ($target+'.previous-program')
    $cleanupRecord=Assert-AbsoluteProgramPath ($previous+'.cleanup-record.json')
    if([IO.Path]::GetDirectoryName($previous) -ne [IO.Path]::GetDirectoryName($target)){throw '升级目录不在同一父目录。'}
    switch($Action){
        'Publish' {
            $prepared=Assert-AbsoluteProgramPath $PreparedRoot
            if([IO.Path]::GetDirectoryName($prepared) -ne [IO.Path]::GetDirectoryName($target) -or
                -not [IO.Path]::GetFileName($prepared).StartsWith([IO.Path]::GetFileName($target)+'.preparing-',[StringComparison]::OrdinalIgnoreCase)){throw '程序必须在安装盘的独立暂存目录解压。'}
            $null=Assert-Tree $prepared $manifest
            if(Test-Path -LiteralPath $target){
                $remaining=@([IO.Directory]::GetFileSystemEntries($target))
                if($remaining|Where-Object{[IO.Path]::GetFileName($_) -ne 'uninstallerIcon.ico'}){throw '安装目录不是空目录；不会覆盖用户已有内容。'}
                if($remaining.Count){[IO.File]::Move((Join-Path $target 'uninstallerIcon.ico'),(Join-Path $prepared 'uninstallerIcon.ico'))}
                [IO.Directory]::Delete($target,$false)
            }
            [IO.Directory]::Move($prepared,$target)
            Write-InstallerMessage '程序已核验并以同盘目录切换完成；未再次复制整个程序。'
        }
        'Retire' {
            $null=Assert-Tree $target $manifest
            if(Test-Path -LiteralPath $previous){
                $old=Read-PreviousRecord $previous $target
                # A retried installation can clean a verified previous program,
                # never an arbitrary sibling directory or customer files.
                Delete-VerifiedTree $previous $old.manifest -Uninstaller $old.uninstaller
                [IO.File]::Delete($cleanupRecord)
            } elseif (Test-Path -LiteralPath $cleanupRecord) {
                $old=Read-PreviousRecord $previous $target
                if (-not $old.committed) { throw '回退记录缺少旧程序；未覆盖任何目录。' }
                [IO.File]::Delete($cleanupRecord)
            }
            [IO.Directory]::Move($target,$previous)
            try {
                $record=@{version=1;target=$target;manifest=$manifest;uninstaller=$UninstallerFilename;committed=$false}
                [IO.File]::WriteAllText((Join-Path $previous $recordName),($record|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
            }catch{[IO.Directory]::Move($previous,$target);throw}
            Write-InstallerMessage '旧程序已整体留存供本次升级回退；没有逐文件搬到临时盘。'
        }
        'Complete' {
            $null=Assert-Tree $target $manifest
            if(Test-Path -LiteralPath $previous){
                $old=Read-PreviousRecord $previous $target
                $old.committed=$true
                # Keep committed recovery metadata outside recursive cleanup:
                # a locked old file must not erase the manifest needed to retry.
                [IO.File]::WriteAllText($cleanupRecord,($old|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
                Delete-VerifiedTree $previous $old.manifest -Uninstaller $old.uninstaller
                [IO.File]::Delete($cleanupRecord)
                Write-InstallerMessage '升级已提交，旧程序清理完成；现场数据未变。'
            }
        }
        'Rollback' {
            if(-not (Test-Path -LiteralPath $previous)){
                if (Test-Path -LiteralPath $cleanupRecord) { throw '升级已提交并清理旧版；不能回退。' }
                exit 0
            }
            $failed=$null
            $old=Read-PreviousRecord $previous $target
            if($old.committed){throw '新版已提交；旧程序清理失败，不能恢复可能不完整的旧版。请重新安装修复。'}
            $null=Assert-Tree $previous $old.manifest -Uninstaller $old.uninstaller
            if(Test-Path -LiteralPath $target){
                $remaining=@([IO.Directory]::GetFileSystemEntries($target))
                if($remaining|Where-Object{[IO.Path]::GetFileName($_) -ne 'uninstallerIcon.ico'}){
                    $null=Assert-Tree $target $manifest
                    $failed=Assert-AbsoluteProgramPath ($target+'.failed-'+[Guid]::NewGuid().ToString('N'))
                    [IO.Directory]::Move($target,$failed)
                }else{
                    foreach($file in $remaining){[IO.File]::Delete($file)}
                    [IO.Directory]::Delete($target,$false)
                }
            }
            [IO.Directory]::Move($previous,$target)
            [IO.File]::Delete((Join-Path $target $recordName))
            if ($failed) {
                try { Delete-VerifiedTree $failed $manifest }
                catch { Write-InstallerMessage ('WARNING: 旧程序已恢复，但失败的新程序清理未完成：'+$failed+'；'+$_.Exception.Message) }
            }
            Write-InstallerMessage '已恢复完整旧程序；原现场数据和采集服务配置没有被删除。'
        }
        'Remove' {
            if(Test-Path -LiteralPath $previous){throw '存在未完成升级，先恢复或重新安装后再卸载；旧程序未删除。'}
            # A retry may see files already deleted by a failed prior cleanup;
            # every remaining file/directory still requires the exact manifest.
            if (Test-Path -LiteralPath $target) { $null=Assert-Tree $target $manifest -AllowMissing }
            if (Test-Path -LiteralPath $cleanupRecord) {
                $old=Read-PreviousRecord $previous $target
                if (-not $old.committed) { throw '存在未完成回退，拒绝卸载。' }
                [IO.File]::Delete($cleanupRecord)
            }
            if (Test-Path -LiteralPath $target) { Delete-VerifiedTree $target $manifest }
            Write-InstallerMessage '卸载程序文件已完成；独立采集服务和现场数据保留。'
        }
    }
    exit 0
}catch{Write-InstallerMessage ('ERROR: '+$_.Exception.Message);exit 1}
