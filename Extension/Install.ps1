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

$extensionDir    = Split-Path -Parent $PSCommandPath
$nativeHostDir   = Join-Path $extensionDir "nativehost"
$batPath         = Join-Path $nativeHostDir "NativeHost.bat"
$manifestPath    = Join-Path $nativeHostDir "com.prism.usage.json"
$extManifestPath = Join-Path $extensionDir  "manifest.json"

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
