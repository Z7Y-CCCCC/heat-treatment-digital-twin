param(
    [Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
    [Parameter(Mandatory=$true)][string]$Report
)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$Executable = [IO.Path]::GetFullPath($Executable)
$Report = [IO.Path]::GetFullPath($Report)
$actual = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $ExpectedSha256.ToLowerInvariant()) { throw 'Installer startup input SHA-256 mismatch' }

# Open the actual, unchanged EXE. Only its first settings page is inspected;
# NEVER send Next, /S or an install command. RunAsInvoker is confined to this
# child process to test the UI without requesting elevation or installing.
$stage = Join-Path ([IO.Path]::GetTempPath()) ('installer-startup-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
$target = Join-Path $stage 'NeverInstalled'
$previous = @{}
foreach ($key in @('__COMPAT_LAYER','TEMP','TMP')) { $previous[$key] = [Environment]::GetEnvironmentVariable($key,'Process') }
$child = $null
$handle = [IntPtr]::Zero
$timer = [Diagnostics.Stopwatch]::StartNew()
$evidence = [ordered]@{ success=$false; sha256=$actual; realExecutable=$true; installed=$false; elevationRequested=$false; nextClicked=$false }
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;using System.Collections.Generic;
public static class InstallerStartupNative {
 public delegate bool EnumProc(IntPtr h,IntPtr l);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn,IntPtr l);
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h,EnumProc fn,IntPtr l);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder text,int count);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder text,int count);
 [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h,int id);
 [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,int msg,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int mode);
 public static string Text(IntPtr h){var text=new StringBuilder(2048);GetWindowText(h,text,text.Capacity);return text.ToString();}
 public static IntPtr[] Dialogs(int pid){var result=new List<IntPtr>();EnumWindows((h,l)=>{uint owner;GetWindowThreadProcessId(h,out owner);var name=new StringBuilder(256);GetClassName(h,name,name.Capacity);if(owner==pid && name.ToString()=="#32770")result.Add(h);return true;},IntPtr.Zero);return result.ToArray();}
 public static string[] Texts(IntPtr h){var result=new List<string>();result.Add(Text(h));EnumChildWindows(h,(c,l)=>{var text=Text(c);if(text.Length>0)result.Add(text);return true;},IntPtr.Zero);return result.ToArray();}
}
'@
try {
    [Environment]::SetEnvironmentVariable('__COMPAT_LAYER','RunAsInvoker','Process')
    [Environment]::SetEnvironmentVariable('TEMP',$stage,'Process')
    [Environment]::SetEnvironmentVariable('TMP',$stage,'Process')
    # /D is last and deliberately unquoted, as required by NSIS. It confines
    # even .onInit's SetOutPath to our owned temporary folder.
    $child = Start-Process -FilePath $Executable -ArgumentList ('/D=' + $target) -WorkingDirectory $stage -WindowStyle Hidden -PassThru
    foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key,$previous[$key],'Process') }
    $texts = @()
    for ($i=0; $i -lt 600; $i++) {
        if ($child.HasExited) { throw "Installer exited before settings became ready (exit $($child.ExitCode))" }
        foreach ($window in [InstallerStartupNative]::Dialogs($child.Id)) {
            [InstallerStartupNative]::ShowWindow($window,0) | Out-Null
            $texts = @([InstallerStartupNative]::Texts($window))
            if ($texts -match '初始化失败|Error launching installer|Installer integrity check has failed|already running') { throw ('Installer startup error: ' + ($texts -join ' | ')) }
            $primary = [InstallerStartupNative]::GetDlgItem($window,1)
            if ([InstallerStartupNative]::Text($primary) -eq '下一步' -and [InstallerStartupNative]::IsWindowEnabled($primary) -and $texts -match '^自定义安装$' -and $texts -match '^自动配置运行环境') {
                $handle = $window
                break
            }
        }
        if ($handle -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 100
    }
    if ($handle -eq [IntPtr]::Zero) { throw ('Actual installer settings page did not become ready: ' + ($texts -join ' | ')) }
    # Keep pumping native window messages after Attach. A dangling DLL subclass
    # (e.g. accidental ?u) must not pass merely because one caption appeared.
    Start-Sleep -Milliseconds 500
    if ($child.HasExited) { throw 'Installer crashed after native chrome initialization' }
    $evidence['settingsReady'] = $true
    $evidence['texts'] = $texts
    $evidence['processId'] = $child.Id
    [InstallerStartupNative]::PostMessage($handle,0x10,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
    if (-not $child.WaitForExit(5000)) { throw 'Closing the settings page did not exit the installer' }
    if ($child.ExitCode -ne 1) { throw "Unexpected cancellation exit code: $($child.ExitCode)" }
    $evidence['exitCode'] = $child.ExitCode
    $evidence['success'] = $true
} catch {
    $evidence['error'] = $_.Exception.Message
    throw
} finally {
    foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key,$previous[$key],'Process') }
    if ($child -and -not $child.HasExited) { Stop-Process -Id $child.Id -Force }
    $timer.Stop()
    $evidence['seconds'] = [Math]::Round($timer.Elapsed.TotalSeconds,3)
    New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($Report)) | Out-Null
    $evidence | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Report -Encoding UTF8
    # Delete only this invocation's owned stage, never an install/data folder.
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    $resolved = [IO.Path]::GetFullPath($stage)
    if (-not $resolved.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^installer-startup-[a-f0-9]{32}$') { throw 'Unsafe installer startup cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
$evidence | ConvertTo-Json -Depth 5
