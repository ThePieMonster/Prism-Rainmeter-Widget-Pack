@echo off
REM ==========================================================================
REM  Prism Extension - One-click Setup
REM
REM  Double-click this file to install the native messaging host.
REM  No prompts, no configuration - the extension ID is deterministic
REM  (baked into manifest.json), so registration just works.
REM ==========================================================================

cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1"
echo.
pause
