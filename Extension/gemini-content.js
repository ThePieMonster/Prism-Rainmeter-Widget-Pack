// Content script that runs on gemini.google.com pages.
// Reads the plan badge from the rendered DOM and caches it in chrome.storage
// for the background service worker to pick up.
//
// Only the top bar (where the badge sits next to the Gemini logo) is looked
// at. Chat messages, the prompt box and its mode picker (which can say "Pro"
// on any plan), the sidebar chat list and menus or dialogs are skipped
// without reading their text.

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

            // The service worker owns the 'logs' buffer (logger.js), so hand it
            // the entry instead of rewriting the array from this tab.
            const entry = { ts: Date.now(), level, source, msg: String(msg) };
            if (data !== undefined) {
                try { entry.data = JSON.parse(JSON.stringify(data)); } catch { entry.data = String(data); }
            }
            await chrome.runtime.sendMessage({ type: 'log', entry });
        } catch (e) { /* ignore */ }
    }

    log('debug', 'content', 'Gemini content script injected');

    // False once the extension was updated or removed while this tab stayed
    // open (Chrome does not re-inject content scripts into open tabs).
    function extensionAlive() {
        try { return !!chrome.runtime?.id; } catch { return false; }
    }

    // Gemini's Collect switch in the popup's Settings (on unless set to
    // false). Off, or unreadable, keeps this script idle: it does not look at
    // the page or store anything.
    function collectingFrom(setting) {
        return !setting || setting.gemini !== false;
    }

    async function collectionEnabled() {
        try {
            return collectingFrom((await chrome.storage.sync.get('serviceEnabled')).serviceEnabled);
        } catch {
            return false;
        }
    }

    // Google multi-login index of this tab: /u/1/... or ?authuser=1 is the
    // second signed-in account. The service worker always fetches usage for
    // the default account (index 0), so only that account's plan is stored.
    function accountIndex() {
        const m = /^\/u\/(\d+)(?:\/|$)/.exec(location.pathname);
        if (m) return parseInt(m[1], 10);
        const q = new URLSearchParams(location.search).get('authuser');
        return q && /^\d+$/.test(q) ? parseInt(q, 10) : 0;
    }

    // The furthest down the viewport the top bar can reach (the band used when
    // no header or logo element is found; see topBarLimit)
    const TOP_BAR_PX = 160;

    // Subtrees that are never searched, so their text is never read
    const SKIP = [
        // Conversation: prompts, responses and their content
        'model-response', 'user-query', 'message-content', '.conversation-container', 'chat-history',
        // Prompt box, including its mode picker
        'rich-textarea', 'input-area-v2', 'input-container', 'bard-mode-switcher', '[data-test-id*="mode"]',
        '[contenteditable]', 'textarea', 'input',
        // Sidebar chat titles
        'conversations-list', '.conversation-items-container',
        // Menus, dialogs, tooltips and other overlays
        '.cdk-overlay-container', '[role="dialog"]', '[role="alertdialog"]', '[role="menu"]',
        '[role="listbox"]', '[role="option"]', '[role="tooltip"]',
        // No visible text
        'script', 'style', 'noscript', 'template', 'svg'
    ].join(', ');

    // Signs that the top bar has rendered, so a missing badge means Free
    const HEADER_HINTS = 'header, [role="banner"], top-bar-actions, .top-bar-actions, bard-logo, .bard-logo, [data-test-id*="logo"], [class*="logo"]';

    function inTopBar(el, limit = TOP_BAR_PX) {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < limit;
    }

    // Bottom of the rendered top bar, so the band ends there and not inside
    // the conversation below it; TOP_BAR_PX when no header or logo is found.
    // Each header or logo element counts with 8px of slack, and so do (without
    // slack) its ancestors that still end inside TOP_BAR_PX, so a badge under
    // a small logo is in the band while the full-height app shell is not.
    function topBarLimit() {
        let bottom = 0;
        for (const el of document.querySelectorAll(HEADER_HINTS)) {
            if (el.closest(SKIP) || !inTopBar(el)) continue;
            bottom = Math.max(bottom, el.getBoundingClientRect().bottom + 8);
            for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
                const b = a.getBoundingClientRect().bottom;
                if (b > TOP_BAR_PX) break;
                bottom = Math.max(bottom, b);
            }
        }
        return bottom > 0 ? Math.min(bottom, TOP_BAR_PX) : TOP_BAR_PX;
    }

    // Returns the plan named by the top-bar badge, 'Free' when the top bar is
    // on the page without one, or null when it is not (another route, or not
    // rendered yet) so a cached paid plan is not overwritten with 'Free'.
    function detectPlan() {
        if (!document.body) return null;
        let headerSeen = false;
        const limit = topBarLimit();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
            acceptNode: el => (el.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
        });
        for (let el = walker.nextNode(); el; el = walker.nextNode()) {
            if (el.children.length > 0) continue;
            // Position before text, so nothing below the top bar is read
            if (!inTopBar(el, limit)) continue;
            const t = el.textContent?.trim();
            if (!t || t.length > 10) continue;
            const upper = t.toUpperCase();
            if (upper === 'ULTRA') return 'Ultra';
            if (upper === 'PRO') return 'Pro';
            if (upper === 'PLUS') return 'Plus';
            if (upper === 'ADVANCED') return 'Advanced';
            if (upper === 'GEMINI') headerSeen = true; // the logo text
        }
        if (!headerSeen) {
            headerSeen = [...document.querySelectorAll(HEADER_HINTS)].some(el => !el.closest(SKIP) && inTopBar(el));
        }
        return headerSeen ? 'Free' : null;
    }

    let lastReportedPlan = null;
    let observer = null;
    let skippedOtherAccount = false;
    let running = false;

    function stop() {
        running = false;
        if (observer) observer.disconnect();
        observer = null;
        clearTimeout(window._prismReportTimer);
    }

    async function report() {
        if (!extensionAlive()) { stop(); return; }
        if (!running || !(await collectionEnabled())) return;

        // Another signed-in account's plan would be paired with the default
        // account's usage bars, so leave the stored plan alone
        if (accountIndex() !== 0) {
            if (!skippedOtherAccount) log('debug', 'content', 'Not the default Google account (/u/N); plan not stored');
            skippedOtherAccount = true;
            return;
        }

        const plan = detectPlan();
        if (plan === null) {
            log('debug', 'content', 'Gemini top bar not found; keeping the cached plan');
            return;
        }
        const changed = plan !== lastReportedPlan;
        lastReportedPlan = plan;

        try {
            await chrome.storage.local.set({
                geminiPlanName: plan,
                geminiPlanDetectedAt: Date.now()
            });
        } catch (e) {
            stop();
            return;
        }

        if (changed) {
            log('info', 'content', `Gemini plan detected: ${plan}`);
        } else {
            log('debug', 'content', `Gemini plan unchanged: ${plan}`);
        }
    }

    function start() {
        if (running || !extensionAlive()) return;
        running = true;

        // Run after page has loaded enough to render badges
        if (document.readyState === 'complete') {
            window._prismReportTimer = setTimeout(report, 2000);
        } else {
            window.addEventListener('load', () => {
                if (running) window._prismReportTimer = setTimeout(report, 2000);
            }, { once: true });
        }

        // Also run when we see DOM changes that might include the badge (debounced)
        observer = new MutationObserver(() => {
            if (!extensionAlive()) { stop(); return; }
            clearTimeout(window._prismReportTimer);
            window._prismReportTimer = setTimeout(report, 1500);
        });
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        }
    }

    collectionEnabled().then(on => {
        if (on) start();
        else log('debug', 'content', 'Gemini is turned off in Settings; content script idle');
    });

    // Turned on or off in the popup while this tab stays open
    try {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'sync' || !changes.serviceEnabled) return;
            if (!extensionAlive()) { stop(); return; }
            if (collectingFrom(changes.serviceEnabled.newValue)) start();
            else stop();
        });
    } catch (e) { /* ignore */ }
})();
