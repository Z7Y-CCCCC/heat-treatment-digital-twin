@echo off
setlocal
set "APP_EXE=%~dp0desktop\.cache\collector-center\HeatTreatmentCollectorCenter.exe"
if not exist "%APP_EXE%" goto missing
start "" "%APP_EXE%"
exit /b %ERRORLEVEL%
:missing
echo Native center is missing. Run: npm --prefix desktop run build:collector-center
pause
exit /b 1
