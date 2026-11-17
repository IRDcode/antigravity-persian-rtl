@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-all-mods.ps1" -Action launch
if errorlevel 1 (
    echo.
    pause
    exit /b 1
)
