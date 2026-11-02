@echo off
setlocal
cd /d "%~dp0"
set "NODE_BIN=%~dp0desktop\resources\runtime\node.exe"
if exist "%NODE_BIN%" goto run
set "NODE_BIN=node"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 runtime not found. Install Node.js or prepare desktop resources first.
  pause
  exit /b 1
)
:run
"%NODE_BIN%" "%~dp0tools\license-generator\license-generator.cjs"
if errorlevel 1 pause
