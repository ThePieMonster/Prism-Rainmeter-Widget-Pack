@echo off
REM Native Messaging Host wrapper - launches PowerShell with NativeHost.ps1.
REM Chrome passes the extension origin as argv[1]; we forward stdin/stdout.
REM
REM The launch.log line is a diagnostic so we can tell whether Chrome ever
REM actually spawned us. Truncate it manually if it grows large.
echo [%DATE% %TIME%] launched pid=%RANDOM% args=[%*] >> "%~dp0launch.log"
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0NativeHost.ps1" %*
