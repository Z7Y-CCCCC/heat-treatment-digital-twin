[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('status','logs','install','start','stop','restart')][string]$Action,
    [ValidatePattern('^HeatTreatmentOps-[a-f0-9]{48}$')][string]$PipeName
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$serviceName = 'HeatTreatmentCollector'
$machine = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'HeatTreatmentDigitalTwin'
$configFile = Join-Path $machine 'collector-service.json'
function Read-Config {
    if (-not (Test-Path -LiteralPath $configFile)) { return $null }
    $c = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$c.port -lt 1024 -or [int]$c.port -gt 65535) { throw '服务配置端口无效' }
    if (-not [IO.Path]::IsPathRooted([string]$c.root)) { throw '服务数据目录必须是绝对路径' }
    return $c
}
function Read-Service {
    $s = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    $c = $null; $configError = $null
    try { $c = Read-Config } catch { $configError = $_.Exception.Message }
    return @{ installed=($null -ne $s); name=$serviceName; state=$(if($s){$s.Status.ToString()}else{'not_installed'});
        port=$(if($c){[int]$c.port}else{3001}); root=$(if($c){[string]$c.root}else{$null});
        configError=$configError; configPresent=($null -ne $c) }
}
function Audit([string]$Outcome) {
    try {
        $c=Read-Config
        if($c) {
            $logs=Join-Path ([string]$c.root) 'logs'
            foreach($directory in @([string]$c.root,$logs)) {
                if((Test-Path -LiteralPath $directory) -and ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                    throw '拒绝读取链接数据目录'
                }
            }
            New-Item -ItemType Directory -Force -Path $logs | Out-Null
            $file=Join-Path $logs 'operations.log'
            if((Test-Path -LiteralPath $file) -and (Get-Item -LiteralPath $file).Length -gt 1MB) {
                Move-Item -LiteralPath $file -Destination "$file.previous" -Force
            }
            $entry=@{timestamp=[DateTime]::UtcNow.ToString('o');level='INFO';component='service-control';action=$Action;
                outcome=$Outcome;user=[Security.Principal.WindowsIdentity]::GetCurrent().Name} | ConvertTo-Json -Compress
            [IO.File]::AppendAllText($file,$entry+"`n",[Text.UTF8Encoding]::new($false))
        }
    } catch { } # Never hide the original operation result because audit storage is unavailable.
}
$result=$null
try {
    if ($Action -eq 'status') { $result=@{success=$true;service=(Read-Service)} }
    elseif ($Action -eq 'logs') {
        $c=Read-Config; $files=@()
        if($c) {
            $logs=Join-Path ([string]$c.root) 'logs'
            foreach($name in @('service-host.log','backend.log','backend-error.log','operations.log')) {
                $file=Join-Path $logs $name
                if(-not (Test-Path -LiteralPath $file)) { continue }
                # Only four fixed filenames; no recursive collection, configs, DB or arbitrary paths.
                if((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '拒绝读取链接日志文件' }
                $stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
                try {
                    $count=[int][Math]::Min(131072,$stream.Length); $bytes=New-Object byte[] $count
                    $offset=$stream.Length-$count; [void]$stream.Seek($offset,[IO.SeekOrigin]::Begin)
                    $read=0
                    while($read -lt $count) { $n=$stream.Read($bytes,$read,$count-$read); if($n -eq 0){break}; $read+=$n }
                    $text=[Text.Encoding]::UTF8.GetString($bytes,0,$read)
                    if($offset -gt 0) { $line=$text.IndexOf("`n"); $text=$(if($line -ge 0){$text.Substring($line+1)}else{''}) }
                    $files+=@{name=$name;text=$text}
                } finally { $stream.Dispose() }
            }
        }
        $result=@{success=$true;files=$files;capturedAt=[DateTime]::UtcNow.ToString('o')}
    } else {
        $admin=([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        if(-not $admin) { throw '服务操作需要 Windows 管理员授权' }
        if($Action -eq 'install') {
            & (Join-Path $PSScriptRoot '安装采集服务.ps1') -InstallRoot $PSScriptRoot | Out-Null
        } else {
            $s=Get-Service -Name $serviceName -ErrorAction Stop
            if($Action -in @('stop','restart') -and $s.Status -ne 'Stopped') {
                Stop-Service -Name $serviceName -ErrorAction Stop
                $s.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped,[TimeSpan]::FromSeconds(60))
            }
            if($Action -in @('start','restart')) {
                if($s.Status -ne 'Running') { Start-Service -Name $serviceName -ErrorAction Stop }
                $s.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(60))
            }
        }
        Audit 'success'
        $result=@{success=$true;service=(Read-Service);action=$Action}
    }
} catch {
    if($Action -in @('install','start','stop','restart')) { Audit 'failed' }
    $result=@{success=$false;error=$_.Exception.Message}
}
$json=$result | ConvertTo-Json -Depth 12 -Compress
if($PipeName) {
    $pipe=[IO.Pipes.NamedPipeClientStream]::new('.',$PipeName,[IO.Pipes.PipeDirection]::Out)
    try {
        $pipe.Connect(10000)
        $bytes=[Text.Encoding]::UTF8.GetBytes($json)
        $pipe.Write($bytes,0,$bytes.Length); $pipe.Flush()
    } finally { $pipe.Dispose() }
} else { [Console]::WriteLine($json) }
