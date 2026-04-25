# ==========================================================================
#  Build-Extension.ps1
#  Packages the Chrome extension into a ZIP file ready for upload to the
#  Chrome Web Store. The extension name is read from manifest.json (the
#  single source of truth for the extension's display name).
#
#  Usage:
#    .\Build-Extension.ps1                    # builds Extension-v1.0.0.zip
#    .\Build-Extension.ps1 -OutputDir .\dist  # custom output folder
#    .\Build-Extension.ps1 -KeepKey           # keep the manifest "key" field
# ==========================================================================

param(
    [string]$OutputDir = ".",
    [switch]$KeepKey
)

$ErrorActionPreference = 'Stop'

$repoRoot   = Split-Path -Parent $PSCommandPath
$extDir     = Join-Path $repoRoot "Extension"
$manifest   = Join-Path $extDir "manifest.json"

# ── Read name + version from manifest ─────────────────────────────────────
$manifestJson = Get-Content $manifest -Raw | ConvertFrom-Json
$extName = $manifestJson.name
$version = $manifestJson.version
Write-Host "Building $extName v$version ..." -ForegroundColor Cyan

# ── Files to include (everything the extension actually needs) ────────────
$includeFiles = @(
    "manifest.json"
    "background.js"
    "logger.js"
    "popup.html"
    "popup.js"
    "gemini-content.js"
    "openai-content.js"
    "aistudio-content.js"
    "icon16.png"
    "icon48.png"
    "icon128.png"
)

# ── Verify all files exist ────────────────────────────────────────────────
$missing = @()
foreach ($f in $includeFiles) {
    if (-not (Test-Path (Join-Path $extDir $f))) {
        $missing += $f
    }
}
if ($missing.Count -gt 0) {
    Write-Error "Missing files: $($missing -join ', ')"
    exit 1
}

# ── Stage files into a temp folder ────────────────────────────────────────
$staging = Join-Path $env:TEMP "prism-ext-build-$(Get-Random)"
New-Item -ItemType Directory -Path $staging -Force | Out-Null

foreach ($f in $includeFiles) {
    Copy-Item (Join-Path $extDir $f) (Join-Path $staging $f)
}

# ── Strip the "key" field from manifest (Web Store assigns its own) ───────
if (-not $KeepKey) {
    $staged = Get-Content (Join-Path $staging "manifest.json") -Raw | ConvertFrom-Json
    $staged.PSObject.Properties.Remove("key")
    $staged | ConvertTo-Json -Depth 10 | Out-File (Join-Path $staging "manifest.json") -Encoding UTF8
    Write-Host "  Stripped 'key' from manifest.json (use -KeepKey to keep it)" -ForegroundColor DarkGray
}

# ── Create the ZIP ────────────────────────────────────────────────────────
$outDir = Resolve-Path $OutputDir -ErrorAction SilentlyContinue
if (-not $outDir) { $outDir = $OutputDir }
$zipName = "Extension-v$version.zip"
$zipPath = Join-Path $outDir $zipName

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

Compress-Archive -Path "$staging\*" -DestinationPath $zipPath -CompressionLevel Optimal

# ── Cleanup ───────────────────────────────────────────────────────────────
Remove-Item $staging -Recurse -Force

# ── Summary ───────────────────────────────────────────────────────────────
$zipSize = (Get-Item $zipPath).Length
$zipSizeKB = [math]::Round($zipSize / 1024, 1)
Write-Host ""
Write-Host "  Created: $zipPath ($zipSizeKB KB)" -ForegroundColor Green
Write-Host ""
Write-Host "Upload to: https://chrome.google.com/webstore/devconsole" -ForegroundColor Yellow
Write-Host ""
