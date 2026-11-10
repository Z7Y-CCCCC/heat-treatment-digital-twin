@echo off
setlocal EnableExtensions
title Digital Twin - Current Workspace
rem Build changed source; reuse only a source-matched, verified interface.
set "PROJECT_ROOT=%~dp0"
rem Keep this workspace's desktop data beside its source and downloaded assets.
set "APP_USER_DATA_DIR=%PROJECT_ROOT%backend\data\desktop-profile"
set "APP_DIR=%PROJECT_ROOT%desktop"
set "APP_EXE=%APP_DIR%\node_modules\electron\dist\electron.exe"
set "NODE_EXE=%APP_DIR%\resources\runtime\node.exe"
set "VITE_SCRIPT=%PROJECT_ROOT%frontend\node_modules\vite\bin\vite.js"
set "ENSURE_FRONTEND=%APP_DIR%\scripts\ensure-workspace-frontend.cjs"
set "ELECTRON_RUN_AS_NODE="
if not exist "%APP_EXE%" goto missing
if not exist "%NODE_EXE%" goto missing
if not exist "%VITE_SCRIPT%" goto missing
if not exist "%ENSURE_FRONTEND%" goto missing
if not exist "%PROJECT_ROOT%unity-client\Builds\Windows\HeatTreatmentDigitalTwin.exe" goto missing

echo Workspace: "%PROJECT_ROOT%"
echo [1/2] Checking the latest interface from this workspace...
pushd "%PROJECT_ROOT%frontend"
if errorlevel 1 goto failed
"%NODE_EXE%" "%ENSURE_FRONTEND%"
set "BUILD_RESULT=%ERRORLEVEL%"
popd
if not "%BUILD_RESULT%"=="0" goto failed

rem Disable only browser caches for this launch; preserve accounts and data.
set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=%WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS% --disable-http-cache"
echo [2/2] Starting the current workspace application...
pushd "%APP_DIR%"
if errorlevel 1 goto failed
start "" "%APP_EXE%" "%APP_DIR%" --disable-http-cache --admin
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
