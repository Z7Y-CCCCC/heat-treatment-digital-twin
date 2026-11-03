!include "getProcessInfo.nsh"
Var pid
!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  ; The display installer never installs/stops/removes a collector. Refuse an
  ; in-place upgrade of the old bundled service until its independent plugin
  ; has been migrated, rather than deleting binaries under a running service.
  InitPluginsDir
  File /oname=$PLUGINSDIR\display-install-preflight.ps1 "${__FILEDIR__}\display-install-preflight.ps1"
  nsExec::ExecToStack /TIMEOUT=20000 `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\display-install-preflight.ps1" -InstallRoot "$INSTDIR"`
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "$1"
    Abort
  ${EndIf}
  !insertmacro _CHECK_APP_RUNNING
!macroend
