// ==========================================================================
//  Prism Extension Logger
//  Writes log entries to chrome.storage.local (rolling buffer, max 200 entries).
//  Log level stored in chrome.storage.sync so it persists across installs.
//
//  Loaded via importScripts() in service worker, <script> in popup.
//  Exposes: self.prismLog(level, source, msg, data?)
//           self.prismLogEntry(entry)  - store an entry built in another context
//                                        (content scripts send theirs to the SW)
//           self.prismClearLogs()      - empty the buffer after pending writes
//
//  Every write is a read-modify-write of the whole 'logs' array, so two
//  overlapping writes would drop one of them. Writes are queued one at a time
//  in this context, and entries logged while a write is in flight go into the
//  next write together. The service worker and extension pages share the
//  chrome-extension:// origin, so a Web Lock also keeps the popup and the
//  service worker from overlapping each other.
// ==========================================================================

const MAX_LOG_ENTRIES = 200;
const VALID_LEVELS = ['debug', 'info', 'warn', 'error'];
const LEVEL_WEIGHT = { off: 999, info: 1, debug: 0 };
const LOG_LOCK_NAME = 'prism-logs';

let pendingLogBatch = null;            // entries waiting for the next write
let logWriteChain = Promise.resolve(); // tail of the write queue

function makeLogEntry(level, source, msg, data) {
    const entry = {
        ts: Date.now(),
        level: VALID_LEVELS.includes(level) ? level : 'info',
        source: source || 'core',
        msg: String(msg)
    };
    if (data !== undefined) {
        // Only keep serializable data (copied now, so later changes to the object don't leak in)
        try { entry.data = JSON.parse(JSON.stringify(data)); } catch { entry.data = String(data); }
    }
    return entry;
}

// Runs fn under the shared Web Lock when this context can use it. Web Locks
// are per origin: in a content script navigator.locks belongs to the web
// page, so the lock is skipped there (and wherever the API is missing).
function withLogLock(fn) {
    let ran = false;
    const run = () => { ran = true; return fn(); };
    try {
        const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
        const extOrigin = typeof location !== 'undefined' && location.protocol === 'chrome-extension:';
        if (extOrigin && locks && typeof locks.request === 'function') {
            return locks.request(LOG_LOCK_NAME, run).catch(() => (ran ? undefined : fn()));
        }
    } catch {}
    return ran ? Promise.resolve() : Promise.resolve().then(fn);
}

async function writeLogBatch(entries) {
    try {
        // Read current level setting
        const { logLevel = 'info' } = await chrome.storage.sync.get('logLevel');

        // Gate: if level=off, nothing. If level=info, skip debug.
        if (logLevel === 'off') return;
        const keep = logLevel === 'info' ? entries.filter(e => e.level !== 'debug') : entries;
        if (keep.length === 0) return;

        // Append to rolling buffer (newest first)
        await withLogLock(async () => {
            try {
                const stored = (await chrome.storage.local.get('logs')).logs;
                const logs = Array.isArray(stored) ? stored : [];
                for (const entry of keep) logs.unshift(entry);
                if (logs.length > MAX_LOG_ENTRIES) logs.length = MAX_LOG_ENTRIES;
                await chrome.storage.local.set({ logs });
            } catch {}
        });
    } catch {
        // Silently swallow - don't break callers
    }
}

// Adds an entry to the open batch, starting one if needed. The returned
// promise resolves once the batch holding this entry has been written.
function queueLogEntry(entry) {
    if (!pendingLogBatch) {
        const batch = { entries: [] };
        batch.done = logWriteChain.then(() => {
            // Close the batch as its write starts; later entries form the next one
            if (pendingLogBatch === batch) pendingLogBatch = null;
            return writeLogBatch(batch.entries);
        });
        logWriteChain = batch.done.catch(() => {});
        pendingLogBatch = batch;
    }
    pendingLogBatch.entries.push(entry);
    return pendingLogBatch.done;
}

async function prismLog(level, source, msg, data) {
    try {
        await queueLogEntry(makeLogEntry(level, source, msg, data));
    } catch {
        // Silently swallow - don't break callers
    }
}

// Stores an entry built elsewhere (e.g. a content script's {ts, level, source,
// msg, data}), keeping its timestamp. The level gate still applies.
async function prismLogEntry(raw) {
    try {
        if (!raw || typeof raw !== 'object') return;
        const entry = makeLogEntry(raw.level, raw.source, raw.msg, raw.data);
        if (Number.isFinite(raw.ts)) entry.ts = raw.ts;
        await queueLogEntry(entry);
    } catch {
        // Silently swallow - don't break callers
    }
}

// Empties the buffer behind any write already queued here, so an entry logged
// before the clear cannot bring the old array back. Entries logged after this
// call go into a fresh batch that is written after the clear.
function prismClearLogs() {
    pendingLogBatch = null;
    const done = logWriteChain
        .then(() => withLogLock(() => chrome.storage.local.set({ logs: [] })))
        .catch(() => {});
    logWriteChain = done;
    return done;
}

// Expose globally so both service worker (importScripts) and popup (<script>) can use it
self.prismLog = prismLog;
self.prismLogEntry = prismLogEntry;
self.prismClearLogs = prismClearLogs;
