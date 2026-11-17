; Three native pages. Shared by the real installer and the no-install preview.
!ifndef BUILD_UNINSTALLER
!include "FileFunc.nsh"
!define MUI_UI "${__FILEDIR__}\assets\installer-ui.bin"
!define MUI_UI_HEADERIMAGE "${__FILEDIR__}\assets\installer-ui.bin"
!define MUI_UI_HEADERIMAGE_RIGHT "${__FILEDIR__}\assets\installer-ui.bin"
!define MUI_CUSTOMFUNCTION_GUIINIT DisplayUIInit
!define MUI_INSTFILESPAGE_ABORTHEADER_TEXT "安装未完成"
!define MUI_INSTFILESPAGE_ABORTHEADER_SUBTEXT "请查看失败原因后重新安装"
!insertmacro MUI_INSTFILESPAGE_INTERFACE
Var displayPath
Var displayPathPanel
Var displayPathError
Var displayLaunch
Var displayFont
Var displayTitleFont
Var displaySmallFont
Var displayPrimaryBitmap
Var displayActionId
Var displayBrandIcon
Var displaySidebarBitmap
Var displayBrandFont
Var displayButtonFont
Var displayCloseBitmap
Var displayCloseMode
Var displayCustomToggle
Var displayBrowse
Var displayCustomExpanded
Var displayInstallLog
Var displayFailure
Var displayCancelState
Var displayStageClock

; Builder resets SetDetailsPrint in its section. Restore it in worker hooks.
!macro DisplayStage TEXT
  SetDetailsPrint listonly
  SendMessage $mui.InstFilesPage.Text ${WM_SETTEXT} 0 "STR:${TEXT}"
  System::Call 'kernel32::GetTickCount() i.r9'
  IntOp $9 $9 - $displayStageClock
  IntOp $9 $9 / 1000
  DetailPrint "[+$9 s] ${TEXT}"
!macroend

!macro DisplayAbort TEXT
  StrCpy $displayFailure "${TEXT}"
  !ifdef FAST_PROGRAM_MANIFEST
    SetOutPath $TEMP
    InitPluginsDir
    File /oname=$PLUGINSDIR\program-directory.ps1 "${FAST_PROGRAM_DIRECTORY_SOURCE}"
    File /oname=$PLUGINSDIR\installer-process.ps1 "${FAST_INSTALLER_PROCESS_SOURCE}"
    File /oname=$PLUGINSDIR\program-files.json "${FAST_PROGRAM_MANIFEST}"
    nsExec::ExecToLog /TIMEOUT=240000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\program-directory.ps1" -Action Rollback -InstallRoot "$INSTDIR" -ManifestFile "$PLUGINSDIR\program-files.json" -ManifestSha256 "${FAST_PROGRAM_MANIFEST_SHA256}" -UninstallerFilename "${UNINSTALL_FILENAME}" -InstallerLog'
    Pop $0
  !endif
  SetDetailsPrint listonly
  DetailPrint "$displayFailure"
  SetErrorLevel 2
  Abort "$displayFailure"
!macroend

Function DisplayCheckCancel
  System::Call '$PLUGINSDIR\InstallerWindowChrome.dll::IsCancelRequested() i.s ?!u'
  Pop $displayCancelState
  ${If} $displayCancelState == 1
    !insertmacro DisplayAbort "安装已取消；可能保留部分程序文件，可重新运行安装。已有工程和账户不会被清空。"
  ${EndIf}
FunctionEnd

!macro DisplayLabel X Y W H TEXT COLOR
  ${NSD_CreateLabel} ${X} ${Y} ${W} ${H} "${TEXT}"
  Pop $0
  SetCtlColors $0 "${COLOR}" "FFFFFF"
  SendMessage $0 ${WM_SETFONT} $displayFont 1
!macroend

Function DisplayUIInit
  SetAutoClose true
  SetCtlColors $HWNDPARENT "233E52" "FFFFFF"
  ; Native NSIS font creation keeps the current language charset and DPI.
  CreateFont $displayFont "Microsoft YaHei UI" 10 400
  CreateFont $displayTitleFont "Microsoft YaHei UI" 20 700
  CreateFont $displaySmallFont "Microsoft YaHei UI" 9 400
  CreateFont $displayButtonFont "Microsoft YaHei UI" 12 600
  ; A normal Win32 dialog remains keyboard-accessible, with a compact custom
  ; Cancel button replacing the stock caption. Older Windows ignores this hint.
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 33, *i 2, i 4)'
  InitPluginsDir
  File /oname=$PLUGINSDIR\InstallerWindowChrome.dll "${__FILEDIR__}\.cache\installer-window-chrome\InstallerWindowChrome.dll"
  ; Keep the DLL loaded: its native subclasses live until this process exits.
  ; System::Call parses module names, not a shell command. Quotes become part
  ; of the DLL name and make LoadLibrary fail even when the file exists.
  System::Call '$PLUGINSDIR\InstallerWindowChrome.dll::Attach(p $HWNDPARENT) i.r0 ?!u'
  ${If} $0 != 1
    SetErrorLevel 2
    MessageBox MB_ICONSTOP "安装窗口初始化失败，请重新运行安装程序。"
    Quit
  ${EndIf}
  !ifdef DISPLAY_UI_PREVIEW
    System::Call 'user32::GetDC(p $HWNDPARENT) p.r0'
    System::Call 'gdi32::SelectObject(p r0, p $displayFont) p.r1'
    System::Call 'gdi32::GetTextFaceW(p r0, i ${NSIS_MAX_STRLEN}, w.r2)'
    GetDlgItem $3 $HWNDPARENT 1256
    SendMessage $3 ${WM_SETTEXT} 0 "STR:Font: $2"
    System::Call 'gdi32::SelectObject(p r0, p r1)'
    System::Call 'user32::ReleaseDC(p $HWNDPARENT, p r0)'
  !endif
  Call DisplayPaintSidebar
  GetDlgItem $0 $HWNDPARENT 1039
  System::Alloc 16
  Pop $1
  System::Call 'user32::GetClientRect(p r0, p r1)'
  System::Call '*$1(i, i, i.r2, i.r3)'
  System::Free $1
  ${If} $3 < $2
    StrCpy $2 $3
  ${EndIf}
  System::Call 'kernel32::GetModuleHandleW(p 0) p.r1'
  System::Call 'user32::LoadImageW(p r1, i 103, i 1, i r2, i r2, i 0) p.s'
  Pop $displayBrandIcon
  SendMessage $0 0x170 $displayBrandIcon 0
  GetDlgItem $0 $HWNDPARENT 1037
  SendMessage $0 ${WM_SETFONT} $displayTitleFont 1
  GetDlgItem $0 $HWNDPARENT 1038
  SetCtlColors $0 "B9DFE7" transparent
  GetDlgItem $0 $HWNDPARENT 1220
  SendMessage $0 ${WM_SETTEXT} 0 "STR:v${VERSION}   ·   Windows x64"
  SetCtlColors $0 "7C95A5" "FFFFFF"
  SendMessage $0 ${WM_SETFONT} $displaySmallFont 1
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  Call DisplayShowClose
FunctionEnd

Function DisplayPaintSidebar
  GetDlgItem $R0 $HWNDPARENT 1036
  ShowWindow $R0 ${SW_SHOW}
  System::Alloc 16
  Pop $R1
  System::Call 'user32::GetClientRect(p R0, p R1)'
  System::Call '*$R1(i, i, i.R2, i.R3)'
  System::Free $R1
  InitPluginsDir
  File /oname=$PLUGINSDIR\installer-sidebar.bmp "${__FILEDIR__}\assets\installer-art.bmp"
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\installer-sidebar.bmp", i 0, i 0, i 0, i 0x2010) p.R4'
  System::Call 'user32::GetDC(p R0) p.R5'
  System::Call 'gdi32::CreateCompatibleDC(p R5) p.R6'
  System::Call 'gdi32::SelectObject(p R6, p R4) p.R7'
  System::Call 'gdi32::CreateCompatibleDC(p R5) p.R8'
  System::Call 'gdi32::CreateCompatibleBitmap(p R5, i R2, i R3) p.R9'
  System::Call 'gdi32::SelectObject(p R8, p R9) p.r0'
  System::Call 'gdi32::SetStretchBltMode(p R8, i 4)'
  System::Call 'gdi32::SetBrushOrgEx(p R8, i 0, i 0, p 0)'
  System::Call 'gdi32::StretchBlt(p R8, i 0, i 0, i R2, i R3, p R6, i 0, i 0, i 1024, i 625, i 0xCC0020)'
  System::Call 'gdi32::SelectObject(p R8, p r0)'
  System::Call 'gdi32::SelectObject(p R6, p R7)'
  System::Call 'gdi32::DeleteDC(p R8)'
  System::Call 'gdi32::DeleteDC(p R6)'
  System::Call 'gdi32::DeleteObject(p R4)'
  System::Call 'user32::ReleaseDC(p R0, p R5)'
  SendMessage $R0 0x172 0 $R9
  StrCpy $displaySidebarBitmap $R9
  CreateFont $displayBrandFont "Segoe UI" 28 700
  GetDlgItem $0 $HWNDPARENT 1039
  ShowWindow $0 ${SW_SHOW}
  SendMessage $0 ${WM_SETFONT} $displayBrandFont 1
  SetCtlColors $0 "FFFFFF" transparent
  GetDlgItem $0 $HWNDPARENT 1035
  ShowWindow $0 ${SW_SHOW}
  SendMessage $0 ${WM_SETFONT} $displaySmallFont 1
  SetCtlColors $0 "79D7E2" transparent
  GetDlgItem $0 $HWNDPARENT 1034
  ShowWindow $0 ${SW_SHOW}
  SendMessage $0 ${WM_SETFONT} $displaySmallFont 1
  SetCtlColors $0 "8394A5" "FFFFFF"
FunctionEnd

Function DisplayRefreshFonts
  ; The supplied image owns its title/tagline. Keep MUI status text available
  ; internally without drawing duplicate live labels over the artwork.
  GetDlgItem $0 $HWNDPARENT 1035
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1037
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1038
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1039
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1220
  SendMessage $0 ${WM_SETFONT} $displaySmallFont 1
FunctionEnd

; Real Win32 pushbutton, not a clickable label: retains Tab, Enter, Space,
; accessibility text and pressed/focus handling. Render at its actual DPI size.
Function DisplayPaintPrimary
  StrCpy $displayActionId 1
  Call DisplayPaintAction
FunctionEnd

Function DisplayPaintAction
  GetDlgItem $R0 $HWNDPARENT $displayActionId
  System::Call 'user32::GetWindowLongW(p R0, i -16) i.R1'
  IntOp $R1 $R1 | 0x8080
  System::Call 'user32::SetWindowLongW(p R0, i -16, i R1)'
  System::Alloc 16
  Pop $R1
  System::Call 'user32::GetClientRect(p R0, p R1)'
  System::Call '*$R1(i, i, i.R2, i.R3)'
  System::Call 'user32::GetDC(p R0) p.R4'
  System::Call 'gdi32::CreateCompatibleDC(p R4) p.R5'
  System::Call 'gdi32::CreateCompatibleBitmap(p R4, i R2, i R3) p.R6'
  System::Call 'gdi32::SelectObject(p R5, p R6) p.R7'
  ${If} $displayActionId == 2
  ${AndIf} $displayCloseMode == 1
    System::Call 'gdi32::CreateSolidBrush(i 0x573B11) p.R8'
  ${Else}
    System::Call 'gdi32::CreateSolidBrush(i 0xFFFFFF) p.R8'
  ${EndIf}
  System::Call 'user32::FillRect(p R5, p R1, p R8)'
  System::Call 'gdi32::DeleteObject(p R8)'
  ${If} $displayActionId == 2
  ${AndIf} $displayCloseMode == 1
    System::Call 'gdi32::CreateSolidBrush(i 0x573B11) p.R8'
  ${Else}
    System::Call 'gdi32::CreateSolidBrush(i 0xA08E00) p.R8'
  ${EndIf}
  System::Call 'gdi32::SelectObject(p R5, p R8) p.R9'
  System::Call 'gdi32::GetStockObject(i 8) p.s'
  Pop $0
  System::Call 'gdi32::SelectObject(p R5, p r0) p.s'
  Pop $1
  ; Radius scales with the button height rather than assuming 96 DPI.
  IntOp $0 $R3 / 3
  System::Call 'gdi32::RoundRect(p R5, i 0, i 0, i R2, i R3, i r0, i r0)'
  System::Call 'gdi32::SelectObject(p R5, p r1)'
  System::Call 'gdi32::SelectObject(p R5, p R9)'
  System::Call 'gdi32::DeleteObject(p R8)'
  System::Call 'gdi32::SelectObject(p R5, p $displayButtonFont) p.R8'
  System::Call 'gdi32::SetTextColor(p R5, i 0xFFFFFF)'
  System::Call 'gdi32::SetBkMode(p R5, i 1)'
  System::Call 'user32::GetWindowTextW(p R0, t.R9, i ${NSIS_MAX_STRLEN})'
  System::Call 'user32::DrawTextW(p R5, t R9, i -1, p R1, i 0x25)'
  System::Call 'gdi32::SelectObject(p R5, p R8)'
  System::Call 'gdi32::SelectObject(p R5, p R7)'
  System::Call 'gdi32::DeleteDC(p R5)'
  System::Call 'user32::ReleaseDC(p R0, p R4)'
  SendMessage $R0 ${BM_SETIMAGE} ${IMAGE_BITMAP} $R6
  ${If} $displayActionId == 2
  ${AndIf} $displayCloseMode == 1
    ${If} $displayCloseBitmap != ""
      System::Call 'gdi32::DeleteObject(p $displayCloseBitmap)'
    ${EndIf}
    StrCpy $displayCloseBitmap $R6
  ${Else}
    ${If} $displayPrimaryBitmap != ""
      System::Call 'gdi32::DeleteObject(p $displayPrimaryBitmap)'
    ${EndIf}
    StrCpy $displayPrimaryBitmap $R6
  ${EndIf}
  System::Free $R1
FunctionEnd

Function DisplayShowClose
  ; Header Close/Minimize are independent native controls (1241/1240).
  ; NSIS hides/disables its own Cancel button while installing.
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
FunctionEnd

Function DisplaySettingsPage
  !insertmacro MUI_HEADER_TEXT "热处理数字孪生大屏" "让产线运行，一目了然"
  Call DisplayRefreshFonts
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:下一步"
  Call DisplayPaintPrimary
  Call DisplayShowClose
  nsDialogs::Create 1018
  Pop $0
  SetCtlColors $0 "233E52" "FFFFFF"
  StrCpy $displayCustomExpanded 0
  !insertmacro DisplayLabel 0 0 300u 14u "自动配置运行环境 · 升级保留已有工程" "8394A5"
  ${NSD_CreateLink} 316u 0 96u 14u "自定义安装"
  Pop $displayCustomToggle
  SendMessage $displayCustomToggle ${WM_SETFONT} $displaySmallFont 1
  SetCtlColors $displayCustomToggle "008EA0" "FFFFFF"
  ${NSD_OnClick} $displayCustomToggle DisplayToggleCustom
  ${NSD_CreateLabel} 0 18u 412u 18u ""
  Pop $displayPathPanel
  SetCtlColors $displayPathPanel "F3F6FA" "F3F6FA"
  ${NSD_CreateDirRequest} 7u 19u 355u 16u "$INSTDIR"
  Pop $displayPath
  SendMessage $displayPath ${WM_SETFONT} $displayFont 1
  SetCtlColors $displayPath "364154" "F3F6FA"
  System::Call 'user32::GetWindowLongW(p $displayPath, i -20) i.r1'
  IntOp $1 $1 & 0xFFFFFDFF
  System::Call 'user32::SetWindowLongW(p $displayPath, i -20, i r1)'
  System::Call 'user32::SetWindowPos(p $displayPath, p 0, i 0, i 0, i 0, i 0, i 0x37)'
  ${NSD_CreateLink} 371u 19u 37u 16u "更改"
  Pop $displayBrowse
  SendMessage $displayBrowse ${WM_SETFONT} $displaySmallFont 1
  SetCtlColors $displayBrowse "008EA0" "F3F6FA"
  ${NSD_OnClick} $displayBrowse DisplayBrowsePath
  ${NSD_CreateLabel} 0 37u 412u 12u ""
  Pop $displayPathError
  SetCtlColors $displayPathError "C13F55" "FFFFFF"
  SendMessage $displayPathError ${WM_SETFONT} $displaySmallFont 1
  System::Call 'user32::SetWindowPos(p $displayPathPanel, p 1, i 0, i 0, i 0, i 0, i 0x13)'
  ShowWindow $displayPathPanel ${SW_HIDE}
  ShowWindow $displayPath ${SW_HIDE}
  ShowWindow $displayBrowse ${SW_HIDE}
  ShowWindow $displayPathError ${SW_HIDE}
  ${NSD_OnChange} $displayPath DisplayPathChanged
  nsDialogs::Show
FunctionEnd

Function DisplayToggleCustom
  Pop $0
  ${If} $displayCustomExpanded == 0
    Call DisplayExpandCustomSettings
  ${Else}
    StrCpy $displayCustomExpanded 0
    SendMessage $displayCustomToggle ${WM_SETTEXT} 0 "STR:自定义安装"
    ShowWindow $displayPathPanel ${SW_HIDE}
    ShowWindow $displayPath ${SW_HIDE}
    ShowWindow $displayBrowse ${SW_HIDE}
    ShowWindow $displayPathError ${SW_HIDE}
  ${EndIf}
FunctionEnd

; Also callable from validation: unlike the click callback, this helper does
; not pop a notification handle or collapse settings that are already open.
Function DisplayExpandCustomSettings
  StrCpy $displayCustomExpanded 1
  SendMessage $displayCustomToggle ${WM_SETTEXT} 0 "STR:收起设置"
  ShowWindow $displayPathPanel ${SW_SHOW}
  ShowWindow $displayPath ${SW_SHOW}
  ShowWindow $displayBrowse ${SW_SHOW}
  ShowWindow $displayPathError ${SW_SHOW}
FunctionEnd

; Consume the error text while preserving the caller's path register. Every
; rejected path must leave both its explanation and editable settings visible.
Function DisplayShowPathError
  Exch $0
  Call DisplayExpandCustomSettings
  SendMessage $displayPathError ${WM_SETTEXT} 0 "STR:$0"
  Pop $0
FunctionEnd

Function DisplayPathChanged
  Pop $0
  SendMessage $displayPathError ${WM_SETTEXT} 0 "STR:"
FunctionEnd

Function DisplayBrowsePath
  Pop $0
  nsDialogs::SelectFolderDialog "选择安装位置" "$INSTDIR"
  Pop $0
  ${If} $0 != error
    System::Call 'shlwapi::PathIsRootW(w r0) i.r1'
    ${If} $1 != 0
      StrCpy $0 "$0${PRODUCT_NAME}"
    ${Else}
      Call DisplayProductDirectory
    ${EndIf}
    SendMessage $displayPath ${WM_SETTEXT} 0 "STR:$0"
    SendMessage $displayPathError ${WM_SETTEXT} 0 "STR:"
  ${EndIf}
FunctionEnd

Function DisplaySettingsLeave
  ; Keep invalid-path messages visible even when the optional settings were
  ; collapsed before the user pressed the primary action.
  ${NSD_GetText} $displayPath $0
  StrCpy $1 $0 3
  StrCpy $2 $0 2 1
  ${If} $0 == ""
  ${OrIf} $2 != ":\"
    Push "请选择本机磁盘上的完整安装路径。"
    Call DisplayShowPathError
    Abort
  ${EndIf}
  ; Win32 normalization also supports a new, not-yet-created folder. The NSIS
  ; instruction can clear its input when source and destination are identical.
  System::Call 'kernel32::GetFullPathNameW(w r0, i ${NSIS_MAX_STRLEN}, w.r3, p 0) i.r1'
  ${If} $1 == 0
  ${OrIf} $1 >= ${NSIS_MAX_STRLEN}
    Push "安装路径无效，请重新选择。"
    Call DisplayShowPathError
    Abort
  ${EndIf}
  StrCpy $0 $3
  StrLen $1 $0
  StrCpy $2 $0 1 -1
  ${If} $1 > 3
  ${AndIf} $2 == "\"
    StrCpy $0 $0 -1
  ${EndIf}
  System::Call 'shlwapi::PathGetDriveNumberW(w r0) i.r1'
  ${If} $1 < 0
    Push "请选择本机磁盘上的完整安装路径。"
    Call DisplayShowPathError
    Abort
  ${EndIf}
  System::Call 'shlwapi::PathIsPrefixW(w "$WINDIR", w r0) i.r1'
  ${If} $1 != 0
    Push "请不要将程序安装到 Windows 系统目录中。"
    Call DisplayShowPathError
    Abort
  ${EndIf}
  System::Call 'shlwapi::PathIsRootW(w r0) i.r1'
  ${If} $1 != 0
  ${OrIf} $0 == "$WINDIR"
  ${OrIf} $0 == "$SYSDIR"
  ${OrIf} $0 == "$PROGRAMFILES64"
  ${OrIf} $0 == "$COMMONFILES64"
  ${OrIf} $0 == "$PROFILE"
    Push "请为程序选择独立文件夹，不要直接安装到磁盘或系统目录。"
    Call DisplayShowPathError
    Abort
  ${EndIf}
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r1'
  ${If} $1 != -1
    IntOp $2 $1 & 0x10
    ${If} $2 == 0
      Push "安装位置是一个文件，请选择独立文件夹。"
      Call DisplayShowPathError
      Abort
    ${EndIf}
  ${EndIf}
  Call DisplayProductDirectory
  StrLen $1 $0
  ${If} $1 > 180
    Push "安装路径过长，请选择较短的文件夹名称。"
    Call DisplayShowPathError
    Abort
  ${EndIf}
  StrCpy $INSTDIR $0
  !ifdef DISPLAY_UI_PREVIEW
    GetDlgItem $4 $HWNDPARENT 1256
    SendMessage $4 ${WM_SETTEXT} 0 "STR:Valid install path: $INSTDIR"
  !endif
FunctionEnd

Function DisplayProductDirectory
  ; Preserve an existing installation's exact directory during upgrades. For a
  ; new parent folder retain the old builder's product-subdirectory safeguard.
  IfFileExists "$0\${PRODUCT_NAME}.exe" display_product_directory_done
  ${GetFileName} "$0" $1
  ${If} $1 != "${PRODUCT_NAME}"
    StrCpy $0 "$0\${PRODUCT_NAME}"
  ${EndIf}
  display_product_directory_done:
FunctionEnd

Function DisplayInstallingShow
  System::Call 'kernel32::GetTickCount() i.r0'
  StrCpy $displayStageClock $0
  !insertmacro MUI_HEADER_TEXT "正在安装" "热处理数字孪生大屏"
  Call DisplayRefreshFonts
  ; The progress page uses the entire lower pane while the install action is
  ; hidden, leaving enough space for the native expandable detail list.
  System::Alloc 16
  Pop $R0
  System::Call '*$R0(i 24, i 249, i 412, i 88)'
  System::Call 'user32::MapDialogRect(p $HWNDPARENT, p R0)'
  System::Call '*$R0(i.r0, i.r1, i.r2, i.r3)'
  System::Free $R0
  System::Call 'user32::MoveWindow(p $mui.InstFilesPage, i r0, i r1, i r2, i r3, i 1)'
  SetCtlColors $mui.InstFilesPage "233E52" "FFFFFF"
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:安装中"
  ShowWindow $0 ${SW_HIDE}
  ; Use the standard disabled button during installation; on failure NSIS can
  ; change its caption to Close. Never leave a stale bitmap hiding an error.
  SendMessage $0 ${BM_SETIMAGE} ${IMAGE_BITMAP} 0
  System::Call 'user32::GetWindowLongW(p r0, i -16) i.r1'
  IntOp $1 $1 & 0xFFFF7F7F
  System::Call 'user32::SetWindowLongW(p r0, i -16, i r1)'
  System::Call 'uxtheme::SetWindowTheme(p r0, p 0, p 0)'
  SendMessage $mui.InstFilesPage.Text ${WM_SETTEXT} 0 "STR:复制程序文件"
  SetDetailsPrint listonly
  SetDetailsView show
  StrCpy $displayFailure ""
  System::Call 'kernel32::GetCurrentProcessId() i.r0'
  System::Call 'kernel32::GetTickCount() i.r1'
  StrCpy $displayInstallLog "$TEMP\HeatTreatmentDigitalTwin-install-$0-$1.log"
  System::Call '$PLUGINSDIR\InstallerWindowChrome.dll::BeginInstall(p $mui.InstFilesPage, w "$displayInstallLog") i.r0 ?!u'
  ${If} $0 != 1
    MessageBox MB_ICONSTOP "无法创建安装日志，安装未开始。请检查临时目录的写入权限后重试。"
    SetErrorLevel 2
    Quit
  ${EndIf}
  SetCtlColors $mui.InstFilesPage.Text "233E52" "FFFFFF"
  SendMessage $mui.InstFilesPage.Text ${WM_SETFONT} $displayFont 1
  GetDlgItem $0 $mui.InstFilesPage 1230
  SendMessage $0 ${WM_SETTEXT} 0 "STR:日志：$displayInstallLog"
  SetCtlColors $0 "6D8798" "FFFFFF"
  System::Call 'uxtheme::SetWindowTheme(p $mui.InstFilesPage.ProgressBar, w "", w "")'
  SendMessage $mui.InstFilesPage.ProgressBar 0x409 0 0xA08E00
  SendMessage $mui.InstFilesPage.ProgressBar 0x2001 0 0xF8EDE2
FunctionEnd

Function DisplayFinishPage
  IfAbort 0 display_finish_ok
    SetErrorLevel 2
    Quit
  display_finish_ok:
  Call DisplayRefreshFonts
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:完成"
  ShowWindow $0 ${SW_SHOW}
  Call DisplayPaintPrimary
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  nsDialogs::Create 1018
  Pop $0
  SetCtlColors $0 "233E52" "FFFFFF"
  ${If} $runtimeNeedsReboot == "1"
    !insertmacro MUI_HEADER_TEXT "安装完成，请重启电脑" "Microsoft 运行环境需要重新启动 Windows"
    !insertmacro DisplayLabel 0 0 412u 15u "安装完成，请重启电脑后从桌面打开大屏。" "233E52"
    !insertmacro DisplayLabel 0 20u 412u 15u "不会自动重启电脑。" "8394A5"
    StrCpy $displayLaunch ""
  ${ElseIf} $displayCancelState == 1
    !insertmacro MUI_HEADER_TEXT "安装已结束" "按取消请求不启动大屏"
    !insertmacro DisplayLabel 0 0 412u 20u "安装步骤已经结束；已收到取消请求，不会自动启动大屏。" "233E52"
    StrCpy $displayLaunch ""
  ${Else}
    !insertmacro MUI_HEADER_TEXT "安装完成" "大屏已准备就绪"
    !insertmacro DisplayLabel 0 0 412u 14u "安装完成。首次打开后，完成激活并登录账户。" "233E52"
    !insertmacro DisplayLabel 0 16u 412u 12u "已有工程和账户将保留。" "8394A5"
    ${NSD_CreateCheckbox} 0 32u 412u 14u "启动热处理数字孪生大屏"
    Pop $displayLaunch
    SendMessage $displayLaunch ${WM_SETFONT} $displayFont 1
    SetCtlColors $displayLaunch "233E52" "FFFFFF"
    ${NSD_Check} $displayLaunch
  ${EndIf}
  Call DisplayRefreshFonts
  Call DisplayShowClose
  nsDialogs::Show
FunctionEnd

Function DisplayFinishLeave
  System::Call '$PLUGINSDIR\InstallerWindowChrome.dll::IsCancelRequested() i.s ?!u'
  Pop $displayCancelState
  ${If} $displayCancelState == 1
    Return
  ${EndIf}
  ${If} $displayLaunch != ""
    ${NSD_GetState} $displayLaunch $0
    ${If} $0 == ${BST_CHECKED}
      Call StartPreparedApp
    ${EndIf}
  ${EndIf}
FunctionEnd

; MUI's instfiles LEAVE callback runs when the installation thread completes.
; .onInstFailed runs only while exiting and is too late to repair the error UI.
Function DisplayInstallingLeave
  System::Call '$PLUGINSDIR\InstallerWindowChrome.dll::IsCancelRequested() i.s ?!u'
  Pop $displayCancelState
  System::Call '$PLUGINSDIR\InstallerWindowChrome.dll::EndInstall() ?!u'
  IfAbort 0 display_install_ok
  SetAutoClose false
  SetErrorLevel 2
  SetDetailsView show
  ${If} $displayFailure != ""
    SendMessage $mui.InstFilesPage.Text ${WM_SETTEXT} 0 "STR:$displayFailure"
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "安装未完成" "请查看失败原因后重新安装"
  GetDlgItem $0 $HWNDPARENT 1037
  SetCtlColors $0 "C13F55" "FFFFFF"
  GetDlgItem $0 $mui.InstFilesPage 1230
  SendMessage $0 ${WM_SETTEXT} 0 "STR:日志：$displayInstallLog"
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  StrCpy $displayCloseMode 0
  ; Keep the native failure details visible; Close sits in the footer.
  GetDlgItem $1 $HWNDPARENT 1034
  ShowWindow $1 ${SW_HIDE}
  System::Alloc 16
  Pop $R0
  System::Call '*$R0(i 340, i 339, i 96, i 16)'
  System::Call 'user32::MapDialogRect(p $HWNDPARENT, p R0)'
  System::Call '*$R0(i.r1, i.r2, i.r3, i.r4)'
  System::Free $R0
  System::Call 'user32::MoveWindow(p r0, i r1, i r2, i r3, i r4, i 1)'
  SendMessage $0 ${WM_SETTEXT} 0 "STR:关闭"
  ShowWindow $0 ${SW_SHOW}
  EnableWindow $0 1
  System::Call 'user32::SetWindowPos(p r0, p 0, i 0, i 0, i 0, i 0, i 0x53)'
  StrCpy $displayActionId 2
  Call DisplayPaintAction
  display_install_ok:
FunctionEnd
!endif
