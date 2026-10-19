# ==========================================================================
#  Prism Native Messaging Host
#
#  Receives usage data from the Prism Chrome extension via stdin/stdout
#  (length-prefixed JSON). Writes to ConsumerData.inc.
#
#  Messages arrive as: [4-byte LE uint32 length][JSON bytes]
#  Responses sent as: [4-byte LE uint32 length][JSON bytes]
#
#  Writes into the Prism skin folder Rainmeter actually shows:
#  <Skins>\Prism\@Resources, where <Skins> is SkinPath from Rainmeter.ini,
#  else Documents\Rainmeter\Skins (Install.ps1 and Uninstall.ps1 resolve it
#  the same way). Skins\Prism is normally Setup's junction to this pack; if
#  it is a copied folder, that copy is what Rainmeter shows, so the data goes
#  there. This pack's own Prism\@Resources is the fallback.
# ==========================================================================

$ErrorActionPreference = 'Stop'

# True if $path is an existing folder. Never throws: a malformed SkinPath
# must not stop the host before it can reply.
function Test-Folder($path) {
    if (-not $path) { return $false }
    try { return [bool](Test-Path -LiteralPath $path -PathType Container) } catch { return $false }
}

# Candidate Rainmeter Skins folders, the one Rainmeter uses first:
#   1. SkinPath under [Rainmeter] in %APPDATA%\Rainmeter\Rainmeter.ini
#   2. <Documents>\Rainmeter\Skins when that Rainmeter folder exists
#      (GetFolderPath follows OneDrive and GPO Documents redirection)
#   3. Rainmeter\Skins under %USERPROFILE%\OneDrive\Documents, then
#      %USERPROFILE%\Documents, preferring one whose Rainmeter folder exists
# The others follow in that order, without duplicates.
# Install.ps1 and Uninstall.ps1 have identical copies of Test-Folder and
# Get-SkinsRoots, so all three find the same folder: copy any change to all
# three.
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

# The @Resources folder to write: the first existing Prism\@Resources under
# those Skins folders, then this pack's own, then the standard location even
# if missing (the write then fails and the error goes back to the extension).
function Resolve-ResourcesPath($packDir, $appData, $myDocuments, $userProfile) {
    $candidates = @()
    foreach ($root in @(Get-SkinsRoots $appData $myDocuments $userProfile)) {
        try { $candidates += Join-Path $root 'Prism\@Resources' } catch { }
    }
    if ($packDir) { $candidates += Join-Path $packDir 'Prism\@Resources' }
    foreach ($c in $candidates) {
        if (Test-Folder $c) { return $c }
    }
    if ($userProfile) { return (Join-Path $userProfile 'Documents\Rainmeter\Skins\Prism\@Resources') }
    return $candidates[-1]
}

# $scriptDir is <pack>\Setup, so its parent is the pack.
$scriptDir = Split-Path -Parent $PSCommandPath
$resourcesPath = Resolve-ResourcesPath (Split-Path -Parent $scriptDir) $env:APPDATA ([Environment]::GetFolderPath('MyDocuments')) $env:USERPROFILE
$consumerPath = Join-Path $resourcesPath "ConsumerData.inc"
$logPath = Join-Path $resourcesPath "NativeHost.log"

# The extension and the bridge can run two hosts at once (the bridge delivers
# each payload again, 0-30 s after the extension did). This named mutex makes
# their ConsumerData.inc swaps and log writes take turns. It only orders them:
# a host that cannot get it in time (the other one hung) goes ahead, since
# each step is safe on its own, and one that cannot open it at all works
# without it. Local\ is per logon session, which the extension's host and the
# bridge's (an Interactive logon task) share.
$hostMutex = $null
try { $hostMutex = New-Object System.Threading.Mutex($false, 'Local\PrismNativeHost') } catch { $hostMutex = $null }

# True once this host holds the mutex; pass the result to Exit-HostLock. A
# host killed while holding it (Chrome ends one 2 s after the port closes)
# leaves it abandoned: the wait then throws, but the mutex is ours all the
# same.
function Enter-HostLock([int]$timeoutMs) {
    if ($null -eq $hostMutex) { return $false }
    try { return [bool]$hostMutex.WaitOne($timeoutMs) }
    catch {
        for ($e = $_.Exception; $null -ne $e; $e = $e.InnerException) {
            if ($e -is [System.Threading.AbandonedMutexException]) { return $true }
        }
        return $false
    }
}

function Exit-HostLock($held) {
    if ($held) { try { $hostMutex.ReleaseMutex() } catch { } }
}

# Best-effort: a log that cannot be written (another host instance, tail -f,
# a read-only file, a missing folder) must never stop the data write or the
# reply. Past 1 MB the log is renamed to NativeHost.log.old, instead of
# re-reading the whole file on every call. The host lock keeps a second host
# from appending mid-rotation, or deleting the .old file this one just made.
function Write-Log($msg) {
    $held = Enter-HostLock 500
    try {
        try {
            $info = New-Object System.IO.FileInfo($logPath)
            if ($info.Exists -and $info.Length -gt 1MB) {
                $oldPath = "$logPath.old"
                if ([System.IO.File]::Exists($oldPath)) { [System.IO.File]::Delete($oldPath) }
                [System.IO.File]::Move($logPath, $oldPath)
            }
        } catch { }
        try {
            $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
            $line = ([string]$msg) -replace '[\r\n]+', ' '
            [System.IO.File]::AppendAllText($logPath, "[$ts] $line`r`n", [System.Text.Encoding]::ASCII)
        } catch { }
    }
    finally { Exit-HostLock $held }
}

function Read-Message {
    # Read 4-byte length prefix
    $stdin = [Console]::OpenStandardInput()
    $lenBytes = New-Object byte[] 4
    $read = $stdin.Read($lenBytes, 0, 4)
    if ($read -lt 4) { return $null }
    $length = [BitConverter]::ToUInt32($lenBytes, 0)
    if ($length -eq 0 -or $length -gt 10485760) { return $null }  # Sanity: max 10MB

    # Read payload
    $buf = New-Object byte[] $length
    $totalRead = 0
    while ($totalRead -lt $length) {
        $n = $stdin.Read($buf, $totalRead, $length - $totalRead)
        if ($n -le 0) { break }
        $totalRead += $n
    }
    if ($totalRead -lt $length) { return $null }
    return [System.Text.Encoding]::UTF8.GetString($buf)
}

function Write-Message($obj) {
    $json = $obj | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $lenBytes = [BitConverter]::GetBytes([uint32]$bytes.Length)
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($lenBytes, 0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

# Every value ends up on one INI line, so control characters become spaces:
# a CR or LF would end the line early, and the next line could start a new
# [Section] that captures every later key.
function Format-Value($v) {
    if ($null -eq $v) { return "" }
    return (([string]$v) -replace '[\x00-\x1F\x7F-\x9F\u2028\u2029]+', ' ').Trim()
}

# A payload number (JSON number or numeric string, invariant culture) as a
# [double], or $null for anything else, NaN and infinities included.
function ConvertTo-Number($v) {
    if ($null -eq $v -or $v -is [bool]) { return $null }
    $d = 0.0
    if (-not [double]::TryParse((Format-Value $v), [System.Globalization.NumberStyles]::Float,
            [System.Globalization.CultureInfo]::InvariantCulture, [ref]$d)) { return $null }
    if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return $null }
    return $d
}

# Numbers pass through as sent. Anything else gets the default, so a crafted
# value cannot put text into the skins' Calc formulas.
function Format-Percent($v) {
    if ($null -eq (ConvertTo-Number $v)) { return "0" }
    return Format-Value $v
}

function Format-Money($v) {
    if ($null -eq (ConvertTo-Number $v)) { return "0.00" }
    return Format-Value $v
}

# Always 1 or 0 (a JSON true/false would otherwise be written as True/False).
function Format-Bool($v) {
    if ($v -is [bool]) {
        if ($v) { return "1" }
        return "0"
    }
    $d = ConvertTo-Number $v
    if ($null -eq $d -or $d -eq 0) { return "0" }
    return "1"
}

function Format-Label($v, $default) {
    $s = Format-Value $v
    if ($s -eq "") { return $default }
    return $s
}

# When the payload was collected (the extension's ISO timestamp), not when it
# is written: the bridge can deliver a cached payload up to 10 minutes late
# (older releases replayed it at logon), and the data must keep its real age.
# A missing or unreadable timestamp, or one in the future, falls back to now:
# after the clock is set back, the bridge can still send one record dated up
# to 2 minutes ahead.
function Get-PayloadTime($ts) {
    $now = [DateTimeOffset]::Now
    $dto = $null
    try {
        if ($ts -is [datetime]) {
            $dto = [DateTimeOffset]$ts
        } elseif ((Format-Value $ts) -ne "") {
            $dto = [DateTimeOffset]::Parse((Format-Value $ts), [System.Globalization.CultureInfo]::InvariantCulture,
                [System.Globalization.DateTimeStyles]::AssumeUniversal)
        }
    } catch { $dto = $null }
    if ($null -eq $dto -or $dto -gt $now) { return $now }
    return $dto
}

# Writes ConsumerData.inc as UTF-16 LE with a BOM, which Rainmeter reads
# natively (ASCII turned any non-ASCII project name into '?').
#
# The temp file is per process, since the extension and the bridge can run
# two hosts at once (their swaps take turns on the host lock, but one that
# could not get it goes ahead). The swap is MoveFileEx(REPLACE_EXISTING),
# through Microsoft.VisualBasic so nothing needs compiling: unlike
# Move-Item -Force, which deletes ConsumerData.inc before renaming, it never
# leaves the file missing for a skin that refreshes at that moment. It fails
# while any handle is open on the file (Rainmeter's own short reads
# included), so it is retried, and Move-Item -Force is the fallback for a
# reader that keeps the file open with delete sharing.
#
# A host killed mid-swap (Chrome ends it 2 s after the port closes; logoff)
# never reaches the finally below, so leftover temp files are swept first:
# this naming and the fixed ConsumerData.inc.tmp of hosts before 1.3. Only
# files over a minute old go, since a live one exists for under a second.
function Write-ConsumerData($text) {
    $tempPath = "$consumerPath.$PID.tmp"
    try {
        $cutoff = [DateTime]::UtcNow.AddMinutes(-1)
        $dir = [System.IO.Path]::GetDirectoryName($consumerPath)
        foreach ($f in [System.IO.Directory]::GetFiles($dir, 'ConsumerData.inc*.tmp')) {
            if ([System.IO.Path]::GetFileName($f) -match '^ConsumerData\.inc(\.\d+)?\.tmp$' -and
                    [System.IO.File]::GetLastWriteTimeUtc($f) -lt $cutoff) {
                try { [System.IO.File]::Delete($f) } catch { }
            }
        }
    } catch { }
    try {
        [System.IO.File]::WriteAllText($tempPath, $text, [System.Text.Encoding]::Unicode)
        $haveVb = $false
        try { Add-Type -AssemblyName Microsoft.VisualBasic; $haveVb = $true } catch { }
        if ($haveVb) {
            for ($i = 0; $i -lt 10; $i++) {
                try {
                    [Microsoft.VisualBasic.FileIO.FileSystem]::MoveFile($tempPath, $consumerPath, $true)
                    return
                } catch {
                    if ($i -lt 9) { Start-Sleep -Milliseconds 50 }
                }
            }
        }
        Move-Item -LiteralPath $tempPath -Destination $consumerPath -Force
    }
    finally {
        if ([System.IO.File]::Exists($tempPath)) {
            try { [System.IO.File]::Delete($tempPath) } catch { }
        }
    }
}

try {
    Write-Log "--- Native host started ---"

    while ($true) {
        $msgJson = Read-Message
        if ($null -eq $msgJson) {
            Write-Log "Stdin closed - exiting"
            break
        }

        $msg = $msgJson | ConvertFrom-Json
        Write-Log "Received message (len=$($msgJson.Length))"

        # Build ConsumerData.inc content
        $claude = $msg.claude
        $chatgpt = $msg.chatgpt
        $gemini = $msg.gemini
        $claudeApi = $msg.claudeApi
        $chatgptApi = $msg.chatgptApi
        $geminiApi = $msg.geminiApi

        $updated = Get-PayloadTime $msg.timestamp
        $timestamp = $updated.ToLocalTime().ToString('HH:mm', [System.Globalization.CultureInfo]::InvariantCulture)
        $epoch = $updated.ToUnixTimeSeconds()

        # Deprecated single bar for Gemini skins older than 1.2 (a copied
        # Skins\Prism keeps them): the window closer to its limit, the same
        # rule the extension uses for ChatGPTMessage*. An extension that sends
        # DailyPercent itself wins. Compared as numbers, because the formatted
        # values are strings and "9" -gt "10" in PowerShell.
        if ($null -ne $gemini.DailyPercent) {
            $geminiDailyPercent = $gemini.DailyPercent
            $geminiDailyReset = $gemini.DailyReset
        } else {
            $geminiSession = ConvertTo-Number $gemini.SessionPercent
            $geminiWeekly = ConvertTo-Number $gemini.WeeklyPercent
            if ($null -ne $geminiWeekly -and ($null -eq $geminiSession -or $geminiWeekly -gt $geminiSession)) {
                $geminiDailyPercent = $gemini.WeeklyPercent
                $geminiDailyReset = $gemini.WeeklyReset
            } else {
                $geminiDailyPercent = $gemini.SessionPercent
                $geminiDailyReset = $gemini.SessionReset
            }
        }

        # Every key below must also be in Prism\@Resources\ConsumerDefaults.inc
        # and Setup\Disconnected.inc, with its disconnected value. The
        # defaults keep a skin that reads a new key from showing the raw
        # #Name# text while ConsumerData.inc is older than the key, and
        # Disconnected.inc is what Remove.bat leaves in place of this file.
        # Install.ps1 (Test-OldConsumerData) recognizes a file from a host
        # older than 1.3 by its missing ClaudeApiStale key and resets it, so
        # keep writing that key.
        $content = @"
[Variables]
; ==========================================================================
;  Prism: Consumer Plan Usage Data
;  Auto-updated via Chrome extension -- Last: $timestamp
;
;  Schema:
;    {Service}ConsumerConnected: 0=not logged in, 1=logged in
;    {Service}HasUsageData: 0=plan status only, 1=usage bars available
;    {Service}PlanName: e.g. "Max", "Plus", "Pro", "Free Plan"
;    {Service}Session*/Weekly*: percentage + reset (only when HasUsageData=1)
;    ChatGPTMessage*/GeminiDaily*: deprecated single-bar keys for older skins
;    ClaudeApi*: month-to-date / today / yesterday spend in USD
;    *ApiStale: 1=values not current; *ApiCachedAtEpoch: when cached (0=live)
;    *ApiDataDay: the UTC day (YYYY-MM-DD) TodayTotal belongs to
;    ConsumerLastUpdated*: when the extension collected this data
; ==========================================================================

; --- Claude ---
ClaudeConsumerConnected=$(Format-Bool $claude.Connected)
ClaudeHasUsageData=$(Format-Bool $claude.HasUsageData)
ClaudePlanName=$(Format-Value $claude.PlanName)
ClaudeSessionPercent=$(Format-Percent $claude.SessionPercent)
ClaudeSessionReset=$(Format-Value $claude.SessionReset)
ClaudeWeeklyPercent=$(Format-Percent $claude.WeeklyPercent)
ClaudeWeeklyReset=$(Format-Value $claude.WeeklyReset)

; --- ChatGPT ---
ChatGPTConsumerConnected=$(Format-Bool $chatgpt.Connected)
ChatGPTHasUsageData=$(Format-Bool $chatgpt.HasUsageData)
ChatGPTPlanName=$(Format-Value $chatgpt.PlanName)
ChatGPTSessionPercent=$(Format-Percent $chatgpt.SessionPercent)
ChatGPTSessionReset=$(Format-Value $chatgpt.SessionReset)
ChatGPTWeeklyPercent=$(Format-Percent $chatgpt.WeeklyPercent)
ChatGPTWeeklyReset=$(Format-Value $chatgpt.WeeklyReset)
; Deprecated: single-bar fields read by ChatGPT skins older than 1.3
ChatGPTMessagePercent=$(Format-Percent $chatgpt.MessagePercent)
ChatGPTMessageReset=$(Format-Value $chatgpt.MessageReset)
ChatGPTMessageLabel=Usage

; --- Gemini ---
GeminiConsumerConnected=$(Format-Bool $gemini.Connected)
GeminiHasUsageData=$(Format-Bool $gemini.HasUsageData)
GeminiPlanName=$(Format-Value $gemini.PlanName)
GeminiSessionPercent=$(Format-Percent $gemini.SessionPercent)
GeminiSessionReset=$(Format-Value $gemini.SessionReset)
GeminiWeeklyPercent=$(Format-Percent $gemini.WeeklyPercent)
GeminiWeeklyReset=$(Format-Value $gemini.WeeklyReset)
; Deprecated: single-bar fields read by Gemini skins older than 1.2
GeminiDailyPercent=$(Format-Percent $geminiDailyPercent)
GeminiDailyReset=$(Format-Value $geminiDailyReset)

; --- Claude API Platform ---
ClaudeApiConnected=$(Format-Bool $claudeApi.Connected)
ClaudeApiMonthTotal=$(Format-Money $claudeApi.MonthTotal)
ClaudeApiTodayTotal=$(Format-Money $claudeApi.TodayTotal)
ClaudeApiYesterdayTotal=$(Format-Money $claudeApi.YesterdayTotal)
ClaudeApiPeriodLabel=$(Format-Label $claudeApi.PeriodLabel "MTD")
ClaudeApiStale=$(Format-Bool $claudeApi.Stale)
ClaudeApiCachedAtEpoch=$(Format-Percent $claudeApi.CachedAtEpoch)
ClaudeApiDataDay=$(Format-Label $claudeApi.DataDay "")

; --- ChatGPT API Platform ---
ChatGPTApiConnected=$(Format-Bool $chatgptApi.Connected)
ChatGPTApiMonthTotal=$(Format-Money $chatgptApi.MonthTotal)
ChatGPTApiTodayTotal=$(Format-Money $chatgptApi.TodayTotal)
ChatGPTApiYesterdayTotal=$(Format-Money $chatgptApi.YesterdayTotal)
ChatGPTApiPeriodLabel=$(Format-Label $chatgptApi.PeriodLabel "MTD")
ChatGPTApiStale=$(Format-Bool $chatgptApi.Stale)
ChatGPTApiCachedAtEpoch=$(Format-Percent $chatgptApi.CachedAtEpoch)
ChatGPTApiDataDay=$(Format-Label $chatgptApi.DataDay "")

; --- Gemini API Platform ---
GeminiApiConnected=$(Format-Bool $geminiApi.Connected)
GeminiApiTier=$(Format-Label $geminiApi.Tier "Unknown")
GeminiApiProjectName=$(Format-Label $geminiApi.ProjectName "")
GeminiApiMonthTotal=$(Format-Money $geminiApi.MonthTotal)
GeminiApiSpendCapUsed=$(Format-Money $geminiApi.SpendCapUsed)
GeminiApiSpendCap=$(Format-Money $geminiApi.SpendCap)
GeminiApiHasCap=$(Format-Bool $geminiApi.HasCap)
GeminiApiHasData=$(Format-Bool $geminiApi.HasData)
GeminiApiPeriodLabel=$(Format-Label $geminiApi.PeriodLabel "")
GeminiApiStale=$(Format-Bool $geminiApi.Stale)
GeminiApiCachedAtEpoch=$(Format-Percent $geminiApi.CachedAtEpoch)

; --- Metadata ---
ConsumerLastUpdated=$timestamp
ConsumerLastUpdatedEpoch=$epoch
ConsumerUpdateStatus=OK
"@

        # One line ending throughout (the here-string has whatever this file
        # was saved with), plus the final newline Out-File used to add. The
        # host lock is released before the reply, after which Chrome may end
        # this process.
        $held = Enter-HostLock 2000
        try {
            Write-ConsumerData (($content -replace "`r?`n", "`r`n") + "`r`n")

            Write-Log "Wrote ConsumerData.inc - Claude=$(Format-Value $claude.PlanName)/$(Format-Value $claude.SessionPercent)% ChatGPT=$(Format-Value $chatgpt.PlanName)/$(Format-Value $chatgpt.SessionPercent)% Gemini=$(Format-Value $gemini.PlanName)/$(Format-Value $gemini.SessionPercent)% ClaudeApi=`$$(Format-Value $claudeApi.MonthTotal) ChatGPTApi=`$$(Format-Value $chatgptApi.MonthTotal) GeminiApi=`$$(Format-Value $geminiApi.MonthTotal)"
        }
        finally { Exit-HostLock $held }

        Write-Message @{ ok = $true; timestamp = $timestamp }
    }
}
catch {
    # Reply first, so the extension hears about the error even if the log
    # cannot be written either.
    $errMsg = $_.Exception.Message
    try { Write-Message @{ ok = $false; error = $errMsg } } catch {}
    Write-Log "ERROR: $errMsg"
}
finally {
    Write-Log "--- Native host exiting ---"
}
