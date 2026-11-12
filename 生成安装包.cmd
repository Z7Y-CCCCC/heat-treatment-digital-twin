@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0生成安装包.ps1" -NoPause %*
if errorlevel 1 echo 安装包生成失败，请查看上面的错误信息。
pause
