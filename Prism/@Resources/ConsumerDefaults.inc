[Variables]
; ==========================================================================
;  Prism: Consumer Data Defaults
;  Fallback values for every ConsumerData.inc key, set to the disconnected
;  state. Each data skin includes this file directly before ConsumerData.inc,
;  so live values there always win, and a key that file lacks (or the whole
;  file, before the extension's first sync) falls back to its disconnected
;  value (0 or empty) instead of showing a raw variable name.
;  Keep the keys and values in sync with Setup\Disconnected.inc, and add
;  every new key Setup\NativeHost.ps1 writes here too.
; ==========================================================================

ClaudeConsumerConnected=0
ClaudeHasUsageData=0
ClaudePlanName=
ClaudeSessionPercent=0
ClaudeSessionReset=
ClaudeWeeklyPercent=0
ClaudeWeeklyReset=

ChatGPTConsumerConnected=0
ChatGPTHasUsageData=0
ChatGPTPlanName=
ChatGPTSessionPercent=0
ChatGPTSessionReset=
ChatGPTWeeklyPercent=0
ChatGPTWeeklyReset=
; Deprecated: single-bar fields read by ChatGPT skins older than 1.3
ChatGPTMessagePercent=0
ChatGPTMessageReset=
ChatGPTMessageLabel=Usage

GeminiConsumerConnected=0
GeminiHasUsageData=0
GeminiPlanName=
GeminiSessionPercent=0
GeminiSessionReset=
GeminiWeeklyPercent=0
GeminiWeeklyReset=
; Deprecated: single-bar fields read by Gemini skins older than 1.2
GeminiDailyPercent=0
GeminiDailyReset=

ClaudeApiConnected=0
ClaudeApiMonthTotal=0.00
ClaudeApiTodayTotal=0.00
ClaudeApiYesterdayTotal=0.00
ClaudeApiPeriodLabel=MTD
ClaudeApiStale=0
ClaudeApiCachedAtEpoch=0
ClaudeApiDataDay=

ChatGPTApiConnected=0
ChatGPTApiMonthTotal=0.00
ChatGPTApiTodayTotal=0.00
ChatGPTApiYesterdayTotal=0.00
ChatGPTApiPeriodLabel=MTD
ChatGPTApiStale=0
ChatGPTApiCachedAtEpoch=0
ChatGPTApiDataDay=

GeminiApiConnected=0
GeminiApiTier=Unknown
GeminiApiProjectName=
GeminiApiMonthTotal=0.00
GeminiApiSpendCapUsed=0.00
GeminiApiSpendCap=0.00
GeminiApiHasCap=0
GeminiApiHasData=0
GeminiApiPeriodLabel=
GeminiApiStale=0
GeminiApiCachedAtEpoch=0

ConsumerLastUpdated=
ConsumerLastUpdatedEpoch=0
ConsumerUpdateStatus=DISCONNECTED
