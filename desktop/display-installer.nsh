!include "getProcessInfo.nsh"
!include "nsDialogs.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!include "MUI2.nsh"
!define DISPLAY_PREFLIGHT_SOURCE "${__FILEDIR__}\display-install-preflight.ps1"
Var pid
SetFont "Microsoft YaHei UI" 9
!ifndef BUILD_UNINSTALLER
Var runtimeNeedsReboot
!endif
!define MUI_BGCOLOR "FFFFFF"
!define MUI_TEXTCOLOR "29364B"
!define MUI_INSTFILESPAGE_PROGRESSBAR "colored"
!define MUI_FINISHPAGE_NOREBOOTSUPPORT
!include "${__FILEDIR__}\display-installer-ui.nsh"

!macro customHeader
  ShowInstDetails hide
  ; Loaded after the language files: their old SimSun default must not replace
  ; the UI font. SetFont before MUI_LANGUAGE is silently overridden by the NLF.
  SetFont /LANG=2052 "Microsoft YaHei UI" 9
  SetFont /LANG=1033 "Microsoft YaHei UI" 9
!macroend

!macro customWelcomePage
  Page custom DisplaySettingsPage DisplaySettingsLeave
!macroend

!macro customInit
  SetRegView 64
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  ${If} $0 < 17763
    MessageBox MB_ICONSTOP "需要 Windows 10 1809 或更新版本 / Windows 11（Intel/AMD x64）。请更新 Windows 后再安装。"
    Abort
  ${EndIf}
  ${IfNot} ${IsNativeAMD64}
    MessageBox MB_ICONSTOP "本安装包仅支持 Intel/AMD x64 系统，不支持 32 位或 ARM64。"
    Abort
  ${EndIf}
  StrCpy $runtimeNeedsReboot "0"
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW DisplayInstallingShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE DisplayInstallingLeave
!macroend

!macro customInstall
  SendMessage $mui.InstFilesPage.Text ${WM_SETTEXT} 0 "STR:准备 Microsoft 运行环境"
  DetailPrint "正在检查 WebView2 和 Visual C++ 运行环境…"
  nsExec::ExecToStack /TIMEOUT=510000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\prerequisites\RuntimePrerequisites.ps1" -Action Install -ProvisionDisplayLinks -RuntimeRoot "$INSTDIR\resources\prerequisites" -ReportPath "$TEMP\HeatTreatmentDigitalTwin-runtime-setup.json"`
  Pop $0
  Pop $1
  ${If} $0 == 3010
    StrCpy $runtimeNeedsReboot "1"
    DetailPrint "运行环境已安装，需要重新启动 Windows；不会自动重启电脑。"
  ${ElseIf} $0 != 0
    MessageBox MB_ICONSTOP "运行环境尚未就绪，未启动大屏。$\r$\n$1$\r$\n可重新运行安装程序，或从 Microsoft 官网安装 WebView2 / Visual C++ x64 运行库。"
    Abort
  ${EndIf}
!macroend

!macro customFinishPage
  Function StartPreparedApp
    ${If} $runtimeNeedsReboot == "1"
      MessageBox MB_ICONINFORMATION "请先重新启动 Windows，再从桌面打开大屏。安装程序不会自动重启电脑。"
      Return
    ${EndIf}
    !ifndef DISPLAY_UI_PREVIEW
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
    !else
      ; The fixture reports the launch action without starting any application.
      SetErrorLevel 73
    !endif
  FunctionEnd
  Page custom DisplayFinishPage DisplayFinishLeave
!macroend
!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  ; The display installer never installs/stops/removes a collector. Refuse an
  ; in-place upgrade of the old bundled service until its independent plugin
  ; has been migrated, rather than deleting binaries under a running service.
  InitPluginsDir
  File /oname=$PLUGINSDIR\display-install-preflight.ps1 "${DISPLAY_PREFLIGHT_SOURCE}"
  nsExec::ExecToStack /TIMEOUT=20000 `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\display-install-preflight.ps1" -InstallRoot "$INSTDIR"`
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "$1"
    Abort
  ${EndIf}
  !insertmacro _CHECK_APP_RUNNING
!macroend
