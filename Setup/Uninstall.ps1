# Removes the Prism native messaging host registration AND the bridge
# poller workaround. You'll still need to remove the extension from
# chrome://extensions manually.

$bridgeTaskName = 'Prism Bridge Poller'
$bridgeScriptName = 'BridgePoll.py'
$removedAny = $false

# --- 1. Stop and unregister the bridge poller scheduled task --------------
$existingTask = Get-ScheduledTask -TaskName $bridgeTaskName -ErrorAction SilentlyContinue
if ($existingTask) {
    try {
        Unregister-ScheduledTask -TaskName $bridgeTaskName -Confirm:$false -ErrorAction Stop
        Write-Host "Unregistered scheduled task: $bridgeTaskName" -ForegroundColor Green
        $removedAny = $true
    } catch {
        Write-Host "Failed to unregister scheduled task '$bridgeTaskName': $($_.Exception.Message)" -ForegroundColor Red
    }
} else {
    Write-Host "Scheduled task '$bridgeTaskName' not found, nothing to unregister." -ForegroundColor DarkGray
}

# Kill any running BridgePoll.py instances (they survive the task being deleted)
$running = Get-CimInstance Win32_Process -Filter "Name = 'pythonw.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$bridgeScriptName*" }
if ($running) {
    foreach ($p in $running) {
        try {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
            Write-Host "Killed bridge poller pid $($p.ProcessId)" -ForegroundColor Green
            $removedAny = $true
        } catch {
            Write-Host "Could not kill pid $($p.ProcessId): $($_.Exception.Message)" -ForegroundColor DarkYellow
        }
    }
} else {
    Write-Host "No running bridge poller processes found." -ForegroundColor DarkGray
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
        $removedAny = $true
    } else {
        Write-Host "Not found: $regPath" -ForegroundColor DarkGray
    }
}

# --- 3. Reset ConsumerData.inc so widgets show disconnected state ---------
# Without this, the widgets keep rendering the last percentages/dollar
# values the bridge wrote, even though the bridge is gone. The stub at
# Setup\Disconnected.inc defines every variable as 0/empty so the widgets'
# Hidden=(1-#...Connected#) logic fires correctly.
$scriptDir       = Split-Path -Parent $PSCommandPath
$repoRoot        = Split-Path -Parent $scriptDir
$disconnectedSrc = Join-Path $scriptDir 'Disconnected.inc'
$dataCandidates  = @(
    (Join-Path $repoRoot 'Prism\@Resources'),
    (Join-Path $env:USERPROFILE 'Documents\Rainmeter\Skins\Prism\@Resources'),
    (Join-Path $env:USERPROFILE 'OneDrive\Documents\Rainmeter\Skins\Prism\@Resources')
)

if (-not (Test-Path $disconnectedSrc)) {
    Write-Host "Disconnected stub not found at $disconnectedSrc - skipping data reset." -ForegroundColor DarkYellow
} else {
    $seenPaths  = @{}
    $resetCount = 0
    foreach ($resourcesPath in $dataCandidates) {
        $consumerPath = Join-Path $resourcesPath 'ConsumerData.inc'
        if (-not (Test-Path $consumerPath)) { continue }

        # Resolve to handle directory junctions (Install.ps1 links
        # Documents\Rainmeter\Skins\Prism -> <repo>\Prism), so different
        # candidates may map to the same physical file.
        $resolved = (Resolve-Path $consumerPath).ProviderPath
        if ($seenPaths.ContainsKey($resolved)) { continue }
        $seenPaths[$resolved] = $true

        try {
            Copy-Item -Path $disconnectedSrc -Destination $consumerPath -Force -ErrorAction Stop
            Write-Host "Reset to disconnected: $consumerPath" -ForegroundColor Green
            $removedAny = $true
            $resetCount++
        } catch {
            Write-Host "Failed to reset ${consumerPath}: $($_.Exception.Message)" -ForegroundColor Red
        }
    }

    if ($resetCount -eq 0) {
        Write-Host "No ConsumerData.inc found to reset." -ForegroundColor DarkGray
    }
}

# --- 4. Trigger Rainmeter "Refresh All" so widgets re-read the stub -------
# Same Rainmeter discovery as Install.ps1: running process, App Paths
# registry, PATH, then standard install locations.
$rainmeterExe = $null
$rmRunning = Get-Process Rainmeter -ErrorAction SilentlyContinue | Select-Object -First 1
if ($rmRunning -and $rmRunning.Path) { $rainmeterExe = $rmRunning.Path }
if (-not $rainmeterExe) {
    $appPathsKey = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\Rainmeter.exe'
    if (Test-Path $appPathsKey) {
        $val = (Get-ItemProperty $appPathsKey -ErrorAction SilentlyContinue).'(default)'
        if ($val -and (Test-Path $val)) { $rainmeterExe = $val }
    }
}
if (-not $rainmeterExe) {
    $cmd = Get-Command Rainmeter.exe -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { $rainmeterExe = $cmd.Source }
}
if (-not $rainmeterExe) {
    foreach ($candidate in @(
        'C:\Program Files\Rainmeter\Rainmeter.exe',
        'C:\Program Files (x86)\Rainmeter\Rainmeter.exe'
    )) {
        if (Test-Path $candidate) { $rainmeterExe = $candidate; break }
    }
}

if ($rainmeterExe) {
    # Brief delay so the Disconnected.inc copy above has settled to disk
    # before Rainmeter re-reads it.
    Start-Sleep -Seconds 1
    & $rainmeterExe '!RefreshApp' 2>$null | Out-Null
    Write-Host "Triggered !RefreshApp - all skins reloaded." -ForegroundColor Green
} else {
    Write-Host "Rainmeter not found - skipping !RefreshApp." -ForegroundColor DarkGray
}

Write-Host ""
if ($removedAny) {
    Write-Host "Native host registration and bridge poller removed."
} else {
    Write-Host "Nothing to remove. Native host registration and bridge poller were not present."
}
Write-Host "To remove the extension, go to chrome://extensions and click 'Remove'."
