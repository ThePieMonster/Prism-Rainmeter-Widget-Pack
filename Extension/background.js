// ==========================================================================
//  Prism Extension - Service Worker
//  Periodically fetches usage data from claude.ai, chatgpt.com, gemini.google.com
//  using the user's existing authenticated session. Sends results to the
//  native messaging host which writes to ConsumerData.inc.
// ==========================================================================

importScripts('logger.js');  // defines self.prismLog

const NATIVE_HOST = "com.prism.usage";
const FETCH_INTERVAL_MINUTES = 1;
const ALARM_NAME = "prism-fetch";

// Per-request network timeout. Chrome terminates the service worker when a
// fetch() response takes more than 30s, which would lose the whole cycle.
const FETCH_TIMEOUT_MS = 15000;
// How long the native host gets to reply before the write counts as failed
const NATIVE_REPLY_TIMEOUT_MS = 15000;

// Shorthand - logger.js defines self.prismLog
const log = (level, source, msg, data) => self.prismLog(level, source, msg, data);

// ---- Helpers ----
function formatReset(isoStr) {
    if (!isoStr) return '';
    const reset = new Date(isoStr);
    const now = new Date();
    const diffMin = (reset - now) / 60000;
    if (diffMin < 1) return 'Resets now';
    // Round up once and pick the branch on the rounded total, so 59.5 min
    // reads "1h 0m" (not "60 min") and 299.5 min "5h 0m" (not "4h 60m")
    const total = Math.ceil(diffMin);
    if (total < 60) return 'Resets in ' + total + ' min';
    if (total < 1440) return 'Resets in ' + Math.floor(total / 60) + 'h ' + (total % 60) + 'm';
    return 'Resets ' + reset.toLocaleDateString('en-US', {weekday:'short'}) + ' ' + reset.toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit'});
}

// A usage percentage as a whole number, never negative (0 for a missing or
// non-numeric value). Not capped at 100, so an over-limit reading still shows
// as one: the skins clamp their bars themselves.
function wholePercent(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

// A fresh timeout signal for every request: a shared one would already have
// fired for later retries. It stays attached through the body read, so a
// stalled r.json() / r.text() is cut off too. AbortSignal.timeout needs
// Chrome 103+; older builds get the AbortController equivalent.
function timeoutSignal(ms) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(ms);
    }
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
}

function fetchT(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
    return fetch(url, { ...opts, signal: timeoutSignal(ms) });
}

// Rate limits and upstream errors are worth riding out. Anything else
// (401/403/404...) is a real answer from the service.
function isTransientStatus(status) {
    return status === 408 || status === 429 || status >= 500;
}

function sameLocalMonth(a, b) {
    const da = new Date(a), db = new Date(b);
    return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth();
}

// ---- Cost dates (Claude Console + OpenAI) ----
//
// Both cost endpoints bucket spend by UTC calendar day and neither request
// carries a timezone, so every cost date here is a UTC 'YYYY-MM-DD' string.
// Never format a local-midnight Date with toISOString(): in most timezones
// that lands on the neighbouring UTC day.

function utcDayStr(date, dayOffset = 0) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + dayOffset)).toISOString().slice(0, 10);
}

function costDateRange(now = new Date()) {
    const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
    const monthStartMs = Date.UTC(y, m, 1);
    const yesterdayMs = Date.UTC(y, m, d - 1);
    const tomorrowMs = Date.UTC(y, m, d + 1);
    return {
        monthStart: new Date(monthStartMs).toISOString().slice(0, 10),
        today: utcDayStr(now),
        yesterday: new Date(yesterdayMs).toISOString().slice(0, 10),
        tomorrow: new Date(tomorrowMs).toISOString().slice(0, 10),
        // On the 1st, yesterday is in the previous month: start the range
        // there so Yesterday has data (MonthTotal still starts at monthStart)
        rangeStartSec: Math.min(monthStartMs, yesterdayMs) / 1000,
        tomorrowSec: tomorrowMs / 1000,
        periodLabel: (now.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) + ' MTD').toUpperCase()
    };
}

// A cached cost summary holds Today/Yesterday for the UTC day it was taken
// on (DataDay) and the day before. Those values are passed on as taken, never
// zeroed or moved: a snapshot from an earlier UTC day is flagged Stale, and
// DataDay says which day TodayTotal belongs to, so a reader can dim, hide or
// re-label the rows. Returns null when the snapshot is from an earlier UTC
// month, since its month-to-date total is not this month's.
function flagCostSnapshot(result, cachedAt, now = new Date()) {
    const dataDay = /^\d{4}-\d{2}-\d{2}$/.test(result.DataDay || '') ? result.DataDay
        : utcDayStr(new Date(Number.isFinite(cachedAt) ? cachedAt : 0));
    const today = utcDayStr(now);
    if (dataDay.slice(0, 7) !== today.slice(0, 7)) return null;
    return { ...result, DataDay: dataDay, Stale: dataDay < today ? 1 : 0 };
}

// ---- Last-good consumer snapshots ----
//
// A network blip, 429 or 5xx should not flip a consumer widget to "Not
// connected", which is also what a real sign-out looks like. Each fetcher
// saves the raw values of its last success (plan, plus {pct, resetIso} per
// window, never the formatted reset text) and reuses them for a short while
// on a transient failure, with the reset text rebuilt each time. A confirmed
// sign-out clears the snapshot, so a logout is never hidden.

const CONSUMER_SNAPSHOT_KEYS = { claude: 'claudeLastGood', chatgpt: 'chatgptLastGood', gemini: 'geminiLastGood' };
const CONSUMER_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;

function usageSlot(w) {
    return w ? { pct: w.pct, resetIso: w.resetIso || null } : null;
}

async function saveConsumerSnapshot(svc, plan, usage) {
    try {
        await chrome.storage.local.set({
            [CONSUMER_SNAPSHOT_KEYS[svc]]: {
                plan, session: usageSlot(usage.session), weekly: usageSlot(usage.weekly), cachedAt: Date.now()
            }
        });
    } catch {}
}

async function clearConsumerSnapshot(svc) {
    try { await chrome.storage.local.remove(CONSUMER_SNAPSHOT_KEYS[svc]); } catch {}
}

// The snapshot, if it is recent enough and no window has reset since it was
// taken (the old percentage is wrong after a reset); otherwise null.
async function loadConsumerSnapshot(svc) {
    try {
        const key = CONSUMER_SNAPSHOT_KEYS[svc];
        const snap = (await chrome.storage.local.get(key))[key];
        if (!snap || !snap.cachedAt || !(snap.session || snap.weekly)) return null;
        const now = Date.now();
        const age = now - snap.cachedAt;
        if (age < 0 || age > CONSUMER_SNAPSHOT_MAX_AGE_MS) return null;
        for (const w of [snap.session, snap.weekly]) {
            if (w && w.resetIso && Date.parse(w.resetIso) <= now) return null;
        }
        return snap;
    } catch {
        return null;
    }
}

// Flags a result rebuilt from a snapshot. Hosts ignore the extra fields.
function markStale(result, snap) {
    result.Stale = 1;
    result.AgeSeconds = Math.round((Date.now() - snap.cachedAt) / 1000);
    return result;
}

// ---- Service fetchers ----

function claudeUsageUrl(orgId) {
    return `https://claude.ai/api/organizations/${orgId}/usage`;
}

function buildClaudeResult(planName, usage) {
    return {
        Connected: 1,
        HasUsageData: 1,
        PlanName: planName,
        SessionPercent: usage.session?.pct ?? 0,
        SessionReset: formatReset(usage.session?.resetIso),
        WeeklyPercent: usage.weekly?.pct ?? 0,
        WeeklyReset: formatReset(usage.weekly?.resetIso)
    };
}

// Transient failure: reuse the last good usage if there is one, else report the error
async function claudeFromSnapshot(logMsg, errorText) {
    const snap = await loadConsumerSnapshot('claude');
    if (snap) {
        const result = markStale(buildClaudeResult(snap.plan || '', snap), snap);
        log('warn', 'claude', `${logMsg}; using last good usage from ${result.AgeSeconds}s ago`);
        return result;
    }
    log('error', 'claude', logMsg);
    return { Connected: 0, error: errorText };
}

async function fetchClaude() {
    log('debug', 'claude', 'Fetch started');
    try {
        // Use the cached org ID directly (no pre-flight /usage call). Only
        // re-discover when the usage call itself rejects the org.
        const cachedOrgId = (await chrome.storage.local.get('claudeOrgId')).claudeOrgId || null;
        let orgId = cachedOrgId || await discoverClaudeOrgId();
        if (!orgId) {
            log('warn', 'claude', 'Not signed in to claude.ai (no org ID)');
            await clearConsumerSnapshot('claude');
            return { Connected: 0, error: 'Not logged in to claude.ai' };
        }

        let r = await fetchT(claudeUsageUrl(orgId), { credentials: 'include' });
        if (cachedOrgId && [401, 403, 404].includes(r.status)) {
            log('debug', 'claude', `Usage API returned HTTP ${r.status} on cached org, re-discovering`);
            const fresh = await discoverClaudeOrgId();
            if (!fresh) {
                log('warn', 'claude', 'Not signed in to claude.ai (no org ID)');
                await clearConsumerSnapshot('claude');
                return { Connected: 0, error: 'Not logged in to claude.ai' };
            }
            if (fresh !== orgId) {
                orgId = fresh;
                r = await fetchT(claudeUsageUrl(orgId), { credentials: 'include' });
            }
        }
        if (!r.ok) {
            if (isTransientStatus(r.status)) {
                return await claudeFromSnapshot(`Usage API returned HTTP ${r.status}`, `HTTP ${r.status}`);
            }
            log('error', 'claude', `Usage API returned HTTP ${r.status}`);
            await clearConsumerSnapshot('claude');
            return { Connected: 0, error: `HTTP ${r.status}` };
        }
        const data = await r.json();

        const usage = {
            session: { pct: wholePercent(data.five_hour?.utilization), resetIso: data.five_hour?.resets_at || null },
            weekly: { pct: wholePercent(data.seven_day?.utilization), resetIso: data.seven_day?.resets_at || null }
        };
        const planName = await getClaudePlanName(orgId);
        await saveConsumerSnapshot('claude', planName, usage);

        const result = buildClaudeResult(planName, usage);
        log('info', 'claude', `Fetch success: plan=${planName || '(not determined)'} Session=${result.SessionPercent}% Weekly=${result.WeeklyPercent}%`);
        return result;
    } catch (e) {
        // Offline, timeout or a garbled response: not a sign-out
        return await claudeFromSnapshot('Fetch exception: ' + e.message, e.message);
    }
}

// Finds the org to read usage for: the lastActiveOrg cookie first (no network),
// then /api/organizations. Returns null when signed out; throws on a network
// error, timeout, 429 or 5xx so the caller can treat it as transient.
async function discoverClaudeOrgId() {
    const cookie = await chrome.cookies.get({ url: 'https://claude.ai/', name: 'lastActiveOrg' }).catch(() => null);
    if (cookie && cookie.value) {
        await chrome.storage.local.set({ claudeOrgId: cookie.value });
        log('debug', 'claude', 'Discovered org ID from cookie', { orgId: cookie.value });
        return cookie.value;
    }

    const r = await fetchT('https://claude.ai/api/organizations', { credentials: 'include' });
    if (!r.ok) {
        if (isTransientStatus(r.status)) throw new Error(`/api/organizations returned HTTP ${r.status}`);
        return null;
    }
    const orgs = await r.json();
    if (Array.isArray(orgs) && orgs.length > 0) {
        const sub = orgs.find(o => o.billing_type === 'stripe_subscription') || orgs[0];
        await chrome.storage.local.set({ claudeOrgId: sub.uuid });
        log('debug', 'claude', 'Discovered org ID from /api/organizations', { orgId: sub.uuid });
        // Same response carries the plan, so cache it without another request
        await cacheClaudePlanFromOrgs(orgs, sub.uuid).catch(() => {});
        return sub.uuid;
    }
    return null;
}

// ---- Claude consumer plan name ----
//
// The plan comes from the org entry in https://claude.ai/api/organizations
// that matches the org we read usage for. It is cached per org and refreshed
// every few hours (or when the org changes), not every cycle.
//
// The org object is undocumented. Checked against a live response on
// 2026-10-18: a Max 20x org has capabilities ['chat', 'claude_max'],
// rate_limit_tier 'default_claude_max_20x', billing_type 'stripe_subscription'
// and raven_type null; a Claude Console org on the same account has
// capabilities ['api', 'api_individual', ...], billing_type 'prepaid' and no
// plan. Pro ('claude_pro'), Free (only 'chat') and the Claude for Work
// raven_type values ('team', 'enterprise') follow the same scheme but were
// not seen live. Only fixed labels are ever emitted, and anything
// unrecognised maps to '' so no plan is claimed (the skin then shows no
// label, the popup shows "Active"). If the label stays blank for a known
// plan, set the log level to Debug: the 'Could not determine plan' line
// lists the plan fields that came back.

const CLAUDE_PLAN_KEY = 'claudePlan';
const CLAUDE_PLAN_MAX_AGE_MS = 6 * 60 * 60 * 1000;   // plans rarely change
const CLAUDE_PLAN_RETRY_MS = 30 * 60 * 1000;         // after a failed lookup

function mapClaudePlan(org) {
    if (!org || typeof org !== 'object') return '';
    const caps = Array.isArray(org.capabilities) ? org.capabilities.map(c => String(c).toLowerCase()) : [];
    const tier = typeof org.rate_limit_tier === 'string' ? org.rate_limit_tier.toLowerCase() : '';
    const raven = typeof org.raven_type === 'string' ? org.raven_type.toLowerCase() : '';
    const word = (w) => new RegExp(`(^|_)${w}(_|$)`);
    const marked = (w) => caps.includes(w) || word(w).test(tier);

    if (raven === 'enterprise' || marked('enterprise')) return 'Enterprise';
    if (raven === 'team' || marked('team')) return 'Team';
    // A Claude for Work org of a type not matched above: 'raven' alone does
    // not say Team or Enterprise, so claim neither (nor a personal plan)
    if (raven || caps.includes('raven')) return '';
    if (caps.includes('claude_max') || word('max').test(tier)) return 'Max';
    if (caps.includes('claude_pro') || word('pro').test(tier)) return 'Pro';
    // Free only when the org is plainly a chat-only one with no billing at all
    if (caps.length > 0 && caps.every(c => c === 'chat') &&
        (tier === '' || tier === 'default_claude_ai') && !org.billing_type) {
        return 'Free';
    }
    return '';
}

// Caches the plan of orgId from an /api/organizations response. Returns the
// label ('' when it cannot be determined), or null when orgId is not listed.
async function cacheClaudePlanFromOrgs(orgs, orgId) {
    const org = Array.isArray(orgs) ? orgs.find(o => o && o.uuid === orgId) : null;
    if (!org) return null;
    const name = mapClaudePlan(org);
    if (!name) {
        log('debug', 'claude', 'Could not determine plan from org', {
            capabilities: org.capabilities, rate_limit_tier: org.rate_limit_tier,
            raven_type: org.raven_type, billing_type: org.billing_type,
            analytics_subscription_plan: org.analytics_subscription_plan
        });
    }
    await chrome.storage.local.set({ [CLAUDE_PLAN_KEY]: { orgId, name, ok: true, at: Date.now() } });
    return name;
}

// Never throws: a failed lookup must not turn a good /usage result into an error.
async function getClaudePlanName(orgId) {
    let cached = null;
    try {
        cached = (await chrome.storage.local.get(CLAUDE_PLAN_KEY))[CLAUDE_PLAN_KEY] || null;
        if (cached && cached.orgId === orgId) {
            const age = Date.now() - (cached.at || 0);
            const ttl = cached.ok ? CLAUDE_PLAN_MAX_AGE_MS : CLAUDE_PLAN_RETRY_MS;
            if (age >= 0 && age < ttl) return cached.name || '';
        }
        const r = await fetchT('https://claude.ai/api/organizations', { credentials: 'include' });
        if (!r.ok) throw new Error(`/api/organizations returned HTTP ${r.status}`);
        const name = await cacheClaudePlanFromOrgs(await r.json(), orgId);
        if (name === null) throw new Error('org not listed in /api/organizations');
        return name;
    } catch (e) {
        // Keep the last good label for this org and retry later, not every cycle
        const keep = cached && cached.orgId === orgId ? (cached.name || '') : '';
        log('debug', 'claude', 'Plan lookup failed: ' + e.message);
        try {
            await chrome.storage.local.set({ [CLAUDE_PLAN_KEY]: { orgId, name: keep, ok: false, at: Date.now() } });
        } catch {}
        return keep;
    }
}

// ---- ChatGPT consumer usage (Codex 5-hour + weekly limits) ----
//
// ChatGPT plans meter Codex (and the agentic features that share its pool)
// with a 5-hour rolling window plus a weekly cap, the "Usage remaining" numbers
// in the ChatGPT app's profile menu. The ChatGPT/Codex clients read them from
// backend-api/wham/usage, which needs the bearer token chatgpt.com hands its
// own web app via /api/auth/session. We fetch that token fresh each cycle and
// only hold it in memory for the request; it is never stored or logged.
//
// Response shape (only the fields we use):
//   { plan_type: "plus",
//     rate_limit: { primary_window:   { used_percent, limit_window_seconds: 18000,  reset_at },
//                   secondary_window: { used_percent, limit_window_seconds: 604800, reset_at } } }

const CHATGPT_PLAN_NAMES = {
    free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', team: 'Team',
    business: 'Business', enterprise: 'Enterprise', edu: 'Edu', education: 'Edu'
};

function formatChatGPTPlan(raw) {
    if (!raw) return 'Unknown';
    const key = String(raw).toLowerCase();
    if (CHATGPT_PLAN_NAMES[key]) return CHATGPT_PLAN_NAMES[key];
    // Unmapped plan (e.g. "pro_lite"): title-case it rather than show the raw id
    return key.split(/[_\s-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function parseChatGPTUsage(data) {
    // Classify by window length rather than trusting primary/secondary order:
    // anything a day or shorter is the session window, longer is weekly.
    const out = {};
    const rl = data?.rate_limit;
    for (const w of [rl?.primary_window, rl?.secondary_window]) {
        if (!w || typeof w.used_percent !== 'number') continue;
        const resetSec = typeof w.reset_at === 'number' ? w.reset_at
            : typeof w.reset_after_seconds === 'number' ? Date.now() / 1000 + w.reset_after_seconds
            : null;
        const slot = {
            pct: Math.max(0, Math.min(100, Math.round(w.used_percent))),
            resetIso: resetSec ? new Date(resetSec * 1000).toISOString() : null
        };
        const isWeekly = typeof w.limit_window_seconds === 'number'
            ? w.limit_window_seconds > 86400
            : !!out.session;  // no length given: first window is session, second weekly
        if (isWeekly && !out.weekly) out.weekly = slot;
        else if (!out.session) out.session = slot;
        else if (!out.weekly) out.weekly = slot;
    }
    return out;
}

function buildChatGPTResult(planName, usage) {
    // A window the plan doesn't report still gets a bar; say so rather
    // than show a blank reset that reads like an untouched 0%.
    const result = {
        Connected: 1,
        HasUsageData: 1,
        PlanName: planName,
        SessionPercent: usage.session?.pct ?? 0,
        SessionReset: usage.session ? formatReset(usage.session.resetIso) : 'Not reported',
        WeeklyPercent: usage.weekly?.pct ?? 0,
        WeeklyReset: usage.weekly ? formatReset(usage.weekly.resetIso) : 'Not reported'
    };
    // Legacy fields for widget packs older than 1.3, whose native host
    // still maps ChatGPTMessage* into a single bar: use whichever window
    // is closer to its limit, so a hit weekly cap doesn't read as 0%.
    const legacy = usage.weekly && (!usage.session || usage.weekly.pct > usage.session.pct) ? 'Weekly' : 'Session';
    result.MessagePercent = result[legacy + 'Percent'];
    result.MessageReset = result[legacy + 'Reset'];
    return result;
}

// Transient failure: reuse the last good usage if there is one, else report the error
async function chatgptFromSnapshot(logMsg, errorText) {
    const snap = await loadConsumerSnapshot('chatgpt');
    if (snap) {
        const result = markStale(buildChatGPTResult(snap.plan || 'Unknown', snap), snap);
        log('warn', 'chatgpt', `${logMsg}; using last good usage from ${result.AgeSeconds}s ago`);
        return result;
    }
    log('error', 'chatgpt', logMsg);
    return { Connected: 0, error: errorText };
}

async function fetchChatGPT() {
    log('debug', 'chatgpt', 'Fetch started');
    try {
        const sr = await fetchT('https://chatgpt.com/api/auth/session', { credentials: 'include' });
        if (!sr.ok) {
            if (isTransientStatus(sr.status)) {
                return await chatgptFromSnapshot(`auth/session returned HTTP ${sr.status}`, `HTTP ${sr.status}`);
            }
            log('error', 'chatgpt', `auth/session returned HTTP ${sr.status}`);
            if (sr.status === 401 || sr.status === 403) await clearConsumerSnapshot('chatgpt');
            return { Connected: 0, error: `HTTP ${sr.status}` };
        }
        // Logged-out sessions come back as 200 with an empty object
        const session = await sr.json();
        const accessToken = session?.accessToken;
        if (!accessToken) {
            log('warn', 'chatgpt', 'Not signed in to chatgpt.com (no session)');
            await clearConsumerSnapshot('chatgpt');
            return { Connected: 0, error: 'Not logged in to chatgpt.com' };
        }
        const accountId = session.account?.id;
        let planName = formatChatGPTPlan(session.account?.planType);

        let usage = null;
        let usageTransient = false;
        try {
            const headers = { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' };
            if (accountId) headers['ChatGPT-Account-Id'] = accountId;
            const r = await fetchT('https://chatgpt.com/backend-api/wham/usage', { credentials: 'include', headers });
            if (r.ok) {
                const data = await r.json();
                if (data?.plan_type) planName = formatChatGPTPlan(data.plan_type);
                usage = parseChatGPTUsage(data);
            } else {
                log('warn', 'chatgpt', `wham/usage returned HTTP ${r.status}`);
                usageTransient = isTransientStatus(r.status);
            }
        } catch (e) {
            log('warn', 'chatgpt', 'Usage fetch failed: ' + e.message);
            usageTransient = true;
        }

        if (usage && (usage.session || usage.weekly)) {
            await saveConsumerSnapshot('chatgpt', planName, usage);
            const result = buildChatGPTResult(planName, usage);
            log('info', 'chatgpt', `Fetch success: plan=${planName} Session=${result.SessionPercent}% Weekly=${result.WeeklyPercent}%`);
            return result;
        }

        // Usage call hit a blip: keep the last good bars for a while
        if (usageTransient) {
            const snap = await loadConsumerSnapshot('chatgpt');
            if (snap) {
                const result = markStale(buildChatGPTResult(planName, snap), snap);
                log('warn', 'chatgpt', `Usage unavailable; using last good usage from ${result.AgeSeconds}s ago`);
                return result;
            }
        } else if (usage) {
            // The usage call worked but reports no windows: old bars no longer apply
            await clearConsumerSnapshot('chatgpt');
        }

        // Fallback: logged in but no usage windows (plan without limits, or endpoint changed)
        log('info', 'chatgpt', `Fetch success (plan only): plan=${planName}`);
        return {
            Connected: 1,
            HasUsageData: 0,
            PlanName: planName
        };
    } catch (e) {
        // Offline, timeout or a garbled response: not a sign-out
        return await chatgptFromSnapshot('Fetch exception: ' + e.message, e.message);
    }
}

const CLAUDE_API_CACHE_KEY = 'claudeApiLastGood';
const CLAUDE_API_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

// Fetch with retry-on-5xx (short backoff). Client errors (4xx) return immediately
// since retries won't help. Returns the final Response (even if non-ok).
async function fetchWithRetry(url, opts, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const r = await fetchT(url, opts);  // fresh timeout per attempt
        if (r.ok || r.status < 500) return r;
        if (attempt < maxAttempts) {
            log('debug', 'claude_api', `HTTP ${r.status}, retry ${attempt}/${maxAttempts - 1}`);
            await new Promise(res => setTimeout(res, attempt * 500));
        } else {
            return r; // give up, return last response
        }
    }
}

// Sums `total` (in cents) for the default workspace over the days that pass dayFilter
function sumClaudeCostCents(data, dayFilter) {
    let cents = 0;
    for (const [date, entries] of Object.entries(data?.costs || {})) {
        const day = String(date).slice(0, 10);  // 'YYYY-MM-DD' (tolerates a full ISO key)
        if (!dayFilter(day) || !Array.isArray(entries)) continue;
        for (const e of entries) {
            if (e.workspace_id !== 'default') continue;
            if (typeof e.total === 'number') cents += e.total;
        }
    }
    return cents;
}

async function fetchClaudeApi() {
    log('debug', 'claude_api', 'Fetch started');
    const cachedLastGood = async () => (await chrome.storage.local.get(CLAUDE_API_CACHE_KEY))[CLAUDE_API_CACHE_KEY];
    // Last-good value for a transient failure (null if unusable). Always
    // flagged Stale, even from earlier today, since it is not a live read.
    const usableCache = async () => {
        const cached = await cachedLastGood();
        if (!cached || !cached.result || Date.now() - cached.cachedAt >= CLAUDE_API_CACHE_MAX_AGE_MS) return null;
        const result = flagCostSnapshot(cached.result, cached.cachedAt);
        if (!result) return null;
        const ageSec = Math.round((Date.now() - cached.cachedAt) / 1000);
        return {
            result: { ...result, Stale: 1, AgeSeconds: ageSec, CachedAtEpoch: Math.floor(cached.cachedAt / 1000) },
            ageSec
        };
    };
    // A real answer (signed out, no access) drops the last-good value, so a
    // later transient failure cannot bring back this account's spend
    const dropCache = async () => {
        try { await chrome.storage.local.remove(CLAUDE_API_CACHE_KEY); } catch {}
    };

    try {
        // Month-to-date range in UTC days (see costDateRange)
        const range = costDateRange(new Date());
        const buildUrl = (oid, from = range.monthStart, to = range.tomorrow) =>
            `https://platform.claude.com/api/organizations/${oid}/usage_cost?starting_on=${from}&ending_before=${to}`;
        const fetchOpts = { credentials: 'include', headers: { 'Accept': 'application/json' } };

        // Use cached org ID directly (no pre-flight). Only re-discover if usage_cost fails.
        let orgId = (await chrome.storage.local.get('platformOrgId')).platformOrgId || null;
        let triedDiscovery = false;
        if (!orgId) {
            // A transient failure throws into the catch below (cache, or the
            // error itself), so it is never reported as a sign-out
            orgId = await discoverPlatformOrgId();
            triedDiscovery = true;
            if (!orgId) {
                await dropCache();
                return { Connected: 0, error: 'Not logged in to platform.claude.com' };
            }
        }

        let r = await fetchWithRetry(buildUrl(orgId), fetchOpts);

        // If cached org ID is stale (org renamed/rotated), re-discover once and retry
        if (!r.ok && !triedDiscovery && [401, 403, 404].includes(r.status)) {
            log('debug', 'claude_api', `usage_cost returned ${r.status} on cached org, re-discovering`);
            // If that fails too, the usage_cost status is what gets reported
            const fresh = await discoverPlatformOrgId().catch(e => {
                log('debug', 'claude_api', 'Re-discovery failed: ' + e.message);
                return null;
            });
            if (fresh && fresh !== orgId) {
                orgId = fresh;
                r = await fetchWithRetry(buildUrl(orgId), fetchOpts);
            }
        }

        if (!r.ok) {
            const snippet = (await r.text().catch(() => '')).slice(0, 150);
            // For a transient status (rate limit, timeout or an Anthropic upstream
            // blip), reuse the last-known-good value rather than flashing the
            // widget to "Not connected".
            if (isTransientStatus(r.status)) {
                const cached = await usableCache();
                if (cached) {
                    log('warn', 'claude_api', `HTTP ${r.status} (transient); using cached value from ${cached.ageSec}s ago`);
                    return cached.result;
                }
            }
            log('error', 'claude_api', `usage_cost HTTP ${r.status} | body: ${snippet}`);
            if (!isTransientStatus(r.status)) await dropCache();
            return { Connected: 0, error: `HTTP ${r.status}` };
        }

        let data;
        try {
            data = await r.json();
        } catch (e) {
            // A stalled body (timeout) is transient and goes to the cache below;
            // a 200 that is not JSON is a sign-in page, so the user is signed out
            if (!e || e.name !== 'SyntaxError') throw e;
            log('warn', 'claude_api', 'usage_cost did not return JSON (login required?)');
            await dropCache();
            return { Connected: 0, error: 'Not logged in to platform.claude.com' };
        }
        const monthCents = sumClaudeCostCents(data, day => day >= range.monthStart);
        const todayCents = sumClaudeCostCents(data, day => day === range.today);
        let yesterdayCents = sumClaudeCostCents(data, day => day === range.yesterday);

        // On the 1st, yesterday is last month and outside the MTD range. Ask
        // for that day on its own, so a failure there cannot break the MTD result.
        if (range.yesterday < range.monthStart) {
            try {
                const ry = await fetchWithRetry(buildUrl(orgId, range.yesterday, range.monthStart), fetchOpts, 1);
                if (ry.ok) {
                    yesterdayCents = sumClaudeCostCents(await ry.json(), day => day === range.yesterday);
                } else {
                    log('debug', 'claude_api', `usage_cost for yesterday returned HTTP ${ry.status}`);
                }
            } catch (e) {
                log('debug', 'claude_api', 'usage_cost for yesterday failed: ' + e.message);
            }
        }

        const result = {
            Connected: 1,
            MonthTotal: (monthCents / 100).toFixed(2),
            TodayTotal: (todayCents / 100).toFixed(2),
            YesterdayTotal: (yesterdayCents / 100).toFixed(2),
            PeriodLabel: range.periodLabel,
            DataDay: range.today
        };
        log('info', 'claude_api', `Fetch success: MTD=$${result.MonthTotal} Today=$${result.TodayTotal}`);
        // Cache success for fallback on the next transient failure. Best effort:
        // a failed write must not turn this good read into an error.
        try {
            await chrome.storage.local.set({ [CLAUDE_API_CACHE_KEY]: { result, cachedAt: Date.now() } });
        } catch (e) {
            log('warn', 'claude_api', 'Could not cache the result: ' + e.message);
        }
        return result;
    } catch (e) {
        // Network-level failure (or timeout): try cache too
        const cached = await usableCache().catch(() => null);
        if (cached) {
            log('warn', 'claude_api', `Network error (${e.message}); using cached value from ${cached.ageSec}s ago`);
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
    const r = await fetchT('https://api.openai.com/dashboard/onboarding/login', {
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

function summarizeOpenAICosts(rawData, now = new Date()) {
    // Endpoint returns:
    //   { data: [ { start_time, end_time, results: [ { amount: { value, currency } } ] }, ... ] }
    // Values are USD decimals (not cents like Anthropic's). Buckets are 1d
    // wide from a UTC midnight, so each bucket's start is its UTC day.
    const range = costDateRange(now);

    let monthTotal = 0, todayTotal = 0, yesterdayTotal = 0;
    for (const bucket of (rawData?.data || [])) {
        const bucketDateStr = new Date((bucket.start_time || 0) * 1000).toISOString().slice(0, 10);
        let bucketSum = 0;
        for (const r of (bucket.results || [])) {
            const v = r?.amount?.value;
            if (typeof v === 'number') bucketSum += v;
        }
        // On the 1st the range reaches back into last month for Yesterday
        if (bucketDateStr >= range.monthStart) monthTotal += bucketSum;
        if (bucketDateStr === range.today) todayTotal += bucketSum;
        if (bucketDateStr === range.yesterday) yesterdayTotal += bucketSum;
    }

    return {
        Connected: 1,
        MonthTotal: monthTotal.toFixed(2),
        TodayTotal: todayTotal.toFixed(2),
        YesterdayTotal: yesterdayTotal.toFixed(2),
        PeriodLabel: range.periodLabel,
        DataDay: range.today
    };
}

async function refreshOpenAICostsWithToken(auth0Token) {
    if (!openaiSessionKey) {
        openaiSessionKey = await exchangeOpenAISessionKey(auth0Token);
    }
    if (!openaiSessionKey) return { error: 'no_session_key' };

    // UTC midnight of the 1st (or of yesterday, on the 1st) up to UTC midnight
    // tomorrow, so the 1d buckets line up with UTC days
    const range = costDateRange(new Date());
    const costsUrl = `https://api.openai.com/v1/dashboard/organization/costs?bucket_width=1d&start_time=${range.rangeStartSec}&end_time=${range.tomorrowSec}&limit=31`;

    const r = await fetchT(costsUrl, {
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
    try {
        const cached = (await chrome.storage.local.get(CHATGPT_API_CACHE_KEY))[CHATGPT_API_CACHE_KEY];
        if (!cached || !cached.result) {
            log('warn', 'chatgpt_api', 'No cached data - visit platform.openai.com to initialize');
            return { Connected: 0, error: 'Visit platform.openai.com to initialize' };
        }
        const ageSec = Math.round((Date.now() - cached.cachedAt) / 1000);
        if (cached.result.Connected !== 1) return { ...cached.result, AgeSeconds: ageSec };

        // The snapshot only refreshes while a platform.openai.com tab is open.
        // Flag one from an earlier UTC day as Stale, and drop one from an earlier
        // month: its month-to-date total is not this month's.
        const result = flagCostSnapshot(cached.result, cached.cachedAt);
        if (!result) {
            log('debug', 'chatgpt_api', `Cached costs are from an earlier month (${ageSec}s old)`);
            return { Connected: 0, Stale: 1, error: 'Stale - reopen platform.openai.com to refresh', AgeSeconds: ageSec };
        }
        log('debug', 'chatgpt_api', `Using cached data from ${ageSec}s ago${result.Stale ? ' (taken on an earlier UTC day)' : ''}`);
        return { ...result, AgeSeconds: ageSec, CachedAtEpoch: Math.floor(cached.cachedAt / 1000) };
    } catch (e) {
        // A storage failure takes down this widget only, not the whole cycle
        log('error', 'chatgpt_api', 'Could not read cached cost data: ' + e.message);
        return { Connected: 0, error: e.message };
    }
}

// ---- Gemini API spend (populated by aistudio-content.js) ----
//
// The content script iterates ALL projects on /spend and sends per-project
// cost data. We cache the full payload and compute the view (All vs. specific
// project) at read time based on the user's chrome.storage.sync preference.
// A project the scraper could not read (ok:false / cost:null) keeps its value
// from the previous scrape of the same month, flagged stale.

const GEMINI_API_CACHE_KEY = 'geminiApiLastGood';

// Entries without an ok field come from older scrapes and count as read
function geminiEntryHasValue(p) {
    return !!p && p.ok !== false && p.cost != null && Number.isFinite(parseFloat(p.cost));
}

function moneyStr(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

// Merges a fresh scrape with the cached one. Returns the summary to cache,
// or null when no project could be read and the cache should be kept as is.
function mergeGeminiApiSummary(summary, prev, now = Date.now()) {
    if (!Array.isArray(summary.Projects)) return summary;

    // Carry values over only within the same month and period, so a failed
    // scrape on the 1st never brings back last month's spend
    const prevByName = new Map();
    const prevUsable = prev && prev.result && Array.isArray(prev.result.Projects) &&
        sameLocalMonth(prev.cachedAt, now) &&
        (prev.result.PeriodLabel || '') === (summary.PeriodLabel || '');
    if (prevUsable) {
        for (const p of prev.result.Projects) {
            if (geminiEntryHasValue(p)) prevByName.set(p.name, p);
        }
    }

    let failed = 0, carried = 0;
    const projects = summary.Projects.map(p => {
        if (geminiEntryHasValue(p)) return { ...p, ok: true };
        failed++;
        const old = prevByName.get(p.name);
        if (old) {
            carried++;
            return { ...old, name: p.name, ok: true, stale: true };
        }
        return { name: p.name, cost: null, spendCapUsed: null, spendCap: null, hasCap: false, ok: false };
    });

    const read = projects.filter(geminiEntryHasValue);
    if (read.length === 0) return null;

    const sum = (field) => read.reduce((s, p) => s + (parseFloat(p[field]) || 0), 0).toFixed(2);
    return {
        ...summary,
        Projects: projects,
        ProjectNames: Array.isArray(summary.ProjectNames) ? summary.ProjectNames : projects.map(p => p.name),
        AllTotal: sum('cost'),
        AllCapUsed: sum('spendCapUsed'),
        AllCap: sum('spendCap'),
        HasData: read.some(p => parseFloat(p.cost) > 0) ? 1 : 0,
        FailedCount: failed,
        StaleCount: carried
    };
}

async function fetchGeminiApi() {
    log('debug', 'gemini_api', 'Reading cached spend data from storage');
    try {
        const cached = (await chrome.storage.local.get(GEMINI_API_CACHE_KEY))[GEMINI_API_CACHE_KEY];
        if (!cached || !cached.result) {
            log('warn', 'gemini_api', 'No cached data - visit aistudio.google.com/spend to initialize');
            return { Connected: 0, error: 'Visit aistudio.google.com/spend to initialize' };
        }
        const ageSec = Math.round((Date.now() - cached.cachedAt) / 1000);
        log('debug', 'gemini_api', `Using cached data from ${ageSec}s ago`);

        const raw = cached.result;
        const projectNames = raw.ProjectNames || [];

        // The scrape is "This Month" and only refreshes while a /spend tab is
        // open: a snapshot from an earlier month is not this month's spend.
        if (!sameLocalMonth(cached.cachedAt, Date.now())) {
            log('debug', 'gemini_api', `Cached spend is from an earlier month (${ageSec}s old)`);
            return {
                Connected: 0, Stale: 1, error: 'Stale - visit aistudio.google.com/spend to refresh',
                Tier: raw.Tier || 'Unknown', ProjectNames: projectNames, AgeSeconds: ageSec
            };
        }

        // Determine which project view the user wants
        const { geminiApiProject = '__all__' } = await chrome.storage.sync.get('geminiApiProject').catch(() => ({}));

        let monthTotal, spendCapUsed, spendCap, projectName, hasData, hasCap, stale;

        const proj = geminiApiProject !== '__all__' && Array.isArray(raw.Projects)
            ? raw.Projects.find(p => p.name === geminiApiProject)
            : null;

        if (proj) {
            // Specific project
            if (!geminiEntryHasValue(proj)) {
                // Never read successfully this month: say so rather than show $0.00
                return {
                    Connected: 0, error: `Spend for "${proj.name}" not read yet - visit aistudio.google.com/spend`,
                    Tier: raw.Tier || 'Unknown', ProjectName: proj.name, ProjectNames: projectNames, AgeSeconds: ageSec
                };
            }
            monthTotal = moneyStr(proj.cost);
            spendCapUsed = moneyStr(proj.spendCapUsed);
            spendCap = moneyStr(proj.spendCap);
            projectName = proj.name;
            hasData = parseFloat(proj.cost) > 0 ? 1 : 0;
            hasCap = proj.hasCap;
            stale = proj.stale ? 1 : 0;
        } else {
            // "All Projects" aggregate (also the fallback when the selected
            // project no longer exists)
            monthTotal = moneyStr(raw.AllTotal);
            spendCapUsed = moneyStr(raw.AllCapUsed);
            spendCap = moneyStr(raw.AllCap);
            projectName = 'All Projects';
            hasData = raw.HasData || 0;
            hasCap = parseFloat(spendCap) > 0;
            // Any project not read in the last scrape (carried over, or left out
            // of the total for lack of a value) means the total is not current
            stale = (raw.FailedCount || 0) > 0 || (raw.StaleCount || 0) > 0 ? 1 : 0;
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
            ProjectNames: projectNames,
            AgeSeconds: ageSec,
            CachedAtEpoch: Math.floor(cached.cachedAt / 1000),
            Stale: stale
        };
    } catch (e) {
        // A storage failure takes down this widget only, not the whole cycle
        log('error', 'gemini_api', 'Could not read cached spend data: ' + e.message);
        return { Connected: 0, error: e.message };
    }
}

// Finds the platform.claude.com org with API access. Returns null when the
// answer is that there is none (signed out, or no org with the "api"
// capability); throws on a network error, timeout, 408, 429 or 5xx so the
// caller can treat it as transient rather than as a sign-out.
async function discoverPlatformOrgId() {
    const r = await fetchT('https://platform.claude.com/api/organizations', {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
    });
    if (!r.ok) {
        if (isTransientStatus(r.status)) throw new Error(`/api/organizations returned HTTP ${r.status}`);
        log('warn', 'claude_api', `/api/organizations HTTP ${r.status} (login required?)`);
        return null;
    }
    let orgs;
    try {
        orgs = await r.json();
    } catch (e) {
        // A stalled body (timeout) is transient; a page that is not JSON
        // (such as a sign-in redirect) counts as signed out, as before
        if (!e || e.name !== 'SyntaxError') throw e;
        log('warn', 'claude_api', '/api/organizations did not return JSON (login required?)');
        return null;
    }
    if (!Array.isArray(orgs) || orgs.length === 0) {
        log('warn', 'claude_api', `/api/organizations returned no orgs (len=${orgs?.length})`);
        return null;
    }
    const apiOrg = orgs.find(o => o && Array.isArray(o.capabilities) && o.capabilities.includes('api'));
    if (!apiOrg) {
        const allCaps = orgs.map(o => (o?.capabilities || []).join('|')).join('; ');
        log('warn', 'claude_api', `No org with "api" capability. Found: ${allCaps}`);
        return null;
    }
    // Best effort: without the cache the next cycle just discovers it again
    try {
        await chrome.storage.local.set({ platformOrgId: apiOrg.uuid });
    } catch (e) {
        log('warn', 'claude_api', 'Could not cache the API org ID: ' + e.message);
    }
    // Debug only, like the claude.ai org ID: an exported Info log stays free of account IDs
    log('debug', 'claude_api', 'Discovered API org ID', { orgId: apiOrg.uuid });
    return apiOrg.uuid;
}

// ---- Gemini consumer usage (gemini.google.com/usage) ----
//
// gemini.google.com/usage exposes compute-based limits that refresh every
// 5 hours plus a weekly cap, the same shape as Claude's session/weekly bars.
// The page loads the numbers via a batchexecute RPC (rpcid jSf9Qc) that takes
// no arguments. We replicate it from the service worker: fetch the app HTML
// once to grab the XSRF token (SNlM0e) + build label (cfb2h) + session id
// (FdrFJe), then POST the RPC. Tokens are cached (stable for the session) and
// only re-fetched when the RPC rejects them, so we don't pull the heavy app
// HTML every cycle. If a token refresh does not help (or the HTML has no
// tokens), the HTML fetch backs off (5 min, doubling up to 60 min) while the
// cached tokens are still tried each cycle; any successful read clears it.
//
// NOTE: jSf9Qc is Google's internal RPC id and can change when the Gemini web
// app is rebuilt. If usage stops resolving (HasUsageData flips to 0 while the
// plan still shows), re-capture it from the gemini.google.com/usage network
// tab (POST to .../batchexecute?rpcids=...) and update the constant below.

const GEMINI_USAGE_RPC = 'jSf9Qc';
const GEMINI_TOKENS_KEY = 'geminiTokens';
const GEMINI_TOKENS_MAX_AGE_MS = 6 * 60 * 60 * 1000; // backstop; refresh-on-failure is the real mechanism
const GEMINI_TOKEN_FAIL_KEY = 'geminiTokenFail';     // { rpc, failAt, count }, persisted across SW restarts
const GEMINI_BACKOFF_BASE_MS = 5 * 60 * 1000;
const GEMINI_BACKOFF_MAX_MS = 60 * 60 * 1000;

// Milliseconds left before the app HTML may be fetched again (0 = go ahead).
// A record from another RPC id (an extension update shipped a new one) is ignored.
// So is one dated in the future (the clock was set back): its wait could run
// for hours, and the next failure re-dates it against the corrected clock.
async function geminiBackoffRemaining() {
    const fail = (await chrome.storage.local.get(GEMINI_TOKEN_FAIL_KEY))[GEMINI_TOKEN_FAIL_KEY];
    if (!fail || fail.rpc !== GEMINI_USAGE_RPC || !fail.failAt) return 0;
    const now = Date.now();
    if (fail.failAt > now) return 0;
    const delay = Math.min(GEMINI_BACKOFF_BASE_MS * 2 ** Math.max(0, (fail.count || 1) - 1), GEMINI_BACKOFF_MAX_MS);
    return Math.max(0, fail.failAt + delay - now);
}

async function recordGeminiFailure(reason) {
    try {
        const fail = (await chrome.storage.local.get(GEMINI_TOKEN_FAIL_KEY))[GEMINI_TOKEN_FAIL_KEY];
        const count = (fail && fail.rpc === GEMINI_USAGE_RPC ? fail.count || 0 : 0) + 1;
        await chrome.storage.local.set({ [GEMINI_TOKEN_FAIL_KEY]: { rpc: GEMINI_USAGE_RPC, failAt: Date.now(), count } });
        const delayMin = Math.min(GEMINI_BACKOFF_BASE_MS * 2 ** (count - 1), GEMINI_BACKOFF_MAX_MS) / 60000;
        log('warn', 'gemini', `${reason}; not re-fetching the Gemini app page for ${delayMin} min`);
    } catch {}
}

async function clearGeminiFailure() {
    try { await chrome.storage.local.remove(GEMINI_TOKEN_FAIL_KEY); } catch {}
}

// Returns the tokens, with fetchedNow set (not stored) when this call pulled
// them from the app HTML, or null.
async function getGeminiTokens(forceRefresh) {
    const cached = (await chrome.storage.local.get(GEMINI_TOKENS_KEY))[GEMINI_TOKENS_KEY];
    // A negative age means the clock was set back: treat those tokens as old
    const age = cached ? Date.now() - (cached.cachedAt || 0) : -1;
    if (!forceRefresh && cached && cached.at && age >= 0 && age < GEMINI_TOKENS_MAX_AGE_MS) {
        return cached;
    }
    const waitMs = await geminiBackoffRemaining();
    if (waitMs > 0) {
        log('debug', 'gemini', `Skipping app HTML fetch (backing off ${Math.ceil(waitMs / 60000)} more min)`);
        // Keep trying the last tokens we have, even past their max age, so recovery is immediate
        return !forceRefresh && cached && cached.at ? cached : null;
    }
    const r = await fetchT('https://gemini.google.com/app', { credentials: 'include' });
    if (!r.ok) {
        log('warn', 'gemini', `app HTML fetch HTTP ${r.status} (login required?)`);
        await recordGeminiFailure(`app HTML fetch returned HTTP ${r.status}`);
        return null;
    }
    const html = await r.text();
    const grab = (re) => { const m = html.match(re); return m ? m[1] : null; };
    const at = grab(/"SNlM0e":"([^"]+)"/);
    if (!at) {
        log('warn', 'gemini', 'Could not extract XSRF token (SNlM0e) from app HTML');
        await recordGeminiFailure('No XSRF token in the Gemini app page');
        return null;
    }
    const tokens = {
        at,
        bl: grab(/"cfb2h":"([^"]+)"/) || '',
        sid: grab(/"FdrFJe":"([^"]+)"/) || '',
        cachedAt: Date.now()
    };
    await chrome.storage.local.set({ [GEMINI_TOKENS_KEY]: tokens });
    log('debug', 'gemini', 'Refreshed Gemini tokens from app HTML');
    return { ...tokens, fetchedNow: true };
}

function parseGeminiUsage(inner) {
    // inner = [n, [ [id, fraction(0-1), typeCode, [[resetEpochSec, nanos]]], ... ], bool]
    // typeCode 1 = current/5-hour limit, 2 = weekly limit.
    const entries = Array.isArray(inner) && Array.isArray(inner[1]) ? inner[1] : [];
    const out = {};
    for (const e of entries) {
        if (!Array.isArray(e)) continue;
        const fraction = typeof e[1] === 'number' ? e[1] : 0;
        const resetSec = e[3]?.[0]?.[0];
        const slot = {
            pct: wholePercent(fraction * 100),
            resetIso: typeof resetSec === 'number' ? new Date(resetSec * 1000).toISOString() : null
        };
        if (e[2] === 1) out.session = slot;
        else if (e[2] === 2) out.weekly = slot;
    }
    return out;
}

async function callGeminiUsageRpc(tokens) {
    const reqid = Math.floor(Math.random() * 1e6);
    const url = `https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=${GEMINI_USAGE_RPC}&source-path=%2Fusage&bl=${encodeURIComponent(tokens.bl)}&f.sid=${encodeURIComponent(tokens.sid)}&hl=en&_reqid=${reqid}&rt=c`;
    const freq = JSON.stringify([[[GEMINI_USAGE_RPC, "[]", null, "generic"]]]);
    const body = `f.req=${encodeURIComponent(freq)}&at=${encodeURIComponent(tokens.at)}&`;
    const r = await fetchT(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body,
        credentials: 'include'
    });
    if (!r.ok) return { status: r.status, usage: null };
    const text = await r.text();
    // Response is the chunked batchexecute envelope: )]}'\n\n<len>\n[["wrb.fr","jSf9Qc","<json string>",...]]
    for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s.startsWith('[')) continue;
        try {
            for (const row of JSON.parse(s)) {
                if (Array.isArray(row) && row[0] === 'wrb.fr' && row[1] === GEMINI_USAGE_RPC && row[2]) {
                    return { status: 200, usage: parseGeminiUsage(JSON.parse(row[2])) };
                }
            }
        } catch (e) { /* not the data line - keep scanning */ }
    }
    return { status: 200, usage: null };
}

// Returns { usage, transient }. transient means a rate limit or outage (not
// a token problem), so the caller may reuse the last good usage. Throws on a
// network error or timeout.
async function fetchGeminiUsage() {
    const tokens = await getGeminiTokens(false);
    if (!tokens) return { usage: null, transient: false };
    let res = await callGeminiUsageRpc(tokens);
    if (res.usage) {
        await clearGeminiFailure();
        return { usage: res.usage, transient: false };
    }
    // A 429/5xx is not a token problem: don't pull the app HTML for it
    if (isTransientStatus(res.status)) {
        log('debug', 'gemini', `Usage RPC returned HTTP ${res.status}`);
        return { usage: null, transient: true };
    }
    // Stale token (session rotated) gives a 4xx or an empty payload. Refresh
    // once and retry, unless these tokens were only just fetched in this call.
    if (!tokens.fetchedNow) {
        log('debug', 'gemini', `Usage RPC returned no data (HTTP ${res.status}); refreshing tokens`);
        const fresh = await getGeminiTokens(true);
        if (!fresh) return { usage: null, transient: false };  // backing off, or extraction failed (recorded)
        res = await callGeminiUsageRpc(fresh);
        if (res.usage) {
            await clearGeminiFailure();
            return { usage: res.usage, transient: false };
        }
        if (isTransientStatus(res.status)) return { usage: null, transient: true };
    }
    // Fresh tokens and still nothing: most likely the RPC id changed
    await recordGeminiFailure(`Usage RPC returned no data with fresh tokens (HTTP ${res.status})`);
    return { usage: null, transient: false };
}

function buildGeminiResult(planName, usage) {
    const result = {
        Connected: 1,
        HasUsageData: 1,
        PlanName: planName,
        SessionPercent: usage.session?.pct ?? 0,
        SessionReset: formatReset(usage.session?.resetIso),
        WeeklyPercent: usage.weekly?.pct ?? 0,
        WeeklyReset: formatReset(usage.weekly?.resetIso)
    };
    // Legacy fields for widget packs older than 1.2, whose native host still
    // maps GeminiDaily* into a single bar: use whichever window is closer to
    // its limit, so a hit weekly cap doesn't read as 0%.
    const legacy = usage.weekly && (!usage.session || usage.weekly.pct > usage.session.pct) ? 'Weekly' : 'Session';
    result.DailyPercent = result[legacy + 'Percent'];
    result.DailyReset = result[legacy + 'Reset'];
    return result;
}

async function fetchGemini() {
    log('debug', 'gemini', 'Fetch started');
    try {
        const cookie = await chrome.cookies.get({ url: 'https://gemini.google.com/', name: 'SID' }).catch(() => null);
        if (!cookie) {
            log('warn', 'gemini', 'Not signed in to Google (no SID cookie)');
            await clearConsumerSnapshot('gemini');
            return { Connected: 0, error: 'Not signed in to Google' };
        }

        const cached = await chrome.storage.local.get('geminiPlanName');
        const planName = cached.geminiPlanName || 'Unknown';

        // Pull live usage (5-hour + weekly) from gemini.google.com/usage
        let usage = null;
        let transient = false;
        try {
            const res = await fetchGeminiUsage();
            usage = res.usage;
            transient = res.transient;
        } catch (e) {
            log('warn', 'gemini', 'Usage fetch failed: ' + e.message);
            transient = true;
        }

        if (usage && (usage.session || usage.weekly)) {
            await saveConsumerSnapshot('gemini', planName, usage);
            const result = buildGeminiResult(planName, usage);
            log('info', 'gemini', `Fetch success: plan=${planName} Session=${result.SessionPercent}% Weekly=${result.WeeklyPercent}%`);
            return result;
        }

        // Network blip, rate limit or outage: keep the last good bars for a
        // while. "200 but no data" is not reused, since it is the sign that
        // the RPC id changed (see the NOTE above).
        if (transient) {
            const snap = await loadConsumerSnapshot('gemini');
            if (snap) {
                const result = markStale(buildGeminiResult(planName, snap), snap);
                log('warn', 'gemini', `Usage unavailable; using last good usage from ${result.AgeSeconds}s ago`);
                return result;
            }
        }

        // Fallback: logged in but usage unavailable (RPC changed / token issue)
        if (planName === 'Unknown') {
            // Only the default account's tabs store a plan (see gemini-content.js)
            log('warn', 'gemini', 'Plan unknown and no usage - visit gemini.google.com with your default Google account (not /u/1/...) so the content script can detect the badge');
        } else {
            log('info', 'gemini', `Fetch success (plan only): plan=${planName}`);
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

// Log only, so it never throws: a failed read must not stop the native send
async function detectPlanChanges(newPayload) {
    try {
        const { lastPayload } = await chrome.storage.local.get('lastPayload');
        if (!lastPayload) return;
        for (const svc of ['claude', 'chatgpt', 'gemini']) {
            const oldPlan = lastPayload[svc]?.PlanName;
            const newPlan = newPayload[svc]?.PlanName;
            if (oldPlan && newPlan && oldPlan !== newPlan && newPlan !== 'Unknown') {
                log('info', svc, `Plan changed: ${oldPlan} -> ${newPlan}`);
            }
        }
    } catch (e) {
        log('warn', 'core', 'Plan-change check skipped: ' + e.message);
    }
}

// ---- Native host ----

// Every host version replies {ok:true, timestamp} on success and {ok:false,
// error} when it could not write ConsumerData.inc, so a reply alone is not
// success. The outcome is kept in storage (lastNativeResult) for diagnostics.
async function reportNativeResult(response, via, ms, payloadTimestamp, okLevel) {
    const ok = response?.ok === true;
    const error = ok ? null : String(response?.error ?? 'no reply').trim();
    if (ok) {
        log(okLevel, 'core', `Native host write OK (${via})`, { response, ms });
    } else {
        log('error', 'core', `Native host could not write ConsumerData.inc (${via}): ${error}`, { response, ms });
    }
    try {
        await chrome.storage.local.set({ lastNativeResult: { ok, error, via, at: Date.now(), timestamp: payloadTimestamp } });
    } catch {}
}

async function recordNativeFailure(error, payloadTimestamp) {
    try {
        await chrome.storage.local.set({ lastNativeResult: { ok: false, error, via: null, at: Date.now(), timestamp: payloadTimestamp } });
    } catch {}
}

// ---- Main loop ----

// Only one update runs at a time. A request that arrives while one is running
// (alarm, popup refresh, content-script push) queues exactly one more pass,
// and every caller's promise settles after that pass. This keeps two native
// hosts from writing ConsumerData.inc at once and an older run from
// publishing its snapshot after a newer one.
let updateInFlight = null;
let updateAgain = false;

function runUpdate() {
    if (updateInFlight) {
        updateAgain = true;
        return updateInFlight;
    }
    const run = (async () => {
        try {
            let lastErr = null;
            do {
                updateAgain = false;
                try {
                    await doUpdate();
                    lastErr = null;
                } catch (e) {
                    lastErr = e;
                    log('error', 'core', 'runUpdate failed: ' + e.message);
                }
            } while (updateAgain);
            if (lastErr) throw lastErr;
        } finally {
            // Cleared in the same step as the last updateAgain check, so a
            // request can never slip in between and be dropped
            updateInFlight = null;
        }
    })();
    updateInFlight = run;
    return run;
}

async function doUpdate() {
    log('debug', 'core', 'runUpdate started');

    const [claude, chatgpt, gemini, claudeApi, chatgptApi, geminiApi] = await Promise.all([
        fetchClaude(),
        fetchChatGPT(),
        fetchGemini(),
        fetchClaudeApi(),
        fetchChatGPTApi(),
        fetchGeminiApi()
    ]);

    // Error returns only carry Connected:0. The skins multiply HasUsageData
    // into their Hidden/height formulas, so an empty value is a syntax error.
    for (const s of [claude, chatgpt, gemini]) {
        if (s.HasUsageData == null) s.HasUsageData = 0;
    }

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

    // Cache for popup. Best effort: the widgets still get this cycle's data
    // when the write fails, and the popup catches up on the next one.
    try {
        await chrome.storage.local.set({ lastPayload: payload, lastUpdate: Date.now() });
    } catch (e) {
        log('warn', 'core', 'Could not cache the payload for the popup: ' + e.message);
    }

    // Send to native host - try sendNativeMessage first, then connectNative as fallback
    try {
        const t0 = Date.now();
        const response = await new Promise((resolve, reject) => {
            // A host that never answers would otherwise hold up every later update
            const timer = setTimeout(() => {
                const err = new Error(`no reply after ${NATIVE_REPLY_TIMEOUT_MS / 1000}s (host=${NATIVE_HOST})`);
                err.noFallback = true;
                reject(err);
            }, NATIVE_REPLY_TIMEOUT_MS);
            try {
                chrome.runtime.sendNativeMessage(NATIVE_HOST, payload, (response) => {
                    clearTimeout(timer);
                    const dt = Date.now() - t0;
                    if (chrome.runtime.lastError) {
                        reject(new Error(`${chrome.runtime.lastError.message} (after ${dt}ms, host=${NATIVE_HOST})`));
                    } else {
                        resolve(response);
                    }
                });
            } catch (err) {
                clearTimeout(timer);
                reject(err);
            }
        });
        // The host was reached. A {ok:false} reply is reported, not retried
        // through connectNative: a second host would race for the same file.
        await reportNativeResult(response, 'sendNativeMessage', Date.now() - t0, payload.timestamp, 'debug');
    } catch (e) {
        if (e.noFallback) {
            // Still running, so a fallback would start a second host next to it
            log('error', 'core', 'Native host did not answer: ' + e.message);
            await recordNativeFailure(e.message, payload.timestamp);
            return;
        }
        log('warn', 'core', 'sendNativeMessage failed, trying connectNative: ' + e.message);
        // Fallback: try connectNative (persistent port, different Chrome code path)
        try {
            const t0 = Date.now();
            const response = await new Promise((resolve, reject) => {
                let port;
                try {
                    port = chrome.runtime.connectNative(NATIVE_HOST);
                } catch (err) {
                    reject(new Error(`connectNative threw: ${err.message}`));
                    return;
                }
                // Timeout after 5 seconds
                const timer = setTimeout(() => {
                    reject(new Error(`connectNative timeout after 5s`));
                    try { port.disconnect(); } catch {}
                }, 5000);
                port.onMessage.addListener((msg) => {
                    clearTimeout(timer);
                    resolve(msg);
                    port.disconnect();
                });
                port.onDisconnect.addListener(() => {
                    const err = chrome.runtime.lastError;
                    if (err) {
                        clearTimeout(timer);
                        reject(new Error(`connectNative disconnected: ${err.message} (after ${Date.now() - t0}ms)`));
                    }
                });
                port.postMessage(payload);
            });
            await reportNativeResult(response, 'connectNative fallback', Date.now() - t0, payload.timestamp, 'info');
        } catch (e2) {
            log('error', 'core', 'connectNative also failed: ' + e2.message);
            await recordNativeFailure(e2.message, payload.timestamp);
        }
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
        runUpdate().catch(() => {});  // already logged inside runUpdate
    }
});

// Handle manual trigger from popup + content-script cost uploads
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'log' && msg.entry && sender.id === chrome.runtime.id) {
        // Content scripts hand their log entries to the SW, which owns the
        // buffer, so their writes cannot overlap with ours.
        self.prismLogEntry(msg.entry);
        sendResponse({ ok: true });
        return;
    }
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
                try {
                    const existing = (await chrome.storage.local.get(CHATGPT_API_CACHE_KEY))[CHATGPT_API_CACHE_KEY];
                    if (!existing || !existing.result) {
                        await chrome.storage.local.set({
                            [CHATGPT_API_CACHE_KEY]: { result: { Connected: 0, error: errMsg }, cachedAt: Date.now() }
                        });
                    }
                } catch (e) {
                    log('warn', 'chatgpt_api', 'Could not record the missing token: ' + e.message);
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
                    // Keep cached success around - only overwrite if we have no prior good data.
                    // fetchChatGPTApi checks its age at read time (new day: Stale, new month: dropped).
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
            try {
                // Merge with the last scrape: a project the scraper could not
                // read keeps its previous value instead of counting as $0.00
                const prev = (await chrome.storage.local.get(GEMINI_API_CACHE_KEY))[GEMINI_API_CACHE_KEY];
                const merged = mergeGeminiApiSummary(msg.summary, prev);
                if (!merged) {
                    log('warn', 'gemini_api', 'Content script could not read spend for any project; keeping the previous data');
                    sendResponse({ ok: false, error: 'no_projects_read' });
                    return;
                }
                await chrome.storage.local.set({
                    [GEMINI_API_CACHE_KEY]: { result: merged, cachedAt: Date.now() }
                });
                const pCount = (merged.Projects || []).length;
                const partial = merged.FailedCount
                    ? ` (${merged.FailedCount} not read, ${merged.StaleCount} kept from the last scrape)`
                    : '';
                log('info', 'gemini_api', `Content script pushed fresh spend: ${pCount} projects${partial}, allTotal=$${merged.AllTotal} tier=${merged.Tier}`);
                runUpdate().catch(() => {});
                sendResponse({ ok: true });
            } catch (e) {
                log('error', 'gemini_api', 'Could not store pushed spend: ' + e.message);
                sendResponse({ ok: false, error: e.message });
            }
        })();
        return true;
    }
});
