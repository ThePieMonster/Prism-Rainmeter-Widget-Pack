@echo off
REM Native Messaging Host wrapper - launches PowerShell with the NativeHost.ps1 script
REM Chrome passes the extension origin as argv[1], we pass stdin/stdout through.
echo [%DATE% %TIME%] bat launched args=[%*] >> "%~dp0launch.log"
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0NativeHost.ps1" %*
