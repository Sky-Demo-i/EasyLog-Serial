@echo off
chcp 65001 >nul
setlocal
set "SCRIPT=%~dp0gitee-deploy.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
echo.
pause
