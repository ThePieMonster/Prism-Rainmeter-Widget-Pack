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

async function applyServiceVisibility() {
    const vis = await getServiceVisibility();
    const order = await getServiceOrder();

    // 1. Apply order + visibility to the Status panel
    const statusPanel = document.getElementById('panel-status');
    const lastUpdated = document.getElementById('last-updated');
    for (const key of order) {
        const row = document.getElementById(SERVICE_ROWS[key]);
        if (!row) continue;
        row.style.display = vis[key] ? '' : 'none';
        // Move to just before last-updated (so rows stay above the footer timestamp)
        if (lastUpdated && row.parentNode === statusPanel) {
            statusPanel.insertBefore(row, lastUpdated);
        }
    }

    // 2. Apply order to the Settings service list
    const list = document.getElementById('service-list');
    if (list) {
        for (const key of order) {
            const item = list.querySelector(`.service-item[data-service="${key}"]`);
            if (item) list.appendChild(item);
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

// ---- Drag to reorder services ----
(function setupDragReorder() {
    const list = document.getElementById('service-list');
    if (!list) return;

    let dragged = null;

    // Only allow drag when the user grabs the drag handle - prevents accidental
    // drags when the toggle or label is clicked. Draggable is toggled on at
    // mousedown and off again at dragend.
    list.querySelectorAll('.service-item').forEach(item => {
        item.setAttribute('draggable', 'false');
        const handle = item.querySelector('.drag-handle');
        if (handle) {
            handle.addEventListener('mousedown', () => item.setAttribute('draggable', 'true'));
            handle.addEventListener('mouseup',   () => item.setAttribute('draggable', 'false'));
        }
    });

    list.addEventListener('dragstart', (e) => {
        const item = e.target.closest('.service-item');
        if (!item) return;
        dragged = item;
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

async function renderStatus() {
    const { lastPayload, lastUpdate } = await chrome.storage.local.get(['lastPayload', 'lastUpdate']);

    const lastUpdEl = document.getElementById('last-updated');
    if (lastUpdate) {
        const ago = Math.round((Date.now() - lastUpdate) / 1000);
        const txt = ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m ago`;
        lastUpdEl.textContent = `Last updated ${txt}`;
    } else {
        lastUpdEl.textContent = 'No data yet';
    }

    if (!lastPayload) return;

    // ---- Claude ----
    const c = lastPayload.claude || {};
    setPlanBadge(document.getElementById('claude-plan'), c.Connected, c.PlanName);
    const claudeDetail = document.getElementById('claude-detail');
    const claudeBarSession = document.getElementById('claude-bar-session');
    const claudeBarWeekly = document.getElementById('claude-bar-weekly');

    if (!c.Connected) {
        claudeDetail.textContent = c.error || 'Not connected';
        claudeBarSession.style.display = 'none';
        claudeBarWeekly.style.display = 'none';
    } else if (c.HasUsageData) {
        claudeDetail.innerHTML = `Session <strong>${c.SessionPercent}%</strong> · ${c.SessionReset || ''}<br>Weekly <strong>${c.WeeklyPercent}%</strong> · ${c.WeeklyReset || ''}`;
        claudeBarSession.style.display = 'block';
        claudeBarSession.querySelector('.service-bar-fill').style.width = (c.SessionPercent || 0) + '%';
        claudeBarWeekly.style.display = 'block';
        claudeBarWeekly.querySelector('.service-bar-fill').style.width = (c.WeeklyPercent || 0) + '%';
    } else {
        claudeDetail.textContent = 'Active - no usage data available';
        claudeBarSession.style.display = 'none';
        claudeBarWeekly.style.display = 'none';
    }

    // ---- ChatGPT ----
    const g = lastPayload.chatgpt || {};
    setPlanBadge(document.getElementById('chatgpt-plan'), g.Connected, g.PlanName);
    const gDetail = document.getElementById('chatgpt-detail');
    if (!g.Connected) gDetail.textContent = g.error || 'Not connected';
    else if (g.HasUsageData) gDetail.innerHTML = `<strong>${g.MessagePercent}%</strong> messages used`;
    else gDetail.textContent = 'Active - no usage data available';

    // ---- Gemini ----
    const m = lastPayload.gemini || {};
    setPlanBadge(document.getElementById('gemini-plan'), m.Connected, m.PlanName);
    const mDetail = document.getElementById('gemini-detail');
    if (!m.Connected) mDetail.textContent = m.error || 'Not connected';
    else if (m.HasUsageData) mDetail.innerHTML = `<strong>${m.DailyPercent}%</strong> daily used`;
    else if (m.PlanName === 'Unknown') mDetail.innerHTML = `Visit <a href="https://gemini.google.com/" target="_blank" rel="noopener">gemini.google.com</a> to detect plan`;
    else mDetail.textContent = 'Active - no usage data available';

    // ---- Claude API (platform.claude.com) ----
    const a = lastPayload.claudeApi || {};
    setPlanBadge(document.getElementById('claude-api-plan'), a.Connected, a.PeriodLabel);
    const aDetail = document.getElementById('claude-api-detail');
    if (!a.Connected) {
        aDetail.innerHTML = `Not logged into <a href="https://platform.claude.com/" target="_blank" rel="noopener">platform.claude.com</a>`;
    } else {
        aDetail.innerHTML = `<strong>$${a.MonthTotal}</strong> this month · Today $${a.TodayTotal}`;
    }

    // ---- ChatGPT API (platform.openai.com) ----
    const o = lastPayload.chatgptApi || {};
    setPlanBadge(document.getElementById('chatgpt-api-plan'), o.Connected, o.PeriodLabel);
    const oDetail = document.getElementById('chatgpt-api-detail');
    if (!o.Connected) {
        oDetail.innerHTML = `Visit <a href="https://platform.openai.com/settings/organization/usage" target="_blank" rel="noopener">platform.openai.com</a> to initialize`;
    } else {
        oDetail.innerHTML = `<strong>$${o.MonthTotal}</strong> this month · Today $${o.TodayTotal}`;
    }

    // ---- Gemini API (aistudio.google.com) ----
    const ga = lastPayload.geminiApi || {};
    setPlanBadge(document.getElementById('gemini-api-plan'), ga.Connected, ga.PeriodLabel);
    const gaDetail = document.getElementById('gemini-api-detail');
    if (!ga.Connected) {
        gaDetail.innerHTML = `Visit <a href="https://aistudio.google.com/spend" target="_blank" rel="noopener">aistudio.google.com/spend</a> to initialize`;
    } else if (ga.HasData) {
        gaDetail.innerHTML = `<strong>$${ga.MonthTotal}</strong> this month · ${ga.ProjectName || 'All Projects'}`;
    } else {
        gaDetail.textContent = `${ga.Tier} - no spend this period`;
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
        projectSelect.value = geminiApiProject;
    }
}

// ---- Logs renderer ----

function formatRelativeTime(ts) {
    const sec = Math.round((Date.now() - ts) / 1000);
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

async function renderLogs() {
    const listEl = document.getElementById('logs-list');
    const { logs = [] } = await chrome.storage.local.get('logs');

    if (logs.length === 0) {
        listEl.innerHTML = '<div class="empty">No logs yet</div>';
        return;
    }

    const html = logs.slice(0, 100).map(entry => {
        const ts = formatRelativeTime(entry.ts);
        return `<div class="log-entry ${entry.level}">
            <span class="ts">${ts}</span>
            <span class="lvl">${entry.level}</span>
            <span class="src">${entry.source}</span>
            <span class="msg">${escapeHtml(entry.msg)}</span>
        </div>`;
    }).join('');
    listEl.innerHTML = html;
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
    await chrome.storage.local.set({ logs: [] });
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
        await chrome.runtime.sendMessage({ action: 'refresh' });
        await new Promise(r => setTimeout(r, 600));
        await renderStatus();
        await renderLogs();
        showToast('Updated', 'success');
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

// Live polling while popup is open
const pollInterval = setInterval(async () => {
    await renderStatus();
    await applyServiceVisibility();
    await renderLogs();
}, 2000);

window.addEventListener('unload', () => clearInterval(pollInterval));
