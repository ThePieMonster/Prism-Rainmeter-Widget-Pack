@echo off
REM Native Messaging Host wrapper - launches PowerShell with the NativeHost.ps1 script
REM Chrome passes the extension origin as argv[1], we pass stdin/stdout through.
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0NativeHost.ps1" %*
