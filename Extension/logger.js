// ==========================================================================
//  Prism Extension Logger
//  Writes log entries to chrome.storage.local (rolling buffer, max 200 entries).
//  Log level stored in chrome.storage.sync so it persists across installs.
//
//  Loaded via importScripts() in service worker, <script> in popup.
//  Exposes: self.prismLog(level, source, msg, data?)
// ==========================================================================

const MAX_LOG_ENTRIES = 200;
const VALID_LEVELS = ['debug', 'info', 'warn', 'error'];
const LEVEL_WEIGHT = { off: 999, info: 1, debug: 0 };

async function prismLog(level, source, msg, data) {
    try {
        // Read current level setting
        const { logLevel = 'info' } = await chrome.storage.sync.get('logLevel');

        // Gate: if level=off, nothing. If level=info, skip debug.
        if (logLevel === 'off') return;
        if (logLevel === 'info' && level === 'debug') return;

        // Append to rolling buffer
        const { logs = [] } = await chrome.storage.local.get('logs');
        const entry = {
            ts: Date.now(),
            level: VALID_LEVELS.includes(level) ? level : 'info',
            source: source || 'core',
            msg: String(msg)
        };
        if (data !== undefined) {
            // Only keep serializable data
            try { entry.data = JSON.parse(JSON.stringify(data)); } catch { entry.data = String(data); }
        }
        logs.unshift(entry);
        if (logs.length > MAX_LOG_ENTRIES) logs.length = MAX_LOG_ENTRIES;
        await chrome.storage.local.set({ logs });
    } catch {
        // Silently swallow - don't break callers
    }
}

// Expose globally so both service worker (importScripts) and popup (<script>) can use it
self.prismLog = prismLog;
