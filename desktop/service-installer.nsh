!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  ; Refuse while the UI is open, before touching the service. Cancelling an
  ; upgrade must never leave collection stopped or force-kill unsaved editors.
  nsExec::ExecToLog `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "if(Get-Process -Name '热处理数字孪生大屏','HeatTreatmentDigitalTwin','HeatTreatmentAdminHost' -ErrorAction SilentlyContinue){exit 1}else{exit 0}"`
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "请先保存编辑并完全退出 Unity 和后台管理，再重新运行安装或卸载。采集服务仍在运行，未强制终止任何程序。"
    Abort
  ${EndIf}
  nsExec::ExecToLog `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference='Stop'; $$s=Get-Service HeatTreatmentCollector -ErrorAction SilentlyContinue; if($$s -and $$s.Status -ne 'Stopped'){Stop-Service HeatTreatmentCollector; $$s.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(60))}"`
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "采集服务无法安全停止，安装或卸载已取消，未强制终止数据库。"
    Abort
  ${EndIf}
  !insertmacro _CHECK_APP_RUNNING
!macroend

!macro customInstall
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\安装采集服务.ps1" -InstallRoot "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "采集服务安装失败。请查看安装日志，或以管理员身份运行安装目录内的 安装采集服务.ps1。"
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\安装采集服务.ps1" -InstallRoot "$INSTDIR" -Uninstall'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "采集服务未能安全停止，请先停止 HeatTreatmentCollector 服务后再卸载。"
    Abort
  ${EndIf}
!macroend
