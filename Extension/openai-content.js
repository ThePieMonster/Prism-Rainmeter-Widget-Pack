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

// Minimal logger (content scripts can't importScripts(), so we inline)
async function prismLog(level, source, msg, data) {
    const { logLevel = 'info' } = await chrome.storage.sync.get('logLevel').catch(() => ({}));
    if (logLevel === 'off') return;
    if (logLevel === 'info' && level === 'debug') return;
    const prefix = `[Prism:${source}]`;
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    if (data !== undefined) fn(prefix, msg, data); else fn(prefix, msg);
    try {
        const { logs = [] } = await chrome.storage.local.get('logs');
        logs.unshift({ ts: Date.now(), level, source, msg, data });
        if (logs.length > 200) logs.length = 200;
        await chrome.storage.local.set({ logs });
    } catch {}
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
    await prismLog('debug', 'chatgpt_api', `Looking for Auth0 token (${location.href})`);
    const auth = await readJwtWithRetry();
    if (!auth) {
        const nearKeys = listAuth0Keys();
        await prismLog('warn', 'chatgpt_api', `No Auth0 JWT found. Keys matching auth/token: ${nearKeys.length ? nearKeys.slice(0, 3).join(', ') : '(none)'}`);
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
console.log('[Prism:chatgpt_api] content script loaded on', location.href);
prismLog('info', 'chatgpt_api', `Content script loaded on ${location.href}`).catch(e => {
    console.error('[Prism:chatgpt_api] prismLog failed at load:', e);
});

// Push token shortly after load, then re-push every 5 minutes (the SW caches
// the resulting session key for the duration of the OpenAI session, so this
// is just a heartbeat — usually cheap because no exchange is needed).
setTimeout(pushAuthToken, 1500);
setInterval(pushAuthToken, 5 * 60 * 1000);
