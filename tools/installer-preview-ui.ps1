param([Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][string]$OutputDirectory,[ValidateSet('normal','reboot','failure','cancel','progress-cancel')][string]$Scenario='normal',[switch]$CaptureSurface)
$ErrorActionPreference='Stop'
$Executable=[IO.Path]::GetFullPath($Executable)
$previewRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/installer-preview'))+[IO.Path]::DirectorySeparatorChar
if(-not $Executable.StartsWith($previewRoot,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($Executable) -ne 'InstallerPreview.exe'){throw 'Only the isolated UI fixture may run; never pass a real installer'}
$source=Get-Content -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($Executable)) 'preview.nsi') -Raw
if($source -notmatch '!define DISPLAY_UI_PREVIEW' -or $source -match '(?im)^\s*(WriteReg\w*|Exec\w*|File\s|CreateDirectory\s|!insertmacro customInstall)'){throw 'Unsafe operations in preview source'}
New-Item -ItemType Directory -Path $OutputDirectory -Force|Out-Null
$env:PSModulePath=Join-Path $PSHOME 'Modules'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;using System.Runtime.InteropServices;
public static class SetupPreviewNative {
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int mode);
 [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h,int id);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,int msg,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll",EntryPoint="SendMessageW")] public static extern IntPtr SendNumber(IntPtr h,int msg,IntPtr w,IntPtr l);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h,int msg,IntPtr w,string text);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,System.Text.StringBuilder text,int max);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,System.Text.StringBuilder text,int max);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h,EnumProc p,IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h,int index);
 public static string[] Controls(IntPtr h){var list=new System.Collections.Generic.List<string>();EnumChildWindows(h,(c,l)=>{var t=new System.Text.StringBuilder(2048);GetWindowText(c,t,2048);Rect r;GetWindowRect(c,out r);list.Add(c+"|"+IsWindowVisible(c)+"|"+r.Left+","+r.Top+","+r.Right+","+r.Bottom+"|"+t);return true;},IntPtr.Zero);return list.ToArray();}
 public static string[] Texts(IntPtr h){var list=new System.Collections.Generic.List<string>();EnumChildWindows(h,(c,l)=>{var text=new System.Text.StringBuilder(2048);GetWindowText(c,text,2048);if(text.Length>0)list.Add(text.ToString());return true;},IntPtr.Zero);return list.ToArray();}
 public static string[] VisibleTexts(IntPtr h){var list=new System.Collections.Generic.List<string>();EnumChildWindows(h,(c,l)=>{if(!IsWindowVisible(c))return true;var text=new System.Text.StringBuilder(2048);GetWindowText(c,text,2048);if(text.Length>0)list.Add(text.ToString());return true;},IntPtr.Zero);return list.ToArray();}
 public static string Text(IntPtr h){var text=new System.Text.StringBuilder(2048);GetWindowText(h,text,2048);return text.ToString();}
 public static IntPtr FindId(IntPtr h,int id){IntPtr found=IntPtr.Zero;EnumChildWindows(h,(c,l)=>{if(GetDlgCtrlID(c)==id){found=c;return false;}return true;},IntPtr.Zero);return found;}
 public static IntPtr Edit(IntPtr h){IntPtr found=IntPtr.Zero;EnumChildWindows(h,(c,l)=>{var cls=new System.Text.StringBuilder(100);GetClassName(c,cls,100);if(cls.ToString()=="Edit" && IsWindowVisible(c)){found=c;return false;}return true;},IntPtr.Zero);return found;}
 public static IntPtr CustomToggle(IntPtr h){
  IntPtr found=IntPtr.Zero;
  EnumChildWindows(h,(c,l)=>{
   if(!IsWindowVisible(c) || !IsWindowEnabled(c))return true;
   var cls=new System.Text.StringBuilder(100);GetClassName(c,cls,100);
   if(!String.Equals(cls.ToString(),"Button",StringComparison.OrdinalIgnoreCase) || (GetWindowLongW(c,-16)&0xf)!=0xb)return true;
   var text=Text(c);
   if(text.StartsWith("自定义安装",StringComparison.Ordinal) || text.StartsWith("收起设置",StringComparison.Ordinal)){found=c;return false;}
   return true;
  },IntPtr.Zero);
  return found;
 }
 public static bool ClickCustomToggle(IntPtr root){
  var link=CustomToggle(root);if(link==IntPtr.Zero)return false;
  var parent=GetParent(link);var id=GetDlgCtrlID(link);
  if(parent==IntPtr.Zero || parent==root || id<0)return false;
  // nsDialogs LINK is an owner-draw BUTTON. Its child dialog dispatches
  // BN_CLICKED using the actual generated control ID, not the root's ID 1/2.
  return PostMessage(parent,0x111,new IntPtr(id & 0xffff),link);
 }
 public delegate bool EnumProc(IntPtr h,IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p,IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int z,uint flags);
 public struct Rect {public int Left,Top,Right,Bottom;}
 public static IntPtr Find(int pid){IntPtr found=IntPtr.Zero;EnumWindows((h,l)=>{uint p;GetWindowThreadProcessId(h,out p);Rect r;GetWindowRect(h,out r);var cls=new System.Text.StringBuilder(100);GetClassName(h,cls,100);if(p==pid && cls.ToString()=="#32770" && r.Right-r.Left>350 && r.Bottom-r.Top>200){found=h;return false;}return true;},IntPtr.Zero);return found;}
}
'@
$child=Start-Process -FilePath $Executable -WindowStyle Hidden -PassThru
try {
 Start-Sleep -Milliseconds 1600
 $handle=[IntPtr]::Zero
 for($i=0;$i -lt 100;$i++){ $handle=[SetupPreviewNative]::Find($child.Id);if($handle -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 100 }
 if($handle -eq [IntPtr]::Zero){throw 'Installer preview window did not open'}
 [SetupPreviewNative]::SetWindowPos($handle,[IntPtr]1,40,40,0,0,0x11)|Out-Null
 $null=[SetupPreviewNative]::ShowWindow($handle,4)
 function Capture([string]$Name){
  $rect=New-Object SetupPreviewNative+Rect;[SetupPreviewNative]::GetWindowRect($handle,[ref]$rect)|Out-Null
  $bitmap=New-Object Drawing.Bitmap(($rect.Right-$rect.Left),($rect.Bottom-$rect.Top));$graphics=[Drawing.Graphics]::FromImage($bitmap);$dc=$graphics.GetHdc()
  try{[SetupPreviewNative]::PrintWindow($handle,$dc,0)|Out-Null}finally{$graphics.ReleaseHdc($dc);$graphics.Dispose()}
  $bitmap.Save((Join-Path $OutputDirectory $Name),[Drawing.Imaging.ImageFormat]::Png);$bitmap.Dispose()
  if($CaptureSurface){
   [SetupPreviewNative]::SetWindowPos($handle,[IntPtr](-1),40,40,0,0,0x11)|Out-Null;Start-Sleep -Milliseconds 300
   $b=New-Object Drawing.Bitmap(($rect.Right-$rect.Left),($rect.Bottom-$rect.Top));$g=[Drawing.Graphics]::FromImage($b)
   try{$g.CopyFromScreen(40,40,0,0,$b.Size);$b.Save((Join-Path $OutputDirectory ('surface-'+$Name)),[Drawing.Imaging.ImageFormat]::Png)}finally{$g.Dispose();$b.Dispose();[SetupPreviewNative]::SetWindowPos($handle,[IntPtr](-2),40,40,0,0,0x11)|Out-Null;[SetupPreviewNative]::SetWindowPos($handle,[IntPtr]1,40,40,0,0,0x11)|Out-Null}
  }
 }
 function Click([string]$Id){
  $button=[SetupPreviewNative]::GetDlgItem($handle,[int]$Id)
  if($button -eq [IntPtr]::Zero){throw "Missing installer button $Id"}
  for($n=0;$n -lt 50;$n++){if([SetupPreviewNative]::IsWindowEnabled($button) -and [SetupPreviewNative]::IsWindowVisible($button)){break};Start-Sleep -Milliseconds 100}
  if(-not [SetupPreviewNative]::IsWindowEnabled($button) -or -not [SetupPreviewNative]::IsWindowVisible($button)){throw "Installer action $Id is not available"}
  # Deliver the native BN_CLICKED command without activating a background
  # window. BM_CLICK can silently fail for an inactive dialog (Win32 contract).
  $null=[SetupPreviewNative]::PostMessage($handle,0x111,[IntPtr]([int]$Id),$button);Start-Sleep -Milliseconds 600
 }
 function Set-CustomExpanded([bool]$Expanded){
  $toggle=[SetupPreviewNative]::CustomToggle($handle)
  if($toggle -eq [IntPtr]::Zero){throw 'Missing visible custom-install toggle'}
  $caption=[SetupPreviewNative]::Text($toggle)
  $actualExpanded=$caption.StartsWith('收起设置',[StringComparison]::Ordinal)
  if($actualExpanded -ne $Expanded){
   if(-not [SetupPreviewNative]::ClickCustomToggle($handle)){throw 'Custom-install link notification was not delivered to its child dialog'}
  }
  for($n=0;$n -lt 50;$n++){
   $caption=[SetupPreviewNative]::Text($toggle)
   $editable=[SetupPreviewNative]::Edit($handle) -ne [IntPtr]::Zero
   if($caption.StartsWith('收起设置',[StringComparison]::Ordinal) -eq $Expanded -and $editable -eq $Expanded){return}
   Start-Sleep -Milliseconds 100
  }
  throw 'Custom-install expansion state was not confirmed'
 }
 Start-Sleep -Milliseconds 500
 [SetupPreviewNative]::Controls($handle)|Set-Content -LiteralPath (Join-Path $OutputDirectory 'settings-controls.txt') -Encoding UTF8
 Capture '01-settings.png'
 $pathChecks=@()
 if($Scenario -eq 'cancel'){
  $null=[SetupPreviewNative]::PostMessage($handle,0x10,[IntPtr]::Zero,[IntPtr]::Zero)
  if(-not $child.WaitForExit(5000)){throw 'Close did not cancel the setup page'}
  @{success=$true;scenario='cancel';installed=$false;exitCode=$child.ExitCode}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $OutputDirectory 'cancel-result.json') -Encoding UTF8
  return
 }
 if($Scenario -eq 'normal'){
  Set-CustomExpanded $true
  $edit=[SetupPreviewNative]::Edit($handle);if($edit -eq [IntPtr]::Zero){throw 'Missing editable installation path'}
  $original=[SetupPreviewNative]::Text($edit)
  foreach($invalid in @('relative-path','C:\',$env:WINDIR,(Join-Path $env:WINDIR 'System32'))){
   foreach($collapsed in @($false,$true)){
    Set-CustomExpanded $true
    $edit=[SetupPreviewNative]::Edit($handle)
    [SetupPreviewNative]::SendMessage($edit,0xC,[IntPtr]::Zero,$invalid)|Out-Null
    if($collapsed){Set-CustomExpanded $false}
    Click '1'
    # WM_COMMAND/nsDialogs validation can finish after the posted command on a
    # busy build host. Wait for the REQUIRED visible error/editable state, not
    # a fixed sleep; never treat a hidden label or a page transition as success.
    for($validationWait=0;$validationWait -lt 50;$validationWait++){
     $visibleErrors=[SetupPreviewNative]::VisibleTexts($handle)|Where-Object {$_ -match '^请选择|^请不要|^请为|^安装位置|^安装路径'}
     if($visibleErrors -and [SetupPreviewNative]::Edit($handle) -ne [IntPtr]::Zero){break}
     Start-Sleep -Milliseconds 100
    }
    if([SetupPreviewNative]::Text([SetupPreviewNative]::GetDlgItem($handle,1037)) -ne '热处理数字孪生大屏'){throw "Invalid path entered installation: $invalid"}
    $visibleErrors=[SetupPreviewNative]::VisibleTexts($handle)|Where-Object {$_ -match '^请选择|^请不要|^请为|^安装位置|^安装路径'}
    if(-not $visibleErrors){throw "Missing visible inline validation for $invalid (collapsed=$collapsed)"}
    if([SetupPreviewNative]::Edit($handle) -eq [IntPtr]::Zero){throw "Rejected path settings remained collapsed: $invalid"}
    $pathChecks+=@{path=$invalid;collapsedBeforeSubmit=$collapsed;blocked=$true;visibleError=$true;settingsEditable=$true}
   }
  }
  [SetupPreviewNative]::SendMessage($edit,0xC,[IntPtr]::Zero,$original)|Out-Null
  Set-CustomExpanded $false
 }
 # Production has an offline collector-selection page between settings and work.
 Click '1'
 if([SetupPreviewNative]::Text([SetupPreviewNative]::GetDlgItem($handle,1)) -ne '开始安装'){throw 'Missing collector selection page'}
 Click '1';Capture '02-installing.png'
 if([SetupPreviewNative]::Text([SetupPreviewNative]::GetDlgItem($handle,1037)) -eq '热处理数字孪生大屏'){
  throw ('Installation did not start: '+([SetupPreviewNative]::Texts($handle) -join ' | '))
 }
 foreach($id in @(1240,1241)){
  $button=[SetupPreviewNative]::GetDlgItem($handle,$id)
  if(-not [SetupPreviewNative]::IsWindowVisible($button) -or -not [SetupPreviewNative]::IsWindowEnabled($button)){throw "Header button $id disappeared during installation"}
 }
 $details=[SetupPreviewNative]::FindId($handle,1016)
 if(-not [SetupPreviewNative]::IsWindowVisible($details) -or [SetupPreviewNative]::SendNumber($details,0x1004,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -lt 1){throw 'Installation details are empty or hidden'}
 Click '1240'
 if(-not [SetupPreviewNative]::IsIconic($handle)){throw 'Minimize did not minimize the actual window'}
 [SetupPreviewNative]::ShowWindow($handle,9)|Out-Null
 if($Scenario -eq 'progress-cancel'){Click '1241'}
 for($i=0;$i -lt 300;$i++){
  $heading=[SetupPreviewNative]::Text([SetupPreviewNative]::GetDlgItem($handle,1037))
  if($heading -match '安装完成|安装未完成'){break};Start-Sleep -Milliseconds 100
 }
 Capture '03-result.png'
 $texts=[SetupPreviewNative]::Texts($handle)
 $texts|Set-Content -LiteralPath (Join-Path $OutputDirectory 'final-texts.txt') -Encoding UTF8
 if($Scenario -eq 'normal' -and -not ($texts -match '大屏已准备就绪')){throw 'Missing successful completion page'}
 if($Scenario -eq 'reboot' -and -not ($texts -match '安装完成，请重启电脑')){throw 'Missing reboot-required completion page'}
 if($Scenario -eq 'reboot' -and ($texts -match '^启动热处理')){throw 'Reboot-required page must not offer launching the app'}
 if($Scenario -in @('failure','progress-cancel') -and ($heading -ne '安装未完成')){throw 'Failure did not remain on an error page'}
 if($Scenario -in @('failure','progress-cancel')){
  $logLabel=[SetupPreviewNative]::Text([SetupPreviewNative]::FindId($handle,1230))
  if($logLabel -notmatch '日志：(.+)$'){throw 'Missing persistent log path'}
  $logPath=$Matches[1];$log=Get-Content -LiteralPath $logPath -Raw -Encoding UTF8
  if($Scenario -eq 'failure' -and ($log -notmatch '中文错误详情不会丢失' -or $log -notmatch '1603')){throw 'Failure output was lost or incorrectly decoded'}
  if($Scenario -eq 'progress-cancel' -and $log -notmatch '安装已取消'){throw 'Cancellation was not recorded'}
  Start-Sleep -Milliseconds 1000
  if(-not ([SetupPreviewNative]::VisibleTexts($handle)|Where-Object {$_ -match '1603|安装已取消'})){throw 'Error text vanished after completion'}
  Click '1241'
 }else{Click '1'}
 if(-not $child.WaitForExit(5000)){throw 'Finish/Close did not exit the preview'}
 if($Scenario -eq 'normal' -and $child.ExitCode -ne 73){throw 'The launch checkbox did not invoke the no-op launch fixture'}
 if($Scenario -ne 'normal' -and $child.ExitCode -eq 73){throw 'App launch was attempted after failure or required reboot'}
 $result=@{success=$true;scenario=$Scenario;nativeNSIS=$true;installed=$false;exitCode=$child.ExitCode;pathChecks=$pathChecks;screenshots=@('01-settings.png','02-installing.png','03-result.png');texts=$texts}
 $result|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $OutputDirectory 'result.json') -Encoding UTF8
} catch {
 if($handle -ne [IntPtr]::Zero -and -not $child.HasExited){
  [SetupPreviewNative]::Controls($handle)|Set-Content -LiteralPath (Join-Path $OutputDirectory 'failure-controls.txt') -Encoding UTF8
  Capture 'failure.png'
 }
 throw
} finally { if(-not $child.HasExited){Stop-Process -Id $child.Id -Force} }
