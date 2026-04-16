// ==========================================================================
//  Prism Usage Tracker - Service Worker
//  Periodically fetches usage data from claude.ai, chatgpt.com, gemini.google.com
//  using the user's existing authenticated session. Sends results to the
//  native messaging host which writes to ConsumerData.inc.
// ==========================================================================

importScripts('logger.js');  // defines self.prismLog

const NATIVE_HOST = "com.prism.usage";
const FETCH_INTERVAL_MINUTES = 1;
const ALARM_NAME = "prism-fetch";

// Shorthand - logger.js defines self.prismLog
const log = (level, source, msg, data) => self.prismLog(level, source, msg, data);

// ---- Helpers ----
function formatReset(isoStr) {
    if (!isoStr) return '';
    const reset = new Date(isoStr);
    const now = new Date();
    const diffMin = (reset - now) / 60000;
    if (diffMin < 1) return 'Resets now';
    if (diffMin < 60) return 'Resets in ' + Math.ceil(diffMin) + ' min';
    if (diffMin < 1440) {
        const hrs = Math.floor(diffMin / 60);
        const mins = Math.ceil(diffMin % 60);
        return 'Resets in ' + hrs + 'h ' + mins + 'm';
    }
    return 'Resets ' + reset.toLocaleDateString('en-US', {weekday:'short'}) + ' ' + reset.toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit'});
}

// ---- Service fetchers ----

async function fetchClaude() {
    log('debug', 'claude', 'Fetch started');
    try {
        const bootstrapOrgId = await getClaudeOrgId();
        if (!bootstrapOrgId) {
            log('warn', 'claude', 'Not signed in to claude.ai (no org ID)');
            return { Connected: 0, error: 'Not logged in to claude.ai' };
        }

        const r = await fetch(`https://claude.ai/api/organizations/${bootstrapOrgId}/usage`, {
            credentials: 'include'
        });
        if (!r.ok) {
            log('error', 'claude', `Usage API returned HTTP ${r.status}`);
            return { Connected: 0, error: `HTTP ${r.status}` };
        }
        const data = await r.json();

        const result = {
            Connected: 1,
            HasUsageData: 1,
            PlanName: 'Max',
            SessionPercent: data.five_hour?.utilization ?? 0,
            SessionReset: formatReset(data.five_hour?.resets_at),
            WeeklyPercent: data.seven_day?.utilization ?? 0,
            WeeklyReset: formatReset(data.seven_day?.resets_at)
        };
        log('info', 'claude', `Fetch success: Session=${result.SessionPercent}% Weekly=${result.WeeklyPercent}%`);
        return result;
    } catch (e) {
        log('error', 'claude', 'Fetch exception: ' + e.message);
        return { Connected: 0, error: e.message };
    }
}

async function getClaudeOrgId() {
    const cached = await chrome.storage.local.get('claudeOrgId');
    if (cached.claudeOrgId) {
        try {
            const test = await fetch(`https://claude.ai/api/organizations/${cached.claudeOrgId}/usage`, { credentials: 'include' });
            if (test.ok) return cached.claudeOrgId;
        } catch {}
    }

    try {
        const cookie = await chrome.cookies.get({ url: 'https://claude.ai/', name: 'lastActiveOrg' }).catch(() => null);
        if (cookie && cookie.value) {
            await chrome.storage.local.set({ claudeOrgId: cookie.value });
            log('debug', 'claude', 'Discovered org ID from cookie', { orgId: cookie.value });
            return cookie.value;
        }

        const r = await fetch('https://claude.ai/api/organizations', { credentials: 'include' });
        if (!r.ok) return null;
        const orgs = await r.json();
        if (orgs && orgs.length > 0) {
            const sub = orgs.find(o => o.billing_type === 'stripe_subscription') || orgs[0];
            await chrome.storage.local.set({ claudeOrgId: sub.uuid });
            log('debug', 'claude', 'Discovered org ID from /api/organizations', { orgId: sub.uuid });
            return sub.uuid;
        }
    } catch (e) {
        log('error', 'claude', 'Failed to discover org ID: ' + e.message);
    }
    return null;
}

async function fetchChatGPT() {
    log('debug', 'chatgpt', 'Fetch started');
    try {
        const r = await fetch('https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27', {
            credentials: 'include'
        });
        if (!r.ok) {
            log('error', 'chatgpt', `accounts/check returned HTTP ${r.status}`);
            return { Connected: 0, error: `HTTP ${r.status}` };
        }
        const data = await r.json();

        const acct = data.accounts?.default;
        if (!acct) {
            log('warn', 'chatgpt', 'accounts/check returned no default account');
            return { Connected: 0, error: 'No account data' };
        }

        const planMap = {
            'chatgptguestplan': 'Free Plan',
            'chatgptfreeplan': 'Free Plan',
            'chatgptplusplan': 'Plus',
            'chatgptproplan': 'Pro',
            'chatgptteamplan': 'Team',
            'chatgptbusinessplan': 'Business',
            'chatgptenterpriseplan': 'Enterprise'
        };
        const rawPlan = acct.entitlement?.subscription_plan || acct.account?.plan_type || 'unknown';
        const planName = planMap[rawPlan] || rawPlan;

        log('info', 'chatgpt', `Fetch success: plan=${planName}`);
        return {
            Connected: 1,
            HasUsageData: 0,
            PlanName: planName
        };
    } catch (e) {
        log('error', 'chatgpt', 'Fetch exception: ' + e.message);
        return { Connected: 0, error: e.message };
    }
}

const CLAUDE_API_CACHE_KEY = 'claudeApiLastGood';
const CLAUDE_API_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

// Fetch with retry-on-5xx (short backoff). Client errors (4xx) return immediately
// since retries won't help. Returns the final Response (even if non-ok).
async function fetchWithRetry(url, opts, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const r = await fetch(url, opts);
        if (r.ok || r.status < 500) return r;
        if (attempt < maxAttempts) {
            log('debug', 'claude_api', `HTTP ${r.status}, retry ${attempt}/${maxAttempts - 1}`);
            await new Promise(res => setTimeout(res, attempt * 500));
        } else {
            return r; // give up, return last response
        }
    }
}

async function fetchClaudeApi() {
    log('debug', 'claude_api', 'Fetch started');
    const cachedLastGood = async () => (await chrome.storage.local.get(CLAUDE_API_CACHE_KEY))[CLAUDE_API_CACHE_KEY];

    try {
        // Compute date range for month-to-date
        const today = new Date();
        const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
        const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
        const toDateStr = (d) => d.toISOString().split('T')[0];
        const buildUrl = (oid) => `https://platform.claude.com/api/organizations/${oid}/usage_cost?starting_on=${toDateStr(firstOfMonth)}&ending_before=${toDateStr(tomorrow)}`;
        const fetchOpts = { credentials: 'include', headers: { 'Accept': 'application/json' } };

        // Use cached org ID directly (no pre-flight). Only re-discover if usage_cost fails.
        let orgId = (await chrome.storage.local.get('platformOrgId')).platformOrgId || null;
        let triedDiscovery = false;
        if (!orgId) {
            orgId = await discoverPlatformOrgId();
            triedDiscovery = true;
            if (!orgId) {
                return { Connected: 0, error: 'Not logged in to platform.claude.com' };
            }
        }

        let r = await fetchWithRetry(buildUrl(orgId), fetchOpts);

        // If cached org ID is stale (org renamed/rotated), re-discover once and retry
        if (!r.ok && !triedDiscovery && [401, 403, 404].includes(r.status)) {
            log('debug', 'claude_api', `usage_cost returned ${r.status} on cached org, re-discovering`);
            const fresh = await discoverPlatformOrgId();
            if (fresh && fresh !== orgId) {
                orgId = fresh;
                r = await fetchWithRetry(buildUrl(orgId), fetchOpts);
            }
        }

        if (!r.ok) {
            const snippet = (await r.text().catch(() => '')).slice(0, 150);
            // For transient 5xx (Anthropic upstream blip), reuse last-known-good value
            // rather than flashing the widget to "Not connected".
            if (r.status >= 500) {
                const cached = await cachedLastGood();
                if (cached && Date.now() - cached.cachedAt < CLAUDE_API_CACHE_MAX_AGE_MS) {
                    const ageSec = Math.round((Date.now() - cached.cachedAt) / 1000);
                    log('warn', 'claude_api', `HTTP ${r.status} (upstream); using cached value from ${ageSec}s ago`);
                    return cached.result;
                }
            }
            log('error', 'claude_api', `usage_cost HTTP ${r.status} | body: ${snippet}`);
            return { Connected: 0, error: `HTTP ${r.status}` };
        }

        const data = await r.json();

        // Sum `total` (in cents) across all entries for the default workspace
        let monthCents = 0, todayCents = 0, yesterdayCents = 0;
        const todayStr = toDateStr(today);
        const yesterdayStr = toDateStr(yesterday);
        for (const [date, entries] of Object.entries(data.costs || {})) {
            for (const e of entries) {
                if (e.workspace_id !== 'default') continue;
                monthCents += e.total;
                if (date === todayStr) todayCents += e.total;
                if (date === yesterdayStr) yesterdayCents += e.total;
            }
        }

        const result = {
            Connected: 1,
            MonthTotal: (monthCents / 100).toFixed(2),
            TodayTotal: (todayCents / 100).toFixed(2),
            YesterdayTotal: (yesterdayCents / 100).toFixed(2),
            PeriodLabel: (today.toLocaleString('en-US', { month: 'short' }) + ' MTD').toUpperCase()
        };
        log('info', 'claude_api', `Fetch success: MTD=$${result.MonthTotal} Today=$${result.TodayTotal}`);
        // Cache success for fallback on next upstream blip
        await chrome.storage.local.set({ [CLAUDE_API_CACHE_KEY]: { result, cachedAt: Date.now() } });
        return result;
    } catch (e) {
        // Network-level failure — try cache too
        const cached = await cachedLastGood();
        if (cached && Date.now() - cached.cachedAt < CLAUDE_API_CACHE_MAX_AGE_MS) {
            const ageSec = Math.round((Date.now() - cached.cachedAt) / 1000);
            log('warn', 'claude_api', `Network error (${e.message}); using cached value from ${ageSec}s ago`);
            return cached.result;
        }
        log('error', 'claude_api', 'Fetch exception: ' + e.message);
        return { Connected: 0, error: e.message };
    }
}

// ---- ChatGPT API cost (populated by openai-content.js + SW fetches) ----
//
// The content script reads the Auth0 JWT from platform.openai.com and hands
// it here. The actual api.openai.com calls happen in the service worker so
// they bypass CORS preflight (host_permissions covers both origins).

const CHATGPT_API_CACHE_KEY = 'chatgptApiLastGood';
let openaiSessionKey = null; // module-scope cache, dropped on 401/403

async function exchangeOpenAISessionKey(auth0Token) {
    // Same call platform.openai.com itself makes after Auth0 login.
    // Response shape: { user: { session: { sensitive_id: "sess-..." } }, ... }
    const r = await fetch('https://api.openai.com/dashboard/onboarding/login', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${auth0Token}`, 'Content-Type': 'application/json' }
    });
    if (!r.ok) {
        const body = (await r.text().catch(() => '')).slice(0, 200);
        log('warn', 'chatgpt_api', `onboarding/login HTTP ${r.status} | body: ${body}`);
        return null;
    }
    const data = await r.json();
    const key = data?.user?.session?.sensitive_id;
    if (!key) {
        log('warn', 'chatgpt_api', 'onboarding/login OK but no session.sensitive_id in response');
        return null;
    }
    log('debug', 'chatgpt_api', `Got session key (sess-...${key.slice(-6)})`);
    return key;
}

function summarizeOpenAICosts(rawData) {
    // Endpoint returns:
    //   { data: [ { start_time, end_time, results: [ { amount: { value, currency } } ] }, ... ] }
    // Values are USD decimals (not cents like Anthropic's).
    const today = new Date();
    const toDateStr = (d) => d.toISOString().split('T')[0];
    const todayStr = toDateStr(today);
    const yesterdayStr = toDateStr(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1));

    let monthTotal = 0, todayTotal = 0, yesterdayTotal = 0;
    for (const bucket of (rawData?.data || [])) {
        const bucketDate = new Date((bucket.start_time || 0) * 1000);
        const bucketDateStr = toDateStr(bucketDate);
        let bucketSum = 0;
        for (const r of (bucket.results || [])) {
            const v = r?.amount?.value;
            if (typeof v === 'number') bucketSum += v;
        }
        monthTotal += bucketSum;
        if (bucketDateStr === todayStr) todayTotal += bucketSum;
        if (bucketDateStr === yesterdayStr) yesterdayTotal += bucketSum;
    }

    return {
        Connected: 1,
        MonthTotal: monthTotal.toFixed(2),
        TodayTotal: todayTotal.toFixed(2),
        YesterdayTotal: yesterdayTotal.toFixed(2),
        PeriodLabel: (today.toLocaleString('en-US', { month: 'short' }) + ' MTD').toUpperCase()
    };
}

async function refreshOpenAICostsWithToken(auth0Token) {
    if (!openaiSessionKey) {
        openaiSessionKey = await exchangeOpenAISessionKey(auth0Token);
    }
    if (!openaiSessionKey) return { error: 'no_session_key' };

    const now = new Date();
    const startOfMonth = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
    const endOfTomorrow = Math.floor(Date.now() / 1000) + 86400;
    const costsUrl = `https://api.openai.com/v1/dashboard/organization/costs?bucket_width=1d&start_time=${startOfMonth}&end_time=${endOfTomorrow}&limit=31`;

    const r = await fetch(costsUrl, {
        headers: { 'Authorization': `Bearer ${openaiSessionKey}`, 'Accept': 'application/json' }
    });
    if (!r.ok) {
        const body = (await r.text().catch(() => '')).slice(0, 200);
        log('error', 'chatgpt_api', `costs HTTP ${r.status} | body: ${body}`);
        if (r.status === 401 || r.status === 403) openaiSessionKey = null; // force re-exchange
        return { error: `HTTP ${r.status}` };
    }
    const data = await r.json();
    const summary = summarizeOpenAICosts(data);
    return { ok: true, summary };
}

async function fetchChatGPTApi() {
    log('debug', 'chatgpt_api', 'Reading cached cost data from storage');
    const cached = (await chrome.storage.local.get(CHATGPT_API_CACHE_KEY))[CHATGPT_API_CACHE_KEY];
    if (!cached || !cached.result) {
        log('warn', 'chatgpt_api', 'No cached data - visit platform.openai.com to initialize');
        return { Connected: 0, error: 'Visit platform.openai.com to initialize' };
    }
    const ageSec = Math.round((Date.now() - cached.cachedAt) / 1000);
    log('debug', 'chatgpt_api', `Using cached data from ${ageSec}s ago`);
    return { ...cached.result, AgeSeconds: ageSec };
}

// ---- Gemini API spend (populated by aistudio-content.js) ----
//
// The content script iterates ALL projects on /spend and sends per-project
// cost data. We cache the full payload and compute the view (All vs. specific
// project) at read time based on the user's chrome.storage.sync preference.

const GEMINI_API_CACHE_KEY = 'geminiApiLastGood';

async function fetchGeminiApi() {
    log('debug', 'gemini_api', 'Reading cached spend data from storage');
    const cached = (await chrome.storage.local.get(GEMINI_API_CACHE_KEY))[GEMINI_API_CACHE_KEY];
    if (!cached || !cached.result) {
        log('warn', 'gemini_api', 'No cached data - visit aistudio.google.com/spend to initialize');
        return { Connected: 0, error: 'Visit aistudio.google.com/spend to initialize' };
    }
    const ageSec = Math.round((Date.now() - cached.cachedAt) / 1000);
    log('debug', 'gemini_api', `Using cached data from ${ageSec}s ago`);

    const raw = cached.result;

    // Determine which project view the user wants
    const { geminiApiProject = '__all__' } = await chrome.storage.sync.get('geminiApiProject').catch(() => ({}));

    let monthTotal, spendCapUsed, spendCap, projectName, hasData, hasCap;

    if (geminiApiProject === '__all__' || !raw.Projects) {
        // "All Projects" aggregate
        monthTotal = raw.AllTotal || '0.00';
        spendCapUsed = raw.AllCapUsed || '0.00';
        spendCap = raw.AllCap || '0.00';
        projectName = 'All Projects';
        hasData = raw.HasData || 0;
        hasCap = parseFloat(spendCap) > 0;
    } else {
        // Specific project
        const proj = (raw.Projects || []).find(p => p.name === geminiApiProject);
        if (proj) {
            monthTotal = proj.cost;
            spendCapUsed = proj.spendCapUsed;
            spendCap = proj.spendCap;
            projectName = proj.name;
            hasData = parseFloat(proj.cost) > 0 ? 1 : 0;
            hasCap = proj.hasCap;
        } else {
            // Selected project no longer exists — fall back to All
            monthTotal = raw.AllTotal || '0.00';
            spendCapUsed = raw.AllCapUsed || '0.00';
            spendCap = raw.AllCap || '0.00';
            projectName = 'All Projects';
            hasData = raw.HasData || 0;
            hasCap = parseFloat(spendCap) > 0;
        }
    }

    return {
        Connected: 1,
        Tier: raw.Tier || 'Unknown',
        ProjectName: projectName,
        MonthTotal: monthTotal,
        SpendCapUsed: spendCapUsed,
        SpendCap: spendCap,
        HasCap: hasCap ? 1 : 0,
        HasData: hasData,
        PeriodLabel: raw.PeriodLabel || '',
        ProjectNames: raw.ProjectNames || [],
        AgeSeconds: ageSec
    };
}

async function discoverPlatformOrgId() {
    try {
        const r = await fetch('https://platform.claude.com/api/organizations', {
            credentials: 'include',
            headers: { 'Accept': 'application/json' }
        });
        if (!r.ok) {
            log('warn', 'claude_api', `/api/organizations HTTP ${r.status} (login required?)`);
            return null;
        }
        const orgs = await r.json();
        if (!Array.isArray(orgs) || orgs.length === 0) {
            log('warn', 'claude_api', `/api/organizations returned no orgs (len=${orgs?.length})`);
            return null;
        }
        const apiOrg = orgs.find(o => Array.isArray(o.capabilities) && o.capabilities.includes('api'));
        if (!apiOrg) {
            const allCaps = orgs.map(o => (o.capabilities || []).join('|')).join('; ');
            log('warn', 'claude_api', `No org with "api" capability. Found: ${allCaps}`);
            return null;
        }
        await chrome.storage.local.set({ platformOrgId: apiOrg.uuid });
        log('info', 'claude_api', `Discovered API org ID: ${apiOrg.uuid}`);
        return apiOrg.uuid;
    } catch (e) {
        log('error', 'claude_api', 'discoverPlatformOrgId threw: ' + e.message);
        return null;
    }
}

async function fetchGemini() {
    log('debug', 'gemini', 'Fetch started');
    try {
        const cookie = await chrome.cookies.get({ url: 'https://gemini.google.com/', name: 'SID' }).catch(() => null);
        if (!cookie) {
            log('warn', 'gemini', 'Not signed in to Google (no SID cookie)');
            return { Connected: 0, error: 'Not signed in to Google' };
        }

        const cached = await chrome.storage.local.get(['geminiPlanName', 'geminiPlanDetectedAt']);
        const planName = cached.geminiPlanName || 'Unknown';
        if (planName === 'Unknown') {
            log('warn', 'gemini', 'Plan unknown - visit gemini.google.com once so the content script can detect the badge');
        } else {
            const ageSec = cached.geminiPlanDetectedAt ? Math.round((Date.now() - cached.geminiPlanDetectedAt) / 1000) : -1;
            log('info', 'gemini', `Fetch success: plan=${planName} (detected ${ageSec}s ago)`);
        }

        return {
            Connected: 1,
            HasUsageData: 0,
            PlanName: planName
        };
    } catch (e) {
        log('error', 'gemini', 'Fetch exception: ' + e.message);
        return { Connected: 0, error: e.message };
    }
}

// ---- Plan-change detection ----

async function detectPlanChanges(newPayload) {
    const { lastPayload } = await chrome.storage.local.get('lastPayload');
    if (!lastPayload) return;
    for (const svc of ['claude', 'chatgpt', 'gemini']) {
        const oldPlan = lastPayload[svc]?.PlanName;
        const newPlan = newPayload[svc]?.PlanName;
        if (oldPlan && newPlan && oldPlan !== newPlan && newPlan !== 'Unknown') {
            log('info', svc, `Plan changed: ${oldPlan} -> ${newPlan}`);
        }
    }
}

// ---- Main loop ----

async function runUpdate() {
    log('debug', 'core', 'runUpdate started');

    const [claude, chatgpt, gemini, claudeApi, chatgptApi, geminiApi] = await Promise.all([
        fetchClaude(),
        fetchChatGPT(),
        fetchGemini(),
        fetchClaudeApi(),
        fetchChatGPTApi(),
        fetchGeminiApi()
    ]);

    const payload = {
        timestamp: new Date().toISOString(),
        claude,
        chatgpt,
        gemini,
        claudeApi,
        chatgptApi,
        geminiApi
    };

    await detectPlanChanges(payload);

    // Cache for popup
    await chrome.storage.local.set({ lastPayload: payload, lastUpdate: Date.now() });

    // Send to native host
    try {
        await new Promise((resolve, reject) => {
            chrome.runtime.sendNativeMessage(NATIVE_HOST, payload, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve(response);
                }
            });
        });
        log('debug', 'core', 'Native host write OK');
    } catch (e) {
        log('error', 'core', 'Native host error: ' + e.message);
    }
}

// ---- Lifecycle ----

chrome.runtime.onInstalled.addListener(() => {
    log('info', 'core', 'Extension installed/updated');
    chrome.alarms.create(ALARM_NAME, {
        when: Date.now() + 2000,
        periodInMinutes: FETCH_INTERVAL_MINUTES
    });
});

chrome.runtime.onStartup.addListener(() => {
    log('info', 'core', 'Browser startup');
    chrome.alarms.create(ALARM_NAME, {
        when: Date.now() + 2000,
        periodInMinutes: FETCH_INTERVAL_MINUTES
    });
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) {
        log('debug', 'core', 'Alarm fired');
        runUpdate();
    }
});

// Handle manual trigger from popup + content-script cost uploads
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'refresh') {
        log('info', 'popup', 'Manual refresh requested');
        runUpdate().then(() => sendResponse({ ok: true })).catch(e => {
            log('error', 'core', 'Manual refresh failed: ' + e.message);
            sendResponse({ ok: false, error: e.message });
        });
        return true; // async response
    }
    if (msg.type === 'openai_auth_token') {
        // Content script handed us an Auth0 JWT (or no_jwt error). The SW
        // does the api.openai.com calls so they bypass CORS.
        (async () => {
            if (msg.error || !msg.token) {
                const errMsg = msg.error || 'no_token';
                const existing = (await chrome.storage.local.get(CHATGPT_API_CACHE_KEY))[CHATGPT_API_CACHE_KEY];
                if (!existing || !existing.result) {
                    await chrome.storage.local.set({
                        [CHATGPT_API_CACHE_KEY]: { result: { Connected: 0, error: errMsg }, cachedAt: Date.now() }
                    });
                }
                sendResponse({ ok: false, error: errMsg });
                return;
            }

            try {
                const res = await refreshOpenAICostsWithToken(msg.token);
                if (res.ok) {
                    await chrome.storage.local.set({
                        [CHATGPT_API_CACHE_KEY]: { result: res.summary, cachedAt: Date.now() }
                    });
                    log('info', 'chatgpt_api', `Fetch success: MTD=$${res.summary.MonthTotal} Today=$${res.summary.TodayTotal}`);
                    runUpdate().catch(() => {});
                    sendResponse({ ok: true, summary: res.summary });
                } else {
                    // Keep cached success around — only overwrite if we have no prior good data
                    const existing = (await chrome.storage.local.get(CHATGPT_API_CACHE_KEY))[CHATGPT_API_CACHE_KEY];
                    if (!existing || !existing.result || existing.result.Connected !== 1) {
                        await chrome.storage.local.set({
                            [CHATGPT_API_CACHE_KEY]: { result: { Connected: 0, error: res.error }, cachedAt: Date.now() }
                        });
                    }
                    sendResponse({ ok: false, error: res.error });
                }
            } catch (e) {
                log('error', 'chatgpt_api', 'SW fetch exception: ' + e.message);
                sendResponse({ ok: false, error: e.message });
            }
        })();
        return true;
    }
    if (msg.type === 'gemini_api_update' && msg.summary) {
        (async () => {
            await chrome.storage.local.set({
                [GEMINI_API_CACHE_KEY]: { result: msg.summary, cachedAt: Date.now() }
            });
            const pCount = (msg.summary.Projects || []).length;
            log('info', 'gemini_api', `Content script pushed fresh spend: ${pCount} projects, allTotal=$${msg.summary.AllTotal} tier=${msg.summary.Tier}`);
            runUpdate().catch(() => {});
            sendResponse({ ok: true });
        })();
        return true;
    }
});
