# ==========================================================================
#  Prism Native Messaging Host
#
#  Receives usage data from the Prism Chrome extension via stdin/stdout
#  (length-prefixed JSON). Writes to ConsumerData.inc.
#
#  Messages arrive as: [4-byte LE uint32 length][JSON bytes]
#  Responses sent as: [4-byte LE uint32 length][JSON bytes]
#
#  Layout-resilient: searches several candidate locations for the Rainmeter
#  @Resources folder so this script works whether it lives in the dev repo
#  (alongside Prism/), in the installed skins folder, or in a system-wide
#  install location.
# ==========================================================================

$ErrorActionPreference = 'Stop'

# Resolve the Rainmeter @Resources folder.
$scriptDir = Split-Path -Parent $PSCommandPath
$candidates = @()

# 1. Adjacent repo layout (dev):  <repo>/Extension/nativehost/ -> <repo>/Prism/@Resources
$candidates += Join-Path (Split-Path -Parent (Split-Path -Parent $scriptDir)) 'Prism\@Resources'
# 2. Installed repo layout: <repo>/@Resources directly
$candidates += Join-Path (Split-Path -Parent (Split-Path -Parent $scriptDir)) '@Resources'
# 3. Standard Rainmeter install: Documents\Rainmeter\Skins\Prism\@Resources
$candidates += Join-Path $env:USERPROFILE 'Documents\Rainmeter\Skins\Prism\@Resources'
# 4. OneDrive-redirected Documents
$candidates += Join-Path $env:USERPROFILE 'OneDrive\Documents\Rainmeter\Skins\Prism\@Resources'

$resourcesPath = $null
foreach ($c in $candidates) {
    if (Test-Path $c) { $resourcesPath = $c; break }
}
if (-not $resourcesPath) {
    # Last resort: default to the standard location even if missing (will error on write)
    $resourcesPath = Join-Path $env:USERPROFILE 'Documents\Rainmeter\Skins\Prism\@Resources'
}
$consumerPath = Join-Path $resourcesPath "ConsumerData.inc"
$logPath = Join-Path $resourcesPath "NativeHost.log"

function Write-Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logPath -Value "[$ts] $msg" -Encoding ASCII
    if (Test-Path $logPath) {
        $allLines = Get-Content $logPath
        if ($allLines.Count -gt 10000) {
            $allLines | Select-Object -Last 10000 | Out-File -FilePath $logPath -Encoding ASCII -Force
        }
    }
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

function Format-Value($v) {
    if ($null -eq $v) { return "" }
    return [string]$v
}

function Format-Percent($v) {
    if ($null -eq $v -or $v -eq "") { return "0" }
    return [string]$v
}

function Format-Money($v) {
    if ($null -eq $v -or $v -eq "") { return "0.00" }
    return [string]$v
}

function Format-Bool($v) {
    if ($null -eq $v -or $v -eq "") { return "0" }
    return [string]$v
}

function Format-Label($v, $default) {
    if ($null -eq $v -or $v -eq "") { return $default }
    return [string]$v
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

        $timestamp = Get-Date -Format "HH:mm"
        $epoch = [DateTimeOffset]::Now.ToUnixTimeSeconds()
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
;    {Service}Bar*: percentage + reset (only when HasUsageData=1)
;    ClaudeApi*: month-to-date / today / yesterday spend in USD
; ==========================================================================

; --- Claude ---
ClaudeConsumerConnected=$(Format-Value $claude.Connected)
ClaudeHasUsageData=$(Format-Value $claude.HasUsageData)
ClaudePlanName=$(Format-Value $claude.PlanName)
ClaudeSessionPercent=$(Format-Percent $claude.SessionPercent)
ClaudeSessionReset=$(Format-Value $claude.SessionReset)
ClaudeWeeklyPercent=$(Format-Percent $claude.WeeklyPercent)
ClaudeWeeklyReset=$(Format-Value $claude.WeeklyReset)

; --- ChatGPT ---
ChatGPTConsumerConnected=$(Format-Value $chatgpt.Connected)
ChatGPTHasUsageData=$(Format-Value $chatgpt.HasUsageData)
ChatGPTPlanName=$(Format-Value $chatgpt.PlanName)
ChatGPTMessagePercent=$(Format-Percent $chatgpt.MessagePercent)
ChatGPTMessageReset=$(Format-Value $chatgpt.MessageReset)
ChatGPTMessageLabel=Messages (3hr)

; --- Gemini ---
GeminiConsumerConnected=$(Format-Value $gemini.Connected)
GeminiHasUsageData=$(Format-Value $gemini.HasUsageData)
GeminiPlanName=$(Format-Value $gemini.PlanName)
GeminiDailyPercent=$(Format-Percent $gemini.DailyPercent)
GeminiDailyReset=$(Format-Value $gemini.DailyReset)

; --- Claude API Platform ---
ClaudeApiConnected=$(Format-Bool $claudeApi.Connected)
ClaudeApiMonthTotal=$(Format-Money $claudeApi.MonthTotal)
ClaudeApiTodayTotal=$(Format-Money $claudeApi.TodayTotal)
ClaudeApiYesterdayTotal=$(Format-Money $claudeApi.YesterdayTotal)
ClaudeApiPeriodLabel=$(Format-Label $claudeApi.PeriodLabel "MTD")

; --- ChatGPT API Platform ---
ChatGPTApiConnected=$(Format-Bool $chatgptApi.Connected)
ChatGPTApiMonthTotal=$(Format-Money $chatgptApi.MonthTotal)
ChatGPTApiTodayTotal=$(Format-Money $chatgptApi.TodayTotal)
ChatGPTApiYesterdayTotal=$(Format-Money $chatgptApi.YesterdayTotal)
ChatGPTApiPeriodLabel=$(Format-Label $chatgptApi.PeriodLabel "MTD")

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

; --- Metadata ---
ConsumerLastUpdated=$timestamp
ConsumerLastUpdatedEpoch=$epoch
ConsumerUpdateStatus=OK
"@

        # Atomic write
        $tempPath = "$consumerPath.tmp"
        $content | Out-File -FilePath $tempPath -Encoding ASCII -Force
        Move-Item -Path $tempPath -Destination $consumerPath -Force

        Write-Log "Wrote ConsumerData.inc - Claude=$(Format-Value $claude.PlanName)/$(Format-Value $claude.SessionPercent)% ChatGPT=$(Format-Value $chatgpt.PlanName) Gemini=$(Format-Value $gemini.PlanName) ClaudeApi=`$$(Format-Value $claudeApi.MonthTotal) ChatGPTApi=`$$(Format-Value $chatgptApi.MonthTotal) GeminiApi=$(Format-Value $geminiApi.RequestCount)req"

        Write-Message @{ ok = $true; timestamp = $timestamp }
    }
}
catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    try { Write-Message @{ ok = $false; error = $_.Exception.Message } } catch {}
}
finally {
    Write-Log "--- Native host exiting ---"
}
