// Content script that runs on gemini.google.com pages.
// Reads the plan badge from the rendered DOM and caches it in chrome.storage
// for the background service worker to pick up.

(function () {
    // Inline logger (content scripts can't importScripts; this mirrors logger.js)
    async function log(level, source, msg, data) {
        try {
            const { logLevel = 'info' } = await chrome.storage.sync.get('logLevel');
            if (logLevel === 'off') return;
            if (logLevel === 'info' && level === 'debug') return;

            const prefix = `[Prism:${source}]`;
            const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
            if (data !== undefined) fn(prefix, msg, data); else fn(prefix, msg);

            const { logs = [] } = await chrome.storage.local.get('logs');
            const entry = { ts: Date.now(), level, source, msg: String(msg) };
            if (data !== undefined) {
                try { entry.data = JSON.parse(JSON.stringify(data)); } catch { entry.data = String(data); }
            }
            logs.unshift(entry);
            if (logs.length > 200) logs.length = 200;
            await chrome.storage.local.set({ logs });
        } catch (e) { /* ignore */ }
    }

    log('debug', 'content', 'Gemini content script injected');

    function detectPlan() {
        const candidates = document.querySelectorAll('*');
        for (const el of candidates) {
            if (el.children.length > 0) continue;
            const t = el.textContent?.trim();
            if (!t || t.length > 10) continue;
            const upper = t.toUpperCase();
            if (upper === 'ULTRA') return 'Ultra';
            if (upper === 'PRO') return 'Pro';
            if (upper === 'ADVANCED') return 'Advanced';
        }
        return 'Free';
    }

    let lastReportedPlan = null;
    let observer = null;

    async function report() {
        const plan = detectPlan();
        const changed = plan !== lastReportedPlan;
        lastReportedPlan = plan;

        try {
            await chrome.storage.local.set({
                geminiPlanName: plan,
                geminiPlanDetectedAt: Date.now()
            });
        } catch (e) {
            if (observer) observer.disconnect();
            return;
        }

        if (changed) {
            log('info', 'content', `Gemini plan detected: ${plan}`);
        } else {
            log('debug', 'content', `Gemini plan unchanged: ${plan}`);
        }
    }

    // Run after page has loaded enough to render badges
    if (document.readyState === 'complete') {
        setTimeout(report, 2000);
    } else {
        window.addEventListener('load', () => setTimeout(report, 2000));
    }

    // Also run when we see DOM changes that might include the badge (debounced)
    observer = new MutationObserver(() => {
        clearTimeout(window._prismReportTimer);
        window._prismReportTimer = setTimeout(report, 1500);
    });
    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
    }
})();
