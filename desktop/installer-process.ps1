# Shared, streaming process boundary for Windows PowerShell 5.1 / NSIS.
# Children always emit UTF-8; only the outer nsExec boundary emits UTF-16LE.
function Initialize-InstallerOutput([switch]$ForNsis) {
    # A PowerShell 7 parent can leave an incompatible module search path.
    # Installer children use the Windows PowerShell 5.1 system manifests.
    $modulePaths = @((Join-Path $PSHOME 'Modules'))
    if ($env:ProgramFiles) { $modulePaths += Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules' }
    $env:PSModulePath = $modulePaths -join ';'
    $script:InstallerClock = [Diagnostics.Stopwatch]::StartNew()
    $script:ProgressPreference = 'SilentlyContinue'
    $global:OutputEncoding = [Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    if ($ForNsis) {
        [Console]::OutputEncoding = [Text.Encoding]::Unicode
        # Legacy nsExec treats a BOM-only pipe write as ANSI (it has no NUL).
        # Emit BOM and an ASCII-led UTF-16 line together, never a bare BOM.
        [Console]::WriteLine(([string][char]0xFEFF) + '[+0.0s] 安装诊断日志（UTF-16LE）')
    }
}
function Write-InstallerMessage([string]$Message) {
    $elapsed = if ($script:InstallerClock) { $script:InstallerClock.Elapsed.TotalSeconds } else { 0 }
    [Console]::WriteLine(('[+{0:F1}s] {1}' -f $elapsed, $Message))
}
function ConvertTo-InstallerArgument([string]$Value) {
    # CommandLineToArgvW quoting, including quotes and terminal backslashes.
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}
function Get-InstallerPowerShell {
    $native = Join-Path $env:SystemRoot 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'
    if ([IntPtr]::Size -eq 4 -and (Test-Path -LiteralPath $native)) { return $native }
    return Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
}
function Get-InstallerNativeEncoding {
    # sc.exe / icacls.exe use the Windows OEM page, not the UTF-8 contract of
    # our PowerShell children. Decode at that one boundary, then emit Unicode.
    if (-not ('InstallerNativeCodePage' -as [type])) {
        Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class InstallerNativeCodePage { [DllImport("kernel32.dll")] public static extern uint GetOEMCP(); }'
    }
    return [Text.Encoding]::GetEncoding([int][InstallerNativeCodePage]::GetOEMCP())
}
function Invoke-InstallerProcess {
    param([Parameter(Mandatory=$true)][string]$FilePath,
        [string[]]$ArgumentList = @(), [ValidateRange(1,3600)][int]$TimeoutSeconds = 1200,
        [switch]$NativeOutput)
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $FilePath
    $info.Arguments = ($ArgumentList | ForEach-Object { ConvertTo-InstallerArgument $_ }) -join ' '
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $textEncoding = if ($NativeOutput) { Get-InstallerNativeEncoding } else { [Text.UTF8Encoding]::new($false) }
    $info.StandardOutputEncoding = $textEncoding
    $info.StandardErrorEncoding = $textEncoding
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $info
    $clock = [Diagnostics.Stopwatch]::StartNew(); $lastProgress = 0
    try {
        if (-not $process.Start()) { throw '子进程未能启动。' }
        $stdout = $process.StandardOutput.ReadLineAsync(); $stderr = $process.StandardError.ReadLineAsync()
        $outDone = $false; $errDone = $false
        while (-not ($outDone -and $errDone -and $process.HasExited)) {
            $drained = 0
            while (-not $outDone -and $stdout.IsCompleted -and $drained -lt 128) {
                $line = $stdout.GetAwaiter().GetResult()
                if ($null -eq $line) { $outDone = $true } else {
                    Write-InstallerMessage $line; $stdout = $process.StandardOutput.ReadLineAsync()
                }
                $drained++
            }
            while (-not $errDone -and $stderr.IsCompleted -and $drained -lt 256) {
                $line = $stderr.GetAwaiter().GetResult()
                if ($null -eq $line) { $errDone = $true } else {
                    Write-InstallerMessage ('stderr: ' + $line); $stderr = $process.StandardError.ReadLineAsync()
                }
                $drained++
            }
            if ($clock.Elapsed.TotalSeconds -gt $TimeoutSeconds) {
                # Only this helper's child is owned here; never kill SCM/PLC/MySQL.
                if (-not $process.HasExited) { $process.Kill() }
                throw ('安装子进程超过 {0} 秒；请保留日志。' -f $TimeoutSeconds)
            }
            if ($clock.Elapsed.TotalSeconds - $lastProgress -ge 10) {
                Write-InstallerMessage ('系统步骤仍在执行，已等待 {0:F0} 秒。' -f $clock.Elapsed.TotalSeconds)
                $lastProgress = $clock.Elapsed.TotalSeconds
            }
            # Drain completed lines in batches: never add 50 ms per log line.
            if ($drained -eq 0) { Start-Sleep -Milliseconds 25 }
        }
        $process.WaitForExit()
        return $process.ExitCode
    } finally { $process.Dispose() }
}
function Invoke-InstallerPowerShell([string]$Script, [string[]]$ScriptArguments = @(), [int]$TimeoutSeconds = 1200) {
    return Invoke-InstallerProcess -FilePath (Get-InstallerPowerShell) -ArgumentList (@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$Script) + $ScriptArguments) -TimeoutSeconds $TimeoutSeconds
}
function Wait-InstallerServiceStatus {
    param([Parameter(Mandatory=$true)]$Controller,
        [ValidateSet('Running','Stopped')][string]$Target, [int]$TimeoutSeconds)
    $clock = [Diagnostics.Stopwatch]::StartNew(); $nextProgress = 0
    do {
        $Controller.Refresh()
        if ($Controller.Status.ToString() -eq $Target) { return }
        if ($Target -eq 'Running' -and $Controller.Status.ToString() -eq 'Stopped' -and $clock.Elapsed.TotalSeconds -ge 1) {
            throw '采集服务在就绪前停止；请查看 service-host.log，不会报告安装成功。'
        }
        if ($clock.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw ('采集服务等待 {0} 超时（{1} 秒）。' -f $Target,$TimeoutSeconds) }
        if ($clock.Elapsed.TotalSeconds -ge $nextProgress) {
            Write-InstallerMessage ('采集服务状态 {0}，等待 {1}，已用 {2:F0} 秒。' -f $Controller.Status,$Target,$clock.Elapsed.TotalSeconds)
            $nextProgress += 5
        }
        Start-Sleep -Milliseconds 250
    } while ($true)
}

function Stop-InstallerService($Controller, [int]$TimeoutSeconds = 60) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $Controller.Refresh()
    if ($Controller.Status.ToString() -eq 'StartPending') {
        Wait-InstallerServiceStatus $Controller -Target Running -TimeoutSeconds $TimeoutSeconds
        $Controller.Refresh()
    }
    if ($Controller.Status.ToString() -notin @('Stopped','StopPending')) { $Controller.Stop() }
    $remaining = [Math]::Max(0, $TimeoutSeconds - [int][Math]::Floor($clock.Elapsed.TotalSeconds))
    Wait-InstallerServiceStatus $Controller -Target Stopped -TimeoutSeconds $remaining
}
function Start-InstallerService($Controller, [int]$TimeoutSeconds = 900) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $Controller.Refresh()
    if ($Controller.Status.ToString() -eq 'StopPending') {
        Wait-InstallerServiceStatus $Controller -Target Stopped -TimeoutSeconds $TimeoutSeconds
        $Controller.Refresh()
    }
    if ($Controller.Status.ToString() -eq 'Paused') { $Controller.Continue() }
    elseif ($Controller.Status.ToString() -notin @('Running','StartPending','ContinuePending')) { $Controller.Start() }
    $remaining = [Math]::Max(0, $TimeoutSeconds - [int][Math]::Floor($clock.Elapsed.TotalSeconds))
    Wait-InstallerServiceStatus $Controller -Target Running -TimeoutSeconds $remaining
}

function Assert-InstallerProgramDirectory([string]$Value) {
    if ($Value -notmatch '^[a-zA-Z]:[\\/]') { throw '程序目录必须为本机绝对路径。' }
    $full=[IO.Path]::GetFullPath($Value).TrimEnd('\')
    foreach($root in @([IO.Path]::GetPathRoot($full),$env:SystemRoot,$env:ProgramFiles,${env:ProgramFiles(x86)},$env:ProgramW6432,$env:ProgramData,$env:USERPROFILE)) {
        if($root -and $full -eq [IO.Path]::GetFullPath($root).TrimEnd('\')) { throw '拒绝把系统、用户或数据根目录当作程序目录。' }
    }
    if(Test-Path -LiteralPath (Join-Path $full '.git')) { throw '拒绝把源码工作区当作程序目录。' }
    $ancestor=$full
    while($ancestor) {
        if(Test-Path -LiteralPath (Join-Path $ancestor '.git')) { throw '拒绝操作源码工作区及其子目录。' }
        if(Test-Path -LiteralPath $ancestor){
            if((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '程序目录及父目录不能为链接或重解析点。' }
        }
        $parent=[IO.Path]::GetDirectoryName($ancestor)
        if($parent -eq $ancestor){break};$ancestor=$parent
    }
    $config=Join-Path $env:ProgramData 'HeatTreatmentDigitalTwin\collector-service.json'
    if(Test-Path -LiteralPath $config) {
        $existing=Get-Content -LiteralPath $config -Encoding UTF8 -Raw|ConvertFrom-Json
        if($existing.root) {
            $data=[IO.Path]::GetFullPath([string]$existing.root).TrimEnd('\')
            if(($data+'\').StartsWith($full+'\',[StringComparison]::OrdinalIgnoreCase) -or
                ($full+'\').StartsWith($data+'\',[StringComparison]::OrdinalIgnoreCase)) { throw '程序目录与现场数据重叠，拒绝移动。' }
        }
    }
    return $full
}
function Get-CollectorPayloadStage([string]$SourceRoot,[string]$InstallRoot,[switch]$UsePreparedPayload) {
    $source=[IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
    $target=Assert-InstallerProgramDirectory $InstallRoot
    if ($UsePreparedPayload) {
        $source=Assert-InstallerProgramDirectory $source
        if ([IO.Path]::GetDirectoryName($source) -ne [IO.Path]::GetDirectoryName($target) -or
            [IO.Path]::GetFileName($source) -notmatch '^HeatTreatmentCollectorPayload-[a-f0-9]{32}$') {
            throw '直接安装只接受已核验的同盘插件暂存目录，不接受下载目录或其他路径。'
        }
        $item=Get-Item -LiteralPath $source
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '插件暂存目录不能为链接。' }
        return $source
    }
    return $target + '.preparing-' + [Guid]::NewGuid().ToString('N')
}
function Resolve-CollectorDataRoot([string]$MachineDirectory,[string]$RequestedRoot,[string]$ExistingRoot,[switch]$NewEmptyData) {
    $machine=[IO.Path]::GetFullPath($MachineDirectory).TrimEnd('\')
    $selected=if ($NewEmptyData) { Join-Path $machine ('collector-empty-'+[Guid]::NewGuid().ToString('N')) }
        elseif ($ExistingRoot) { $ExistingRoot } else { $RequestedRoot }
    # Without a service configuration this is a fresh install, not an implicit
    # restore of an orphaned ProgramData directory left by an old uninstall.
    if (-not $ExistingRoot -and (Test-Path -LiteralPath $selected)) {
        $selected = Join-Path $machine ('collector-empty-' + [Guid]::NewGuid().ToString('N'))
    }
    $resolved=[IO.Path]::GetFullPath($selected)
    if ($resolved.TrimEnd('\') -eq [IO.Path]::GetPathRoot($resolved).TrimEnd('\')) { throw '服务数据目录不能是磁盘根目录。' }
    if ($NewEmptyData -and ([IO.Path]::GetDirectoryName($resolved) -ne $machine -or (Test-Path -LiteralPath $resolved))) {
        throw '空白现场目录必须为明确新建的机器级目录，不能覆盖旧工程。'
    }
    return $resolved
}
