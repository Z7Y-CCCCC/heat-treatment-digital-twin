@echo off
setlocal
cd /d "%~dp0\..\.."
node tools\license-generator\license-generator.cjs
if errorlevel 1 pause
