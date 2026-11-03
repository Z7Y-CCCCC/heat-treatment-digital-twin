[CmdletBinding()]
param(
    [ValidateSet('Inspect','Install')][string]$Action='Inspect',
    [ValidateSet('All','WebView2','VCRedist')][string]$Component='All',
    [string]$RuntimeRoot='',
    [string]$ReportPath,
    [switch]$ProvisionDisplayLinks
)
if(-not $RuntimeRoot){$RuntimeRoot=Join-Path $PSScriptRoot 'resources\prerequisites'}
$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+(Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules')
$ProgressPreference='SilentlyContinue'
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Read-Value([string]$Key,[string]$Name) {
    $base=$null;$child=$null
    try {
        $hive=if($Key.StartsWith('HKLM:')){[Microsoft.Win32.RegistryHive]::LocalMachine}else{[Microsoft.Win32.RegistryHive]::CurrentUser}
        $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,[Microsoft.Win32.RegistryView]::Registry64)
        $child=$base.OpenSubKey($Key.Substring(6))
        if($child){$child.GetValue($Name)}
    } catch { $null } finally { if($child){$child.Dispose()};if($base){$base.Dispose()} }
}
function Inspect-Environment {
    $build=Read-Value 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' 'CurrentBuildNumber'
    $arch=if($env:PROCESSOR_ARCHITEW6432){$env:PROCESSOR_ARCHITEW6432}else{$env:PROCESSOR_ARCHITECTURE}
    $versions=@()
    foreach($prefix in @('HKLM:\SOFTWARE\WOW6432Node','HKLM:\SOFTWARE','HKCU:\SOFTWARE')) {
        $pv=Read-Value ($prefix+'\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}') 'pv'
        if($pv -and $pv -match '^\d+\.\d+') { $versions+=[version]$pv }
    }
    $web=($versions | Sort-Object -Descending | Select-Object -First 1)
    $vcKey='HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64'
    $vc=Read-Value $vcKey 'Version'
    $vcInstalled=(Read-Value $vcKey 'Installed') -eq 1
    [ordered]@{ build=[int]$build; architecture=$arch; supported=([int]$build -ge 17763 -and $arch -eq 'AMD64');
        webView2=[ordered]@{version=[string]$web;ready=($null -ne $web -and $web -ge [version]'120.0')};
        vcRedist=[ordered]@{version=[string]$vc;ready=($vcInstalled -and $vc -and [version]($vc.TrimStart('v')) -ge [version]'14.40')};
        observedAt=[DateTime]::UtcNow.ToString('o') }
}
function Install-VerifiedRuntime([string]$Name,[string]$Filename,[string[]]$Arguments) {
    $manifest=Get-Content -LiteralPath (Join-Path $RuntimeRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $expected=$manifest.files | Where-Object name -eq $Filename | Select-Object -First 1
    $file=Join-Path $RuntimeRoot $Filename
    if(-not $expected -or -not (Test-Path -LiteralPath $file)) { throw "缺少 $Name 离线安装文件，请重新下载安装包或从 Microsoft 官网安装该组件。" }
    if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $expected.sha256) { throw "$Name 文件校验失败，未执行。" }
    $signature=Get-AuthenticodeSignature -LiteralPath $file
    if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') { throw "$Name 的 Microsoft 数字签名验证失败，未执行。" }
    $admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $options=@{FilePath=$file;ArgumentList=$Arguments;PassThru=$true;WindowStyle='Hidden'}
    if(-not $admin){$options.Verb='RunAs'}
    $child=Start-Process @options
    if(-not $child.WaitForExit(240000)){throw "$Name 安装超时，请查看 Windows 安装日志后重试。"}
    if($child.ExitCode -eq 3010){return $true}
    if($child.ExitCode -notin @(0,1638)){throw "$Name 安装失败（$($child.ExitCode)），请从 Microsoft 官网修复后重试。"}
    return $false
}
function Prepare-DisplayLinkDirectory {
    # Only the alias container is shared; actual databases stay in userData.
    # Users can create their own child, not change another user's links. Keep
    # this separate from the optional service's administrator-owned directory.
    $root=Join-Path $env:ProgramData 'HeatTreatmentDigitalTwinDisplayLinks'
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true,$false)
    $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    foreach($sid in @('S-1-5-18','S-1-5-32-544')){
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl',$inherit,'None','Allow'))
    }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'ReadAndExecute,CreateDirectories','None','None','Allow'))
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-3-0'),'FullControl',$inherit,'InheritOnly','Allow'))
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    Set-Acl -LiteralPath $root -AclObject $acl
}
try {
    $before=Inspect-Environment
    $reboot=$false
    if($Action -eq 'Install') {
        if(-not $before.supported){throw '需要 Windows 10 1809 或更新版本 / Windows 11，且为 Intel/AMD x64 系统；不支持 32 位、ARM64 或 Windows S 模式。'}
        if($Component -in @('All','VCRedist') -and -not $before.vcRedist.ready){$reboot=(Install-VerifiedRuntime 'Visual C++ x64 运行库' 'vc_redist.x64.exe' @('/install','/quiet','/norestart')) -or $reboot}
        if($Component -in @('All','WebView2') -and -not $before.webView2.ready){$reboot=(Install-VerifiedRuntime 'WebView2 Runtime' 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe' @('/silent','/install')) -or $reboot}
        # Only the elevated installer provisions the shared alias container.
        # First-launch repair runs as the customer: its Microsoft child installer
        # may elevate, but this PowerShell process must not rewrite machine ACLs.
        if($ProvisionDisplayLinks){Prepare-DisplayLinkDirectory}
    }
    $result=Inspect-Environment
    $result.restartRequired=$reboot
    $result.success=$true
    if($Action -eq 'Install' -and -not $reboot -and ((($Component -in @('All','WebView2')) -and -not $result.webView2.ready) -or (($Component -in @('All','VCRedist')) -and -not $result.vcRedist.ready))) { throw '运行环境安装后仍未就绪，请重新启动 Windows 或联系管理员检查安装策略。' }
    $json=$result | ConvertTo-Json -Depth 5 -Compress
    if($ReportPath){[IO.File]::WriteAllText($ReportPath,$json,[Text.UTF8Encoding]::new($false))}
    [Console]::WriteLine($json)
    if($reboot){exit 3010}
    exit 0
} catch { [Console]::WriteLine((@{success=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress));exit 1 }
