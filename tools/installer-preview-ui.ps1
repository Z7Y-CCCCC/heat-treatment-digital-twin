param([Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][string]$OutputDirectory,[ValidateSet('normal','reboot','failure','cancel')][string]$Scenario='normal',[switch]$CaptureSurface)
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
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h,int msg,IntPtr w,string text);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,System.Text.StringBuilder text,int max);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,System.Text.StringBuilder text,int max);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h,EnumProc p,IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 public static string[] Controls(IntPtr h){var list=new System.Collections.Generic.List<string>();EnumChildWindows(h,(c,l)=>{var t=new System.Text.StringBuilder(2048);GetWindowText(c,t,2048);Rect r;GetWindowRect(c,out r);list.Add(c+"|"+IsWindowVisible(c)+"|"+r.Left+","+r.Top+","+r.Right+","+r.Bottom+"|"+t);return true;},IntPtr.Zero);return list.ToArray();}
 public static string[] Texts(IntPtr h){var list=new System.Collections.Generic.List<string>();EnumChildWindows(h,(c,l)=>{var text=new System.Text.StringBuilder(2048);GetWindowText(c,text,2048);if(text.Length>0)list.Add(text.ToString());return true;},IntPtr.Zero);return list.ToArray();}
 public static string Text(IntPtr h){var text=new System.Text.StringBuilder(2048);GetWindowText(h,text,2048);return text.ToString();}
 public static IntPtr Edit(IntPtr h){IntPtr found=IntPtr.Zero;EnumChildWindows(h,(c,l)=>{var cls=new System.Text.StringBuilder(100);GetClassName(c,cls,100);if(cls.ToString()=="Edit" && IsWindowVisible(c)){found=c;return false;}return true;},IntPtr.Zero);return found;}
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
  $edit=[SetupPreviewNative]::Edit($handle);if($edit -eq [IntPtr]::Zero){throw 'Missing editable installation path'}
  $original=[SetupPreviewNative]::Text($edit)
  foreach($invalid in @('relative-path','C:\',$env:WINDIR,(Join-Path $env:WINDIR 'System32'))){
   [SetupPreviewNative]::SendMessage($edit,0xC,[IntPtr]::Zero,$invalid)|Out-Null;Click '1'
   if([SetupPreviewNative]::Text([SetupPreviewNative]::GetDlgItem($handle,1037)) -ne '热处理数字孪生大屏'){throw "Invalid path entered installation: $invalid"}
   if(-not ([SetupPreviewNative]::Texts($handle) -match '请选择|请不要|请为')){throw "Missing inline validation for $invalid"}
   $pathChecks+=@{path=$invalid;blocked=$true}
  }
  [SetupPreviewNative]::SendMessage($edit,0xC,[IntPtr]::Zero,$original)|Out-Null
 }
 Click '1';Capture '02-installing.png'
 if([SetupPreviewNative]::Text([SetupPreviewNative]::GetDlgItem($handle,1037)) -eq '热处理数字孪生大屏'){
  throw ('Installation did not start: '+([SetupPreviewNative]::Texts($handle) -join ' | '))
 }
 for($i=0;$i -lt 200;$i++){
  $heading=[SetupPreviewNative]::Text([SetupPreviewNative]::GetDlgItem($handle,1037))
  if($heading -match '安装完成|安装未完成'){break};Start-Sleep -Milliseconds 100
 }
 Capture '03-result.png'
 $texts=[SetupPreviewNative]::Texts($handle)
 $texts|Set-Content -LiteralPath (Join-Path $OutputDirectory 'final-texts.txt') -Encoding UTF8
 if($Scenario -eq 'normal' -and -not ($texts -match '大屏已准备就绪')){throw 'Missing successful completion page'}
 if($Scenario -eq 'reboot' -and -not ($texts -match '安装完成，请重启电脑')){throw 'Missing reboot-required completion page'}
 if($Scenario -eq 'reboot' -and ($texts -match '^启动热处理')){throw 'Reboot-required page must not offer launching the app'}
 if($Scenario -eq 'failure' -and ($heading -ne '安装未完成')){throw 'Failure did not remain on an error page'}
 if($Scenario -eq 'failure'){Click '2'}else{Click '1'}
 if(-not $child.WaitForExit(5000)){throw 'Finish/Close did not exit the preview'}
 if($Scenario -eq 'normal' -and $child.ExitCode -ne 73){throw 'The launch checkbox did not invoke the no-op launch fixture'}
 if($Scenario -ne 'normal' -and $child.ExitCode -eq 73){throw 'App launch was attempted after failure or required reboot'}
 $result=@{success=$true;scenario=$Scenario;nativeNSIS=$true;installed=$false;exitCode=$child.ExitCode;pathChecks=$pathChecks;screenshots=@('01-settings.png','02-installing.png','03-result.png');texts=$texts}
 $result|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $OutputDirectory 'result.json') -Encoding UTF8
} finally { if(-not $child.HasExited){Stop-Process -Id $child.Id -Force} }
