; Offline installer I/O overrides; loaded AFTER the stock archive macros.
; The same verified native decoder is retained. No raw/partial copy fallback.
Var /GLOBAL displayPreparedRoot
!macroundef extractUsing7za
!macro extractUsing7za FILE
  !insertmacro DisplayStage "在安装盘解压并核验程序（不二次复制）"
  System::Call 'kernel32::GetCurrentProcessId() i.r8'
  System::Call 'kernel32::GetTickCount() i.r9'
  StrCpy $displayPreparedRoot "$INSTDIR.preparing-$8-$9"
  ${If} ${FileExists} "$displayPreparedRoot"
    !insertmacro DisplayAbort "独立解压目录已存在；未覆盖任何文件，请重新运行安装。"
  ${EndIf}
  CreateDirectory "$displayPreparedRoot"
  ClearErrors
  SetOutPath "$displayPreparedRoot"
  Nsis7z::Extract "${FILE}"
  SetOutPath $TEMP
  InitPluginsDir
  File /oname=$PLUGINSDIR\program-directory.ps1 "${FAST_PROGRAM_DIRECTORY_SOURCE}"
  File /oname=$PLUGINSDIR\installer-process.ps1 "${FAST_INSTALLER_PROCESS_SOURCE}"
  File /oname=$PLUGINSDIR\program-files.json "${FAST_PROGRAM_MANIFEST}"
  nsExec::ExecToLog /TIMEOUT=240000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\program-directory.ps1" -Action Publish -InstallRoot "$INSTDIR" -PreparedRoot "$displayPreparedRoot" -ManifestFile "$PLUGINSDIR\program-files.json" -ManifestSha256 "${FAST_PROGRAM_MANIFEST_SHA256}" -UninstallerFilename "${UNINSTALL_FILENAME}" -InstallerLog'
  Pop $0
  ${If} $0 != 0
    !insertmacro DisplayAbort "程序核验或目录切换失败（$0）；没有复制不完整程序，旧工程未清空。"
  ${EndIf}
  SetOutPath $INSTDIR
!macroend

!macroundef installApplicationFiles
!macro installApplicationFiles
  !ifdef APP_PACKAGE_URL
    !error "The optimized installer is offline-only; a web/updater install needs a reviewed I/O policy."
  !endif
  !ifdef APP_BUILD_DIR
    !error "The optimized installer requires the verified 7z archive, not APP_BUILD_DIR."
  !else
    !insertmacro extractEmbeddedAppPackage
  !endif
  ; This product has no electron-updater. Do not write another complete,
  ; unused installer (currently 833 MiB) into the user's updater cache.
  File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"
!macroend
