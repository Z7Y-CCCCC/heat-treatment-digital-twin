[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $(if($env:ProgramW6432){$env:ProgramW6432}else{$env:ProgramFiles}) 'HeatTreatmentCollectorPlugin'),
    [string]$ImportDataDirectory = '',
    [switch]$ResumeImportedData,
    [switch]$SkipUserDataImport,
    [switch]$UsePreparedPayload,
    [switch]$NewEmptyData
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'installer-process.ps1')
Initialize-InstallerOutput
if($NewEmptyData -and ($ResumeImportedData -or $ImportDataDirectory)){throw '空白安装与显式迁移互斥；原工程不会被覆盖。'}
if($ResumeImportedData -and -not $ImportDataDirectory){throw '恢复导入必须明确提供原工程目录。'}
if($SkipUserDataImport){$ImportDataDirectory=''}
$source = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
$manifest = Get-Content -LiteralPath (Join-Path $source 'plugin-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.product -ne 'collector-plugin' -or $manifest.files.Count -lt 10) { throw '采集插件清单无效。' }
function Test-PluginFiles([string]$Root,[switch]$PayloadOnly) {
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $entries = @(Get-ChildItem -LiteralPath $Root -Force -Recurse)
    if ($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw '插件目录不能含链接。' }
    $allowed = @{}
    foreach ($entry in $manifest.files) {
        $file = [IO.Path]::GetFullPath((Join-Path $prefix $entry.path))
        if (-not $file.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or $entry.path -match '[:\\]') { throw '插件清单包含非法路径。' }
        $allowed[$entry.path] = $true
        if ($PayloadOnly -and -not (Test-Path -LiteralPath $file)) {
            if ($entry.path -in @('安装采集插件.cmd','Install-CollectorPlugin.ps1')) { continue }
            throw "缺少插件文件：$($entry.path)"
        }
        $item = Get-Item -LiteralPath $file
        if ($item.PSIsContainer -or $item.Length -ne $entry.size -or
            (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.sha256) { throw "插件文件校验失败：$($entry.path)" }
    }
    foreach ($entry in $entries | Where-Object { -not $_.PSIsContainer }) {
        $name = $entry.FullName.Substring($prefix.Length).Replace('\','/')
        if ($name -ne 'plugin-manifest.json' -and -not $allowed.ContainsKey($name)) { throw "未列入清单的插件文件：$name" }
    }
}
Test-PluginFiles $source
if (-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    # Capture the original user's APPDATA before elevation; never migrate the
    # administrator's unrelated account database by accident.
    foreach ($value in @($InstallRoot,$ImportDataDirectory,$PSCommandPath)) { if ($value.Contains('"')) { throw '路径含非法引号。' } }
    $elevatedArguments=@(
        '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"{0}"' -f $PSCommandPath),
        '-InstallRoot',('"{0}"' -f $InstallRoot))
    if(-not $SkipUserDataImport -and $ImportDataDirectory){$elevatedArguments+=@('-ImportDataDirectory',('"{0}"' -f $ImportDataDirectory))}
    if($ResumeImportedData){$elevatedArguments+='-ResumeImportedData'}
    if($SkipUserDataImport){$elevatedArguments+='-SkipUserDataImport'}
    if($NewEmptyData){$elevatedArguments+='-NewEmptyData'}
    if($UsePreparedPayload){$elevatedArguments+='-UsePreparedPayload'}
    $child = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList $elevatedArguments
    if ($child.ExitCode -ne 0) { throw '采集插件安装失败，原始数据保留。' }
    Write-Host '采集插件已安装。重新打开大屏即可连接。'
    exit 0
}
if (Get-Process -Name '热处理数字孪生大屏','HeatTreatmentDigitalTwin','HeatTreatmentAdminHost' -ErrorAction SilentlyContinue) {
    throw '请先保存并退出大屏和后台；没有停止采集服务。'
}
$target = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if(Get-CimInstance Win32_Process -Filter "Name='HeatTreatmentCollectorCenter.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase) }) {
    throw '升级已安装的采集程序前，请先关闭其运行中心；解压包中的运行中心不影响首次安装。'
}
if ((Test-Path -LiteralPath (Join-Path $target '热处理数字孪生大屏.exe')) -or ($target + '\').StartsWith($source,[StringComparison]::OrdinalIgnoreCase)) { throw '请使用独立插件安装目录。' }
if ($target -eq [IO.Path]::GetPathRoot($target).TrimEnd('\') -or ($source).StartsWith($target + '\',[StringComparison]::OrdinalIgnoreCase)) { throw '插件安装目录不能包含解压源目录或为磁盘根目录。' }
$staging = Get-CollectorPayloadStage $source $target -UsePreparedPayload:$UsePreparedPayload
if(-not $UsePreparedPayload){
    New-Item -ItemType Directory -Path $staging -ErrorAction Stop | Out-Null
    foreach ($name in @('resources','安装采集服务.ps1','installer-process.ps1','采集运行中心.cmd','collector-operations.ps1','README.md','plugin-manifest.json')) {
        Copy-Item -LiteralPath (Join-Path $source $name) -Destination $staging -Recurse
    }
    Test-PluginFiles $staging -PayloadOnly
}
# Direct use never bypasses Test-PluginFiles $source above: it publishes the
# exact, fully hashed administrator-owned directory rather than copying it again.
$configFile = Join-Path $env:ProgramData 'HeatTreatmentDigitalTwin\collector-service.json'
$previousConfig = if (Test-Path -LiteralPath $configFile) { [IO.File]::ReadAllBytes($configFile) } else { $null }
$previousService = Get-CimInstance Win32_Service -Filter "Name='HeatTreatmentCollector'"
$wasRunning = $previousService -and $previousService.State -eq 'Running'
if($ResumeImportedData) {
    if($previousConfig){throw '已有服务配置时无需恢复首次导入，请按正常升级流程执行。'}
    $imported=Join-Path $env:ProgramData 'HeatTreatmentDigitalTwin\collector\data'
    foreach($name in @('database-config.json','admin-security.json')){
        $a=Join-Path (Join-Path $ImportDataDirectory 'data') $name;$b=Join-Path $imported $name
        if(-not (Test-Path -LiteralPath $a) -or -not (Test-Path -LiteralPath $b) -or
            (Get-FileHash -LiteralPath $a -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $b -Algorithm SHA256).Hash){throw '已导入数据与原工程不一致，拒绝自动恢复；原数据均保留。'}
    }
}
if(-not $previousService) {
    $preflight = & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $staging '安装采集服务.ps1') -InstallRoot $staging -CheckOnly
    if($LASTEXITCODE -ne 0) { throw '独立采集包预检失败；未移动现有安装，未切换数据。' }
    if(-not ($preflight | ConvertFrom-Json).portAvailable) { throw '服务端口仍被其他程序占用，请先保存并退出旧大屏。没有强制关闭任何进程。' }
}
$backup = $null
try {
    if ($previousService -and $previousService.State -ne 'Stopped') {
        $service = Get-Service HeatTreatmentCollector
        Stop-InstallerService $service -TimeoutSeconds 60
    }
    if (Test-Path -LiteralPath $target) {
        $backup = $target + '.previous-' + [Guid]::NewGuid().ToString('N')
        Move-Item -LiteralPath $target -Destination $backup
    }
    Move-Item -LiteralPath $staging -Destination $target
    $runtimeScript=Join-Path $target 'resources\prerequisites\RuntimePrerequisites.ps1'
    if(Test-Path -LiteralPath $runtimeScript){
        $runtimeCode=Invoke-InstallerPowerShell $runtimeScript @('-Action','Install','-Component','VCRedist','-RuntimeRoot',(Join-Path $target 'resources\prerequisites'))
        if($runtimeCode -ne 0){throw '采集插件运行环境未就绪，请重启 Windows 或修复 Visual C++ x64 运行库后重试。'}
    }
    $arguments = @('-InstallRoot',$target)
    if($NewEmptyData){$arguments+='-NewEmptyData'}
    if (-not $SkipUserDataImport -and -not $previousConfig -and -not $ResumeImportedData -and $ImportDataDirectory -and (Test-Path -LiteralPath (Join-Path $ImportDataDirectory 'data\database-config.json'))) {
        $arguments += @('-ImportDataDirectory',$ImportDataDirectory)
    }
    $serviceCode=Invoke-InstallerPowerShell (Join-Path $target '安装采集服务.ps1') $arguments
    if ($serviceCode -ne 0) { throw "服务注册失败（$serviceCode）。" }
} catch {
    $failure = $_
    try {
        $newService = Get-Service HeatTreatmentCollector -ErrorAction SilentlyContinue
        if ($newService -and $newService.Status -ne 'Stopped') {
            Stop-InstallerService $newService -TimeoutSeconds 60
        }
        if ($backup -and (Test-Path -LiteralPath $backup)) {
            if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination ($target + '.failed-' + [Guid]::NewGuid().ToString('N')) }
            Move-Item -LiteralPath $backup -Destination $target
        }
        if ($previousConfig) { [IO.File]::WriteAllBytes($configFile,$previousConfig) }
        elseif (Test-Path -LiteralPath $configFile) { Remove-Item -LiteralPath $configFile }
        if ($previousService) {
            $current = Get-CimInstance Win32_Service -Filter "Name='HeatTreatmentCollector'"
            $result = Invoke-CimMethod -InputObject $current -MethodName Change -Arguments @{PathName=$previousService.PathName}
            if ($result.ReturnValue -ne 0) { throw '无法恢复原服务路径。' }
            if ($wasRunning) { $restored=Get-Service HeatTreatmentCollector; Start-InstallerService $restored -TimeoutSeconds 900 }
        } elseif ($newService) { & "$env:SystemRoot\System32\sc.exe" delete HeatTreatmentCollector | Out-Null }
    } catch { Write-Warning "自动恢复未完成，请保留日志和旧目录：$($_.Exception.Message)" }
    throw $failure
}
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('CommonDesktopDirectory'),[Environment]::GetFolderPath('CommonPrograms'))) {
    $shortcut = $shell.CreateShortcut((Join-Path $folder '采集运行中心.lnk'))
    $shortcut.TargetPath = Join-Path $target 'resources\collector-center\HeatTreatmentCollectorCenter.exe'
    $shortcut.Save()
}
Write-Host "采集插件已安装：$target。原数据和升级前目录均保留。"
