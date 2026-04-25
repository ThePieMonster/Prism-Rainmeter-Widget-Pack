# Removes the Prism native messaging host registration AND the bridge
# poller workaround. You'll still need to remove the extension from
# chrome://extensions manually.

$bridgeTaskName = 'Prism Bridge Poller'
$bridgeScriptName = 'BridgePoll.py'

# --- 1. Stop and unregister the bridge poller scheduled task --------------
try {
    Unregister-ScheduledTask -TaskName $bridgeTaskName -Confirm:$false -ErrorAction Stop
    Write-Host "Unregistered scheduled task: $bridgeTaskName" -ForegroundColor Green
} catch {
    Write-Host "No scheduled task '$bridgeTaskName' to remove." -ForegroundColor DarkGray
}

# Kill any running BridgePoll.py instances (they survive the task being deleted)
$running = Get-CimInstance Win32_Process -Filter "Name = 'pythonw.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$bridgeScriptName*" }
foreach ($p in $running) {
    try {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
        Write-Host "Killed bridge poller pid $($p.ProcessId)" -ForegroundColor Green
    } catch {
        Write-Host "Could not kill pid $($p.ProcessId): $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}

# --- 2. Remove native messaging registry entries --------------------------
$regPaths = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.prism.usage',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.prism.usage',
    'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.prism.usage'
)

foreach ($regPath in $regPaths) {
    if (Test-Path $regPath) {
        Remove-Item -Path $regPath -Force -Recurse
        Write-Host "Removed: $regPath" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "Native host registration and bridge poller removed."
Write-Host "To remove the extension, go to chrome://extensions and click 'Remove'."
