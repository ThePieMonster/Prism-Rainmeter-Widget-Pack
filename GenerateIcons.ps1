# ==========================================================================
#  Resizes icon.png to the three sizes Chrome extensions need (16, 48, 128).
#  The source image is not modified beyond resizing.
# ==========================================================================

Add-Type -AssemblyName System.Drawing

$dir = 'C:\Users\Admin\Documents\Rainmeter\Skins\Prism\Extension'
$sourcePath = Join-Path $dir 'icon.png'

if (-not (Test-Path $sourcePath)) {
    Write-Host "ERROR: Source icon not found at $sourcePath" -ForegroundColor Red
    exit 1
}

function Resize-Icon {
    param(
        [string]$sourcePath,
        [int]$size,
        [string]$outPath
    )

    $src = [System.Drawing.Image]::FromFile($sourcePath)
    try {
        $bmp = New-Object System.Drawing.Bitmap($size, $size)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

            # Full-frame resize — no cropping, no modification beyond scaling
            $destRect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
            $g.DrawImage($src, $destRect, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel)
        } finally {
            $g.Dispose()
        }
        $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        Write-Host "Saved $outPath (${size}x${size})"
    } finally {
        $src.Dispose()
    }
}

Resize-Icon -sourcePath $sourcePath -size 128 -outPath (Join-Path $dir 'icon128.png')
Resize-Icon -sourcePath $sourcePath -size 48  -outPath (Join-Path $dir 'icon48.png')
Resize-Icon -sourcePath $sourcePath -size 16  -outPath (Join-Path $dir 'icon16.png')
