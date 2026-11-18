!include "${__FILEDIR__}\installer-exec.nsh"
; Optional offline payload. The display runtime remains collector-free; the
; selected plugin is installed to its own Program Files directory and SCM job.
!ifndef BUILD_UNINSTALLER
Var collectorChoice
Var collectorDisplayRadio
Var collectorServiceRadio
Var collectorExisting
Var collectorInstalled
Var collectorNewEmpty
Var collectorNewEmptyApplied
Var collectorEmptyCheckbox
Var collectorChoiceDialog
Var collectorPolicyLabel
Var collectorEmptySelection
!ifndef DISPLAY_UI_PREVIEW
  !if "$%DIGITAL_TWIN_COLLECTOR_PAYLOAD_INCLUDE%" == ""
    !error "A verified same-build collector payload is required. Use the full release build."
  !endif
  !include "$%DIGITAL_TWIN_COLLECTOR_PAYLOAD_INCLUDE%"
!endif

Function CollectorChoiceInit
  StrCpy $collectorChoice "0"
  StrCpy $collectorInstalled "0"
  StrCpy $collectorNewEmpty "0"
  StrCpy $collectorEmptySelection "0"
  StrCpy $collectorNewEmptyApplied "0"
  StrCpy $collectorExisting "0"
  !ifdef DISPLAY_UI_PREVIEW
    ; Preview fixtures never inspect real SCM or machine/user configuration.
    !ifdef DISPLAY_UI_PREVIEW_EXISTING_COLLECTOR
      StrCpy $collectorExisting "1"
      StrCpy $collectorChoice "1"
    !endif
  !else
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
  !endif
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "/WITHCOLLECTOR=" $1
    ${IfNot} ${Errors}
      ${If} $1 != "0"
      ${AndIf} $1 != "1"
        MessageBox MB_ICONSTOP "/WITHCOLLECTOR 只能为 0 或 1。" /SD IDOK
        SetErrorLevel 2
        Quit
      ${EndIf}
      StrCpy $collectorChoice $1
    ${EndIf}
    ClearErrors
    ${GetOptions} $0 "/NEWEMPTY=" $1
    ${IfNot} ${Errors}
      ${If} $1 != "0"
      ${AndIf} $1 != "1"
        MessageBox MB_ICONSTOP "/NEWEMPTY 只能为 0 或 1。" /SD IDOK
        SetErrorLevel 2
        Quit
      ${EndIf}
      StrCpy $collectorNewEmpty $1
      ${If} $collectorNewEmpty == "1"
      ${AndIf} $collectorChoice != "1"
        MessageBox MB_ICONSTOP "新建空白现场须同时选择本机采集（/WITHCOLLECTOR=1）；旧工程不会删除。" /SD IDOK
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
  StrCpy $collectorEmptySelection $collectorNewEmpty
FunctionEnd

Function CollectorChoicePage
  Call DisplayCollectorLayout
  Call DisplayRefreshFonts
  Call DisplayShowClose
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:开始安装"
  Call DisplayPaintPrimary
  nsDialogs::Create 1018
  Pop $collectorChoiceDialog
  ${If} $collectorChoiceDialog == "error"
    MessageBox MB_ICONSTOP "安装方式选择页初始化失败，请重新运行安装程序。"
    SetErrorLevel 2
    Quit
  ${EndIf}
  SetCtlColors $collectorChoiceDialog "233E52" "FFFFFF"
  ${NSD_CreateRadioButton} 0 0 412u 16u "仅展示：大屏、后台管理及外部数据接口"
  Pop $collectorDisplayRadio
  SetCtlColors $collectorDisplayRadio "233E52" "FFFFFF"
  SendMessage $collectorDisplayRadio ${WM_SETFONT} $displayFont 1
  ${NSD_CreateRadioButton} 0 19u 412u 16u "展示＋本机采集：同时安装独立的开机采集服务"
  Pop $collectorServiceRadio
  SetCtlColors $collectorServiceRadio "233E52" "FFFFFF"
  SendMessage $collectorServiceRadio ${WM_SETFONT} $displayFont 1
  ${If} $collectorChoice == "1"
    ${NSD_Check} $collectorServiceRadio
  ${Else}
    ${NSD_Check} $collectorDisplayRadio
  ${EndIf}
  ${NSD_CreateLabel} 0 39u 412u 24u ""
  Pop $collectorPolicyLabel
  SetCtlColors $collectorPolicyLabel "687F91" "FFFFFF"
  SendMessage $collectorPolicyLabel ${WM_SETFONT} $displayFont 1
  ${NSD_CreateCheckbox} 0 67u 412u 16u "新建空白现场（旧工程原目录保留，不删除模型或 PLC 配置）"
  Pop $collectorEmptyCheckbox
  SetCtlColors $collectorEmptyCheckbox "233E52" "FFFFFF"
  SendMessage $collectorEmptyCheckbox ${WM_SETFONT} $displayFont 1
  !insertmacro DisplayLabel 0 88u 412u 24u "出厂仅含 7 个视角的组件布局；不预置模型、PLC、设备、账户或业务记录。" "687F91"
  ${NSD_OnClick} $collectorDisplayRadio CollectorDataChanged
  ${NSD_OnClick} $collectorServiceRadio CollectorDataChanged
  ${NSD_OnClick} $collectorEmptyCheckbox CollectorEmptyChanged
  Call CollectorDataToggle
  nsDialogs::Show
FunctionEnd

Function CollectorDataChanged
  Pop $0
  Call CollectorDataToggle
FunctionEnd

Function CollectorEmptyChanged
  Pop $0
  ${NSD_GetState} $collectorEmptyCheckbox $0
  StrCpy $collectorEmptySelection "0"
  ${If} $0 == ${BST_CHECKED}
    StrCpy $collectorEmptySelection "1"
  ${EndIf}
  !ifdef DISPLAY_UI_PREVIEW_EVIDENCE
    Call CollectorPreviewRecord
  !endif
FunctionEnd

Function CollectorDataToggle
  ${NSD_GetState} $collectorServiceRadio $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $collectorChoice "1"
    EnableWindow $collectorEmptyCheckbox 1
    ${If} $collectorEmptySelection == "1"
      ${NSD_Check} $collectorEmptyCheckbox
    ${Else}
      ${NSD_Uncheck} $collectorEmptyCheckbox
    ${EndIf}
    ${If} $collectorExisting == "1"
      SendMessage $collectorPolicyLabel ${WM_SETTEXT} 0 "STR:已有现场默认保留。需要全新数据，请勾选“新建空白现场”；旧工程不会删除。"
    ${Else}
      SendMessage $collectorPolicyLabel ${WM_SETTEXT} 0 "STR:首次安装自动创建空白现场；关闭大屏不停止独立采集服务。"
    ${EndIf}
  ${Else}
    StrCpy $collectorChoice "0"
    EnableWindow $collectorEmptyCheckbox 0
    ${NSD_Uncheck} $collectorEmptyCheckbox
    SendMessage $collectorPolicyLabel ${WM_SETTEXT} 0 "STR:仅更新大屏，不更改独立采集服务。连接已有采集端时仍会显示该端的原有数据。"
  ${EndIf}
  !ifdef DISPLAY_UI_PREVIEW_EVIDENCE
    Call CollectorPreviewRecord
  !endif
FunctionEnd

Function CollectorChoiceLeave
  StrCpy $collectorNewEmpty "0"
  ${NSD_GetState} $collectorServiceRadio $0
  StrCpy $collectorChoice "0"
  ${If} $0 == ${BST_CHECKED}
    StrCpy $collectorChoice "1"
    ${NSD_GetState} $collectorEmptyCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $collectorNewEmpty "1"
    ${EndIf}
  ${EndIf}
  !ifdef DISPLAY_UI_PREVIEW_EVIDENCE
    Call CollectorPreviewRecord
  !endif
FunctionEnd
!ifndef DISPLAY_UI_PREVIEW
; Functions are compiled before electron-builder declares its PowerShellPath.
; Use the system path directly rather than depend on the later shared hook.
Function InstallSelectedCollector
  ; Display-only explicitly leaves the independently managed collector alone.
  ; Same-build payload/version/readiness gates still apply when it is selected.
  ${If} $collectorChoice != "1"
    DetailPrint "仅展示：跳过采集插件；已有采集服务及现场数据保持不变。"
    Return
  ${EndIf}
  ${If} $collectorInstalled == "1"
    Return
  ${EndIf}
  Call DisplayCheckCancel
  StrCpy $R3 ""
  ${If} $collectorNewEmpty == "1"
  ${AndIf} $collectorNewEmptyApplied != "1"
    StrCpy $R3 "-NewEmptyData"
    !insertmacro DisplayStage "校验插件并新建空白现场（旧工程不删除）"
  ${Else}
    !insertmacro DisplayStage "校验并安装同版本采集插件（保留已有机器级工程）"
  ${EndIf}
  InitPluginsDir
  ; ZIP is already compressed. Store it verbatim, exactly like builder's own
  ; application archive; this also permits independent final-EXE hash checks.
  SetCompress off
  File /oname=$PLUGINSDIR\collector-plugin.zip "${COLLECTOR_PAYLOAD_ZIP}"
  SetCompress auto
  File /oname=$PLUGINSDIR\installer-process.ps1 "${__FILEDIR__}\installer-process.ps1"
  File /oname=$PLUGINSDIR\Install-CollectorPayload.ps1 "${__FILEDIR__}\Install-CollectorPayload.ps1"
  InstallerExec::ExecToLog /TIMEOUT=1200000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\Install-CollectorPayload.ps1" -ArchivePath "$PLUGINSDIR\collector-plugin.zip" -ExpectedSha256 "${COLLECTOR_PAYLOAD_SHA256}" -ExpectedVersion "${COLLECTOR_BUILD_VERSION}" -ExpectedCommit "${COLLECTOR_BUILD_COMMIT}" -InstallerLog $R3`
  Pop $0
  ${If} $0 != 0
    !insertmacro DisplayAbort "采集插件安装失败（返回：$0），已停止继续安装大屏。具体错误保留在详情和日志中。"
  ${EndIf}
  StrCpy $collectorInstalled "1"
  StrCpy $collectorNewEmptyApplied "1"
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
  InstallerExec::ExecToLog /TIMEOUT=180000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\Install-CollectorPayload.ps1" -ArchivePath "$PLUGINSDIR\collector-plugin.zip" -ExpectedSha256 "${COLLECTOR_PAYLOAD_SHA256}" -ExpectedVersion "${COLLECTOR_BUILD_VERSION}" -ExpectedCommit "${COLLECTOR_BUILD_COMMIT}" -VerifyInstalledOnly -InstallerLog`
  Pop $0
  ${If} $0 != 0
    StrCpy $collectorInstalled "0"
    Call InstallSelectedCollector
  ${EndIf}
FunctionEnd
!endif
!endif
