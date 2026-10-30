@echo off
setlocal
rem Use the existing desktop host, data directory and database configuration.
set "ELECTRON_RUN_AS_NODE="
set "APP_DIR=%~dp0desktop"
set "APP_EXE=%~dp0desktop\node_modules\electron\dist\electron.exe"
if not exist "%APP_EXE%" goto missing
if not exist "%~dp0unity-client\Builds\Windows\HeatTreatmentDigitalTwin.exe" goto missing
pushd "%APP_DIR%"
start "" "%APP_EXE%" "%APP_DIR%"
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%
:missing
echo Application files are missing. Keep this launcher in the project root.
echo See the startup instructions in this folder.
pause
exit /b 1
