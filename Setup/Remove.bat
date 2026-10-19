@echo off
REM ==========================================================================
REM  Prism Extension - One-click Uninstall
REM
REM  Double-click this file to remove the native messaging host registration
REM  and the bridge-poller scheduled task, plus their logs (launch.log,
REM  bridge.log, NativeHost.log). Does NOT touch the extension
REM  itself (remove that from chrome://extensions) or your Prism skins
REM  folder (delete it manually if you want it gone).
REM
REM  Only removes the install that belongs to this folder: if Setup.bat was
REM  last run from another Prism folder, that install is left in place.
REM ==========================================================================

cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall.ps1"
echo.
pause
