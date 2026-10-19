# ==========================================================================
#  Build-Extension.ps1
#  Packages the Chrome extension into a ZIP file ready for upload to the
#  Chrome Web Store. The extension name is read from manifest.json (the
#  single source of truth for the extension's display name).
#
#  Usage:
#    .\Build-Extension.ps1                    # builds Extension-v<version>.zip
#                                             # (version from manifest.json)
#    .\Build-Extension.ps1 -OutputDir .\dist  # custom output folder (created
#                                             # if it does not exist)
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
$manifestJson = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
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
    if (-not (Test-Path -LiteralPath (Join-Path $extDir $f))) {
        $missing += $f
    }
}
if ($missing.Count -gt 0) {
    Write-Error "Missing files: $($missing -join ', ')"
    exit 1
}

# ── Output folder (Compress-Archive does not create it) ───────────────────
# Created before anything is staged, so a bad -OutputDir fails here with
# nothing to clean up. New-Item -Force quietly returns an existing file of
# that name, hence the check. The full path is worked out first: with [ or ]
# in the current folder, PowerShell 5.1's Resolve-Path and Test-Path get a
# relative path such as "." wrong.
$outDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDir)
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
if (-not (Test-Path -LiteralPath $outDir -PathType Container)) {
    Write-Error "OutputDir is not a folder: $OutputDir"
    exit 1
}
$zipName = "Extension-v$version.zip"
$zipPath = Join-Path $outDir $zipName

# ── Stage files into a temp folder ────────────────────────────────────────
$staging = Join-Path $env:TEMP "prism-ext-build-$(Get-Random)"
$tempZip = "$staging.zip"
try {
    New-Item -ItemType Directory -Path $staging -Force | Out-Null

    foreach ($f in $includeFiles) {
        Copy-Item -LiteralPath (Join-Path $extDir $f) -Destination (Join-Path $staging $f)
    }

    # ── Strip the "key" field from manifest (Web Store assigns its own) ───
    if (-not $KeepKey) {
        $staged = Get-Content -LiteralPath (Join-Path $staging "manifest.json") -Raw | ConvertFrom-Json
        $staged.PSObject.Properties.Remove("key")
        # WriteAllText rather than Out-File: PowerShell 5.1's UTF8 encoding adds a BOM
        [System.IO.File]::WriteAllText((Join-Path $staging "manifest.json"), ($staged | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "  Stripped 'key' from manifest.json (use -KeepKey to keep it)" -ForegroundColor DarkGray
    }

    # ── Create the ZIP ────────────────────────────────────────────────────
    # Built next to the staging folder, then moved into place: in Windows
    # PowerShell 5.1, Compress-Archive cannot write to a path with [ or ].
    Compress-Archive -Path "$staging\*" -DestinationPath $tempZip -CompressionLevel Optimal
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    Move-Item -LiteralPath $tempZip -Destination $zipPath
}
finally {
    # ── Cleanup (also after a failed build) ───────────────────────────────
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tempZip -Force -ErrorAction SilentlyContinue
}

# ── Summary ───────────────────────────────────────────────────────────────
$zipSize = (Get-Item -LiteralPath $zipPath).Length
$zipSizeKB = [math]::Round($zipSize / 1024, 1)
Write-Host ""
Write-Host "  Created: $zipPath ($zipSizeKB KB)" -ForegroundColor Green
Write-Host ""
Write-Host "Upload to: https://chrome.google.com/webstore/devconsole" -ForegroundColor Yellow
Write-Host ""
