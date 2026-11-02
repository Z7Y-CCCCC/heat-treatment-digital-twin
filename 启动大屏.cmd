@echo off
setlocal EnableExtensions
title Digital Twin - Current Workspace
rem Recreated launcher: rebuild this checkout before starting the desktop app.
set "PROJECT_ROOT=%~dp0"
set "APP_DIR=%PROJECT_ROOT%desktop"
set "APP_EXE=%APP_DIR%\node_modules\electron\dist\electron.exe"
set "NODE_EXE=%APP_DIR%\resources\runtime\node.exe"
set "VITE_SCRIPT=%PROJECT_ROOT%frontend\node_modules\vite\bin\vite.js"
set "ELECTRON_RUN_AS_NODE="
if not exist "%APP_EXE%" goto missing
if not exist "%NODE_EXE%" goto missing
if not exist "%VITE_SCRIPT%" goto missing
if not exist "%PROJECT_ROOT%unity-client\Builds\Windows\HeatTreatmentDigitalTwin.exe" goto missing

echo Workspace: "%PROJECT_ROOT%"
echo [1/2] Building the latest interface from this workspace...
pushd "%PROJECT_ROOT%frontend"
if errorlevel 1 goto failed
"%NODE_EXE%" "%VITE_SCRIPT%" build
set "BUILD_RESULT=%ERRORLEVEL%"
popd
if not "%BUILD_RESULT%"=="0" goto failed

rem Disable only browser caches for this launch; preserve accounts and data.
set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=%WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS% --disable-http-cache"
echo [2/2] Starting the current workspace application...
pushd "%APP_DIR%"
if errorlevel 1 goto failed
start "" "%APP_EXE%" "%APP_DIR%" --disable-http-cache
set "RESULT=%ERRORLEVEL%"
popd
if not "%RESULT%"=="0" goto failed
exit /b 0

:missing
echo Required application files are missing in this workspace.
echo Follow the build instructions in the project startup guide.
pause
exit /b 1

:failed
echo The current workspace could not be built or started. See the error above.
pause
exit /b 1
