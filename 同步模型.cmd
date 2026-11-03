@echo off
cd /d "%~dp0"
node tools/model-assets.cjs --sync
if errorlevel 1 (
  echo.
  echo Sync stopped. Local changes were not overwritten.
  pause
  exit /b 1
)
pause
