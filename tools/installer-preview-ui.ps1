param([Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$env:PSModulePath=Join-Path $PSHOME 'Modules'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Drawing
Add-Type @'
using System;using System.Runtime.InteropServices;
public static class SetupPreviewNative {
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int mode);
 [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h,int id);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,int msg,IntPtr w,IntPtr l);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,System.Text.StringBuilder text,int max);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,System.Text.StringBuilder text,int max);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h,EnumProc p,IntPtr l);
 public static string[] Texts(IntPtr h){var list=new System.Collections.Generic.List<string>();EnumChildWindows(h,(c,l)=>{var text=new System.Text.StringBuilder(2048);GetWindowText(c,text,2048);if(text.Length>0)list.Add(text.ToString());return true;},IntPtr.Zero);return list.ToArray();}
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
 $handle=[IntPtr]::Zero
 for($i=0;$i -lt 100;$i++){ $handle=[SetupPreviewNative]::Find($child.Id);if($handle -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 100 }
 if($handle -eq [IntPtr]::Zero){throw 'Installer preview window did not open'}
 [SetupPreviewNative]::SetWindowPos($handle,[IntPtr]::Zero,-10000,-10000,0,0,0x15)|Out-Null
 $null=[SetupPreviewNative]::ShowWindow($handle,4)
 $window=[Windows.Automation.AutomationElement]::FromHandle($handle)
 function Capture([string]$Name){
  $rect=New-Object SetupPreviewNative+Rect;[SetupPreviewNative]::GetWindowRect($handle,[ref]$rect)|Out-Null
  $bitmap=New-Object Drawing.Bitmap(($rect.Right-$rect.Left),($rect.Bottom-$rect.Top));$graphics=[Drawing.Graphics]::FromImage($bitmap);$dc=$graphics.GetHdc()
  try{[SetupPreviewNative]::PrintWindow($handle,$dc,2)|Out-Null}finally{$graphics.ReleaseHdc($dc);$graphics.Dispose()}
  $bitmap.Save((Join-Path $OutputDirectory $Name),[Drawing.Imaging.ImageFormat]::Png);$bitmap.Dispose()
 }
 function Click([string]$Id){
  $button=[SetupPreviewNative]::GetDlgItem($handle,[int]$Id)
  if($button -eq [IntPtr]::Zero){throw "Missing installer button $Id"}
  $null=[SetupPreviewNative]::PostMessage($button,0xF5,[IntPtr]::Zero,[IntPtr]::Zero);Start-Sleep -Milliseconds 600
 }
 Start-Sleep -Milliseconds 500;Capture '01-welcome.png';Click '1';Capture '02-directory.png';Click '1';Capture '03-ready.png'
 $texts=[SetupPreviewNative]::Texts($handle)
 if(-not ($texts -match '独立可选插件')){throw 'Ready page is missing the optional collector explanation'}
 $result=@{success=$true;nativeNSIS=$true;installed=$false;screenshots=@('01-welcome.png','02-directory.png','03-ready.png');texts=$texts}
 $result|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $OutputDirectory 'result.json') -Encoding UTF8
} finally { if(-not $child.HasExited){Stop-Process -Id $child.Id -Force} }
