# ==========================================================================
#  Prism Extension - Automated Installation Script
#
#  Writes the Native Messaging Host manifest (com.prism.usage.json) and
#  registers it in the Windows Registry for Chrome / Edge / Brave.
#
#  Determining which extension ID(s) to allow:
#    1. The published Chrome Web Store ID is hardcoded below - this is the
#       ID every end user will have after installing from the store.
#    2. If manifest.json contains a "key" field (dev/sideload install),
#       compute the deterministic ID from that key and allow it too.
#    3. Scan Chrome / Edge / Brave User Data folders for any installed
#       extension whose manifest matches our name, and allow those IDs too
#       (handles profiles, custom sideload keys, etc.)
#    4. Write all unique IDs into allowed_origins so the native host
#       accepts messages from any of the above.
# ==========================================================================

$ErrorActionPreference = 'Stop'

# Hardcoded Chrome Web Store extension ID - never changes once published.
# Source: https://chromewebstore.google.com/detail/prism-rainmeter/nmlnncddmhjfiahelimfgajdidcobajc
$WebStoreExtensionId = 'nmlnncddmhjfiahelimfgajdidcobajc'

$setupDir        = Split-Path -Parent $PSCommandPath
$repoRoot        = Split-Path -Parent $setupDir
$extensionDir    = Join-Path $repoRoot "Extension"
$batPath         = Join-Path $setupDir "NativeHost.bat"
$manifestPath    = Join-Path $setupDir "com.prism.usage.json"
$extManifestPath = Join-Path $extensionDir "manifest.json"

# --------------------------------------------------------------------------
# Load the packaged extension manifest (for display name + optional key)
# --------------------------------------------------------------------------
if (-not (Test-Path $extManifestPath)) {
    Write-Host "ERROR: Cannot find manifest.json at $extManifestPath" -ForegroundColor Red
    exit 1
}

$extManifest = Get-Content $extManifestPath -Raw | ConvertFrom-Json
$extName = $extManifest.name
$b64Key  = $extManifest.key

Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "  $extName - Automated Setup" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""

# --------------------------------------------------------------------------
# Helper: compute Chrome's deterministic extension ID from a base64 key.
#   1. SHA256 of DER-encoded public key bytes
#   2. First 16 bytes → 32 hex chars → map each nibble (0-f) to a-p
# --------------------------------------------------------------------------
function Get-ChromeExtensionIdFromKey {
    param([string]$Base64Key)
    $pubKeyBytes = [Convert]::FromBase64String($Base64Key)
    $sha         = [System.Security.Cryptography.SHA256]::Create()
    $hash        = $sha.ComputeHash($pubKeyBytes)
    $sb = New-Object System.Text.StringBuilder
    foreach ($b in $hash[0..15]) {
        [void]$sb.Append([char]([int][char]'a' + ([int]$b -shr 4)))
        [void]$sb.Append([char]([int][char]'a' + ([int]$b -band 0x0F)))
    }
    return $sb.ToString()
}

# --------------------------------------------------------------------------
# Helper: scan Chrome/Edge User Data folders for extensions whose manifest
# name matches our extension. Returns a list of extension IDs.
# --------------------------------------------------------------------------
function Find-InstalledExtensionIds {
    param([string]$TargetName)
    $found = @()
    $userDataRoots = @(
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data'),
        (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\User Data')
    )
    foreach ($root in $userDataRoots) {
        if (-not (Test-Path $root)) { continue }
        $profiles = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' }
        foreach ($profile in $profiles) {
            $extensionsPath = Join-Path $profile.FullName 'Extensions'
            if (-not (Test-Path $extensionsPath)) { continue }
            $extDirs = Get-ChildItem $extensionsPath -Directory -ErrorAction SilentlyContinue
            foreach ($extDir in $extDirs) {
                # Pick the highest version subfolder
                $versionDirs = Get-ChildItem $extDir.FullName -Directory -ErrorAction SilentlyContinue |
                               Sort-Object Name -Descending
                if ($versionDirs.Count -eq 0) { continue }
                $candidate = Join-Path $versionDirs[0].FullName 'manifest.json'
                if (-not (Test-Path $candidate)) { continue }
                try {
                    $m = Get-Content $candidate -Raw -ErrorAction Stop | ConvertFrom-Json
                    if ($m.name -eq $TargetName) {
                        $found += $extDir.Name
                    }
                } catch { continue }
            }
        }
    }
    return ($found | Select-Object -Unique)
}

# --------------------------------------------------------------------------
# STEP 1: Collect every extension ID that should be allowed.
# --------------------------------------------------------------------------
$allowedIds = @()

# (a) The published Chrome Web Store ID - always included
Write-Host "Web Store extension ID: $WebStoreExtensionId" -ForegroundColor Green
$allowedIds += $WebStoreExtensionId

# (b) Dev-key-derived ID, if manifest.json has a "key" field
if ($b64Key) {
    $keyId = Get-ChromeExtensionIdFromKey $b64Key
    Write-Host "Dev-key extension ID:   $keyId" -ForegroundColor Green
    $allowedIds += $keyId
}

# (c) Any other IDs found by scanning installed browsers
$installedIds = Find-InstalledExtensionIds -TargetName $extName
if ($installedIds.Count -gt 0) {
    foreach ($id in $installedIds) {
        if ($allowedIds -notcontains $id) {
            Write-Host "Installed extension ID: $id" -ForegroundColor Green
            $allowedIds += $id
        }
    }
}

$allowedIds = $allowedIds | Select-Object -Unique
Write-Host ""
Write-Host "Allowing $($allowedIds.Count) extension ID(s)." -ForegroundColor Cyan
Write-Host ""

# --------------------------------------------------------------------------
# STEP 2: Write the native-host manifest (com.prism.usage.json)
# --------------------------------------------------------------------------
Write-Host "Writing native-host manifest..." -ForegroundColor Yellow

$allowedOrigins = @($allowedIds | ForEach-Object { "chrome-extension://$_/" })
$hostManifest = [ordered]@{
    name            = 'com.prism.usage'
    description     = "$extName Native Host"
    path            = $batPath
    type            = 'stdio'
    allowed_origins = $allowedOrigins
}
# Chrome's native-messaging manifest parser can be picky about line endings on
# some Windows builds - CRLF endings (PowerShell's default) have been observed
# to cause "Specified native messaging host not found" errors. Write with LF
# endings and UTF-8 (no BOM) to match the format used by Chrome's own first-
# party native hosts (e.g. Claude, KeePassXC).
$jsonText = ($hostManifest | ConvertTo-Json -Depth 10) -replace "`r`n", "`n"
[System.IO.File]::WriteAllText($manifestPath, $jsonText, [System.Text.UTF8Encoding]::new($false))
Write-Host "  -> $manifestPath" -ForegroundColor Green

# --------------------------------------------------------------------------
# STEP 3: Register with Chrome / Edge / Brave via the Windows Registry
# --------------------------------------------------------------------------
Write-Host ""
Write-Host "Registering native host..." -ForegroundColor Yellow

$regPaths = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.prism.usage',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.prism.usage',
    'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.prism.usage'
)

foreach ($regPath in $regPaths) {
    try {
        if (-not (Test-Path $regPath)) {
            New-Item -Path $regPath -Force | Out-Null
        }
        Set-ItemProperty -Path $regPath -Name '(Default)' -Value $manifestPath
        Write-Host "  -> $regPath" -ForegroundColor Green
    } catch {
        Write-Host "  !! Could not register $regPath : $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}

# --------------------------------------------------------------------------
# STEP 4: Make the Prism skins folder visible to Rainmeter
#
# Rainmeter only loads skins from <Documents>\Rainmeter\Skins\. Link or copy
# the repo's Prism folder into that directory so the widgets appear in
# Rainmeter Manager. We prefer a directory junction (changes in either
# location stay in sync); fall back to a copy if junction creation fails
# (e.g. cross-volume, no permission).
# --------------------------------------------------------------------------
Write-Host ""
Write-Host "Linking Prism skins into Rainmeter..." -ForegroundColor Yellow

$repoSkinSrc = Join-Path $repoRoot 'Prism'

if (-not (Test-Path $repoSkinSrc)) {
    Write-Host "  !! Could not find $repoSkinSrc - skipping skin link." -ForegroundColor DarkYellow
} else {
    # Find the user's Documents folder. OneDrive-redirected installs put it
    # under %USERPROFILE%\OneDrive\Documents instead of %USERPROFILE%\Documents.
    $docCandidates = @(
        (Join-Path $env:USERPROFILE 'OneDrive\Documents\Rainmeter\Skins'),
        (Join-Path $env:USERPROFILE 'Documents\Rainmeter\Skins')
    )
    $skinsRoot = $null
    foreach ($c in $docCandidates) {
        $parent = Split-Path -Parent $c
        if (Test-Path $parent) { $skinsRoot = $c; break }
    }
    if (-not $skinsRoot) { $skinsRoot = $docCandidates[-1] }

    if (-not (Test-Path $skinsRoot)) {
        New-Item -ItemType Directory -Path $skinsRoot -Force | Out-Null
        Write-Host "  Created $skinsRoot" -ForegroundColor DarkGray
    }

    $skinTarget = Join-Path $skinsRoot 'Prism'
    if (Test-Path $skinTarget) {
        # Already exists. Detect what kind: junction/symlink pointing at our
        # repo (good), or a separate copy/junction pointing elsewhere (warn).
        $existing = Get-Item $skinTarget -Force
        $isLink = ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
        if ($isLink -and $existing.Target) {
            $linkTarget = ($existing.Target | Select-Object -First 1)
            if ($linkTarget -ieq $repoSkinSrc) {
                Write-Host "  Already linked: $skinTarget -> $repoSkinSrc" -ForegroundColor DarkGray
            } else {
                Write-Host "  $skinTarget already linked to $linkTarget (leaving alone)." -ForegroundColor DarkYellow
            }
        } else {
            Write-Host "  $skinTarget already exists as a regular folder (leaving alone)." -ForegroundColor DarkYellow
            Write-Host "  Delete it first if you want this script to junction the repo here." -ForegroundColor DarkGray
        }
    } else {
        # Try junction first (no admin needed, transparent for tools)
        try {
            New-Item -ItemType Junction -Path $skinTarget -Target $repoSkinSrc -ErrorAction Stop | Out-Null
            Write-Host "  Junction: $skinTarget -> $repoSkinSrc" -ForegroundColor Green
        } catch {
            Write-Host "  Junction failed ($($_.Exception.Message)) - falling back to copy." -ForegroundColor DarkYellow
            Copy-Item -Path $repoSkinSrc -Destination $skinTarget -Recurse -Force
            Write-Host "  Copied: $repoSkinSrc -> $skinTarget" -ForegroundColor Green
            Write-Host "  Note: skin edits in the repo will NOT be reflected in Rainmeter." -ForegroundColor DarkGray
        }
    }
}

# --------------------------------------------------------------------------
# STEP 5: Activate the Prism widgets in Rainmeter
#
# If Rainmeter is running, ask it to load each widget at its last-known
# position (or default position on first run). Skipped silently if
# Rainmeter isn't installed yet -- the user can install it later and pick
# widgets manually.
# --------------------------------------------------------------------------
Write-Host ""
Write-Host "Activating Prism widgets in Rainmeter..." -ForegroundColor Yellow

# Find Rainmeter.exe. Try in order of reliability:
#   1. Running Rainmeter process (rock-solid if it's open)
#   2. App Paths registry entry (set by installer on most installs)
#   3. Get-Command (covers PATH, Chocolatey, Scoop)
#   4. Hardcoded standard install locations (final fallback)
$rainmeterExe = $null
$running = Get-Process Rainmeter -ErrorAction SilentlyContinue | Select-Object -First 1
if ($running -and $running.Path) {
    $rainmeterExe = $running.Path
}
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

if (-not $rainmeterExe) {
    Write-Host "  Rainmeter not installed - skipping widget activation." -ForegroundColor DarkYellow
    Write-Host "  Install Rainmeter from https://www.rainmeter.net/ then re-run this script." -ForegroundColor DarkGray
} else {
    # Each widget = subfolder + .ini file
    $widgets = @(
        @{ Config = 'Prism\Clock';      File = 'Clock.ini' },
        @{ Config = 'Prism\Claude';     File = 'Claude.ini' },
        @{ Config = 'Prism\ChatGPT';    File = 'ChatGPT.ini' },
        @{ Config = 'Prism\Gemini';     File = 'Gemini.ini' },
        @{ Config = 'Prism\ClaudeApi';  File = 'ClaudeApi.ini' },
        @{ Config = 'Prism\ChatGPTApi'; File = 'ChatGPTApi.ini' },
        @{ Config = 'Prism\GeminiApi';  File = 'GeminiApi.ini' }
    )
    foreach ($w in $widgets) {
        & $rainmeterExe '!ActivateConfig' $w.Config $w.File 2>$null | Out-Null
    }
    Write-Host "  Sent !ActivateConfig for $($widgets.Count) Prism widgets." -ForegroundColor Green
    Write-Host "  (Right-click any widget to reposition, change style, or unload.)" -ForegroundColor DarkGray
}

# --------------------------------------------------------------------------
# STEP 6: Bridge poller (workaround for Chrome native-messaging cache bug)
#
# In some Chrome installs, sendNativeMessage / connectNative fail in 0-1ms
# with "host not found" even though everything above is correctly configured.
# The SW still successfully fetches usage data and caches it to
# chrome.storage.local; the poller below reads that cache and pipes it to
# the same NativeHost.bat the SW would have called. See BridgePoll.py for
# the full backstory.
#
# Skipped silently if Python is not installed -- the bridge is only a
# fallback, and direct native messaging works for users on unaffected
# Chrome builds.
# --------------------------------------------------------------------------
Write-Host ""
Write-Host "Setting up bridge poller (Chrome workaround)..." -ForegroundColor Yellow

$pythonw = $null
foreach ($candidate in @(
    'C:\Program Files\Python313\pythonw.exe',
    'C:\Program Files\Python312\pythonw.exe',
    'C:\Program Files\Python311\pythonw.exe',
    'C:\Program Files\Python310\pythonw.exe'
)) {
    if (Test-Path $candidate) { $pythonw = $candidate; break }
}
if (-not $pythonw) {
    $cmd = Get-Command pythonw.exe -ErrorAction SilentlyContinue
    if ($cmd) { $pythonw = $cmd.Source }
}

$bridgeScript = Join-Path $setupDir 'BridgePoll.py'
$bridgeTaskName = 'Prism Bridge Poller'

if (-not $pythonw) {
    Write-Host "  Python not found - skipping bridge setup." -ForegroundColor DarkYellow
    Write-Host "  (If Chrome's native messaging works on your install, you don't need it.)" -ForegroundColor DarkGray
} elseif (-not (Test-Path $bridgeScript)) {
    Write-Host "  $bridgeScript missing - skipping bridge setup." -ForegroundColor DarkYellow
} else {
    try {
        # Tear down any prior registration before creating fresh
        Unregister-ScheduledTask -TaskName $bridgeTaskName -Confirm:$false -ErrorAction SilentlyContinue

        $action = New-ScheduledTaskAction -Execute $pythonw -Argument "`"$bridgeScript`""
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Days 365) `
            -RestartInterval (New-TimeSpan -Minutes 5) `
            -RestartCount 3
        $principal = New-ScheduledTaskPrincipal `
            -UserId $env:USERNAME `
            -LogonType Interactive `
            -RunLevel Limited
        Register-ScheduledTask -TaskName $bridgeTaskName `
            -Action $action -Trigger $trigger `
            -Settings $settings -Principal $principal -Force | Out-Null
        Write-Host "  Scheduled task '$bridgeTaskName' (at logon) -> OK" -ForegroundColor Green

        # Start it now too so the user doesn't have to log out
        $running = Get-CimInstance Win32_Process -Filter "Name = 'pythonw.exe'" |
            Where-Object { $_.CommandLine -like "*BridgePoll.py*" }
        if (-not $running) {
            Start-Process -FilePath $pythonw -ArgumentList "`"$bridgeScript`"" -WindowStyle Hidden | Out-Null
            Write-Host "  Started bridge poller (pythonw.exe)" -ForegroundColor Green
        } else {
            Write-Host "  Bridge poller already running (pid $($running.ProcessId))" -ForegroundColor DarkGray
        }
    } catch {
        Write-Host "  !! Bridge setup failed: $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}

Write-Host ""
Write-Host "=====================================================" -ForegroundColor Green
Write-Host "  Installation Complete!" -ForegroundColor Green
Write-Host "=====================================================" -ForegroundColor Green
Write-Host ""

if ($installedIds.Count -eq 0) {
    Write-Host "Next step:" -ForegroundColor Yellow
    Write-Host "  Install the Prism extension from the Chrome Web Store:" -ForegroundColor Yellow
    Write-Host "    https://chromewebstore.google.com/detail/prism-rainmeter/$WebStoreExtensionId" -ForegroundColor Cyan
    Write-Host "  The native host is already registered for that ID."
    Write-Host ""
} else {
    Write-Host "Tip:" -ForegroundColor Yellow
    Write-Host "  If the extension was running before this script finished, click its"
    Write-Host "  Reload button in chrome://extensions (or restart the browser) so"
    Write-Host "  the native-messaging permission takes effect."
    Write-Host ""
}
