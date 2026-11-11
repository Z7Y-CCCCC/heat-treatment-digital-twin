@echo off
setlocal
set "APP_EXE=%~dp0collector-runtime\resources\collector-center\HeatTreatmentCollectorCenter.exe"
if not exist "%APP_EXE%" goto missing
start "" "%APP_EXE%"
exit /b %ERRORLEVEL%
:missing
echo Complete independent collector runtime is missing. Run: npm --prefix desktop run build:collector-runtime
pause
exit /b 1
