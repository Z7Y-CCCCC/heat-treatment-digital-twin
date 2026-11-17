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
!include "${__FILEDIR__}\collector-installer.nsh"

!macro customHeader
  ShowInstDetails show
  ; Loaded after the language files: their old SimSun default must not replace
  ; the UI font. SetFont before MUI_LANGUAGE is silently overridden by the NLF.
  SetFont /LANG=2052 "Microsoft YaHei UI" 9
  SetFont /LANG=1033 "Microsoft YaHei UI" 9
!macroend

!macro customWelcomePage
  Page custom DisplaySettingsPage DisplaySettingsLeave
  Page custom CollectorChoicePage CollectorChoiceLeave
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
  Call CollectorChoiceInit
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW DisplayInstallingShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE DisplayInstallingLeave
!macroend

!macro customInstall
  Call DisplayCheckCancel
  !insertmacro DisplayStage "准备 Microsoft 运行环境"
  DetailPrint "正在检查 WebView2 和 Visual C++ 运行环境…"
  nsExec::ExecToLog /TIMEOUT=510000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\prerequisites\RuntimePrerequisites.ps1" -Action Install -ProvisionDisplayLinks -InstallerLog -RuntimeRoot "$INSTDIR\resources\prerequisites" -ReportPath "$TEMP\HeatTreatmentDigitalTwin-runtime-setup.json"`
  Pop $0
  ${If} $0 == 3010
    StrCpy $runtimeNeedsReboot "1"
    DetailPrint "运行环境已安装，需要重新启动 Windows；不会自动重启电脑。"
  ${ElseIf} $0 != 0
    !insertmacro DisplayAbort "运行环境配置失败（返回：$0），未启动大屏。详情及日志保留在下方；可重新运行安装程序。"
  ${EndIf}
  Call DisplayCheckCancel
  Call VerifySelectedCollector
  Call DisplayCheckCancel
!macroend

; The legacy NSIS decoder may not reliably raise an error for an unsupported
; archive stream. Never report success with missing executables/dependencies.
!macro customFiles_x64
  Call DisplayCheckCancel
  !insertmacro DisplayStage "核验解压后的程序和运行环境文件"
  !insertmacro DisplayRequireFile "$INSTDIR\${PRODUCT_NAME}.exe"
  !insertmacro DisplayRequireFile "$INSTDIR\resources\runtime\node.exe"
  !insertmacro DisplayRequireFile "$INSTDIR\resources\backend\server.js"
  !insertmacro DisplayRequireFile "$INSTDIR\resources\native-client\HeatTreatmentDigitalTwin.exe"
  !insertmacro DisplayRequireFile "$INSTDIR\resources\native-client\AdminHost\HeatTreatmentAdminHost.exe"
  !insertmacro DisplayRequireFile "$INSTDIR\resources\prerequisites\RuntimePrerequisites.ps1"
!macroend

!macro DisplayRequireFile FILE
  ${IfNot} ${FileExists} "${FILE}"
    !insertmacro DisplayAbort "程序文件解压不完整：${FILE}。安装已停止，请查看日志，不会启动损坏的程序。"
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
  ; Install/migrate the selected same-build plugin BEFORE overwriting display
  ; files. Its service and data remain outside the display install directory.
  !ifndef BUILD_UNINSTALLER
    Call DisplayCheckCancel
    !insertmacro DisplayStage "检查正在运行的程序与采集服务"
    Call InstallSelectedCollector
    Call DisplayCheckCancel
    !insertmacro DisplayStage "检查升级条件（不会清空已有工程）"
  !endif
  InitPluginsDir
  File /oname=$PLUGINSDIR\display-install-preflight.ps1 "${DISPLAY_PREFLIGHT_SOURCE}"
  nsExec::ExecToStack /TIMEOUT=20000 `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\display-install-preflight.ps1" -InstallRoot "$INSTDIR"`
  Pop $0
  Pop $1
  ${If} $0 != 0
    !ifdef BUILD_UNINSTALLER
    MessageBox MB_ICONSTOP "$1"
    Abort
    !else
      !insertmacro DisplayAbort "升级条件检查失败（返回：$0）：$1"
    !endif
  ${EndIf}
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    Call DisplayCheckCancel
    !insertmacro DisplayStage "解压并复制大屏程序文件"
  !endif
!macroend
