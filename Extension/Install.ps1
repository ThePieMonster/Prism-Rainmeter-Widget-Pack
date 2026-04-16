# ==========================================================================
#  Prism Extension - Automated Installation Script
#
#  This script is fully automatic - no prompts required. It:
#  1. Reads the RSA public key baked into manifest.json
#  2. Computes the deterministic Chrome extension ID from that key
#  3. Writes the Native Messaging Host manifest (com.prism.usage.json)
#  4. Registers the native host in the Windows Registry for Chrome and Edge
#
#  Because the extension ID is derived from a fixed public key in
#  manifest.json, it is the SAME on every machine - no need to look it up
#  in chrome://extensions.
# ==========================================================================

$ErrorActionPreference = 'Stop'

$extensionDir    = Split-Path -Parent $PSCommandPath
$nativeHostDir   = Join-Path $extensionDir "nativehost"
$batPath         = Join-Path $nativeHostDir "NativeHost.bat"
$manifestPath    = Join-Path $nativeHostDir "com.prism.usage.json"
$extManifestPath = Join-Path $extensionDir  "manifest.json"

Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "  Prism Usage Tracker - Automated Setup" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""

# --------------------------------------------------------------------------
# STEP 1: Read the extension's public key from manifest.json
# --------------------------------------------------------------------------
if (-not (Test-Path $extManifestPath)) {
    Write-Host "ERROR: Cannot find manifest.json at $extManifestPath" -ForegroundColor Red
    exit 1
}

$extManifest = Get-Content $extManifestPath -Raw | ConvertFrom-Json
$b64Key = $extManifest.key

if (-not $b64Key) {
    Write-Host "ERROR: manifest.json has no 'key' field. Cannot derive extension ID." -ForegroundColor Red
    Write-Host "       Regenerate the key or restore manifest.json from source." -ForegroundColor Red
    exit 1
}

# --------------------------------------------------------------------------
# STEP 2: Compute the deterministic extension ID
#
# Chrome's algorithm:
#   1. Take SHA256 of the DER-encoded public key
#   2. Use the first 16 bytes (32 hex chars)
#   3. Map each hex nibble (0-f) to a letter (a-p)
# --------------------------------------------------------------------------
$pubKeyBytes = [Convert]::FromBase64String($b64Key)
$sha         = [System.Security.Cryptography.SHA256]::Create()
$hash        = $sha.ComputeHash($pubKeyBytes)

$sb = New-Object System.Text.StringBuilder
foreach ($b in $hash[0..15]) {
    [void]$sb.Append([char]([int][char]'a' + ([int]$b -shr 4)))
    [void]$sb.Append([char]([int][char]'a' + ([int]$b -band 0x0F)))
}
$extId = $sb.ToString()

Write-Host "Extension ID: $extId" -ForegroundColor Green
Write-Host ""

# --------------------------------------------------------------------------
# STEP 3: Write the native-host manifest (com.prism.usage.json)
# --------------------------------------------------------------------------
Write-Host "Writing native-host manifest..." -ForegroundColor Yellow

$hostManifest = @{
    name            = 'com.prism.usage'
    description     = 'Prism Usage Tracker Native Host'
    path            = $batPath
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$extId/")
}
$hostManifest | ConvertTo-Json | Out-File -FilePath $manifestPath -Encoding ASCII -Force
Write-Host "  -> $manifestPath" -ForegroundColor Green

# --------------------------------------------------------------------------
# STEP 4: Register with Chrome and Edge via the Windows Registry
# --------------------------------------------------------------------------
Write-Host ""
Write-Host "Registering with Chrome and Edge..." -ForegroundColor Yellow

$regPaths = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.prism.usage',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.prism.usage'
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
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Open chrome://extensions (or edge://extensions)"
Write-Host "  2. Enable 'Developer mode' (top-right toggle)"
Write-Host "  3. Click 'Load unpacked' and select:"
Write-Host "     $extensionDir" -ForegroundColor Cyan
Write-Host "  4. The extension ID will match: $extId" -ForegroundColor Cyan
Write-Host "  5. Make sure you're logged into claude.ai / chatgpt.com / gemini.google.com"
Write-Host "  6. Click the extension icon and hit 'Refresh Now'"
Write-Host ""
Write-Host "If you had the extension loaded BEFORE running this script,"
Write-Host "click the reload button on its card in chrome://extensions to pick up"
Write-Host "the new deterministic ID."
Write-Host ""
