[CmdletBinding()]
param(
    [string]$InstallRoot = $PSScriptRoot,
    [ValidateRange(1024,65535)][int]$Port = 3001,
    [string]$DataRoot = (Join-Path $env:ProgramData 'HeatTreatmentDigitalTwin\collector'),
    [string]$ImportDataDirectory,
    [switch]$Uninstall,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
if($CheckOnly -and $Uninstall) { throw '预检不能同时执行卸载。' }
$serviceName = 'HeatTreatmentCollector'
if ($Uninstall -and -not $CheckOnly -and -not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '安装、移除采集服务需要管理员权限；请以管理员身份运行本脚本。'
}
$installDirectory = (Resolve-Path -LiteralPath $InstallRoot).Path
$machineDirectory = Join-Path $env:ProgramData 'HeatTreatmentDigitalTwin'
$configFile = Join-Path $machineDirectory 'collector-service.json'
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
function Invoke-ServiceCommand([string[]]$Arguments) {
    & "$env:SystemRoot\System32\sc.exe" @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Windows 服务配置失败（$LASTEXITCODE）" }
}
if ($Uninstall) {
    if ($service -and $service.Status -ne 'Stopped') {
        Stop-Service -Name $serviceName -ErrorAction Stop
        $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(60))
    }
    if ($service) { Invoke-ServiceCommand @('delete', $serviceName) }
    Write-Host "已移除采集服务；现场数据保留在 $DataRoot，未删除。"
    exit 0
}
$resourcesDirectory = Join-Path $installDirectory 'resources'
$distributionFile = Join-Path $resourcesDirectory 'backend\distribution.json'
if(-not (Test-Path -LiteralPath $distributionFile) -or
    (Get-Content -LiteralPath $distributionFile -Raw -Encoding UTF8 | ConvertFrom-Json).product -ne 'collector-plugin') {
    throw '这里是大屏程序或不完整的开发缓存，不能安装采集服务。请从完整独立采集运行中心包安装。'
}
$hostExe = Join-Path $resourcesDirectory 'collector-service\HeatTreatmentCollector.exe'
foreach ($required in @($hostExe, (Join-Path $resourcesDirectory 'collector-service\worker.cjs'),
    (Join-Path $resourcesDirectory 'runtime\node.exe'), (Join-Path $resourcesDirectory 'backend-dependencies.tar'),
    (Join-Path $resourcesDirectory 'backend\server.js'), (Join-Path $resourcesDirectory 'templates\factory-template.db'),
    (Join-Path $resourcesDirectory 'mysql\bin\mysqld.exe'))) {
    if (-not (Test-Path -LiteralPath $required)) { throw "缺少服务运行资源：$required" }
}
if (Test-Path -LiteralPath $configFile) {
    $existing = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $DataRoot = [string]$existing.root
    $Port = [int]$existing.port
}
$dataDirectory = [IO.Path]::GetFullPath($DataRoot)
if ($dataDirectory -eq [IO.Path]::GetPathRoot($dataDirectory)) { throw '服务数据目录不能是磁盘根目录。' }
$probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
$portAvailable=$true
try { $probe.Start() } catch { $portAvailable=$false } finally { $probe.Stop() }
if($CheckOnly) {
    [ordered]@{ resourcesReady=$true;serviceInstalled=($null-ne $service);port=$Port;portAvailable=$portAvailable;dataRoot=$dataDirectory;requiresAdministrator=$true } | ConvertTo-Json -Compress
    exit 0
}
if(-not $service -and -not $portAvailable) { throw "端口 $Port 正由其他程序使用。请先保存并退出旧大屏，不能并行启动第二个采集器。" }
if ($ImportDataDirectory) {
    $source = (Resolve-Path -LiteralPath $ImportDataDirectory).Path
    if((Test-Path -LiteralPath $dataDirectory) -and (Get-ChildItem -LiteralPath $dataDirectory -Force | Select-Object -First 1)) { throw '服务数据目录已有内容，拒绝覆盖；迁移请使用后台整站恢复。' }
    $sourcePrefix=$source.TrimEnd('\')+'\'
    if(Get-CimInstance Win32_Process -Filter "Name='mysqld.exe' OR Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($sourcePrefix,[StringComparison]::OrdinalIgnoreCase)-ge 0 }) {
        throw '原工程数据库仍在运行。请保存并退出旧大屏，不能复制活动中的数据库。'
    }
}
if (-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '安装采集服务需要 Windows 管理员授权。' }
# Validate resources and configuration before stopping a working installation.
if ($service -and $service.Status -ne 'Stopped') {
    Stop-Service -Name $serviceName -ErrorAction Stop
    $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(60))
}
$probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
try { $probe.Start() } catch { throw "端口 $Port 已被占用，未注册新服务。请先处理端口冲突。" } finally { $probe.Stop() }
New-Item -ItemType Directory -Force -Path $machineDirectory, $dataDirectory | Out-Null
if ($ImportDataDirectory) {
    $source = (Resolve-Path -LiteralPath $ImportDataDirectory).Path
    if (Get-ChildItem -LiteralPath $dataDirectory -Force | Select-Object -First 1) {
        throw '服务数据目录已有内容，拒绝覆盖；迁移请使用后台整站恢复。'
    }
    $runningDesktop = Get-Process -Name '热处理数字孪生大屏', 'HeatTreatmentDigitalTwin', 'HeatTreatmentAdminHost' -ErrorAction SilentlyContinue
    if ($runningDesktop) { throw '迁移前请完全退出旧软件，不能复制正在使用的数据库。' }
    foreach ($name in @('data', 'uploads', 'mysql', 'machine-identity.json', 'machine-identity.json.bak', 'machine-identity.json.hardware')) {
        $sourcePath = Join-Path $source $name
        if (Test-Path -LiteralPath $sourcePath) { Copy-Item -LiteralPath $sourcePath -Destination $dataDirectory -Recurse }
    }
    # Older display builds stored their installation anchor at machine level.
    # Preserve it (including hardware fallback) when moving to the service.
    foreach ($name in @('machine-identity.json','machine-identity.json.bak','machine-identity.json.hardware')) {
        $legacy = Join-Path $machineDirectory $name
        $destination = Join-Path $dataDirectory $name
        if (-not (Test-Path -LiteralPath $destination) -and (Test-Path -LiteralPath $legacy)) { Copy-Item -LiteralPath $legacy -Destination $destination }
    }
    # Rewrite only paths owned by this app; external database settings remain intact.
    $databaseConfigFile = Join-Path $dataDirectory 'data\database-config.json'
    if (Test-Path -LiteralPath $databaseConfigFile) {
        $databaseConfig = Get-Content -LiteralPath $databaseConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($databaseConfig.type -eq 'sqlite' -or $databaseConfig.managedBy -eq 'desktop-mysql') {
            $databaseConfig.filename = Join-Path $dataDirectory 'data\factory.db'
            [IO.File]::WriteAllText($databaseConfigFile, ($databaseConfig | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
        }
    }
}
$configuration = [ordered]@{ version = 1; serviceName = $serviceName; root = $dataDirectory;
    resourcesRoot = $resourcesDirectory; port = $Port; backendOrigin = "http://127.0.0.1:$Port" }
# Write UTF-8 without BOM so Node and Windows clients use the same contract.
$temporaryConfig = "$configFile.tmp"
[IO.File]::WriteAllText($temporaryConfig, ($configuration | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporaryConfig -Destination $configFile -Force
$binaryPath = '"{0}" --config "{1}"' -f $hostExe, $configFile
if (-not $service) {
    New-Service -Name $serviceName -BinaryPathName $binaryPath -DisplayName '热处理数字孪生 · PLC采集服务' -StartupType Automatic |
        Out-Null
} else {
    # Win32_Service avoids native-shell quoting corruption for Chinese paths.
    $instance = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    $changed = Invoke-CimMethod -InputObject $instance -MethodName Change -Arguments @{PathName=$binaryPath;StartMode='Automatic'}
    if ($changed.ReturnValue -ne 0) { throw "更新服务路径失败：$($changed.ReturnValue)" }
}
Invoke-ServiceCommand @('config', $serviceName, 'obj=', 'NT AUTHORITY\LocalService')
Invoke-ServiceCommand @('sidtype', $serviceName, 'unrestricted')
Invoke-ServiceCommand @('description', $serviceName, '开机即运行 PLC 只读采集、数据存储和接口，无需登录桌面；Unity退出不停止采集。')
Invoke-ServiceCommand @('failure', $serviceName, 'reset=', '86400', 'actions=', 'restart/5000/restart/15000/restart/60000')
Invoke-ServiceCommand @('failureflag', $serviceName, '1')
if (-not [Diagnostics.EventLog]::SourceExists($serviceName)) {
    New-EventLog -LogName Application -Source $serviceName
}
# Service metadata is machine-owned. A standard desktop user can discover
# its port, but cannot redirect a later elevated diagnostics read elsewhere.
$security = [Security.AccessControl.DirectorySecurity]::new()
$security.SetAccessRuleProtection($true,$false)
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagate = [Security.AccessControl.PropagationFlags]::None
foreach($sid in @('S-1-5-18','S-1-5-32-544')) {
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),
        [Security.AccessControl.FileSystemRights]::FullControl,$inherit,$propagate,[Security.AccessControl.AccessControlType]::Allow))
}
$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),
    [Security.AccessControl.FileSystemRights]::ReadAndExecute,$inherit,$propagate,[Security.AccessControl.AccessControlType]::Allow))
$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.NTAccount]::new("NT SERVICE\$serviceName"),
    [Security.AccessControl.FileSystemRights]::ReadAndExecute,$inherit,$propagate,[Security.AccessControl.AccessControlType]::Allow))
$security.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
Set-Acl -LiteralPath $machineDirectory -AclObject $security
$serviceGrant = 'NT SERVICE\{0}:(OI)(CI)M' -f $serviceName
& "$env:SystemRoot\System32\icacls.exe" $dataDirectory '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' $serviceGrant
if ($LASTEXITCODE -ne 0) { throw '无法设置服务数据目录权限。' }
$linksDirectory = Join-Path $machineDirectory 'mysql-links'
New-Item -ItemType Directory -Force -Path $linksDirectory | Out-Null
& "$env:SystemRoot\System32\icacls.exe" $linksDirectory '/grant:r' $serviceGrant
if ($LASTEXITCODE -ne 0) { throw '无法设置 MySQL 兼容路径权限。' }
Start-Service -Name $serviceName
$readyDeadline = (Get-Date).AddMinutes(15)
do {
    try {
        $health = Invoke-RestMethod -Uri "$($configuration.backendOrigin)/api/health" -TimeoutSec 3
        if ($health.status -eq 'ok' -and $health.db.connected -eq $true -and $health.runtime.role -eq 'collector' -and $health.runtime.owner -eq 'windows-service' -and $health.runtime.serviceName -eq $serviceName) { break }
    } catch { }
    if ((Get-Date) -gt $readyDeadline) { throw "采集服务启动超时，请查看 $dataDirectory\logs" }
    Start-Sleep -Seconds 1
} while ($true)
Write-Host "采集服务已安装并设置为开机自动启动：$($configuration.backendOrigin)"
Write-Host "现场数据：$dataDirectory；退出 Unity 不会停止采集服务。"
