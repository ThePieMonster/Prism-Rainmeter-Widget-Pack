# Removes the Prism native messaging host registration AND the bridge
# poller workaround, plus their logs. You'll still need to remove the
# extension from chrome://extensions manually.
#
# Only removes what belongs to the pack folder it runs from, plus leftovers
# that point at a folder that no longer exists. After an upgrade into a new
# folder, the old folder's Remove.bat therefore leaves the new install alone.

$bridgeTaskName = 'Prism Bridge Poller'
$bridgeScriptName = 'BridgePoll.py'
# For the closing summary: $removedAny when the task, a poller or a
# registry key was removed ($removedRegistration for the task and keys
# only), $hadFailure when the task, a registry key or a data reset could
# not be removed or reset (a poller that could not be stopped sets
# $pollerUnchecked instead).
$removedAny = $false
$removedRegistration = $false
$hadFailure = $false

$scriptDir       = Split-Path -Parent $PSCommandPath
$repoRoot        = Split-Path -Parent $scriptDir
$myManifest      = Join-Path $scriptDir 'com.prism.usage.json'
$myBridgeScript  = Join-Path $scriptDir $bridgeScriptName
$mySkinSrc       = Join-Path $repoRoot 'Prism'
$disconnectedSrc = Join-Path $scriptDir 'Disconnected.inc'

$isElevated = $false
try {
    $isElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { $isElevated = $false }

# --- Helpers ---------------------------------------------------------------

function Test-Folder($path) {
    if (-not $path) { return $false }
    try { return [bool](Test-Path -LiteralPath $path -PathType Container) } catch { return $false }
}

function Test-SamePath([string]$A, [string]$B) {
    if (-not $A -or -not $B) { return $false }
    try {
        return ([System.IO.Path]::GetFullPath($A).TrimEnd('\') -ieq [System.IO.Path]::GetFullPath($B).TrimEnd('\'))
    } catch { return $false }
}

# 'Mine' when $Path is this pack's file, 'Missing' when it is empty or no
# longer exists (a deleted or moved pack), 'Other' for another pack's file.
function Get-PathOwner([string]$Path, [string]$Mine) {
    if (Test-SamePath $Path $Mine) { return 'Mine' }
    if (-not $Path) { return 'Missing' }
    try { if (Test-Path -LiteralPath $Path) { return 'Other' } } catch { }
    return 'Missing'
}

# <pack>\Setup\<file> -> <pack>
function Get-PackRoot([string]$SetupFile) {
    try { return (Split-Path -Parent (Split-Path -Parent $SetupFile)) } catch { return $SetupFile }
}

function Get-DocumentsFolder {
    try { return [Environment]::GetFolderPath('MyDocuments') } catch { return $null }
}

# Rainmeter's Skins folder first, then the other candidates. Same resolver
# as Install.ps1 and NativeHost.ps1 (keep the three in sync):
#   1. SkinPath under [Rainmeter] in %APPDATA%\Rainmeter\Rainmeter.ini
#   2. <Documents>\Rainmeter\Skins when that Rainmeter folder exists
#   3. Rainmeter\Skins under %USERPROFILE%\OneDrive\Documents, then
#      %USERPROFILE%\Documents, preferring one whose Rainmeter folder exists
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

# Bridge pollers in this logon session, from any pack folder: a python*.exe
# whose command line runs BridgePoll.py as its script. Editors that merely
# have the file open do not match. A python process whose command line
# cannot be read (started as administrator) comes back as Kind 'Unknown'.
# Same matcher as Install.ps1; keep them in sync.
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

# Same Rainmeter discovery as Install.ps1: running process, App Paths
# registry, PATH, then standard install locations.
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

# --- 0. Work out which Prism folder is installed --------------------------
# The registry keys and the task name are shared by every Prism folder. If
# they point at another folder that still exists, that folder is the active
# install: leave its registration, task and poller alone.
$regPaths = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.prism.usage',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.prism.usage',
    'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.prism.usage'
)
$regEntries = @()
foreach ($regPath in $regPaths) {
    $entry = [pscustomobject]@{ Path = $regPath; Exists = $false; Value = $null; Owner = $null }
    if (Test-Path $regPath) {
        $entry.Exists = $true
        $entry.Value = (Get-ItemProperty -LiteralPath $regPath -ErrorAction SilentlyContinue).'(default)'
        $entry.Owner = Get-PathOwner $entry.Value $myManifest
    }
    $regEntries += $entry
}

$existingTask = $null
try { $existingTask = Get-ScheduledTask -TaskName $bridgeTaskName -ErrorAction SilentlyContinue } catch { $existingTask = $null }
$taskScript = $null
$taskOwner = $null
if ($existingTask) {
    foreach ($a in @($existingTask.Actions)) {
        if ("$($a.Arguments)" -match '(?i)"?(?<p>[^"]*BridgePoll\.py)"?') { $taskScript = $Matches['p'].Trim(); break }
    }
    $taskOwner = Get-PathOwner $taskScript $myBridgeScript
}

$otherPacks = @()
foreach ($e in $regEntries) { if ($e.Owner -eq 'Other') { $otherPacks += Get-PackRoot $e.Value } }
if ($taskOwner -eq 'Other') { $otherPacks += Get-PackRoot $taskScript }
$otherPacks = @($otherPacks | Where-Object { $_ } | Sort-Object -Unique)
$scoped = $otherPacks.Count -gt 0

if ($scoped) {
    Write-Host "Prism is installed from another folder:" -ForegroundColor Yellow
    foreach ($p in $otherPacks) { Write-Host "  $p" -ForegroundColor Yellow }
    Write-Host "Only this folder's own leftovers are removed; that install is left in place." -ForegroundColor Yellow
    Write-Host ""
}

# --- 1. Stop and unregister the bridge poller scheduled task --------------
if ($existingTask) {
    if ($taskOwner -eq 'Other') {
        Write-Host "Left in place: scheduled task '$bridgeTaskName' (runs $taskScript)" -ForegroundColor DarkGray
    } else {
        try {
            # Stops the instance the task started; unregistering alone does not.
            Stop-ScheduledTask -TaskName $bridgeTaskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $bridgeTaskName -Confirm:$false -ErrorAction Stop
            Write-Host "Unregistered scheduled task: $bridgeTaskName" -ForegroundColor Green
            $removedAny = $true
            $removedRegistration = $true
        } catch {
            # The task starts a poller again at the next logon.
            $hadFailure = $true
            Write-Host "Failed to unregister scheduled task '$bridgeTaskName': $($_.Exception.Message)" -ForegroundColor Red
        }
    }
} else {
    Write-Host "Scheduled task '$bridgeTaskName' not found, nothing to unregister." -ForegroundColor DarkGray
}

# Kill any running BridgePoll.py instances (they survive the task being
# deleted). While another install is active, only this folder's pollers and
# ones whose script no longer exists are stopped. $pollerUnchecked is set
# when a poller may still be running: the process list could not be read,
# a kill failed, or a python command line could not be checked.
$pollerUnchecked = $false
$procs = @()
try {
    $procs = @(Get-BridgePollers)
} catch {
    $pollerUnchecked = $true
    Write-Host "Could not list running processes: $($_.Exception.Message)" -ForegroundColor DarkYellow
    Write-Host "Sign out, or restart, to make sure no bridge poller keeps running." -ForegroundColor DarkYellow
}
$pollers = @($procs | Where-Object { $_.Kind -eq 'Poller' })
foreach ($p in $pollers) {
    if ($scoped) {
        $owner = 'Other'
        $rooted = $false
        try { $rooted = [System.IO.Path]::IsPathRooted($p.ScriptPath) } catch { $rooted = $false }
        if ($rooted) { $owner = Get-PathOwner $p.ScriptPath $myBridgeScript }
        if ($owner -eq 'Other') {
            Write-Host "Left running: bridge poller pid $($p.ProcessId) ($($p.ScriptPath))" -ForegroundColor DarkGray
            continue
        }
    }
    try {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
        Write-Host "Killed bridge poller pid $($p.ProcessId)" -ForegroundColor Green
        $removedAny = $true
    } catch {
        $pollerUnchecked = $true
        Write-Host "Could not kill pid $($p.ProcessId): $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}
$unknown = @($procs | Where-Object { $_.Kind -eq 'Unknown' })
if ($unknown.Count -gt 0 -and -not $isElevated) {
    $pollerUnchecked = $true
    $list = ($unknown | ForEach-Object { "$($_.Name) pid $($_.ProcessId)" }) -join ', '
    Write-Host "Could not check $list - it may be a bridge poller started as administrator." -ForegroundColor DarkYellow
    Write-Host "Re-run Remove.bat as administrator, or sign out, to make sure no poller keeps running." -ForegroundColor DarkYellow
}
# Only when every python process could be checked.
if (-not $pollerUnchecked -and $pollers.Count -eq 0) {
    Write-Host "No running bridge poller processes found." -ForegroundColor DarkGray
}

# --- 2. Remove native messaging registry entries --------------------------
foreach ($entry in $regEntries) {
    if (-not $entry.Exists) {
        Write-Host "Not found: $($entry.Path)" -ForegroundColor DarkGray
    } elseif ($entry.Owner -eq 'Other') {
        Write-Host "Left in place: $($entry.Path) (-> $($entry.Value))" -ForegroundColor DarkGray
    } else {
        try {
            Remove-Item -LiteralPath $entry.Path -Force -Recurse -ErrorAction Stop
            Write-Host "Removed: $($entry.Path)" -ForegroundColor Green
            $removedAny = $true
            $removedRegistration = $true
        } catch {
            # A key left behind keeps the host registered, so a poller
            # keeps running it.
            $hadFailure = $true
            Write-Host "Failed to remove $($entry.Path): $($_.Exception.Message)" -ForegroundColor Red
        }
    }
}

# --- 2b. Remove this folder's logs ----------------------------------------
# NativeHost.bat writes launch.log and BridgePoll.py writes bridge.log next
# to themselves, so these are this folder's own files even while another
# install is active. Best-effort: a host Chrome starts at this moment can
# still add a line.
$removedLogs = @()
foreach ($n in 'launch.log', 'launch.log.old', 'bridge.log') {
    $logFile = Join-Path $scriptDir $n
    if (-not (Test-Path -LiteralPath $logFile -PathType Leaf)) { continue }
    try {
        Remove-Item -LiteralPath $logFile -Force -ErrorAction Stop
        $removedLogs += $n
    } catch {
        Write-Host "Could not remove ${logFile}: $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}
if ($removedLogs.Count -gt 0) {
    Write-Host "Removed logs in ${scriptDir}: $($removedLogs -join ', ')" -ForegroundColor Green
}

# --- 3. Reset ConsumerData.inc so widgets show disconnected state ---------
# Without this, the widgets keep rendering the last percentages/dollar
# values the bridge wrote, even though the bridge is gone. The stub at
# Setup\Disconnected.inc defines every variable as 0/empty so the widgets'
# Hidden=(1-#...Connected#) logic fires correctly.
#
# Candidates: this pack's own Prism\@Resources, then Prism\@Resources in
# every Skins folder Rainmeter may use (see Get-SkinsRoots). The host's
# NativeHost.log next to each disconnected file (reset now or already the
# stub) is removed too.
#
# A file that already holds the stub (seeded by Install.ps1, or reset by an
# earlier run) is not rewritten, so running Remove.bat again changes nothing.
$ownResources = Join-Path $repoRoot 'Prism\@Resources'
$dataCandidates = @($ownResources)
foreach ($root in @(Get-SkinsRoots $env:APPDATA (Get-DocumentsFolder) $env:USERPROFILE)) {
    try { $dataCandidates += Join-Path $root 'Prism\@Resources' } catch { }
}

$visibleChanged = $false
$resetCount = 0
if (-not (Test-Path -LiteralPath $disconnectedSrc)) {
    Write-Host "Disconnected stub not found at $disconnectedSrc - skipping data reset." -ForegroundColor DarkYellow
} else {
    $stubText = $null
    try { $stubText = [System.IO.File]::ReadAllText($disconnectedSrc) } catch { $stubText = $null }
    # Physical file -> $true when this run rewrote it, $false when it was
    # left unchanged (already the stub, or the reset failed).
    $seenPaths = @{}
    $foundCount = 0
    foreach ($resourcesPath in $dataCandidates) {
        $consumerPath = Join-Path $resourcesPath 'ConsumerData.inc'
        if (-not (Test-Path -LiteralPath $consumerPath)) { continue }
        $isOwn = ($resourcesPath -eq $ownResources)

        # Install.ps1 links <Skins>\Prism -> <pack>\Prism, so different
        # candidates may be the same physical file. Resolve-Path does not
        # follow junctions, so map a linked Prism folder to its target first.
        # If it links to a different pack (e.g. an older release), that is the
        # copy Rainmeter shows, so it gets reset too, unless another install
        # is active: then that copy is the active install's.
        $physical = $consumerPath
        $linkedHere = $false
        $skinItem = Get-Item -LiteralPath (Split-Path -Parent $resourcesPath) -Force -ErrorAction SilentlyContinue
        if ($skinItem -and $skinItem.LinkType -and $skinItem.Target) {
            $linkTarget = $skinItem.Target | Select-Object -First 1
            $physical = Join-Path $linkTarget '@Resources\ConsumerData.inc'
            $linkedHere = Test-SamePath $linkTarget $mySkinSrc
        }
        if ($scoped -and -not $isOwn -and -not $linkedHere) {
            Write-Host "Left alone: $consumerPath (Rainmeter shows the other install there)" -ForegroundColor DarkGray
            continue
        }

        $resolved = [System.IO.Path]::GetFullPath($physical)
        if ($seenPaths.ContainsKey($resolved)) {
            if ($seenPaths[$resolved] -and -not $isOwn) { $visibleChanged = $true }
            continue
        }

        $foundCount++
        $shownPath = $consumerPath
        if ($physical -ne $consumerPath) { $shownPath = "$consumerPath (-> $physical)" }
        $current = $null
        if ($null -ne $stubText) {
            try { $current = [System.IO.File]::ReadAllText($consumerPath) } catch { $current = $null }
        }
        $disconnected = $false
        if ($null -ne $current -and $current -ceq $stubText) {
            Write-Host "Already disconnected: $shownPath" -ForegroundColor DarkGray
            $seenPaths[$resolved] = $false
            $disconnected = $true
        } else {
            try {
                Copy-Item -LiteralPath $disconnectedSrc -Destination $consumerPath -Force -ErrorAction Stop
                Write-Host "Reset to disconnected: $shownPath" -ForegroundColor Green
                $seenPaths[$resolved] = $true
                if (-not $isOwn) { $visibleChanged = $true }
                $resetCount++
                $disconnected = $true
            } catch {
                $seenPaths[$resolved] = $false
                $hadFailure = $true
                Write-Host "Failed to reset ${consumerPath}: $($_.Exception.Message)" -ForegroundColor Red
            }
        }
        if ($disconnected) {
            # The host keeps its log next to the data it writes.
            foreach ($n in 'NativeHost.log', 'NativeHost.log.old') {
                Remove-Item -LiteralPath (Join-Path $resourcesPath $n) -Force -ErrorAction SilentlyContinue
            }
        }
    }

    if ($foundCount -eq 0) {
        Write-Host "No ConsumerData.inc found to reset." -ForegroundColor DarkGray
    }
}

# --- 4. Trigger Rainmeter "Refresh All" so widgets re-read the stub -------
# Only when this run rewrote a ConsumerData.inc: the skins read nothing
# else this script changes.
if ($resetCount -eq 0) {
    Write-Host "No widget data changed - skipping !RefreshApp." -ForegroundColor DarkGray
} elseif ($scoped -and -not $visibleChanged) {
    Write-Host "Rainmeter shows the other install - skipping !RefreshApp." -ForegroundColor DarkGray
} else {
    $rainmeterExe = Find-RainmeterExe
    if ($rainmeterExe) {
        # Brief delay so the Disconnected.inc copy above has settled to disk
        # before Rainmeter re-reads it. Rainmeter.exe exits with 0 only when a
        # running instance took the bang (Out-Null makes PowerShell wait).
        Start-Sleep -Seconds 1
        & $rainmeterExe '!RefreshApp' | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Triggered !RefreshApp - all skins reloaded." -ForegroundColor Green
        } else {
            Write-Host "Rainmeter is not running; the widgets show the reset data when it next starts." -ForegroundColor DarkGray
        }
    } else {
        Write-Host "Rainmeter not found - skipping !RefreshApp." -ForegroundColor DarkGray
    }
}

Write-Host ""
# A task or registry key left behind keeps the bridge registered: the task
# starts a poller again at the next logon and it keeps writing live data.
$failNote = 'Some items could not be removed or reset (see the red lines above).'
if (-not $isElevated) { $failNote += ' Re-run Setup\Remove.bat as administrator.' }
if ($scoped) {
    if ($hadFailure) { Write-Host $failNote -ForegroundColor Red }
    foreach ($p in $otherPacks) {
        Write-Host "Prism is still installed from $p. To uninstall it, run its Setup\Remove.bat."
    }
    $skinsLinkedHere = $false
    foreach ($resourcesPath in @($dataCandidates | Select-Object -Skip 1)) {
        $skinItem = Get-Item -LiteralPath (Split-Path -Parent $resourcesPath) -Force -ErrorAction SilentlyContinue
        if ($skinItem -and $skinItem.LinkType -and $skinItem.Target -and
            (Test-SamePath ($skinItem.Target | Select-Object -First 1) $mySkinSrc)) { $skinsLinkedHere = $true }
    }
    if ($skinsLinkedHere) {
        Write-Host "Rainmeter still shows the skins in this folder. Re-run Setup\Setup.bat in the folder above"
        Write-Host "to link its skins instead, then delete this folder."
    } elseif (-not $hadFailure) {
        Write-Host "This folder is no longer in use and can simply be deleted."
    }
} else {
    if ($hadFailure) {
        Write-Host $failNote -ForegroundColor Red
    } elseif ($pollerUnchecked) {
        if ($removedRegistration) {
            Write-Host "Native host registration removed. A bridge poller may still be running (see above)."
        } else {
            Write-Host "Native host registration was not present. A bridge poller may still be running (see above)."
        }
    } elseif ($removedAny) {
        Write-Host "Native host registration and bridge poller removed."
    } else {
        Write-Host "Nothing to remove. Native host registration and bridge poller were not present."
    }
    Write-Host "To remove the extension, go to chrome://extensions and click 'Remove'."
}
