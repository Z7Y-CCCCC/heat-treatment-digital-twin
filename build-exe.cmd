@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\build-release.ps1" %*
set "build_exit_code=%ERRORLEVEL%"
echo.
if not "%build_exit_code%"=="0" echo Build failed. Check the messages above.
pause
exit /b %build_exit_code%
