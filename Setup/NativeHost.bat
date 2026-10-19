@echo off
REM Native Messaging Host wrapper - launches PowerShell with NativeHost.ps1.
REM Chrome passes the extension origin as argv[1]; we forward stdin/stdout.
REM
REM The launch.log line is a diagnostic so we can tell whether Chrome ever
REM actually spawned us (NativeHost.log only starts once PowerShell runs).
REM Past 1 MB it is renamed to launch.log.old. The rotation sends all its
REM output to nul because stdout is the native-messaging channel, and
REM move /y never prompts (a prompt would read the message from stdin).
if exist "%~dp0launch.log" for %%F in ("%~dp0launch.log") do if %%~zF GTR 1048576 move /y "%%~fF" "%%~fF.old" >nul 2>&1
echo [%DATE% %TIME%] launched pid=%RANDOM% args=[%*] >> "%~dp0launch.log"
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0NativeHost.ps1" %*
