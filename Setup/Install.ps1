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
#    3. Write those IDs into allowed_origins so the native host accepts
#       messages from either. Installed extensions are never matched by
#       display name: any publisher can reuse a name.
#
#  Then links the Prism skins into Rainmeter, loads the widgets and sets up
#  the bridge poller (STEP 4-6 below).
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
if (-not (Test-Path -LiteralPath $extManifestPath)) {
    Write-Host "ERROR: Cannot find manifest.json at $extManifestPath" -ForegroundColor Red
    exit 1
}

$extManifest = Get-Content -LiteralPath $extManifestPath -Raw | ConvertFrom-Json
$extName = $extManifest.name
$b64Key  = $extManifest.key

Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "  $extName - Automated Setup" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""

# Nothing here needs admin rights: the registry keys, the skins link and the
# scheduled task are all per-user. Run elevated, a poller or Rainmeter started
# from here would run as administrator, and with a different admin account
# everything would land in that account's profile instead of yours.
$isElevated = $false
try {
    $isElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { $isElevated = $false }
if ($isElevated) {
    Write-Host "Note: Setup is running as administrator, which it does not need." -ForegroundColor DarkYellow
    Write-Host "      Everything it sets up is for the account it runs as. If that is not" -ForegroundColor DarkYellow
    Write-Host "      the account you use day to day, close this window and double-click" -ForegroundColor DarkYellow
    Write-Host "      Setup.bat from your own account instead." -ForegroundColor DarkYellow
    Write-Host ""
}

# --------------------------------------------------------------------------
# Helper: compute Chrome's deterministic extension ID from a base64 key.
#   1. SHA256 of DER-encoded public key bytes
#   2. First 16 bytes -> 32 hex chars -> map each nibble (0-f) to a-p
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
# Helper: is the extension installed under one of the allowed IDs in any
# Chrome (stable, Beta, Dev, Canary) / Edge / Brave profile? Only picks the
# closing hint; it never adds an ID. A store install has an Extensions\<id>
# folder; an unpacked one only gets Local Extension Settings\<id> once it
# has run. Same browser folders BridgePoll.py scans.
# --------------------------------------------------------------------------
function Test-PrismExtensionInstalled {
    param([string[]]$Ids)
    $userDataRoots = @(
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome Beta\User Data'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome Dev\User Data'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome SxS\User Data'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data'),
        (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\User Data')
    )
    foreach ($root in $userDataRoots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $profileDirs = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
                       Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' }
        foreach ($profileDir in $profileDirs) {
            foreach ($id in $Ids) {
                if ((Test-Path -LiteralPath (Join-Path $profileDir.FullName "Extensions\$id")) -or
                    (Test-Path -LiteralPath (Join-Path $profileDir.FullName "Local Extension Settings\$id"))) {
                    return $true
                }
            }
        }
    }
    return $false
}

# --------------------------------------------------------------------------
# Helpers: find Rainmeter's Skins folder. NativeHost.ps1 and Uninstall.ps1
# resolve it the same way, so keep the three in sync:
#   1. SkinPath under [Rainmeter] in %APPDATA%\Rainmeter\Rainmeter.ini
#   2. <Documents>\Rainmeter\Skins when that Rainmeter folder exists
#      (GetFolderPath follows OneDrive and GPO Documents redirection)
#   3. Rainmeter\Skins under %USERPROFILE%\OneDrive\Documents, then
#      %USERPROFILE%\Documents, preferring one whose Rainmeter folder exists
# Get-SkinsRoots returns that folder first, then the other candidates. The
# skin folder Rainmeter shows is <first>\Prism.
# --------------------------------------------------------------------------
function Test-Folder($path) {
    if (-not $path) { return $false }
    try { return [bool](Test-Path -LiteralPath $path -PathType Container) } catch { return $false }
}

function Get-DocumentsFolder {
    try { return [Environment]::GetFolderPath('MyDocuments') } catch { return $null }
}

function Get-SkinsRoots($appData, $myDocuments, $userProfile) {
    $skinPathRoot = $null
    if ($appData) {
        try {
            $rmIni = Join-Path $appData 'Rainmeter\Rainmeter.ini'
            if ([System.IO.File]::Exists($rmIni)) {
                # Rainmeter writes this file as UTF-16 LE with a BOM;
                # ReadAllLines follows the BOM (ANSI without one).
                $section = ''
                foreach ($line in [System.IO.File]::ReadAllLines($rmIni, [System.Text.Encoding]::Default)) {
                    if ($line -match '^\s*\[(.*)\]\s*$') { $section = $Matches[1].Trim(); continue }
                    if ($section -eq 'Rainmeter' -and $line -match '^\s*SkinPath\s*=(.*)$') {
                        $value = $Matches[1].Trim() -replace '^"(.*)"$', '$1'
                        $value = [Environment]::ExpandEnvironmentVariables($value)
                        if ($value) {
                            if (-not [System.IO.Path]::IsPathRooted($value)) {
                                $value = Join-Path (Split-Path -Parent $rmIni) $value
                            }
                            $skinPathRoot = $value.TrimEnd('\')
                        }
                        break
                    }
                }
            }
        } catch { $skinPathRoot = $null }
    }

    # Join-Path throws for a drive that is not mapped (an offline network
    # share, say); such a folder is simply not a candidate.
    $myDocsRoot = $null
    if ($myDocuments) { try { $myDocsRoot = Join-Path $myDocuments 'Rainmeter\Skins' } catch { } }
    $guesses = @()
    if ($userProfile) {
        $guesses = @(
            (Join-Path $userProfile 'OneDrive\Documents\Rainmeter\Skins'),
            (Join-Path $userProfile 'Documents\Rainmeter\Skins')
        )
    }

    $resolved = $null
    if ($skinPathRoot) {
        $resolved = $skinPathRoot
    } elseif ($myDocsRoot -and (Test-Folder (Split-Path -Parent $myDocsRoot))) {
        $resolved = $myDocsRoot
    } else {
        foreach ($g in $guesses) {
            if (Test-Folder (Split-Path -Parent $g)) { $resolved = $g; break }
        }
        if (-not $resolved -and $guesses.Count -gt 0) { $resolved = $guesses[-1] }
    }

    $roots = @()
    $seen = @{}
    foreach ($r in (@($resolved, $skinPathRoot, $myDocsRoot) + $guesses)) {
        if (-not $r) { continue }
        $key = $r.TrimEnd('\')
        try { $key = [System.IO.Path]::GetFullPath($key).TrimEnd('\') } catch { }
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $roots += $r
    }
    return $roots
}

# --------------------------------------------------------------------------
# Helper: the Skins folder of a portable Rainmeter, or $null when
# $RainmeterExe is not one. A portable Rainmeter keeps Rainmeter.ini next to
# Rainmeter.exe, reads SkinPath from there (<exe folder>\Skins without one)
# and ignores %APPDATA%\Rainmeter. Only Setup needs this, so it is not part
# of Get-SkinsRoots: NativeHost.ps1 falls back to this pack's own
# Prism\@Resources, which is the folder STEP 4 links into that Skins folder,
# and Uninstall.ps1 resets that folder too. STEP 4 warns when the host would
# write somewhere else.
# --------------------------------------------------------------------------
function Get-PortableSkinsRoot([string]$RainmeterExe) {
    if (-not $RainmeterExe) { return $null }
    try {
        $exeDir = Split-Path -Parent $RainmeterExe
        $rmIni = Join-Path $exeDir 'Rainmeter.ini'
        if (-not [System.IO.File]::Exists($rmIni)) { return $null }
        $value = $null
        $section = ''
        foreach ($line in [System.IO.File]::ReadAllLines($rmIni, [System.Text.Encoding]::Default)) {
            if ($line -match '^\s*\[(.*)\]\s*$') { $section = $Matches[1].Trim(); continue }
            if ($section -eq 'Rainmeter' -and $line -match '^\s*SkinPath\s*=(.*)$') {
                $value = [Environment]::ExpandEnvironmentVariables(($Matches[1].Trim() -replace '^"(.*)"$', '$1'))
                break
            }
        }
        if (-not $value) { $value = 'Skins' }
        if (-not [System.IO.Path]::IsPathRooted($value)) { $value = Join-Path $exeDir $value }
        return $value.TrimEnd('\')
    } catch { return $null }
}

# --------------------------------------------------------------------------
# Helper: find Rainmeter.exe. Try in order of reliability:
#   1. Running Rainmeter process (rock-solid if it's open)
#   2. App Paths registry entry (set by installer on most installs)
#   3. Get-Command (covers PATH, Chocolatey, Scoop)
#   4. Hardcoded standard install locations (final fallback)
# --------------------------------------------------------------------------
function Find-RainmeterExe {
    $proc = Get-Process Rainmeter -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc -and $proc.Path) { return $proc.Path }
    $appPathsKey = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\Rainmeter.exe'
    if (Test-Path $appPathsKey) {
        $val = (Get-ItemProperty $appPathsKey -ErrorAction SilentlyContinue).'(default)'
        if ($val) { $val = $val.Trim('"') }
        if ($val -and (Test-Path -LiteralPath $val)) { return $val }
    }
    $cmd = Get-Command Rainmeter.exe -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    foreach ($candidate in @(
        'C:\Program Files\Rainmeter\Rainmeter.exe',
        'C:\Program Files (x86)\Rainmeter\Rainmeter.exe'
    )) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

# --------------------------------------------------------------------------
# Helpers: is Rainmeter running and able to take bangs? Rainmeter.exe hands
# a bang to the running instance's hidden control window (class
# DummyRainWClass) and drops it when there is none, so that window, not the
# process or a visible skin, is what "ready" means here.
# --------------------------------------------------------------------------
$script:rmCanFindWindow = $null
function Test-RainmeterReady {
    if ($null -eq $script:rmCanFindWindow) {
        $script:rmCanFindWindow = $false
        try {
            Add-Type -Namespace PrismSetup -Name NativeMethods -ErrorAction Stop -MemberDefinition `
                '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);'
            $script:rmCanFindWindow = $true
        } catch { }
    }
    if ($script:rmCanFindWindow) {
        # [NullString]::Value, not $null: PowerShell passes $null to a string
        # parameter as '', which would only match an untitled window, and
        # Rainmeter's control window has a title.
        return ([PrismSetup.NativeMethods]::FindWindow('DummyRainWClass', [NullString]::Value) -ne [IntPtr]::Zero)
    }
    return [bool](Get-Process Rainmeter -ErrorAction SilentlyContinue)
}

function Start-RainmeterAndWait {
    param([string]$Exe, [int]$TimeoutSec = 20)
    Start-Process -FilePath $Exe -WorkingDirectory (Split-Path -Parent $Exe) | Out-Null
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-RainmeterReady) {
            # Without FindWindow only the process is known; give it time to
            # create its control window.
            if (-not $script:rmCanFindWindow) { Start-Sleep -Seconds 3 }
            return $true
        }
        Start-Sleep -Milliseconds 250
    }
    return $false
}

# --------------------------------------------------------------------------
# Helper: read the Active= value of every config in Rainmeter.ini (portable
# installs keep it next to Rainmeter.exe). Active=0 means the user unloaded
# that widget. Returns @{} when there is no readable Rainmeter.ini.
# --------------------------------------------------------------------------
function Get-RainmeterActiveStates {
    param([string]$RainmeterExe)
    $states = @{}
    $iniPaths = @()
    if ($RainmeterExe) { $iniPaths += Join-Path (Split-Path -Parent $RainmeterExe) 'Rainmeter.ini' }
    if ($env:APPDATA) { $iniPaths += Join-Path $env:APPDATA 'Rainmeter\Rainmeter.ini' }
    foreach ($ini in $iniPaths) {
        if (-not [System.IO.File]::Exists($ini)) { continue }
        $section = ''
        foreach ($line in [System.IO.File]::ReadAllLines($ini, [System.Text.Encoding]::Default)) {
            if ($line -match '^\s*\[(.*)\]\s*$') { $section = $Matches[1].Trim(); continue }
            if ($section -and $line -match '^\s*Active\s*=\s*(-?\d+)') { $states[$section] = [int]$Matches[1] }
        }
        break
    }
    return $states
}

# --------------------------------------------------------------------------
# Helper: carry the style/theme picked in an older release over to this
# pack's Settings.inc (the widgets' right-click menus write it there). Only
# CurrentStyle and CurrentTheme are copied, and only when this pack ships
# that style. The file keeps its encoding and line endings.
# --------------------------------------------------------------------------
function Get-SettingsValue([string]$Text, [string]$Key) {
    $m = [regex]::Match($Text, "(?im)^[ \t]*$Key[ \t]*=[ \t]*([^\r\n]*?)[ \t]*\r?$")
    if ($m.Success) { return $m.Groups[1].Value }
    return $null
}

function Copy-StyleSettings {
    param([string]$OldSettings, [string]$NewSettings, [string]$StylesDir)
    if (-not (Test-Path -LiteralPath $OldSettings -PathType Leaf) -or
        -not (Test-Path -LiteralPath $NewSettings -PathType Leaf)) { return }

    $oldText = [System.IO.File]::ReadAllText($OldSettings, [System.Text.Encoding]::Default)
    $reader = New-Object System.IO.StreamReader($NewSettings, [System.Text.Encoding]::Default, $true)
    try {
        $newText = $reader.ReadToEnd()
        $encoding = $reader.CurrentEncoding
    } finally { $reader.Dispose() }

    $oldStyle = Get-SettingsValue $oldText 'CurrentStyle'
    $oldTheme = Get-SettingsValue $oldText 'CurrentTheme'
    $newStyle = Get-SettingsValue $newText 'CurrentStyle'
    $newTheme = Get-SettingsValue $newText 'CurrentTheme'
    if (-not $oldStyle -and -not $oldTheme) { return }

    $style = $newStyle
    $theme = $newTheme
    if ($oldStyle) { $style = $oldStyle }
    if ($oldTheme) { $theme = $oldTheme }
    if ($style -eq $newStyle -and $theme -eq $newTheme) { return }

    # The values end up in an @Include path (Styles\<Style>-<Theme>.inc).
    $usable = $newStyle -and $newTheme -and
              $style -match '^[A-Za-z0-9 _-]+$' -and $theme -match '^[A-Za-z0-9 _-]+$' -and
              (Test-Path -LiteralPath (Join-Path $StylesDir "$style-$theme.inc") -PathType Leaf)
    if (-not $usable) {
        Write-Host "  Your old style/theme ($style / $theme) is not in this release; pick one from any widget's right-click menu." -ForegroundColor DarkGray
        return
    }

    $newText = $newText -replace '(?im)^([ \t]*CurrentStyle[ \t]*=)[^\r\n]*', ('${1}' + $style)
    $newText = $newText -replace '(?im)^([ \t]*CurrentTheme[ \t]*=)[^\r\n]*', ('${1}' + $theme)
    [System.IO.File]::WriteAllText($NewSettings, $newText, $encoding)
    Write-Host "  Kept your style/theme from the old release ($style / $theme) in $NewSettings" -ForegroundColor Green
}

# --------------------------------------------------------------------------
# Helper: is $Other the folder $Folder? Comparing the strings misses a second
# spelling of one folder (a junction or symlink alias, a mapped drive versus
# its UNC path, an 8.3 short name), so a uniquely named empty file is written
# into $Folder, looked for under $Other and deleted again.
# --------------------------------------------------------------------------
function Test-SameFolder([string]$Folder, [string]$Other) {
    if (Test-SamePath $Folder $Other) { return $true }
    if (-not (Test-Folder $Folder) -or -not (Test-Folder $Other)) { return $false }
    $name = '.prism-setup-' + [guid]::NewGuid().ToString('N') + '.tmp'
    $marker = Join-Path $Folder $name
    try {
        [System.IO.File]::WriteAllText($marker, '')
        return [System.IO.File]::Exists((Join-Path $Other $name))
    } catch {
        return $false
    } finally {
        try { if ([System.IO.File]::Exists($marker)) { [System.IO.File]::Delete($marker) } } catch { }
    }
}

# --------------------------------------------------------------------------
# Helper: was this ConsumerData.inc written by a host older than 1.3? Those
# files have the host's keys but not ClaudeApiStale, which every 1.3 host
# write includes. Only such a file is ever replaced by the seed in STEP 4.
# --------------------------------------------------------------------------
function Test-OldConsumerData([string]$Path) {
    try { $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::Default) } catch { return $false }
    return (($text -match '(?im)^[ \t]*ClaudeConsumerConnected[ \t]*=') -and
            ($text -notmatch '(?im)^[ \t]*ClaudeApiStale[ \t]*='))
}

# --------------------------------------------------------------------------
# Helper: find pythonw.exe (Python 3.10+) for the bridge poller. Checks, in
# order: PEP 514 registrations (HKCU, then HKLM 64- and 32-bit; covers the
# python.org per-user and all-users installers), the default python.org
# install folders, then pythonw.exe on PATH (also the Microsoft Store and
# Python install manager aliases). The newest 3.x wins; free-threaded (3.13t)
# and pre-release builds are skipped. Returns the full path, or $null.
# --------------------------------------------------------------------------
function Find-Pythonw {
    $found = @()
    $order = 0
    $packagedRoot = $null
    if ($env:ProgramFiles) { $packagedRoot = (Join-Path $env:ProgramFiles 'WindowsApps') + '\' }

    foreach ($root in @(
        'HKCU:\Software\Python\PythonCore',
        'HKLM:\Software\Python\PythonCore',
        'HKLM:\Software\WOW6432Node\Python\PythonCore'
    )) {
        try {
            if (-not (Test-Path -LiteralPath $root)) { continue }
            foreach ($tagKey in @(Get-ChildItem -LiteralPath $root -ErrorAction Stop)) {
                if ($tagKey.PSChildName -notmatch '^3\.(\d+)(-(32|64|arm64))?$') { continue }
                $minor = [int]$Matches[1]
                if ($minor -lt 10) { continue }
                $version = $tagKey.GetValue('Version')
                if ($version -and "$version" -notmatch '^\d+(\.\d+)*$') { continue }
                $installKey = Get-Item -LiteralPath (Join-Path $tagKey.PSPath 'InstallPath') -ErrorAction SilentlyContinue
                if (-not $installKey) { continue }
                $exe = $installKey.GetValue('WindowedExecutablePath')
                if (-not $exe) {
                    $dir = $installKey.GetValue('')
                    if ($dir) { $exe = Join-Path $dir 'pythonw.exe' }
                }
                if (-not $exe) { continue }
                $order++
                $found += [pscustomobject]@{ Minor = $minor; Order = $order; Path = "$exe" }
            }
        } catch { }
    }

    $folderRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)})
    if ($env:LOCALAPPDATA) { $folderRoots = @(Join-Path $env:LOCALAPPDATA 'Programs\Python') + $folderRoots }
    foreach ($base in $folderRoots) {
        if (-not (Test-Folder $base)) { continue }
        foreach ($dir in @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue)) {
            if ($dir.Name -notmatch '^Python3(\d+)(-32|-arm64)?$') { continue }
            $minor = [int]$Matches[1]
            if ($minor -lt 10) { continue }
            $order++
            $found += [pscustomobject]@{ Minor = $minor; Order = $order; Path = (Join-Path $dir.FullName 'pythonw.exe') }
        }
    }

    # The Store package folder itself cannot be launched directly; its PATH
    # alias (found by Get-Command below) can.
    $usable = @($found | Where-Object {
        (Test-Path -LiteralPath $_.Path -PathType Leaf) -and
        -not ($packagedRoot -and $_.Path.StartsWith($packagedRoot, [StringComparison]::OrdinalIgnoreCase))
    } | Sort-Object @{ Expression = 'Minor'; Descending = $true }, @{ Expression = 'Order'; Descending = $false })
    if ($usable.Count -gt 0) { return $usable[0].Path }

    $cmd = Get-Command pythonw.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    return $null
}

# --------------------------------------------------------------------------
# Helpers: bridge pollers running in this logon session, from any pack
# folder. A poller is a python*.exe (python, pythonw, pythonw3.12, ...)
# whose command line runs BridgePoll.py as its script:
#     "<python>" [-u ...] "<folder>\BridgePoll.py"
# Editors that merely have the file open, and python -m tools given its
# path, do not match. A python process whose command line cannot be read
# (started as administrator while this runs without) is returned with Kind
# 'Unknown'. Uninstall.ps1 has the same matcher; keep them in sync.
# --------------------------------------------------------------------------
function Get-BridgePollers {
    $pattern = '(?i)^\s*(?:"[^"]*"|[^\s"]+)(?:\s+"?-[A-Za-z]+"?)*\s+(?:"(?<script>(?:[^"]*[\\/])?BridgePoll\.py)"|(?<script>(?:[^\s"]*[\\/])?BridgePoll\.py))(?:\s|$)'
    $sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name LIKE 'python%'" -ErrorAction Stop)) {
        if ($p.SessionId -ne $sessionId) { continue }
        if ($p.Name -notmatch '^pythonw?(\d+(\.\d+)*t?)?\.exe$') { continue }
        if (-not $p.CommandLine) {
            [pscustomobject]@{ ProcessId = $p.ProcessId; Name = $p.Name; Kind = 'Unknown'; ScriptPath = $null }
        } elseif ($p.CommandLine -match $pattern) {
            [pscustomobject]@{ ProcessId = $p.ProcessId; Name = $p.Name; Kind = 'Poller'; ScriptPath = $Matches['script'] }
        }
    }
}

function Test-SamePath([string]$A, [string]$B) {
    if (-not $A -or -not $B) { return $false }
    try {
        return ([System.IO.Path]::GetFullPath($A).TrimEnd('\') -ieq [System.IO.Path]::GetFullPath($B).TrimEnd('\'))
    } catch { return $false }
}

function Stop-BridgePollers {
    $procs = @(Get-BridgePollers)
    $stopped = @()
    foreach ($p in @($procs | Where-Object { $_.Kind -eq 'Poller' })) {
        try {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
            Write-Host "  Stopped bridge poller pid $($p.ProcessId) ($($p.ScriptPath))" -ForegroundColor DarkGray
            $stopped += $p.ProcessId
        } catch {
            Write-Host "  !! Could not stop bridge poller pid $($p.ProcessId): $($_.Exception.Message)" -ForegroundColor DarkYellow
        }
    }
    if ($stopped.Count -gt 0) {
        try { Wait-Process -Id $stopped -Timeout 5 -ErrorAction SilentlyContinue } catch { }
    }
    $unknown = @($procs | Where-Object { $_.Kind -eq 'Unknown' })
    if ($unknown.Count -gt 0 -and -not $isElevated) {
        $list = ($unknown | ForEach-Object { "$($_.Name) pid $($_.ProcessId)" }) -join ', '
        Write-Host "  !! Could not check $list (started as administrator?)." -ForegroundColor DarkYellow
        Write-Host "     If that is an older bridge poller, it keeps running until you sign out." -ForegroundColor DarkGray
    }
}

function Wait-BridgePoller {
    param([string]$Script, [int]$TimeoutSec = 5)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ($true) {
        $match = @(Get-BridgePollers | Where-Object { $_.Kind -eq 'Poller' -and (Test-SamePath $_.ScriptPath $Script) })
        if ($match.Count -gt 0) { return $match[0] }
        if ((Get-Date) -ge $deadline) { return $null }
        Start-Sleep -Milliseconds 250
    }
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

$allowedIds = @($allowedIds | Select-Object -Unique)
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
# Rainmeter only loads skins from its Skins folder (see Get-SkinsRoots, and
# Get-PortableSkinsRoot for a portable Rainmeter).
# Link or copy the repo's Prism folder into that directory so the widgets
# appear in Rainmeter Manager. We prefer a directory junction (changes in
# either location stay in sync); fall back to a copy if junction creation
# fails (e.g. cross-volume, no permission).
#
# The Skins folder is never created before Rainmeter's first start:
# Rainmeter only installs its default skins and layout into a Skins folder
# it creates itself.
#
# On upgrade, Skins\Prism may already be a junction to an older extracted
# release. The native host registered above writes ConsumerData.inc through
# that path, so a stale junction would feed this release's data to the old
# skins. Re-point it here. A regular folder (copy-fallback install) is never
# deleted; the user gets instructions instead.
#
# Once the skins are linked (or copied), a missing ConsumerData.inc, or one
# an older release's host wrote, is replaced with the disconnected stub (see
# the end of this step).
# --------------------------------------------------------------------------
Write-Host ""
Write-Host "Linking Prism skins into Rainmeter..." -ForegroundColor Yellow

$rainmeterExe = Find-RainmeterExe
$repoSkinSrc = Join-Path $repoRoot 'Prism'
$skinTarget = $null

if (-not (Test-Path -LiteralPath $repoSkinSrc)) {
    Write-Host "  !! Could not find $repoSkinSrc - skipping skin link." -ForegroundColor DarkYellow
} else {
    $portableRoot = Get-PortableSkinsRoot $rainmeterExe
    if ($portableRoot) {
        $skinsRoot = $portableRoot
        Write-Host "  Portable Rainmeter in $(Split-Path -Parent $rainmeterExe)" -ForegroundColor DarkGray
    } else {
        $skinsRoot = @(Get-SkinsRoots $env:APPDATA (Get-DocumentsFolder) $env:USERPROFILE)[0]
    }
    $rainmeterIni = $null
    if ($env:APPDATA) { $rainmeterIni = Join-Path $env:APPDATA 'Rainmeter\Rainmeter.ini' }
    $rmStartTried = $false

    # Has Rainmeter run before, so its default skins were already offered
    # once? A normal install has then written %APPDATA%\Rainmeter\Rainmeter.ini.
    # A portable one ships its Rainmeter.ini, so there only a running
    # Rainmeter shows it.
    $rmHasRun = $false
    if ($portableRoot) {
        try { $rmHasRun = [bool](Test-RainmeterReady) } catch { $rmHasRun = $false }
    } else {
        $rmHasRun = [bool]($rainmeterIni -and (Test-Path -LiteralPath $rainmeterIni))
    }

    if (-not (Test-Folder $skinsRoot) -and -not $rmHasRun -and
        $rainmeterExe -and -not $isElevated -and -not (Test-RainmeterReady)) {
        # Installed but never started: let Rainmeter create its own folders.
        Write-Host "  Starting Rainmeter once so it can set up its Skins folder..." -ForegroundColor DarkGray
        $rmStartTried = $true
        try {
            if (Start-RainmeterAndWait -Exe $rainmeterExe) {
                # $rainmeterExe can be a launcher (a PATH shim, an App Paths
                # entry) for a portable Rainmeter elsewhere. Only the running
                # processes name the Rainmeter.exe that actually started.
                if (-not $portableRoot) {
                    foreach ($rmProc in @(Get-Process Rainmeter -ErrorAction SilentlyContinue)) {
                        $startedRoot = Get-PortableSkinsRoot $rmProc.Path
                        if ($startedRoot) {
                            $rainmeterExe = $rmProc.Path
                            $portableRoot = $startedRoot
                            $skinsRoot = $portableRoot
                            Write-Host "  Portable Rainmeter in $(Split-Path -Parent $rainmeterExe)" -ForegroundColor DarkGray
                            break
                        }
                    }
                }
                $deadline = (Get-Date).AddSeconds(15)
                while ((Get-Date) -lt $deadline) {
                    if (-not $portableRoot) {
                        $skinsRoot = @(Get-SkinsRoots $env:APPDATA (Get-DocumentsFolder) $env:USERPROFILE)[0]
                    }
                    if (Test-Folder $skinsRoot) { break }
                    Start-Sleep -Milliseconds 500
                }
            }
        } catch {
            Write-Host "  !! Could not start Rainmeter: $($_.Exception.Message)" -ForegroundColor DarkYellow
        }
    }

    if (-not (Test-Folder $skinsRoot)) {
        $rmRunning = $false
        try { $rmRunning = [bool](Test-RainmeterReady) } catch { $rmRunning = $false }
        if ($portableRoot) {
            $rmHasRun = $rmRunning
        } else {
            $rmHasRun = [bool]($rainmeterIni -and (Test-Path -LiteralPath $rainmeterIni))
        }
        if ($rmHasRun) {
            try {
                New-Item -ItemType Directory -Path $skinsRoot -Force | Out-Null
                Write-Host "  Created $skinsRoot" -ForegroundColor DarkGray
            } catch {
                Write-Host "  !! Could not create $skinsRoot : $($_.Exception.Message)" -ForegroundColor DarkYellow
            }
        } elseif ($rmRunning) {
            # Running, but not with a Rainmeter.ini Setup knows of (started
            # with its own settings file, say), so its Skins folder is unknown.
            # The native host writes only to the Skins folders Get-SkinsRoots
            # lists, else to this pack's own @Resources, so only a link to
            # this pack gets usage data there.
            Write-Host "  Rainmeter is running, but Setup could not find its Skins folder - skipping skin link." -ForegroundColor DarkYellow
            Write-Host "  Link $repoSkinSrc into the Skins folder that Rainmeter uses" -ForegroundColor DarkGray
            Write-Host "  (in a Command Prompt: mklink /J ""<Skins folder>\Prism"" ""$repoSkinSrc"")," -ForegroundColor DarkGray
            Write-Host "  then load the widgets from Rainmeter > Manage. A copy gets no usage data." -ForegroundColor DarkGray
        } else {
            Write-Host "  Rainmeter has not created its Skins folder yet - skipping skin link." -ForegroundColor DarkYellow
            Write-Host "  (Creating it first would stop Rainmeter from installing its default skins.)" -ForegroundColor DarkGray
            if ($rmStartTried) {
                Write-Host "  Once Rainmeter is running, re-run Setup\Setup.bat." -ForegroundColor DarkGray
            } elseif ($rainmeterExe) {
                Write-Host "  Start Rainmeter once, then re-run Setup\Setup.bat." -ForegroundColor DarkGray
            }
        }
    }

    if (Test-Folder $skinsRoot) {
        $skinTarget = Join-Path $skinsRoot 'Prism'
        $createLink = $true
        $skinsReady = $false
        # Get-Item rather than Test-Path so a junction whose target folder was
        # deleted (an old release cleaned up after extracting this one) is still
        # detected and replaced.
        $existing = Get-Item -LiteralPath $skinTarget -Force -ErrorAction SilentlyContinue
        if ($existing) {
            # Plain folders (including OneDrive placeholders, which are reparse
            # points too) have no LinkType/Target.
            $linkTarget = $null
            if ($existing.LinkType -and $existing.Target) {
                $linkTarget = ($existing.Target | Select-Object -First 1).TrimEnd('\')
            }

            if (-not $linkTarget) {
                # Copy-fallback install from an earlier run, or a manual copy.
                # Never delete it: it may hold the user's own edits.
                $createLink = $false
                Write-Host "  !! $skinTarget is a regular folder, not a link to this pack." -ForegroundColor Yellow
                Write-Host "     It is a separate copy (from an earlier Setup run or a manual install)," -ForegroundColor Yellow
                if ($portableRoot) {
                    Write-Host "     so the widgets may be older than this release." -ForegroundColor Yellow
                } else {
                    Write-Host "     so the widgets may be older than this release while the native host" -ForegroundColor Yellow
                    Write-Host "     registered above writes its data into that copy." -ForegroundColor Yellow
                }
                Write-Host "     To update the skins:" -ForegroundColor Yellow
                Write-Host "       1. Exit Rainmeter (right-click its tray icon, then Exit)."
                Write-Host "       2. Move $skinTarget out of the Skins folder (or delete it)."
                Write-Host "          Back up any skin files you edited first."
                Write-Host "       3. Re-run Setup\Setup.bat to link $repoSkinSrc in its place."
            } elseif (Test-SameFolder $repoSkinSrc $linkTarget) {
                # Also when Setup runs through another path to this pack (a
                # junction to it, a mapped drive): re-pointing would be a no-op
                # and the "old release" advice below would name this pack.
                $createLink = $false
                $skinsReady = $true
                Write-Host "  Already linked: $skinTarget -> $repoSkinSrc" -ForegroundColor DarkGray
                if (-not (Test-SamePath $repoSkinSrc $linkTarget)) {
                    Write-Host "    (as $linkTarget, the same folder)" -ForegroundColor DarkGray
                }
            } elseif ($existing.LinkType -ne 'Junction') {
                # Setup only ever creates junctions, so a symlink is the user's own.
                $createLink = $false
                Write-Host "  !! $skinTarget is a $($existing.LinkType) to $linkTarget (leaving alone)." -ForegroundColor DarkYellow
                Write-Host "     Remove that link yourself, then re-run Setup\Setup.bat to link $repoSkinSrc." -ForegroundColor DarkGray
            } else {
                # Junction to a different Prism folder, usually an older release.
                # A non-recursive delete of a junction removes only the link; the
                # folder it points to is left exactly as it was.
                $oldExists = Test-Path -LiteralPath $linkTarget
                Write-Host "  $skinTarget was linked to a different Prism folder:" -ForegroundColor Yellow
                if ($oldExists) {
                    Write-Host "    $linkTarget" -ForegroundColor Yellow
                } else {
                    Write-Host "    $linkTarget (no longer exists)" -ForegroundColor Yellow
                }
                try {
                    [System.IO.Directory]::Delete($skinTarget, $false)
                    Write-Host "  Removed the old junction (its target folder was not touched)." -ForegroundColor DarkGray
                    if ($oldExists) {
                        try {
                            Copy-StyleSettings -OldSettings (Join-Path $linkTarget '@Resources\Settings.inc') `
                                               -NewSettings (Join-Path $repoSkinSrc '@Resources\Settings.inc') `
                                               -StylesDir (Join-Path $repoSkinSrc '@Resources\Styles')
                        } catch {
                            Write-Host "  !! Could not carry your style/theme over: $($_.Exception.GetBaseException().Message)" -ForegroundColor DarkYellow
                            Write-Host "     Pick it again from any widget's right-click menu." -ForegroundColor DarkGray
                        }
                        Write-Host "  Rainmeter no longer uses $linkTarget." -ForegroundColor DarkGray
                        Write-Host "  Once you're happy with this release, just delete that folder. Do not run" -ForegroundColor DarkGray
                        Write-Host "  its Setup\Remove.bat: before v1.3 it also removes this install." -ForegroundColor DarkGray
                    }
                } catch {
                    $createLink = $false
                    Write-Host "  !! Could not remove the old junction: $($_.Exception.GetBaseException().Message)" -ForegroundColor Red
                    Write-Host "     Rainmeter will keep showing the skins from $linkTarget." -ForegroundColor DarkYellow
                    Write-Host "     Close anything open in $skinTarget (Explorer, editors), then re-run Setup\Setup.bat." -ForegroundColor DarkGray
                }
            }
        }

        if ($createLink) {
            # Try junction first (no admin needed, transparent for tools).
            # Windows PowerShell 5.1 resolves -Target as a wildcard path, so a
            # pack folder with [ ] in its name must be escaped there.
            $junctionTarget = $repoSkinSrc
            if ($PSVersionTable.PSVersion.Major -le 5) {
                $junctionTarget = [System.Management.Automation.WildcardPattern]::Escape($repoSkinSrc)
            }
            try {
                New-Item -ItemType Junction -Path $skinTarget -Target $junctionTarget -ErrorAction Stop | Out-Null
                $skinsReady = $true
                Write-Host "  Junction: $skinTarget -> $repoSkinSrc" -ForegroundColor Green
            } catch {
                Write-Host "  Junction failed ($($_.Exception.Message)) - falling back to copy." -ForegroundColor DarkYellow
                try {
                    Copy-Item -LiteralPath $repoSkinSrc -Destination $skinTarget -Recurse -Force -ErrorAction Stop
                    $skinsReady = $true
                    Write-Host "  Copied: $repoSkinSrc -> $skinTarget" -ForegroundColor Green
                    Write-Host "  Note: skin edits in the repo will NOT be reflected in Rainmeter." -ForegroundColor DarkGray
                } catch {
                    Write-Host "  !! Copy failed: $($_.Exception.Message)" -ForegroundColor Red
                }
            }
        }

        # Only the native host writes ConsumerData.inc, so a new pack has
        # none until the extension first syncs. The widgets still render
        # "Not connected" from ConsumerDefaults.inc, but Rainmeter logs
        # "Unable to read file" for the missing @Include on every refresh.
        # Seed it with the disconnected stub. Copy with overwrite off never
        # replaces a file, so data the host wrote first always wins.
        #
        # After an in-place upgrade (extracted over the old folder, or a git
        # pull) the file an older host wrote is still there, and the 1.3
        # ChatGPT and Gemini skins cannot render it: an empty HasUsageData
        # breaks their formulas, and HasUsageData=1 without the Session and
        # Weekly keys shows 0% used. Only such a file (see
        # Test-OldConsumerData) is overwritten; the widgets then say "Not
        # connected" until the extension next sends data.
        $seedSrc = Join-Path $setupDir 'Disconnected.inc'
        $seedDir = Join-Path $skinTarget '@Resources'
        $seedDst = Join-Path $seedDir 'ConsumerData.inc'
        if ($skinsReady -and (Test-Path -LiteralPath $seedSrc -PathType Leaf) -and (Test-Folder $seedDir)) {
            if (-not [System.IO.File]::Exists($seedDst)) {
                try {
                    [System.IO.File]::Copy($seedSrc, $seedDst, $false)
                    Write-Host "  Created $seedDst (disconnected until the extension sends data)" -ForegroundColor DarkGray
                } catch {
                    if (-not [System.IO.File]::Exists($seedDst)) {
                        Write-Host "  !! Could not create ${seedDst}: $($_.Exception.GetBaseException().Message)" -ForegroundColor DarkYellow
                    }
                }
            } elseif (Test-OldConsumerData $seedDst) {
                try {
                    [System.IO.File]::Copy($seedSrc, $seedDst, $true)
                    Write-Host "  Replaced $seedDst, written by an older release" -ForegroundColor DarkGray
                    Write-Host "  (disconnected until the extension sends data)" -ForegroundColor DarkGray
                } catch {
                    Write-Host "  !! Could not replace ${seedDst}: $($_.Exception.GetBaseException().Message)" -ForegroundColor DarkYellow
                    Write-Host "     The ChatGPT and Gemini widgets may look wrong until the extension next sends data." -ForegroundColor DarkGray
                }
            }
        }

        # A portable Rainmeter's Skins folder is not one NativeHost.ps1 looks
        # in: the host writes to the first Prism\@Resources in the Skins
        # folders Get-SkinsRoots lists, else to this pack's own, which a link
        # made above shows. Say so when that is not what Rainmeter shows (a
        # copy, or a Prism folder left over from a non-portable Rainmeter).
        $shownResources = Join-Path $skinTarget '@Resources'
        if ($portableRoot -and (Test-Folder $shownResources)) {
            $packResources = Join-Path $repoSkinSrc '@Resources'
            $hostResources = $packResources
            foreach ($root in @(Get-SkinsRoots $env:APPDATA (Get-DocumentsFolder) $env:USERPROFILE)) {
                $candidate = $null
                try { $candidate = Join-Path $root 'Prism\@Resources' } catch { continue }
                if (Test-Folder $candidate) { $hostResources = $candidate; break }
            }
            if (-not (Test-SameFolder $shownResources $hostResources)) {
                Write-Host "  !! The native host writes its data to $hostResources," -ForegroundColor DarkYellow
                Write-Host "     not to the skins this portable Rainmeter shows, so they get no usage data." -ForegroundColor DarkYellow
                if (Test-SamePath $hostResources $packResources) {
                    Write-Host "     Only a link to $repoSkinSrc (not a copy) gets it." -ForegroundColor DarkGray
                } else {
                    Write-Host "     If $(Split-Path -Parent $hostResources) is left over from a" -ForegroundColor DarkGray
                    Write-Host "     non-portable Rainmeter, move it out of that Skins folder." -ForegroundColor DarkGray
                }
            }
        }
    }
}

# --------------------------------------------------------------------------
# STEP 5: Activate the Prism widgets in Rainmeter
#
# Starts Rainmeter if it is installed but not running, then asks it to
# rescan its Skins folder (!RefreshApp) and load each widget at its
# last-known position (or default position on first run). Widgets the user
# unloaded (Active=0 in Rainmeter.ini) stay unloaded. Skipped if Rainmeter
# isn't installed yet -- the user can install it later and re-run Setup.
# --------------------------------------------------------------------------
Write-Host ""
Write-Host "Activating Prism widgets in Rainmeter..." -ForegroundColor Yellow

if (-not $rainmeterExe) {
    Write-Host "  Rainmeter not installed - skipping widget activation." -ForegroundColor DarkYellow
    Write-Host "  Install Rainmeter from https://www.rainmeter.net/, start it once, then re-run this script." -ForegroundColor DarkGray
} elseif (-not $skinTarget -or -not (Test-Path -LiteralPath $skinTarget)) {
    Write-Host "  The Prism skins are not in Rainmeter's Skins folder - skipping widget activation." -ForegroundColor DarkYellow
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

    $rmReady = $false
    try { $rmReady = Test-RainmeterReady } catch { $rmReady = $false }
    if (-not $rmReady -and -not $isElevated) {
        Write-Host "  Rainmeter is not running - starting it..." -ForegroundColor DarkGray
        try { $rmReady = Start-RainmeterAndWait -Exe $rainmeterExe } catch {
            Write-Host "  !! Could not start Rainmeter: $($_.Exception.Message)" -ForegroundColor DarkYellow
        }
    }

    # Rainmeter.exe exits with 0 only when a running instance took the bang.
    # Piping to Out-Null makes PowerShell wait for it so $LASTEXITCODE is set.
    $refreshed = $false
    if ($rmReady) {
        & $rainmeterExe '!RefreshApp' | Out-Null
        $refreshed = ($LASTEXITCODE -eq 0)
    }

    if (-not $refreshed) {
        if (-not $rmReady -and $isElevated) {
            Write-Host "  Rainmeter is not running (Setup does not start it while running as administrator)." -ForegroundColor DarkYellow
        } else {
            Write-Host "  !! Could not reach Rainmeter." -ForegroundColor DarkYellow
        }
        Write-Host "  Start Rainmeter, then load the Prism widgets from Rainmeter > Manage" -ForegroundColor DarkGray
        Write-Host "  (or re-run Setup\Setup.bat)." -ForegroundColor DarkGray
    } else {
        # Refresh All first: Rainmeter only knows the skins it found at its
        # last scan, so on a first install (or a re-pointed link) the
        # !ActivateConfig bangs would fail before it. It also reloads widgets
        # that were already active, picking up new .ini/@Include files. The
        # refresh runs asynchronously, so give it a moment before activating.
        Write-Host "  Triggered !RefreshApp - all skins reloaded." -ForegroundColor Green
        Start-Sleep -Seconds 2

        $states = @{}
        try { $states = Get-RainmeterActiveStates -RainmeterExe $rainmeterExe } catch { $states = @{} }
        $activated = 0
        $skipped = @()
        $failed = @()
        foreach ($w in $widgets) {
            if ($states.ContainsKey($w.Config) -and $states[$w.Config] -eq 0) {
                $skipped += $w.Config
                continue
            }
            & $rainmeterExe '!ActivateConfig' $w.Config $w.File | Out-Null
            if ($LASTEXITCODE -eq 0) { $activated++ } else { $failed += $w.Config }
        }
        if ($activated -gt 0) {
            Write-Host "  Sent !ActivateConfig for $activated Prism widget(s)." -ForegroundColor Green
        }
        if ($skipped.Count -eq $widgets.Count) {
            Write-Host "  All Prism widgets are unloaded in Rainmeter, so none were loaded." -ForegroundColor DarkYellow
            Write-Host "  Load the ones you want from Rainmeter > Manage." -ForegroundColor DarkGray
        } elseif ($skipped.Count -gt 0) {
            Write-Host "  Left unloaded, as you had them: $($skipped -join ', ')" -ForegroundColor DarkGray
            Write-Host "  Load them from Rainmeter > Manage if you want them back." -ForegroundColor DarkGray
        }
        if ($failed.Count -gt 0) {
            Write-Host "  !! Rainmeter did not take !ActivateConfig for: $($failed -join ', ')" -ForegroundColor DarkYellow
        }

        Write-Host "  (Right-click any widget to reposition, change style, or unload.)" -ForegroundColor DarkGray
    }
}

# --------------------------------------------------------------------------
# STEP 6: Bridge poller (workaround for Chrome native-messaging cache bug)
#
# In some Chrome installs, sendNativeMessage / connectNative fail in 0-1ms
# with "host not found" even though everything above is correctly configured.
# The SW still successfully fetches usage data and caches it to
# chrome.storage.local; the poller below reads that cache and pipes it to
# NativeHost.ps1, which it starts with powershell.exe and the same flags
# NativeHost.bat uses. See BridgePoll.py for the full backstory.
#
# Every running poller is stopped first, from this or any other pack folder:
# re-registering the task does not stop one, and an older release's poller
# would keep feeding its own (older) NativeHost.ps1 into the skins linked
# above until the next logon. A poller only exits by itself once its own
# NativeHost.ps1 is gone (pre-1.3 pollers never do), so an old pack folder
# that still exists keeps its poller alive.
#
# Skipped if Python is not installed -- the bridge is only a fallback, and
# direct native messaging works for users on unaffected Chrome builds.
# --------------------------------------------------------------------------
Write-Host ""
Write-Host "Setting up bridge poller (Chrome workaround)..." -ForegroundColor Yellow

$bridgeScript = Join-Path $setupDir 'BridgePoll.py'
$bridgeTaskName = 'Prism Bridge Poller'

$pythonw = $null
try { $pythonw = Find-Pythonw } catch { $pythonw = $null }

$oldTask = $null
try { $oldTask = Get-ScheduledTask -TaskName $bridgeTaskName -ErrorAction SilentlyContinue } catch { $oldTask = $null }
if ($oldTask) {
    # Stops the instance the task started; unregistering alone would not.
    try { Stop-ScheduledTask -TaskName $bridgeTaskName -ErrorAction Stop } catch { }
}
try {
    Stop-BridgePollers
} catch {
    Write-Host "  !! Could not check for running bridge pollers: $($_.Exception.Message)" -ForegroundColor DarkYellow
}

if (-not $pythonw -or -not (Test-Path -LiteralPath $bridgeScript)) {
    if (-not $pythonw) {
        Write-Host "  Python 3.10+ not found - skipping bridge setup." -ForegroundColor DarkYellow
        Write-Host "  (If Chrome's native messaging works on your install, you don't need it." -ForegroundColor DarkGray
        Write-Host "   Otherwise install Python from https://www.python.org/downloads/ and re-run this script.)" -ForegroundColor DarkGray
    } else {
        Write-Host "  $bridgeScript missing - skipping bridge setup." -ForegroundColor DarkYellow
    }
    # A task left from an earlier run would start an older poller again at
    # every logon.
    if ($oldTask) {
        try {
            Unregister-ScheduledTask -TaskName $bridgeTaskName -Confirm:$false -ErrorAction Stop
            Write-Host "  Removed the old '$bridgeTaskName' task." -ForegroundColor DarkGray
        } catch {
            Write-Host "  !! Could not remove the old '$bridgeTaskName' task: $($_.Exception.Message)" -ForegroundColor DarkYellow
        }
    }
    Write-Host "  The extension still sends its data through Chrome's native messaging." -ForegroundColor DarkGray
} else {
    $taskOk = $false
    try {
        # The full DOMAIN\user name (PC\user, AzureAD\user, ...) resolves for
        # every account type; a bare user name does not for Entra ID users.
        $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

        # Tear down any prior registration before creating fresh
        Unregister-ScheduledTask -TaskName $bridgeTaskName -Confirm:$false -ErrorAction SilentlyContinue

        $action = New-ScheduledTaskAction -Execute $pythonw -Argument "`"$bridgeScript`""
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
        $settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Days 365) `
            -RestartInterval (New-TimeSpan -Minutes 5) `
            -RestartCount 3
        $principal = New-ScheduledTaskPrincipal `
            -UserId $me `
            -LogonType Interactive `
            -RunLevel Limited
        Register-ScheduledTask -TaskName $bridgeTaskName `
            -Action $action -Trigger $trigger `
            -Settings $settings -Principal $principal -Force | Out-Null
        $taskOk = $true
        Write-Host "  Scheduled task '$bridgeTaskName' (at logon) -> OK" -ForegroundColor Green
        Write-Host "    $pythonw" -ForegroundColor DarkGray
    } catch {
        Write-Host "  !! Could not register the '$bridgeTaskName' task: $($_.Exception.Message)" -ForegroundColor DarkYellow
    }

    # Start it now too so the user doesn't have to log out. Through the task
    # when possible: it runs with normal (not administrator) rights even when
    # Setup is elevated, and its working folder is not inside this pack, so
    # the folder can still be deleted after a later upgrade.
    #
    # It is started by hand only when the task itself could not be started.
    # A task-started poller that is slow to show up would otherwise get a
    # twin, and two pollers race each other for ConsumerData.inc and the
    # host log. A process list that cannot be read (WMI) only means the
    # poller cannot be confirmed; it is no reason to start another.
    $poller = $null
    $taskStarted = $false
    $handStarted = $false
    $startError = $null
    $checkError = $null
    if ($taskOk) {
        try {
            Start-ScheduledTask -TaskName $bridgeTaskName -ErrorAction Stop
            $taskStarted = $true
        } catch {
            Write-Host "  Could not start the task now: $($_.Exception.Message)" -ForegroundColor DarkGray
        }
        if ($taskStarted) {
            try { $poller = Wait-BridgePoller -Script $bridgeScript -TimeoutSec 10 } catch { $checkError = $_.Exception.Message }
        }
    }
    if (-not $taskStarted -and -not $isElevated) {
        try {
            Start-Process -FilePath $pythonw -ArgumentList "`"$bridgeScript`"" `
                -WorkingDirectory $env:USERPROFILE -WindowStyle Hidden | Out-Null
            $handStarted = $true
        } catch {
            $startError = $_.Exception.Message
            Write-Host "  !! Could not start the bridge poller: $startError" -ForegroundColor DarkYellow
        }
        if ($handStarted) {
            try { $poller = Wait-BridgePoller -Script $bridgeScript } catch { $checkError = $_.Exception.Message }
        }
    }

    if ($poller) {
        Write-Host "  Started bridge poller (pid $($poller.ProcessId))" -ForegroundColor Green
    } elseif ($checkError) {
        if ($taskStarted) {
            Write-Host "  !! Started the task, but could not confirm its bridge poller is running" -ForegroundColor DarkYellow
        } else {
            Write-Host "  !! Started the bridge poller, but could not confirm it is running" -ForegroundColor DarkYellow
        }
        Write-Host "     (process list unavailable: $checkError)." -ForegroundColor DarkYellow
    } elseif ($taskOk) {
        Write-Host "  !! Could not confirm the bridge poller started; the task starts it at your next logon." -ForegroundColor DarkYellow
    } elseif (-not $startError) {
        Write-Host "  !! Bridge poller not started." -ForegroundColor DarkYellow
    }
    if (($poller -or $checkError) -and $handStarted -and -not $taskOk) {
        Write-Host "  It runs until you sign out; it will not start by itself at the next logon." -ForegroundColor DarkYellow
    }
}

Write-Host ""
Write-Host "=====================================================" -ForegroundColor Green
Write-Host "  Installation Complete!" -ForegroundColor Green
Write-Host "=====================================================" -ForegroundColor Green
Write-Host ""

$extensionFound = $false
try { $extensionFound = Test-PrismExtensionInstalled -Ids $allowedIds } catch { $extensionFound = $false }
if (-not $extensionFound) {
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
