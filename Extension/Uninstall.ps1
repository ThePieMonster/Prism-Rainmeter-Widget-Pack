# Removes registry entries for the Prism native messaging host.
# You'll still need to remove the extension from chrome://extensions manually.

$regPaths = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.prism.usage',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.prism.usage'
)

foreach ($regPath in $regPaths) {
    if (Test-Path $regPath) {
        Remove-Item -Path $regPath -Force -Recurse
        Write-Host "Removed: $regPath" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "Native host registration removed."
Write-Host "To remove the extension, go to chrome://extensions and click 'Remove'."
