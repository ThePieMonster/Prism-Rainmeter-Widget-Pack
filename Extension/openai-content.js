// ==========================================================================
//  Prism OpenAI Content Script
//
//  Runs on platform.openai.com. Its only job is to read the Auth0 JWT that
//  the page caches in localStorage and hand it to the service worker. The SW
//  then does all api.openai.com calls (session-key exchange + cost fetch),
//  because content-script fetches to api.openai.com are subject to CORS
//  preflight (which fails for POST + Authorization), while service-worker
//  fetches bypass CORS for any host listed in host_permissions.
// ==========================================================================

// Minimal logger (content scripts can't importScripts(), so we inline).
// Never throws: in an orphaned copy of this script (see extensionAlive)
// chrome.storage throws synchronously.
async function prismLog(level, source, msg, data) {
    try {
        const { logLevel = 'info' } = await chrome.storage.sync.get('logLevel').catch(() => ({}));
        if (logLevel === 'off') return;
        if (logLevel === 'info' && level === 'debug') return;
        const prefix = `[Prism:${source}]`;
        const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        if (data !== undefined) fn(prefix, msg, data); else fn(prefix, msg);
        // The service worker owns the 'logs' buffer (logger.js), so hand it
        // the entry instead of rewriting the array from this tab.
        const entry = { ts: Date.now(), level, source, msg: String(msg) };
        if (data !== undefined) {
            try { entry.data = JSON.parse(JSON.stringify(data)); } catch { entry.data = String(data); }
        }
        await chrome.runtime.sendMessage({ type: 'log', entry });
    } catch {}
}

// False once the extension was updated, reloaded or removed while this tab
// stayed open. Chrome does not re-inject content scripts into open tabs, so
// the old copy keeps its timers but can no longer reach the service worker.
function extensionAlive() {
    try { return !!chrome.runtime?.id; } catch { return false; }
}

function readAuth0Jwt() {
    // The Auth0 SPA SDK stores entries like:
    //   @@auth0spajs@@::<client_id>::https://api.openai.com/v1::openid profile email offline_access
    const scan = (store) => {
        for (const k of Object.keys(store)) {
            if (!k.startsWith('@@auth0spajs@@')) continue;
            try {
                const entry = JSON.parse(store.getItem(k));
                const token = entry?.body?.access_token || entry?.access_token;
                const expiresAt = entry?.expiresAt || null;
                if (token) return { token, expiresAt, key: k };
            } catch {}
        }
        return null;
    };
    return scan(localStorage) || scan(sessionStorage);
}

function listAuth0Keys() {
    const keys = [];
    for (const k of Object.keys(localStorage)) if (k.includes('auth0') || k.includes('token') || k.includes('oai-sc')) keys.push('ls:' + k.slice(0, 80));
    for (const k of Object.keys(sessionStorage)) if (k.includes('auth0') || k.includes('token')) keys.push('ss:' + k.slice(0, 80));
    return keys;
}

async function readJwtWithRetry(maxAttempts = 5, delayMs = 2000) {
    for (let i = 1; i <= maxAttempts; i++) {
        const auth = readAuth0Jwt();
        if (auth) return auth;
        if (i < maxAttempts) {
            await prismLog('debug', 'chatgpt_api', `JWT not yet in storage (attempt ${i}/${maxAttempts}), waiting ${delayMs}ms`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    return null;
}

async function pushAuthToken() {
    if (!extensionAlive()) { clearInterval(heartbeat); return; }
    await prismLog('debug', 'chatgpt_api', 'Looking for Auth0 token');
    const auth = await readJwtWithRetry();
    if (!extensionAlive()) { clearInterval(heartbeat); return; }
    if (!auth) {
        const nearKeys = listAuth0Keys();
        await prismLog('warn', 'chatgpt_api', `No Auth0 JWT found (${nearKeys.length} storage keys match auth/token)`);
        if (nearKeys.length) await prismLog('debug', 'chatgpt_api', `Keys matching auth/token: ${nearKeys.slice(0, 3).join(', ')}`);
        try { await chrome.runtime.sendMessage({ type: 'openai_auth_token', error: 'no_jwt' }); } catch {}
        return;
    }
    await prismLog('debug', 'chatgpt_api', `Sending Auth0 token to service worker (key=${auth.key.slice(0, 40)}...)`);
    try {
        const reply = await chrome.runtime.sendMessage({ type: 'openai_auth_token', token: auth.token });
        if (reply?.ok) {
            await prismLog('info', 'chatgpt_api', `SW fetched OK: MTD=$${reply.summary?.MonthTotal}`);
        } else if (reply?.error) {
            await prismLog('warn', 'chatgpt_api', `SW reported error: ${reply.error}`);
        }
    } catch (e) {
        await prismLog('error', 'chatgpt_api', 'sendMessage failed: ' + e.message);
    }
}

// Sentinel: log immediately on script load so we can tell apart
// "didn't load" from "loaded but errored before reaching pushAuthToken".
// No URL: platform.openai.com paths and query strings carry project,
// response and assistant IDs, and exported logs get attached to bug reports.
console.log('[Prism:chatgpt_api] content script loaded');
prismLog('debug', 'chatgpt_api', 'Content script loaded');

// Push token shortly after load, then re-push every 5 minutes (the SW caches
// the resulting session key for the duration of the OpenAI session, so this
// is just a heartbeat, usually cheap because no exchange is needed). The
// handle is kept so an orphaned copy can stop itself.
const heartbeat = setInterval(pushAuthToken, 5 * 60 * 1000);
setTimeout(pushAuthToken, 1500);
