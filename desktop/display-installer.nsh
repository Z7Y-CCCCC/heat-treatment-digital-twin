!include "getProcessInfo.nsh"
!include "nsDialogs.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!define DISPLAY_PREFLIGHT_SOURCE "${__FILEDIR__}\display-install-preflight.ps1"
Var pid
SetFont "Microsoft YaHei UI" 9
!ifndef BUILD_UNINSTALLER
Var runtimeNeedsReboot
!endif
!define MUI_BGCOLOR "F8F9FD"
!define MUI_TEXTCOLOR "29364B"
!define MUI_INSTFILESPAGE_PROGRESSBAR "colored"
!define MUI_FINISHPAGE_NOREBOOTSUPPORT
!include "MUI2.nsh"

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "生产现场，从这里开始"
  !define MUI_WELCOMEPAGE_TEXT "热处理数字孪生大屏$\r$\n实时大屏 · 后台管理 · 外部接口$\r$\n$\r$\n安装向导将检查并准备所需的 Microsoft 运行环境。$\r$\n$\r$\nPLC 数据采集为独立可选插件，不会随本程序自动安装。"
  !insertmacro MUI_PAGE_WELCOME
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
  Page custom DisplayReadyPage
!macroend
!ifndef BUILD_UNINSTALLER
Function DisplayReadyPage
  !insertmacro MUI_HEADER_TEXT "准备安装" "确认安装内容和运行环境"
  nsDialogs::Create 1018
  Pop $0
  SetCtlColors $0 "29364B" "F8F9FD"
  ${NSD_CreateLabel} 4u 4u 290u 20u "热处理数字孪生大屏"
  Pop $0
  SetCtlColors $0 "29364B" "F8F9FD"
  CreateFont $1 "Microsoft YaHei UI" 13 600
  SendMessage $0 ${WM_SETFONT} $1 1
  ${NSD_CreateLabel} 4u 34u 290u 24u "安装位置：$INSTDIR"
  Pop $0
  SetCtlColors $0 "29364B" "F8F9FD"
  ${NSD_CreateLabel} 4u 66u 290u 22u "运行环境    自动检查，缺少时使用随包离线安装程序"
  Pop $0
  SetCtlColors $0 "29364B" "F8F9FD"
  ${NSD_CreateLabel} 4u 98u 290u 22u "数据采集    独立可选插件，本次不安装"
  Pop $0
  SetCtlColors $0 "29364B" "F8F9FD"
  ${NSD_CreateLabel} 4u 130u 290u 28u "已有工程和账户将保留；不会修改防火墙或关闭系统防护。"
  Pop $0
  SetCtlColors $0 "69788D" "F8F9FD"
  nsDialogs::Show
FunctionEnd
!endif

!macro customInstall
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
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  FunctionEnd
  !define MUI_FINISHPAGE_TITLE "现场已准备就绪"
  !define MUI_FINISHPAGE_TEXT "程序安装完成。$\r$\n$\r$\n首次打开后完成授权，再创建或登录账户。$\r$\n$\r$\n工程数据独立保存，后续升级不会覆盖。"
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "启动大屏"
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartPreparedApp"
  !insertmacro MUI_PAGE_FINISH
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
