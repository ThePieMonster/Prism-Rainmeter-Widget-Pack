@echo off
REM ==========================================================================
REM  Prism Extension - One-click Uninstall
REM
REM  Double-click this file to remove the native messaging host registration
REM  and the bridge-poller scheduled task. Does NOT touch the extension
REM  itself (remove that from chrome://extensions) or your Prism skins
REM  folder (delete it manually if you want it gone).
REM ==========================================================================

cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall.ps1"
echo.
pause
