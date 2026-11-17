; Optional offline payload. The display runtime remains collector-free; the
; selected plugin is installed to its own Program Files directory and SCM job.
!ifndef BUILD_UNINSTALLER
Var collectorChoice
Var collectorDisplayRadio
Var collectorServiceRadio
Var collectorExisting
Var collectorInstalled
!ifndef DISPLAY_UI_PREVIEW
  !if "$%DIGITAL_TWIN_COLLECTOR_PAYLOAD_INCLUDE%" == ""
    !error "A verified same-build collector payload is required. Use the full release build."
  !endif
  !include "$%DIGITAL_TWIN_COLLECTOR_PAYLOAD_INCLUDE%"
!endif

Function CollectorChoiceInit
  StrCpy $collectorChoice "0"
  StrCpy $collectorInstalled "0"
  StrCpy $collectorExisting "0"
  !ifndef DISPLAY_UI_PREVIEW
    ClearErrors
    ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\HeatTreatmentCollector" "ImagePath"
    ${If} $0 != ""
      StrCpy $collectorExisting "1"
      StrCpy $collectorChoice "1"
    ${EndIf}
    ${If} ${FileExists} "$APPDATA\HeatTreatmentDigitalTwin\collector-service.json"
      StrCpy $collectorExisting "1"
      StrCpy $collectorChoice "1"
    ${EndIf}
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "/WITHCOLLECTOR=" $1
    ${IfNot} ${Errors}
      ${If} $1 != "0"
      ${AndIf} $1 != "1"
        MessageBox MB_ICONSTOP "/WITHCOLLECTOR 只能为 0 或 1。"
        SetErrorLevel 2
        Quit
      ${EndIf}
      ${If} $collectorExisting == "1"
      ${AndIf} $1 == "0"
        MessageBox MB_ICONSTOP "已安装采集服务，必须同步更新，避免新旧代码混用；不会卸载或清空现有采集工程。"
        SetErrorLevel 2
        Quit
      ${EndIf}
      StrCpy $collectorChoice $1
    ${EndIf}
  !endif
FunctionEnd

Function CollectorChoicePage
  Call DisplayRefreshFonts
  Call DisplayShowClose
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:开始安装"
  Call DisplayPaintPrimary
  nsDialogs::Create 1018
  Pop $0
  SetCtlColors $0 "233E52" "FFFFFF"
  ${NSD_CreateRadioButton} 0 0 412u 12u "仅展示：大屏、后台管理及外部数据接口"
  Pop $collectorDisplayRadio
  ${NSD_CreateRadioButton} 0 14u 412u 12u "展示＋本机采集：同时安装开机运行的独立采集服务"
  Pop $collectorServiceRadio
  ${If} $collectorChoice == "1"
    ${NSD_Check} $collectorServiceRadio
  ${Else}
    ${NSD_Check} $collectorDisplayRadio
  ${EndIf}
  ${If} $collectorExisting == "1"
    EnableWindow $collectorDisplayRadio 0
    !insertmacro DisplayLabel 0 29u 412u 20u "已装采集服务：同步更新期间短暂停采；保留工程、模型、账号及授权。" "8394A5"
  ${Else}
    !insertmacro DisplayLabel 0 29u 412u 20u "采集插件已随包提供，无需另行下载。关闭大屏不停止采集。" "8394A5"
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function CollectorChoiceLeave
  ${NSD_GetState} $collectorServiceRadio $0
  StrCpy $collectorChoice "0"
  ${If} $0 == ${BST_CHECKED}
    StrCpy $collectorChoice "1"
  ${EndIf}
FunctionEnd

!ifndef DISPLAY_UI_PREVIEW
; Functions are compiled before electron-builder declares its PowerShellPath.
; Use the system path directly rather than depend on the later shared hook.
Function InstallSelectedCollector
  ; Recheck at execution time: a service may have appeared after page init.
  ${If} $collectorChoice != "1"
    ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\HeatTreatmentCollector" "ImagePath"
    ${If} $0 != ""
    ${OrIf} ${FileExists} "$APPDATA\HeatTreatmentDigitalTwin\collector-service.json"
      !insertmacro DisplayAbort "检测到采集服务，请重新打开安装向导并选择同步安装采集插件，避免遗留旧代码。"
    ${EndIf}
  ${EndIf}
  ${If} $collectorChoice != "1"
  ${OrIf} $collectorInstalled == "1"
    Return
  ${EndIf}
  Call DisplayCheckCancel
  !insertmacro DisplayStage "校验并安装同版本采集插件（保留已有机器级工程）"
  InitPluginsDir
  ; ZIP is already compressed. Store it verbatim, exactly like builder's own
  ; application archive; this also permits independent final-EXE hash checks.
  SetCompress off
  File /oname=$PLUGINSDIR\collector-plugin.zip "${COLLECTOR_PAYLOAD_ZIP}"
  SetCompress auto
  File /oname=$PLUGINSDIR\Install-CollectorPayload.ps1 "${__FILEDIR__}\Install-CollectorPayload.ps1"
  nsExec::ExecToLog /TIMEOUT=1200000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\Install-CollectorPayload.ps1" -ArchivePath "$PLUGINSDIR\collector-plugin.zip" -ExpectedSha256 "${COLLECTOR_PAYLOAD_SHA256}" -ExpectedVersion "${COLLECTOR_BUILD_VERSION}" -ExpectedCommit "${COLLECTOR_BUILD_COMMIT}" -InstallerLog`
  Pop $0
  ${If} $0 != 0
    !insertmacro DisplayAbort "采集插件安装失败（返回：$0），已停止继续安装大屏。具体错误保留在详情和日志中。"
  ${EndIf}
  StrCpy $collectorInstalled "1"
  Call DisplayCheckCancel
FunctionEnd
Function VerifySelectedCollector
  ${If} $collectorChoice != "1"
    Return
  ${EndIf}
  Call DisplayCheckCancel
  !insertmacro DisplayStage "核对安装后的采集服务版本与运行状态"
  ; Old display uninstallers may have touched SCM after the pre-copy migration.
  ; Recheck AFTER display installation, repair only with this exact payload,
  ; and never let a completed frontend hide a missing/stale collector service.
  nsExec::ExecToLog /TIMEOUT=180000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\Install-CollectorPayload.ps1" -ArchivePath "$PLUGINSDIR\collector-plugin.zip" -ExpectedSha256 "${COLLECTOR_PAYLOAD_SHA256}" -ExpectedVersion "${COLLECTOR_BUILD_VERSION}" -ExpectedCommit "${COLLECTOR_BUILD_COMMIT}" -VerifyInstalledOnly -InstallerLog`
  Pop $0
  ${If} $0 != 0
    StrCpy $collectorInstalled "0"
    Call InstallSelectedCollector
  ${EndIf}
FunctionEnd
!endif
!endif
