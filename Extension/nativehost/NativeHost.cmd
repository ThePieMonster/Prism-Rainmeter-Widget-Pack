@echo off
echo [%DATE% %TIME%] CMD launched args=[%*] >> "%~dp0launch-cmd.log"
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0NativeHost.ps1" %*
