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

!macro DisplayLabel X Y W H TEXT COLOR
  ${NSD_CreateLabel} ${X} ${Y} ${W} ${H} "${TEXT}"
  Pop $0
  SetCtlColors $0 "${COLOR}" "FFFFFF"
  SendMessage $0 ${WM_SETFONT} $displayFont 1
!macroend

Function DisplayUIInit
  SetAutoClose true
  SetCtlColors $HWNDPARENT "233E52" "FFFFFF"
  ; Explicit Chinese charset avoids machine-dependent Han font substitution.
  System::Call 'user32::GetDC(p $HWNDPARENT) p.r0'
  System::Call 'gdi32::GetDeviceCaps(p r0, i 90) i.r1'
  System::Call 'user32::ReleaseDC(p $HWNDPARENT, p r0)'
  System::Call 'kernel32::MulDiv(i -10, i r1, i 72) i.r2'
  System::Call 'gdi32::CreateFontW(i r2, i 0, i 0, i 0, i 400, i 0, i 0, i 0, i 134, i 0, i 0, i 5, i 0, w "Microsoft YaHei UI") p.s'
  Pop $displayFont
  System::Call 'kernel32::MulDiv(i -15, i r1, i 72) i.r2'
  System::Call 'gdi32::CreateFontW(i r2, i 0, i 0, i 0, i 600, i 0, i 0, i 0, i 134, i 0, i 0, i 5, i 0, w "Microsoft YaHei UI") p.s'
  Pop $displayTitleFont
  System::Call 'kernel32::MulDiv(i -8, i r1, i 72) i.r2'
  System::Call 'gdi32::CreateFontW(i r2, i 0, i 0, i 0, i 400, i 0, i 0, i 0, i 134, i 0, i 0, i 5, i 0, w "Microsoft YaHei UI") p.s'
  Pop $displaySmallFont
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
  SetCtlColors $0 "6D8798" "FFFFFF"
  GetDlgItem $0 $HWNDPARENT 1220
  SendMessage $0 ${WM_SETTEXT} 0 "STR:v${VERSION}   ·   Windows x64"
  SetCtlColors $0 "7C95A5" "FFFFFF"
  SendMessage $0 ${WM_SETFONT} $displaySmallFont 1
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
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
  File /oname=$PLUGINSDIR\installer-sidebar.bmp "${__FILEDIR__}\assets\installer-sidebar.bmp"
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\installer-sidebar.bmp", i 0, i 0, i 0, i 0x2010) p.R4'
  System::Call 'user32::GetDC(p R0) p.R5'
  System::Call 'gdi32::CreateCompatibleDC(p R5) p.R6'
  System::Call 'gdi32::SelectObject(p R6, p R4) p.R7'
  System::Call 'gdi32::CreateCompatibleDC(p R5) p.R8'
  System::Call 'gdi32::CreateCompatibleBitmap(p R5, i R2, i R3) p.R9'
  System::Call 'gdi32::SelectObject(p R8, p R9) p.r0'
  System::Call 'gdi32::SetStretchBltMode(p R8, i 4)'
  System::Call 'gdi32::SetBrushOrgEx(p R8, i 0, i 0, p 0)'
  System::Call 'gdi32::StretchBlt(p R8, i 0, i 0, i R2, i R3, p R6, i 0, i 0, i 600, i 1100, i 0xCC0020)'
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
  SetCtlColors $0 "159EBD" "EDF8FC"
  GetDlgItem $0 $HWNDPARENT 1035
  ShowWindow $0 ${SW_SHOW}
  SendMessage $0 ${WM_SETFONT} $displaySmallFont 1
  SetCtlColors $0 "568797" "EDF8FC"
  GetDlgItem $0 $HWNDPARENT 1034
  ShowWindow $0 ${SW_SHOW}
  SendMessage $0 ${WM_SETFONT} $displaySmallFont 1
  SetCtlColors $0 "568797" "EDF8FC"
FunctionEnd

Function DisplayRefreshFonts
  GetDlgItem $0 $HWNDPARENT 1035
  SendMessage $0 ${WM_SETTEXT} 0 "STR:数字孪生 · 智慧工业"
  ShowWindow $0 ${SW_SHOW}
  ; NSIS assigns the language font after .onGUIInit; apply typography on each
  ; page as well, so the Chinese NLF's legacy SimSun cannot win that race.
  GetDlgItem $0 $HWNDPARENT 1037
  SendMessage $0 ${WM_SETFONT} $displayTitleFont 1
  GetDlgItem $0 $HWNDPARENT 1038
  SendMessage $0 ${WM_SETFONT} $displayFont 1
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
  System::Call 'gdi32::CreateSolidBrush(i 0xFFFFFF) p.R8'
  System::Call 'user32::FillRect(p R5, p R1, p R8)'
  System::Call 'gdi32::DeleteObject(p R8)'
  System::Call 'gdi32::CreateSolidBrush(i 0xBFA510) p.R8'
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
  System::Call 'gdi32::SelectObject(p R5, p $displayFont) p.R8'
  System::Call 'gdi32::SetTextColor(p R5, i 0xFFFFFF)'
  System::Call 'gdi32::SetBkMode(p R5, i 1)'
  System::Call 'user32::GetWindowTextW(p R0, t.R9, i ${NSIS_MAX_STRLEN})'
  System::Call 'user32::DrawTextW(p R5, t R9, i -1, p R1, i 0x25)'
  System::Call 'gdi32::SelectObject(p R5, p R8)'
  System::Call 'gdi32::SelectObject(p R5, p R7)'
  System::Call 'gdi32::DeleteDC(p R5)'
  System::Call 'user32::ReleaseDC(p R0, p R4)'
  SendMessage $R0 ${BM_SETIMAGE} ${IMAGE_BITMAP} $R6
  ${If} $displayPrimaryBitmap != ""
    System::Call 'gdi32::DeleteObject(p $displayPrimaryBitmap)'
  ${EndIf}
  StrCpy $displayPrimaryBitmap $R6
  System::Free $R1
FunctionEnd

Function DisplaySettingsPage
  !insertmacro MUI_HEADER_TEXT "热处理数字孪生大屏" "实时大屏 · 后台管理 · 外部接口"
  Call DisplayRefreshFonts
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:立即安装"
  Call DisplayPaintPrimary
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  nsDialogs::Create 1018
  Pop $0
  SetCtlColors $0 "233E52" "FFFFFF"
  !insertmacro DisplayLabel 0 0 260u 14u "安装位置" "233E52"
  ${NSD_CreateLabel} 0 20u 260u 28u ""
  Pop $displayPathPanel
  SetCtlColors $displayPathPanel "F0F8FC" "F0F8FC"
  ${NSD_CreateDirRequest} 9u 26u 191u 14u "$INSTDIR"
  Pop $displayPath
  SendMessage $displayPath ${WM_SETFONT} $displayFont 1
  SetCtlColors $displayPath "364154" "F0F8FC"
  System::Call 'user32::GetWindowLongW(p $displayPath, i -20) i.r1'
  IntOp $1 $1 & 0xFFFFFDFF
  System::Call 'user32::SetWindowLongW(p $displayPath, i -20, i r1)'
  System::Call 'user32::SetWindowPos(p $displayPath, p 0, i 0, i 0, i 0, i 0, i 0x37)'
  ${NSD_CreateLink} 210u 25u 46u 16u "更改"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $displayFont 1
  SetCtlColors $0 "087FB4" "F0F8FC"
  ${NSD_OnClick} $0 DisplayBrowsePath
  ${NSD_CreateLabel} 0 49u 260u 18u ""
  Pop $displayPathError
  SetCtlColors $displayPathError "C13F55" "FFFFFF"
  SendMessage $displayPathError ${WM_SETFONT} $displaySmallFont 1
  !insertmacro DisplayLabel 0 67u 260u 14u "运行环境自动配置 · 数据保留" "6D8798"
  System::Call 'user32::SetWindowPos(p $displayPathPanel, p 1, i 0, i 0, i 0, i 0, i 0x13)'
  !insertmacro DisplayLabel 0 94u 260u 16u "实时大屏 / 后台管理 / 外部接口" "233E52"
  !insertmacro DisplayLabel 0 115u 260u 14u "PLC 采集插件仍支持独立安装。" "6D8798"
  ${NSD_OnChange} $displayPath DisplayPathChanged
  nsDialogs::Show
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
  ${NSD_GetText} $displayPath $0
  StrCpy $1 $0 3
  StrCpy $2 $0 2 1
  ${If} $0 == ""
  ${OrIf} $2 != ":\"
    SendMessage $displayPathError ${WM_SETTEXT} 0 "STR:请选择本机磁盘上的完整安装路径。"
    Abort
  ${EndIf}
  ; Win32 normalization also supports a new, not-yet-created folder. The NSIS
  ; instruction can clear its input when source and destination are identical.
  System::Call 'kernel32::GetFullPathNameW(w r0, i ${NSIS_MAX_STRLEN}, w.r3, p 0) i.r1'
  ${If} $1 == 0
  ${OrIf} $1 >= ${NSIS_MAX_STRLEN}
    SendMessage $displayPathError ${WM_SETTEXT} 0 "STR:安装路径无效，请重新选择。"
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
    SendMessage $displayPathError ${WM_SETTEXT} 0 "STR:请选择本机磁盘上的完整安装路径。"
    Abort
  ${EndIf}
  System::Call 'shlwapi::PathIsPrefixW(w "$WINDIR", w r0) i.r1'
  ${If} $1 != 0
    SendMessage $displayPathError ${WM_SETTEXT} 0 "STR:请不要将程序安装到 Windows 系统目录中。"
    Abort
  ${EndIf}
  System::Call 'shlwapi::PathIsRootW(w r0) i.r1'
  ${If} $1 != 0
  ${OrIf} $0 == "$WINDIR"
  ${OrIf} $0 == "$SYSDIR"
  ${OrIf} $0 == "$PROGRAMFILES64"
  ${OrIf} $0 == "$COMMONFILES64"
  ${OrIf} $0 == "$PROFILE"
    SendMessage $displayPathError ${WM_SETTEXT} 0 "STR:请为程序选择独立文件夹，不要直接安装到磁盘或系统目录。"
    Abort
  ${EndIf}
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r1'
  ${If} $1 != -1
    IntOp $2 $1 & 0x10
    ${If} $2 == 0
      SendMessage $displayPathError ${WM_SETTEXT} 0 "STR:安装位置是一个文件，请选择独立文件夹。"
      Abort
    ${EndIf}
  ${EndIf}
  Call DisplayProductDirectory
  StrLen $1 $0
  ${If} $1 > 180
    SendMessage $displayPathError ${WM_SETTEXT} 0 "STR:安装路径过长，请选择较短的文件夹名称。"
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
  !insertmacro MUI_HEADER_TEXT "正在安装" "热处理数字孪生大屏"
  Call DisplayRefreshFonts
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
  SetCtlColors $mui.InstFilesPage.Text "233E52" "FFFFFF"
  SendMessage $mui.InstFilesPage.Text ${WM_SETFONT} $displayFont 1
  GetDlgItem $0 $mui.InstFilesPage 1230
  SetCtlColors $0 "6D8798" "FFFFFF"
  System::Call 'uxtheme::SetWindowTheme(p $mui.InstFilesPage.ProgressBar, w "", w "")'
  SendMessage $mui.InstFilesPage.ProgressBar 0x409 0 0xBFA510
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
    !insertmacro DisplayLabel 0 2u 260u 22u "重启后，从桌面打开大屏。" "233E52"
    !insertmacro DisplayLabel 0 32u 260u 22u "不会自动重启电脑。" "6D8798"
    StrCpy $displayLaunch ""
  ${Else}
    !insertmacro MUI_HEADER_TEXT "安装完成" "大屏已准备就绪"
    !insertmacro DisplayLabel 0 2u 260u 22u "首次打开后，完成激活并登录账户。" "233E52"
    !insertmacro DisplayLabel 0 30u 260u 20u "已有工程和账户将保留。" "6D8798"
    ${NSD_CreateCheckbox} 0 62u 260u 18u "启动热处理数字孪生大屏"
    Pop $displayLaunch
    SendMessage $displayLaunch ${WM_SETFONT} $displayFont 1
    SetCtlColors $displayLaunch "233E52" "FFFFFF"
    ${NSD_Check} $displayLaunch
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function DisplayFinishLeave
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
  IfAbort 0 display_install_ok
  !insertmacro MUI_HEADER_TEXT "安装未完成" "请查看失败原因后重新安装"
  GetDlgItem $0 $HWNDPARENT 1037
  SetCtlColors $0 "C13F55" "FFFFFF"
  GetDlgItem $0 $mui.InstFilesPage 1230
  SendMessage $0 ${WM_SETTEXT} 0 "STR:未启动大屏；已有工程与账户保留。"
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  SendMessage $0 ${WM_SETTEXT} 0 "STR:关闭"
  ShowWindow $0 ${SW_SHOW}
  EnableWindow $0 1
  StrCpy $displayActionId 2
  Call DisplayPaintAction
  display_install_ok:
FunctionEnd
!endif
