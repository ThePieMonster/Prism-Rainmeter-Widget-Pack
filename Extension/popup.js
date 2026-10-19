// ==========================================================================
//  Prism Popup - Status / Logs / Settings tabs
// ==========================================================================

// ---- Extension name + version (single source of truth: manifest.json) ----
const EXT_MANIFEST = chrome.runtime.getManifest();
const EXT_NAME = EXT_MANIFEST.name;
const EXT_VERSION = EXT_MANIFEST.version;
document.title = EXT_NAME;
{
    const nameEl = document.getElementById('extension-name');
    if (nameEl) nameEl.textContent = EXT_NAME;
    const versionEl = document.getElementById('version');
    if (versionEl) versionEl.textContent = 'v' + EXT_VERSION;
    const aboutVersionEl = document.getElementById('version-about');
    if (aboutVersionEl) aboutVersionEl.textContent = EXT_VERSION;
}

// ---- Service visibility + order ----
// Each key maps to the Status row's element ID. Defaults: all visible, canonical order.
const SERVICE_VISIBILITY_KEY = 'serviceVisibility';
const SERVICE_ORDER_KEY = 'serviceOrder';
// Canonical default order: alphabetical by brand, with each brand's consumer
// plan followed by its API. Users can reorder via drag-and-drop in Settings.
const SERVICE_ROWS = {
    chatgpt:    'row-chatgpt',
    chatgptApi: 'row-chatgpt-api',
    claude:     'row-claude',
    claudeApi:  'row-claude-api',
    gemini:     'row-gemini',
    geminiApi:  'row-gemini-api',
};
const SERVICE_KEYS_CANONICAL = Object.keys(SERVICE_ROWS);
const SERVICE_DEFAULTS = Object.fromEntries(SERVICE_KEYS_CANONICAL.map(k => [k, true]));
// True between dragstart and dragend in the Settings service list
let isDraggingService = false;

async function getServiceVisibility() {
    const stored = await chrome.storage.sync.get(SERVICE_VISIBILITY_KEY).catch(() => ({}));
    return { ...SERVICE_DEFAULTS, ...(stored[SERVICE_VISIBILITY_KEY] || {}) };
}

async function getServiceOrder() {
    const stored = await chrome.storage.sync.get(SERVICE_ORDER_KEY).catch(() => ({}));
    const saved = stored[SERVICE_ORDER_KEY];
    if (!Array.isArray(saved)) return [...SERVICE_KEYS_CANONICAL];
    // Filter to valid keys, then append any canonical keys that are missing (e.g. after an update adds a service)
    const valid = saved.filter(k => SERVICE_KEYS_CANONICAL.includes(k));
    for (const k of SERVICE_KEYS_CANONICAL) {
        if (!valid.includes(k)) valid.push(k);
    }
    return valid;
}

async function saveServiceOrder(order) {
    await chrome.storage.sync.set({ [SERVICE_ORDER_KEY]: order });
}

// Put nodes in the given order directly before ref (null = at the end). Nodes
// already in that order are left alone: moving a node detaches it, which clears
// any text the user has selected inside it.
function placeInOrder(parent, nodes, ref) {
    const inPlace = nodes.every((node, i) => node.nextElementSibling === (nodes[i + 1] || ref));
    if (inPlace) return;
    for (const node of nodes) parent.insertBefore(node, ref);
}

async function applyServiceVisibility() {
    const vis = await getServiceVisibility();
    const order = await getServiceOrder();

    // 1. Apply order + visibility to the Status panel
    const statusPanel = document.getElementById('panel-status');
    const lastUpdated = document.getElementById('last-updated');
    const rows = [];
    for (const key of order) {
        const row = document.getElementById(SERVICE_ROWS[key]);
        if (!row) continue;
        row.style.display = vis[key] ? '' : 'none';
        if (row.parentNode === statusPanel) rows.push(row);
    }
    // Keep the rows just before last-updated (so they stay above the footer timestamp)
    if (lastUpdated) placeInOrder(statusPanel, rows, lastUpdated);

    // 2. Apply order to the Settings service list
    const list = document.getElementById('service-list');
    if (list) {
        // Not while a drag is in progress: the list is showing the user's
        // in-progress arrangement, which dragend saves and then re-applies.
        // This check sits after the awaits above so a call that started
        // before dragstart cannot snap the dragged row back either.
        if (!isDraggingService) {
            const items = order
                .map(key => list.querySelector(`.service-item[data-service="${key}"]`))
                .filter(Boolean);
            placeInOrder(list, items, null);
        }
        // Sync toggle checkboxes
        list.querySelectorAll('.service-toggle').forEach(cb => {
            const key = cb.dataset.service;
            if (key in vis) cb.checked = vis[key];
        });
    }
}

document.querySelectorAll('.service-toggle').forEach(cb => {
    cb.addEventListener('change', async () => {
        const current = await getServiceVisibility();
        current[cb.dataset.service] = cb.checked;
        await chrome.storage.sync.set({ [SERVICE_VISIBILITY_KEY]: current });
        await applyServiceVisibility();
    });
});

// Re-apply when the order or visibility changes outside this popup's own
// handlers (a second open popup, or Chrome sync from another device). The
// toggle and drag handlers re-apply directly, so this is not polled.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes[SERVICE_ORDER_KEY] || changes[SERVICE_VISIBILITY_KEY])) {
        applyServiceVisibility();
    }
});

// ---- Drag to reorder services ----
(function setupDragReorder() {
    const list = document.getElementById('service-list');
    if (!list) return;

    let dragged = null;

    // Only allow drag when the user grabs the drag handle - prevents accidental
    // drags when the toggle or label is clicked. Draggable is toggled on at
    // mousedown on the handle and off again at dragend, or at the next mouseup
    // anywhere: a press on the handle can be released off it without starting
    // a drag (mouseup does not fire once a drag has started).
    list.querySelectorAll('.service-item').forEach(item => {
        item.setAttribute('draggable', 'false');
        const handle = item.querySelector('.drag-handle');
        if (handle) handle.addEventListener('mousedown', () => item.setAttribute('draggable', 'true'));
    });
    const resetDraggable = () => list.querySelectorAll('.service-item[draggable="true"]')
        .forEach(item => item.setAttribute('draggable', 'false'));
    document.addEventListener('mouseup', resetDraggable);
    // Also on every press (capture phase, so before the handle's listener), in
    // case a mouseup was never delivered
    document.addEventListener('mousedown', resetDraggable, true);

    list.addEventListener('dragstart', (e) => {
        const item = e.target.closest('.service-item');
        if (!item) return;
        dragged = item;
        isDraggingService = true;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Required for Firefox compatibility
        try { e.dataTransfer.setData('text/plain', item.dataset.service); } catch {}
    });

    list.addEventListener('dragend', async () => {
        if (dragged) {
            dragged.classList.remove('dragging');
            dragged.setAttribute('draggable', 'false');
        }
        list.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
        dragged = null;
        // Cleared before the save so the re-apply below (and onChanged) runs
        isDraggingService = false;
        // Save on dragend (covers both drop-inside and drop-outside; the DOM is
        // already at the last-hovered position either way, which matches what
        // the user sees).
        const newOrder = [...list.querySelectorAll('.service-item')].map(el => el.dataset.service);
        await saveServiceOrder(newOrder);
        await applyServiceVisibility();
    });

    list.addEventListener('dragover', (e) => {
        if (!dragged) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const target = e.target.closest('.service-item');
        list.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
        if (!target || target === dragged) return;

        const rect = target.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        if (before) list.insertBefore(dragged, target);
        else list.insertBefore(dragged, target.nextSibling);
    });

    list.addEventListener('drop', (e) => {
        // Prevent default so the browser doesn't try to navigate / open the
        // dragged text. Saving happens in dragend, which fires for both
        // successful drops and cancelled drags.
        e.preventDefault();
    });
})();

// ---- Tab switching ----
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
    });
});

// ---- Service icon links (colored dots open the service page) ----
document.querySelectorAll('.service-icon[data-url]').forEach(icon => {
    icon.addEventListener('click', () => {
        chrome.tabs.create({ url: icon.dataset.url });
    });
});

// ---- Toast ----
let toastTimer = null;
function showToast(msg, kind = 'info') {
    const t = document.getElementById('status-toast');
    t.className = 'status-toast ' + kind + ' visible';
    t.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('visible'), 2200);
}

// ---- Status renderer ----

// Detail lines are re-rendered on every poll. Assigning innerHTML replaces the
// child nodes even when the markup is identical, which clears any text the user
// has selected, so a line is only written when its content changed.
const renderedDetail = new WeakMap();
function setDetail(el, value, asHtml) {
    const key = (asHtml ? 'html:' : 'text:') + value;
    if (renderedDetail.get(el) === key) return;
    renderedDetail.set(el, key);
    if (asHtml) el.innerHTML = value;
    else el.textContent = value;
}
function setDetailHtml(el, html) { setDetail(el, html, true); }
function setDetailText(el, text) { setDetail(el, text, false); }

function setPlanBadge(el, connected, planName) {
    el.classList.remove('connected', 'disconnected', 'unknown');
    if (!connected) {
        el.textContent = 'Disconnected';
        el.classList.add('disconnected');
    } else if (planName === 'Unknown' || !planName) {
        el.textContent = planName || 'Active';
        el.classList.add('unknown');
    } else {
        el.textContent = planName;
        el.classList.add('connected');
    }
}

// "5m ago" for an epoch-ms time, or '' when it is unknown. A time slightly in
// the future (clock skew) reads as 0s.
function timeAgo(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    return formatRelativeTime(Math.min(ms, Date.now())) + ' ago';
}

// Suffix for an API cost row showing a cached read (Stale === 1). Uses the
// cache time, not "Last updated", which is when the last update ran.
function staleSuffix(cachedAtEpoch) {
    const ago = timeAgo(Number(cachedAtEpoch) * 1000);
    return ago ? ` · as of ${ago}` : ' · cached';
}

// Label for TodayTotal: 'Today', or 'Oct 16' when the cost snapshot was taken
// on an earlier UTC day (DataDay is the UTC day TodayTotal belongs to)
function costDayLabel(dataDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataDay || '')) return 'Today';
    if (dataDay === new Date().toISOString().slice(0, 10)) return 'Today';
    const day = new Date(dataDay + 'T00:00:00Z');
    if (Number.isNaN(day.getTime())) return 'Today';
    return day.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// An error message with its last mention of linkText turned into a link, or
// null when it does not mention linkText (raw codes like HTTP 401)
function linkifyError(error, linkText, url) {
    const html = escapeHtml(error);
    const text = escapeHtml(linkText);
    const i = html.lastIndexOf(text);
    if (i < 0) return null;
    return `${html.slice(0, i)}<a href="${url}" target="_blank" rel="noopener">${text}</a>${html.slice(i + text.length)}`;
}

// Session + weekly bars shared by the consumer rows (Claude, ChatGPT, Gemini).
// Returns false when there is no usage data, so the caller fills in the detail text.
// payloadMs is when the payload was built (AgeSeconds counts back from then).
function renderUsageBars(prefix, d, payloadMs) {
    const detail = document.getElementById(`${prefix}-detail`);
    const barSession = document.getElementById(`${prefix}-bar-session`);
    const barWeekly = document.getElementById(`${prefix}-bar-weekly`);
    const show = !!(d.Connected && d.HasUsageData);
    barSession.style.display = show ? 'block' : 'none';
    barWeekly.style.display = show ? 'block' : 'none';
    if (!show) return false;
    // Stale: reused from the last good read after a transient failure
    const cached = d.Stale === 1
        ? `<br>Cached ${timeAgo(payloadMs - Number(d.AgeSeconds) * 1000)}`.trimEnd()
        : '';
    setDetailHtml(detail, `Session <strong>${d.SessionPercent}%</strong> used · ${d.SessionReset || ''}<br>Weekly <strong>${d.WeeklyPercent}%</strong> used · ${d.WeeklyReset || ''}${cached}`);
    barSession.querySelector('.service-bar-fill').style.width = (d.SessionPercent || 0) + '%';
    barWeekly.querySelector('.service-bar-fill').style.width = (d.WeeklyPercent || 0) + '%';
    return true;
}

async function renderStatus() {
    const { lastPayload, lastUpdate } = await chrome.storage.local.get(['lastPayload', 'lastUpdate']);

    const lastUpdEl = document.getElementById('last-updated');
    if (lastUpdate) {
        // Clamped at 0: a lastUpdate in the future (the clock was set back
        // since) would otherwise read as a negative age
        const ago = Math.max(0, Math.round((Date.now() - lastUpdate) / 1000));
        const txt = ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m ago`;
        lastUpdEl.textContent = `Last updated ${txt}`;
    } else {
        lastUpdEl.textContent = 'No data yet';
    }

    if (!lastPayload) return;
    const payloadMs = Date.parse(lastPayload.timestamp);

    // ---- Claude ----
    const c = lastPayload.claude || {};
    setPlanBadge(document.getElementById('claude-plan'), c.Connected, c.PlanName);
    if (!renderUsageBars('claude', c, payloadMs)) {
        setDetailText(document.getElementById('claude-detail'),
            c.Connected ? 'Active - no usage data available' : (c.error || 'Not connected'));
    }

    // ---- ChatGPT ----
    const g = lastPayload.chatgpt || {};
    setPlanBadge(document.getElementById('chatgpt-plan'), g.Connected, g.PlanName);
    if (!renderUsageBars('chatgpt', g, payloadMs)) {
        setDetailText(document.getElementById('chatgpt-detail'),
            g.Connected ? 'Active - no usage data available' : (g.error || 'Not connected'));
    }

    // ---- Gemini ----
    const m = lastPayload.gemini || {};
    setPlanBadge(document.getElementById('gemini-plan'), m.Connected, m.PlanName);
    if (!renderUsageBars('gemini', m, payloadMs)) {
        const mDetail = document.getElementById('gemini-detail');
        if (!m.Connected) {
            setDetailText(mDetail, m.error || 'Not connected');
        } else if (m.PlanName === 'Unknown') {
            setDetailHtml(mDetail, `Visit <a href="https://gemini.google.com/" target="_blank" rel="noopener">gemini.google.com</a> to detect plan`);
        } else {
            setDetailText(mDetail, 'Active - no usage data available');
        }
    }

    // ---- Claude API (platform.claude.com) ----
    const a = lastPayload.claudeApi || {};
    setPlanBadge(document.getElementById('claude-api-plan'), a.Connected, a.PeriodLabel);
    const aDetail = document.getElementById('claude-api-detail');
    if (!a.Connected) {
        // Signed out: no error, the "Not logged in to ..." text, or HTTP 401/403.
        // Anything else (rate limit, outage, offline with no recent cache) is
        // shown as is, so a signed-in user is not told to log in.
        const aLink = `<a href="https://platform.claude.com/" target="_blank" rel="noopener">platform.claude.com</a>`;
        const signedOut = !a.error || /Not logged in/.test(a.error) || /\bHTTP 40[13]\b/.test(a.error);
        setDetailHtml(aDetail, signedOut
            ? `Not logged into ${aLink}`
            : `Could not read spend (${escapeHtml(a.error)}) · ${aLink}`);
    } else {
        setDetailHtml(aDetail, `<strong>$${a.MonthTotal}</strong> this month · ${costDayLabel(a.DataDay)} $${a.TodayTotal}${a.Stale === 1 ? staleSuffix(a.CachedAtEpoch) : ''}`);
    }

    // ---- ChatGPT API (platform.openai.com) ----
    const o = lastPayload.chatgptApi || {};
    setPlanBadge(document.getElementById('chatgpt-api-plan'), o.Connected, o.PeriodLabel);
    const oDetail = document.getElementById('chatgpt-api-detail');
    if (!o.Connected) {
        // Readable errors (e.g. "Stale - reopen platform.openai.com to refresh")
        // are shown as is; raw codes keep the generic hint
        const oUrl = 'https://platform.openai.com/settings/organization/usage';
        setDetailHtml(oDetail, (o.error && linkifyError(o.error, 'platform.openai.com', oUrl)) ||
            `Visit <a href="${oUrl}" target="_blank" rel="noopener">platform.openai.com</a> to initialize`);
    } else {
        setDetailHtml(oDetail, `<strong>$${o.MonthTotal}</strong> this month · ${costDayLabel(o.DataDay)} $${o.TodayTotal}${o.Stale === 1 ? staleSuffix(o.CachedAtEpoch) : ''}`);
    }

    // ---- Gemini API (aistudio.google.com) ----
    const ga = lastPayload.geminiApi || {};
    setPlanBadge(document.getElementById('gemini-api-plan'), ga.Connected, ga.PeriodLabel);
    const gaDetail = document.getElementById('gemini-api-detail');
    // Stale here means some project values were not read in the last scrape
    // (carried over from an earlier one, or left out of the total), so the
    // cache time would overstate how fresh they are
    const gaAll = !ga.ProjectName || ga.ProjectName === 'All Projects';
    const gaStale = ga.Stale === 1 ? (gaAll ? ' · some projects not refreshed' : ' · not refreshed') : '';
    if (!ga.Connected) {
        // e.g. "Stale - visit aistudio.google.com/spend to refresh", or a
        // selected project that has never been read
        const gaUrl = 'https://aistudio.google.com/spend';
        setDetailHtml(gaDetail, (ga.error && linkifyError(ga.error, 'aistudio.google.com/spend', gaUrl)) ||
            `Visit <a href="${gaUrl}" target="_blank" rel="noopener">aistudio.google.com/spend</a> to initialize`);
    } else if (ga.HasData) {
        // Project names come from the scraped page, so they are escaped
        setDetailHtml(gaDetail, `<strong>$${ga.MonthTotal}</strong> this month · ${escapeHtml(ga.ProjectName || 'All Projects')}${gaStale}`);
    } else {
        setDetailText(gaDetail, `${ga.Tier} - no spend this period${gaStale}`);
    }

    // Populate the Gemini project selector in Settings if project list is available
    const projectSelect = document.getElementById('gemini-project');
    if (projectSelect && ga.ProjectNames && ga.ProjectNames.length > 0) {
        const { geminiApiProject = '__all__' } = await chrome.storage.sync.get('geminiApiProject').catch(() => ({}));
        // Only rebuild options if the project list changed
        const currentNames = [...projectSelect.options].map(o => o.value).join(',');
        const newNames = ['__all__', ...ga.ProjectNames].join(',');
        if (currentNames !== newNames) {
            projectSelect.innerHTML = '';
            const allOpt = document.createElement('option');
            allOpt.value = '__all__';
            allOpt.textContent = 'All Projects';
            projectSelect.appendChild(allOpt);
            for (const name of ga.ProjectNames) {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                projectSelect.appendChild(opt);
            }
        }
        // The saved project can drop out of the list (renamed or deleted in AI
        // Studio, or a scrape that only saw the current project). background.js
        // then reports All Projects, so show that instead of a blank select.
        // The preference is kept and applies again if the project comes back.
        const listed = [...projectSelect.options].some(o => o.value === geminiApiProject);
        projectSelect.value = listed ? geminiApiProject : '__all__';
    }
}

// ---- Logs renderer ----

// Clamped at 0, like the footer: an entry from before the clock was set back
// is in the future and would otherwise read as a negative age
function formatRelativeTime(ts) {
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (sec < 60) return sec + 's';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h';
    return Math.floor(hr / 24) + 'd';
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Last markup written to #logs-list, so an unchanged list is not rebuilt
let renderedLogsHtml = null;

async function renderLogs() {
    const listEl = document.getElementById('logs-list');
    const { logs = [] } = await chrome.storage.local.get('logs');

    // The markup leaves out the relative timestamps (filled in below), so it
    // only changes when the entries do. Rebuilding replaces every row, which
    // clears any text the user has selected in the list.
    const html = logs.length === 0
        ? '<div class="empty">No logs yet</div>'
        : logs.slice(0, 100).map(entry => `<div class="log-entry ${escapeHtml(entry.level)}">
            <span class="ts" data-ts="${Number(entry.ts)}"></span>
            <span class="lvl">${escapeHtml(entry.level)}</span>
            <span class="src">${escapeHtml(entry.source)}</span>
            <span class="msg">${escapeHtml(entry.msg)}</span>
        </div>`).join('');
    if (html !== renderedLogsHtml) {
        listEl.innerHTML = html;
        renderedLogsHtml = html;
    }

    listEl.querySelectorAll('.ts[data-ts]').forEach(span => {
        const ts = formatRelativeTime(Number(span.dataset.ts));
        if (span.textContent !== ts) span.textContent = ts;
    });
}

// ---- Log level ----

async function loadLogLevel() {
    const { logLevel = 'info' } = await chrome.storage.sync.get('logLevel');
    document.getElementById('log-level').value = logLevel;
}

document.getElementById('log-level').addEventListener('change', async (e) => {
    const newLevel = e.target.value;
    await chrome.storage.sync.set({ logLevel: newLevel });
    await self.prismLog('info', 'popup', `Log level changed to ${newLevel}`);
    showToast(`Log level: ${newLevel}`, 'success');
    await renderLogs();
});

// ---- Gemini project selector ----

document.getElementById('gemini-project').addEventListener('change', async (e) => {
    const project = e.target.value;
    await chrome.storage.sync.set({ geminiApiProject: project });
    await self.prismLog('info', 'popup', `Gemini project changed to ${project === '__all__' ? 'All Projects' : project}`);
    showToast(`Gemini: ${project === '__all__' ? 'All Projects' : project}`, 'success');
    // Trigger a refresh so the widget picks up the new selection
    try { await chrome.runtime.sendMessage({ action: 'refresh' }); } catch {}
    await renderStatus();
});

// ---- Clear logs ----

document.getElementById('clear-logs').addEventListener('click', async () => {
    // Clear through logger.js's write queue and lock: a plain set here could
    // land under a log write already in flight, which then puts the old
    // entries back.
    if (typeof self.prismClearLogs === 'function') await self.prismClearLogs();
    else await chrome.storage.local.set({ logs: [] });
    await self.prismLog('info', 'popup', 'Logs cleared');
    showToast('Logs cleared', 'success');
    await renderLogs();
});

// ---- Export logs ----

function formatLogsAsText(logs) {
    // Reverse so oldest is first (easier to read chronologically)
    return [...logs].reverse().map(entry => {
        const d = new Date(entry.ts);
        const ts = d.toISOString().replace('T', ' ').slice(0, 19);
        const lvl = entry.level.toUpperCase().padEnd(5);
        const src = (entry.source || '').padEnd(10);
        let line = `[${ts}] ${lvl} ${src} ${entry.msg}`;
        if (entry.data !== undefined && entry.data !== null) {
            try { line += ' ' + JSON.stringify(entry.data); } catch {}
        }
        return line;
    }).join('\n');
}

async function getFormattedLogs() {
    const { logs = [] } = await chrome.storage.local.get('logs');
    if (logs.length === 0) return { logs, text: null };
    const header = `${EXT_NAME} - Log Export\nGenerated: ${new Date().toISOString()}\nEntries: ${logs.length}\n` + '-'.repeat(50) + '\n';
    return { logs, text: header + formatLogsAsText(logs) };
}

document.getElementById('copy-logs').addEventListener('click', async () => {
    const { logs, text } = await getFormattedLogs();
    if (!text) {
        showToast('No logs to copy', 'info');
        return;
    }
    try {
        await navigator.clipboard.writeText(text);
        await self.prismLog('info', 'popup', `Logs copied to clipboard (${logs.length} entries)`);
        showToast(`Copied ${logs.length} entries to clipboard`, 'success');
    } catch (e) {
        await self.prismLog('warn', 'popup', 'Clipboard write failed: ' + e.message);
        showToast('Copy failed: ' + e.message, 'error');
    }
});

document.getElementById('export-logs').addEventListener('click', async () => {
    const { logs, text } = await getFormattedLogs();
    if (!text) {
        showToast('No logs to export', 'info');
        return;
    }
    try {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `prism-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        await self.prismLog('info', 'popup', `Logs exported to file (${logs.length} entries)`);
        showToast(`Downloaded ${logs.length} entries`, 'success');
    } catch (e) {
        await self.prismLog('warn', 'popup', 'Download failed: ' + e.message);
        showToast('Download failed: ' + e.message, 'error');
    }
});

// ---- Manual refresh ----

const refreshBtn = document.getElementById('btn-refresh');
refreshBtn.addEventListener('click', async () => {
    refreshBtn.classList.add('spinning');
    refreshBtn.disabled = true;
    showToast('Refreshing...', 'info');
    try {
        const res = await chrome.runtime.sendMessage({ action: 'refresh' });
        await new Promise(r => setTimeout(r, 600));
        await renderStatus();
        await renderLogs();
        // background.js replies {ok:false, error} when the update itself failed
        if (res && res.ok === false) showToast('Refresh failed: ' + (res.error || 'unknown error'), 'error');
        else showToast('Updated', 'success');
    } catch (err) {
        showToast('Error: ' + err.message, 'error');
    } finally {
        refreshBtn.classList.remove('spinning');
        refreshBtn.disabled = false;
    }
});

// ---- Lifecycle ----

(async function init() {
    await loadLogLevel();
    await applyServiceVisibility();
    await self.prismLog('debug', 'popup', 'Popup opened');
    await renderStatus();
    await renderLogs();
})();

// True while the user has text selected inside the panel that is showing
function hasSelectionInActivePanel() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
    const panel = document.querySelector('.panel.active');
    return !!panel && sel.getRangeAt(0).intersectsNode(panel);
}

// Live polling while popup is open. Service order and visibility are not
// polled: the storage.onChanged listener above re-applies them on change.
const pollInterval = setInterval(async () => {
    // Hold the view still while the user has text selected in it, so the
    // selection survives long enough to copy. Updates resume once it clears.
    if (hasSelectionInActivePanel()) return;
    await renderStatus();
    await renderLogs();
}, 2000);

window.addEventListener('unload', () => clearInterval(pollInterval));
