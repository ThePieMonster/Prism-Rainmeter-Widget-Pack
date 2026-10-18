// ==========================================================================
//  Prism Google AI Studio Content Script
//
//  Runs on aistudio.google.com/spend. Scrapes dollar-cost data from the
//  Gemini API Spend page, iterating through ALL projects in the dropdown
//  so the service worker can offer "All Projects" aggregation or per-project
//  views. Sends per-project cost data to the service worker.
//
//  The spend page shows:
//    - Tier badge ("Free tier" / "Paid tier 1" etc.)
//    - Project selector (no "All" option)
//    - Monthly spend cap: "$X.XX / $Y.YY"
//    - Period selector: "This Month" etc.
//    - Total cost breakdown: Cost $X.XX - Savings $X.XX = Total cost $X.XX
//
//  The scrape drives the page's own dropdowns, so it puts the user's project,
//  time range and model filter back afterwards (unless the user picked another
//  one meanwhile), and the 5-minute refresh waits while the user has the tab
//  in front of them.
// ==========================================================================

// Minimal logger (content scripts can't importScripts(), so we inline).
// Never throws: in an orphaned copy of this script (see extensionAlive)
// chrome.storage throws synchronously, and a throwing logger would abort a
// scrape before it puts the user's project and filters back.
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

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// False once the extension was updated, reloaded or removed while this tab
// stayed open. Chrome does not re-inject content scripts into open tabs, so
// the old copy keeps its timers but can no longer reach the service worker.
function extensionAlive() {
    try { return !!chrome.runtime?.id; } catch { return false; }
}

// Gemini API under Settings > Data collection in the popup (on unless set to
// false). Off, or unreadable, keeps this script idle: it does not touch the
// page, read anything from it or send anything to the service worker.
function collectingFrom(setting) {
    return !setting || setting.geminiApi !== false;
}

async function collectionEnabled() {
    try {
        return collectingFrom((await chrome.storage.sync.get('serviceEnabled')).serviceEnabled);
    } catch {
        return false;
    }
}

// The last known state, for checks that cannot wait for a storage read (a
// scrape deciding whether to switch to the next project). Kept current by
// the storage listener at the bottom.
let collecting = false;

function onSpendPage() { return /\/spend\b/.test(location.pathname); }

// True while the user has this tab in front of them (visible, and its window
// focused). Periodic re-scrapes wait until it is not, and stop switching
// projects as soon as it is.
function pageInUse() {
    return document.visibilityState === 'visible' && document.hasFocus();
}

// ---------------------------------------------------------------------------
//  DOM Helpers
// ---------------------------------------------------------------------------

// Parse a dollar string like "$0.02" or "$10.00" into a number, or null.
function parseDollar(text) {
    if (!text) return null;
    const m = String(text).match(/\$\s*([\d,]+(?:\.\d+)?)/);
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, ''));
    return isFinite(n) ? n : null;
}

// The spend page has exactly 3 comboboxes in fixed order:
//   [0] = Project selector  (inside <ms-project-selector>)
//   [1] = Time range         ("28 Days", "This Month", etc.)
//   [2] = Model filter       ("All Models", specific model names)
// We use positional access rather than text matching because the combobox
// textContent includes ALL option texts when expanded (unreliable).
// Off /spend there are none: the comboboxes on the page the user went to
// (a prompt's model picker, say) are theirs, so a scrape that is still
// running when they leave finds nothing to open.

function getAllComboboxes() { return onSpendPage() ? [...document.querySelectorAll('[role="combobox"]')] : []; }
function getProjectCombobox() {
    if (!onSpendPage()) return null;
    return document.querySelector('ms-project-selector [role="combobox"]') || getAllComboboxes()[0] || null;
}
function getTimeRangeCombobox() { return getAllComboboxes()[1] || null; }
function getModelCombobox() { return getAllComboboxes()[2] || null; }

// The selected value a combobox shows. When open its textContent includes
// all options, so prefer the mat-select-value element or the first line.
function comboValue(combobox) {
    const valEl = combobox.querySelector('.mat-mdc-select-value, .mat-select-value');
    return (valEl ? valEl.textContent?.trim() : combobox.textContent?.trim()?.split('\n')[0]) || '';
}

// The option panel of an open combobox: the listbox its aria-controls names
// (Material sets it while the panel is open), else the first one on the page.
// None off /spend, where an open listbox belongs to the user.
function getListbox(combobox) {
    if (!onSpendPage()) return null;
    const id = combobox?.getAttribute('aria-controls');
    const own = id ? document.getElementById(id) : null;
    const panel = own && (own.matches('[role="listbox"]') ? own : own.querySelector('[role="listbox"]'));
    if (panel && panel.querySelector('[role="option"]')) return panel;
    return document.querySelector('[role="listbox"]');
}

// Set while a dropdown the script opened may still be showing. closeDropdown()
// only ever closes that one, so a menu or dialog the user has open, and the
// user's keyboard focus, are left alone.
let ownDropdownOpen = false;
let ownCombobox = null;

function openDropdown(combobox) {
    ownDropdownOpen = true;
    ownCombobox = combobox;
    combobox.click();
}

// Close the Material dropdown the script opened by clicking its backdrop overlay.
async function closeDropdown() {
    if (!ownDropdownOpen) return;
    ownDropdownOpen = false;
    // Material sets aria-expanded on the combobox. "false" means selecting an
    // option already closed our panel, so any open overlay is the user's.
    // Only when it is not exposed, fall back to looking for an open listbox,
    // and only on /spend: once the user has left it (Angular tears our panel
    // down with the page), an open listbox is theirs.
    const expanded = ownCombobox && ownCombobox.isConnected ? ownCombobox.getAttribute('aria-expanded') : null;
    if (expanded === 'false') return;
    if (expanded !== 'true' && (!onSpendPage() || !document.querySelector('[role="listbox"]'))) return;
    // The newest overlay is on top, so the last backdrop belongs to our panel
    const backdrops = document.querySelectorAll('.cdk-overlay-backdrop');
    const backdrop = backdrops[backdrops.length - 1];
    if (backdrop) { backdrop.click(); await wait(300); }
}

// Read the tier badge text (e.g. "Paid tier 1", "Free tier").
function scrapeTier() {
    const el = [...document.querySelectorAll('*')].find(el => {
        const t = el.textContent?.trim();
        return /^(Free|Paid) tier/i.test(t) && el.children.length === 0;
    });
    return el ? el.textContent.trim() : 'Unknown';
}

// Read the time-range combobox value (e.g. "This Month", "28 Days").
function scrapePeriodLabel() {
    const combo = getTimeRangeCombobox();
    if (!combo) return '';
    return comboValue(combo).toUpperCase();
}

// Scrape dollar values visible on the page for the currently selected project.
// ok is false (and every amount null) when no total cost could be found, so a
// changed or not yet loaded page is not mistaken for $0.00 of spend.
function scrapeCurrentProjectCost() {
    let totalCost = null;
    let spendCapUsed = null;
    let spendCap = null;

    // --- Total cost ---
    // Look for the "Your total cost" heading, then find dollar values nearby.
    // Alternatively, look for "Total cost" label near a dollar value.
    const allElements = [...document.querySelectorAll('*')];

    // Strategy 1: Find "Your total cost" heading
    const totalCostHeading = allElements.find(el =>
        /your total cost/i.test(el.textContent?.trim() || '') &&
        el.children.length <= 3 &&
        el.textContent.length < 100
    );
    if (totalCostHeading) {
        // Look in the parent card for dollar values labeled "Total cost"
        const card = totalCostHeading.closest('[class]')?.parentElement || totalCostHeading.parentElement;
        if (card) {
            const cardText = card.innerText || '';
            // Find "Total cost" followed by a dollar value. Drop the heading
            // first: the case-insensitive match would otherwise start inside
            // "Your total cost" and take the first amount after it, which is
            // the pre-savings Cost. Without a separate label, fall back to the
            // first amount after the heading.
            const tcRegex = /Total\s+cost[\s\S]*?\$\s*([\d,]+\.\d{2})/i;
            const tcMatch = cardText.replace(/your\s+total\s+cost/gi, '').match(tcRegex) || cardText.match(tcRegex);
            if (tcMatch) totalCost = parseFloat(tcMatch[1].replace(/,/g, ''));
        }
    }

    // Strategy 2 (fallback): Find any element with exact text "Total cost" and look for
    // a nearby dollar value
    if (totalCost === null) {
        const tcLabel = allElements.find(el =>
            el.textContent?.trim() === 'Total cost' && el.children.length === 0
        );
        if (tcLabel) {
            // Check siblings and nearby elements for a dollar value
            const parent = tcLabel.parentElement;
            if (parent) {
                const dollarEls = [...parent.querySelectorAll('*')].filter(el =>
                    el.children.length === 0 && /^\$[\d,.]+$/.test(el.textContent?.trim() || '')
                );
                if (dollarEls.length > 0) {
                    totalCost = parseDollar(dollarEls[dollarEls.length - 1].textContent);
                }
            }
        }
    }

    if (totalCost === null) return { ok: false, cost: null, spendCapUsed: null, spendCap: null, hasCap: false };

    // --- Spend cap ---
    // Look for "Monthly spend cap" section with "$X.XX / $Y.YY" pattern
    const capSection = allElements.find(el =>
        /monthly spend cap/i.test(el.textContent?.trim() || '') &&
        el.children.length <= 3 &&
        el.textContent.length < 60
    );
    if (capSection) {
        const capParent = capSection.closest('[class]')?.parentElement || capSection.parentElement;
        if (capParent) {
            const capText = capParent.innerText || '';
            // Match pattern like "$0.01 / $10.00"
            const capMatch = capText.match(/\$\s*([\d,]+\.\d{2})\s*\/\s*\$\s*([\d,]+\.\d{2})/);
            if (capMatch) {
                spendCapUsed = parseFloat(capMatch[1].replace(/,/g, ''));
                spendCap = parseFloat(capMatch[2].replace(/,/g, ''));
            }
        }
    }

    return {
        ok: true,
        cost: totalCost,
        spendCapUsed: spendCapUsed !== null ? spendCapUsed : 0,
        spendCap: spendCap !== null ? spendCap : 0,
        hasCap: spendCap !== null && spendCap > 0
    };
}

// A project whose numbers could not be read: its option was not found, its
// cost card was not found, or the scrape stopped before reaching it. The
// service worker keeps that project's last good values instead of $0.00.
function failedProject(name) {
    return { name, ok: false, cost: null, spendCapUsed: null, spendCap: null, hasCap: false };
}

// ---------------------------------------------------------------------------
//  Ensure filters are set to "This Month" + "All Models"
// ---------------------------------------------------------------------------

async function selectComboboxOption(combobox, desiredText) {
    if (!onSpendPage()) return false; // the user left: leave their page alone
    // Check current value (the inner value element if available)
    const current = comboValue(combobox);
    if (current.toLowerCase() === desiredText.toLowerCase()) return true; // already correct

    await closeDropdown(); // ensure no stale dropdown of ours from a previous call
    openDropdown(combobox);
    await wait(600);

    const listbox = getListbox(combobox);
    if (!listbox) { await closeDropdown(); return false; }

    const option = [...listbox.querySelectorAll('[role="option"]')].find(el =>
        el.textContent?.trim().toLowerCase() === desiredText.toLowerCase()
    );
    if (!option) {
        await closeDropdown();
        await prismLog('warn', 'gemini_api', `Could not find "${desiredText}" in dropdown (current: "${current}")`);
        return false;
    }

    option.click();
    await wait(2000); // wait for page to reload data with new filter
    await closeDropdown(); // ensure dropdown is dismissed after selection
    return true;
}

async function ensureFilters() {
    const timeCombo = getTimeRangeCombobox();
    if (timeCombo) {
        const set = await selectComboboxOption(timeCombo, 'This Month');
        if (set) await prismLog('debug', 'gemini_api', 'Time range confirmed: This Month');
    }

    // Turned off meanwhile: leave the rest of the page alone
    const modelCombo = collecting ? getModelCombobox() : null;
    if (modelCombo) {
        const set = await selectComboboxOption(modelCombo, 'All Models');
        if (set) await prismLog('debug', 'gemini_api', 'Model filter confirmed: All Models');
    }

    // Final safety: close any residual dropdown of ours before project iteration begins
    await closeDropdown();
}

// The user's time range and model filter, read before ensureFilters() so
// restoreFilters() can put them back once every project has been scraped.
// forced is the value ensureFilters() selects in that combobox.
function readFilters() {
    return [[getTimeRangeCombobox, 'This Month'], [getModelCombobox, 'All Models']]
        .map(([get, forced]) => ({ get, forced, el: get() }))
        .filter(f => f.el)
        .map(f => ({ ...f, value: comboValue(f.el) }));
}

async function restoreFilters(saved) {
    for (const { get, forced, el: savedEl, value } of saved || []) {
        // Skip when the user navigated away from /spend; use the combobox now
        // in the same position if Angular re-rendered the saved one
        if (!value || !onSpendPage()) continue;
        const el = savedEl.isConnected ? savedEl : get();
        if (!el) continue;
        // Leave it when it already shows the saved value, or no longer shows
        // the value ensureFilters() set (the user changed it during the scrape)
        const now = comboValue(el).toLowerCase();
        if (now === value.toLowerCase() || now !== forced.toLowerCase()) continue;
        if (await selectComboboxOption(el, value)) {
            await prismLog('debug', 'gemini_api', `Filter restored: ${value}`);
        }
    }
}

// ---------------------------------------------------------------------------
//  Project iteration: scrape all projects
// ---------------------------------------------------------------------------

// Open the project dropdown and click the option named `name`, with retries
// because Angular can be slow after multiple switches. Returns true once the
// option was clicked, and false at once when the user has left /spend or
// userChanged() says they picked a project themselves meanwhile.
async function switchProject(combo, name, userChanged = () => false) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        await closeDropdown();
        await wait(300);
        if (!onSpendPage() || userChanged()) break;
        // Angular may have re-rendered the selector since it was looked up.
        // A detached one is never opened: that click would go nowhere.
        const box = combo.isConnected ? combo : getProjectCombobox();
        if (box) {
            openDropdown(box);
            await wait(600 + attempt * 200); // progressively longer waits

            // No listbox once the user has left during the wait
            const listbox = getListbox(box);
            const options = listbox ? [...listbox.querySelectorAll('[role="option"]')] : [];
            const target = options.find(el => el.textContent?.trim() === name);
            if (target) {
                target.click();
                return true;
            }
        }

        if (attempt < 3 && onSpendPage()) {
            await prismLog('debug', 'gemini_api', `Option "${name}" not found (attempt ${attempt}/3), retrying...`);
        }
    }
    await closeDropdown();
    return false;
}

// The current project's numbers, or a failed entry once the user has left
// /spend (another page's text is never read as spend)
function readProject(name) {
    return onSpendPage() ? { name, ...scrapeCurrentProjectCost() } : failedProject(name);
}

// shouldStop() is checked before each project switch. Once it returns true,
// the projects not yet scraped are reported as failed (not scraped).
async function scrapeAllProjects(shouldStop = () => false) {
    await closeDropdown(); // ensure clean state before touching project dropdown
    const combo = getProjectCombobox();
    if (!combo) {
        await prismLog('warn', 'gemini_api', 'No project combobox found');
        return { projects: [readProject('Default')], originalIndex: 0 };
    }

    // Read the currently selected project name from the combobox value
    const originalName = comboValue(combo) || 'Unknown';

    // Open the dropdown to read all project options
    openDropdown(combo);
    await wait(500);

    const listbox = getListbox(combo);
    const optionEls = listbox ? [...listbox.querySelectorAll('[role="option"]')] : [];

    if (optionEls.length === 0) {
        await closeDropdown();
        return { projects: [readProject(originalName)], originalIndex: 0 };
    }

    const projectNames = optionEls.map(el => el.textContent?.trim() || '');
    const originalIndex = projectNames.indexOf(originalName);
    await prismLog('debug', 'gemini_api', `Found ${projectNames.length} projects: ${projectNames.join(', ')}`);

    // Close the dropdown before iterating
    await closeDropdown();

    const projects = [];
    // The project the page shows right now. Only that one can be read without
    // switching: once the loop has switched away from the original project,
    // the original is no longer on screen when its turn comes. null once the
    // user picked a project, which is not read: its data may still be loading.
    let currentName = originalName;
    let stopped = false;
    let userPicked = false;
    // The selector shows the same text as its options when the original
    // project was found among them. Only then can each read be checked
    // against the project the page shows; otherwise the switch is trusted.
    const canVerify = originalIndex >= 0;
    // True when the selector shows a listed project other than `expected`
    const showsOther = expected => {
        const live = getProjectCombobox();
        const shown = live ? comboValue(live) : '';
        return projectNames.includes(shown) && shown !== expected;
    };
    // Checked before each switch opens the dropdown, so a project the user
    // picks between two reads is not overwritten by the script's next click
    const userChanged = () => canVerify && currentName !== null && showsOther(currentName);
    const stopForUser = async i => {
        userPicked = stopped = true;
        currentName = null;
        await prismLog('info', 'gemini_api', `Project changed on the page during the scrape; stopped switching after ${i} of ${projectNames.length}`);
    };

    try {
        for (let i = 0; i < projectNames.length; i++) {
            const name = projectNames[i];
            const before = currentName; // what the page showed before this turn

            if (name !== currentName) {
                if (!stopped && shouldStop()) {
                    stopped = true;
                    await prismLog('info', 'gemini_api', `Stopped switching projects after ${i} of ${projectNames.length} (tab in use, page left, turned off or extension updated)`);
                }
                if (stopped) {
                    projects.push(failedProject(name));
                    continue;
                }

                if (!(await switchProject(combo, name, () => userChanged() || !collecting))) {
                    projects.push(failedProject(name));
                    if (userChanged()) {
                        // The user picked a project before the click: keep it
                        await stopForUser(i);
                        continue;
                    }
                    // Off /spend or turned off, the switch was given up, not the
                    // option missed; the next turn's shouldStop() logs the stop
                    if (onSpendPage() && collecting) {
                        await prismLog('warn', 'gemini_api', `Could not find option for project ${i + 1} of ${projectNames.length} after 3 attempts`);
                    }
                    continue;
                }
                currentName = name;
                await wait(2500); // Wait for page to load new project's data
                await closeDropdown();
            }

            // Turned off since the scrape started: the page is not read any more
            if (!collecting) {
                projects.push(failedProject(name));
                continue;
            }

            // Read only when the page shows this project, so another project's
            // spend is never stored under this name
            if (canVerify && onSpendPage()) {
                const live = getProjectCombobox();
                const shown = live ? comboValue(live) : '';
                if (shown !== name) {
                    projects.push(failedProject(name));
                    if (projectNames.includes(shown) && shown !== before) {
                        // The user picked it: stop switching and leave it selected
                        await stopForUser(i);
                    } else {
                        // The page dropped the option click and still shows the
                        // previous project, or shows none from the list
                        if (projectNames.includes(shown)) currentName = shown;
                        await prismLog('debug', 'gemini_api', `Project "${name}": the page shows another project; not read`);
                        // The user may have re-picked the shown project instead,
                        // so its data can still be loading: let it settle before
                        // its own turn reads it without switching
                        if (projectNames.indexOf(shown) > i) await wait(2500);
                    }
                    continue;
                }
            }

            const cost = readProject(name);
            projects.push(cost);
            await prismLog('debug', 'gemini_api', cost.ok
                ? `Project "${name}": $${cost.cost.toFixed(2)}`
                : onSpendPage() ? `Project "${name}": total cost not found` : `Project "${name}": not read (spend page left)`);
        }
    } finally {
        // Restore the original project selection if the page shows another
        // one (currentName, not the last list entry, so this also runs when
        // the original project is last in the dropdown)
        if (currentName !== originalName && onSpendPage()) {
            const live = getProjectCombobox();
            const shown = live ? comboValue(live) : currentName;
            if (originalIndex < 0) {
                await prismLog('debug', 'gemini_api', 'Original project is not in the dropdown list; not switching back');
            } else if (userPicked || (shown !== currentName && projectNames.includes(shown))) {
                // The page shows another project than the script last picked:
                // the user chose it during the scrape, so leave it
                await prismLog('debug', 'gemini_api', 'Project was changed during the scrape; not switching back');
            } else if (await switchProject(combo, originalName, () => showsOther(currentName))) {
                await wait(1000);
                await closeDropdown();
            } else if (showsOther(currentName)) {
                // The user picked a project while the switch back was starting
                await prismLog('debug', 'gemini_api', 'Project was changed during the scrape; not switching back');
            } else {
                await prismLog('warn', 'gemini_api', 'Could not switch back to the originally selected project');
            }
        }
    }

    return { projects, originalIndex: Math.max(originalIndex, 0) };
}

// ---------------------------------------------------------------------------
//  Main: scrape and report (with mutex to prevent concurrent runs)
// ---------------------------------------------------------------------------

let scrapeInProgress = false;

// background is true for the 5-minute refresh: it waits while the tab is in
// use and stops switching projects when the user comes back to it. A scrape
// started by opening /spend always runs, so first-time setup gets its data.
async function refreshAndReport(background = false) {
    if (!extensionAlive()) { stopTimers(); return; }
    // Turned off: leave the page alone. Checked before the in-progress flag
    // below, which is tested and set with no await in between.
    if (!collecting || !(await collectionEnabled())) return;
    // Only scrape on the /spend page
    if (!onSpendPage()) return;
    // Prevent concurrent runs: our own project switching changes the URL,
    // which would trigger the SPA watcher and spawn overlapping scrapes.
    if (scrapeInProgress) return;
    if (background && pageInUse()) {
        await prismLog('debug', 'gemini_api', 'Periodic scrape skipped: tab is in use');
        return;
    }
    scrapeInProgress = true;

    const shouldStop = () => !extensionAlive() || !collecting || !onSpendPage() || (background && pageInUse());
    let savedFilters = [];

    try {
        savedFilters = readFilters();
        // Make sure we're looking at "This Month" + "All Models" before scraping
        await ensureFilters();
        // The user may have left /spend meanwhile; nothing is read or opened
        // on the page they went to
        if (!onSpendPage()) {
            await prismLog('debug', 'gemini_api', 'Spend page left before the projects were read; scrape stopped');
            return;
        }
        if (!collecting) {
            await prismLog('debug', 'gemini_api', 'Turned off in Settings before the projects were read; scrape stopped');
            return;
        }

        const tier = scrapeTier();
        const periodLabel = scrapePeriodLabel();
        const { projects, originalIndex } = await scrapeAllProjects(shouldStop);

        // Compute "All" aggregate from the projects that could be read
        const okProjects = projects.filter(p => p.ok);
        if (okProjects.length === 0) {
            // Leaving /spend before any project was read is not a scrape failure
            if (onSpendPage()) {
                await prismLog('warn', 'gemini_api', `Could not read spend for any of ${projects.length} project(s); keeping the last good data`);
            } else {
                await prismLog('debug', 'gemini_api', 'Spend page left before any project was read; keeping the last good data');
            }
            return;
        }
        const allTotal = okProjects.reduce((sum, p) => sum + p.cost, 0);
        const allCapUsed = okProjects.reduce((sum, p) => sum + p.spendCapUsed, 0);
        const allCap = okProjects.reduce((sum, p) => sum + p.spendCap, 0);
        const money = v => (v === null ? null : v.toFixed(2));

        const summary = {
            Connected: 1,
            Tier: tier,
            PeriodLabel: periodLabel || 'THIS MONTH',
            HasData: okProjects.some(p => p.cost > 0) ? 1 : 0,
            AllTotal: allTotal.toFixed(2),
            AllCapUsed: allCapUsed.toFixed(2),
            AllCap: allCap.toFixed(2),
            // Projects with ok: false carry null amounts; the service worker
            // fills them in from its last good copy
            FailedCount: projects.length - okProjects.length,
            Projects: projects.map(p => ({
                name: p.name,
                ok: p.ok,
                cost: money(p.cost),
                spendCapUsed: money(p.spendCapUsed),
                spendCap: money(p.spendCap),
                hasCap: p.hasCap
            })),
            ProjectNames: projects.map(p => p.name),
            OriginalIndex: originalIndex
        };

        if (!extensionAlive()) return; // orphaned mid-scrape: no service worker to send to
        // Turned off mid-scrape: what was read is dropped, not sent
        if (!collecting || !(await collectionEnabled())) {
            await prismLog('debug', 'gemini_api', 'Turned off in Settings during the scrape; spend not sent');
            return;
        }
        await prismLog('info', 'gemini_api', `Scraped ${projects.length} projects (${summary.FailedCount} failed): allTotal=$${summary.AllTotal} tier=${tier}`);
        try {
            await chrome.runtime.sendMessage({ type: 'gemini_api_update', summary });
        } catch {}
    } catch (e) {
        await prismLog('error', 'gemini_api', 'Scrape exception: ' + e.message);
    } finally {
        // Put the user's time range and model filter back, after the project
        // restore and only once every project has been read
        try { await restoreFilters(savedFilters); } catch {}
        await closeDropdown();
        scrapeInProgress = false;
    }
}

// Sentinel log. No URL: AI Studio paths and query strings carry project and
// Drive file IDs, and exported logs get attached to bug reports.
console.log('[Prism:gemini_api] content script loaded');
prismLog('debug', 'gemini_api', `Content script loaded (spend page: ${onSpendPage() ? 'yes' : 'no'})`);

// Interval handles, so an orphaned or turned-off copy can stop itself
const timers = [];
let lastPathname = location.pathname;

function stopTimers() {
    for (const t of timers) clearInterval(t);
    timers.length = 0;
}

function startTimers() {
    if (timers.length) return;
    // Re-scrape every 5 minutes
    timers.push(setInterval(() => refreshAndReport(true), 5 * 60 * 1000));

    // Re-scrape when user navigates within the SPA (but NOT when we're mid-scrape,
    // since our own project switching changes the ?project= URL param)
    lastPathname = location.pathname;
    timers.push(setInterval(() => {
        if (!extensionAlive()) { stopTimers(); return; }
        // Only watch the pathname, not the search params (which change during iteration)
        if (location.pathname !== lastPathname) {
            lastPathname = location.pathname;
            setTimeout(() => refreshAndReport(), 3000);
        }
    }, 2000));
}

collectionEnabled().then(on => {
    collecting = on;
    if (!on) {
        prismLog('debug', 'gemini_api', 'Gemini API is turned off in Settings; content script idle');
        return;
    }
    startTimers();
    // Initial scrape after page settles (give extra time for Angular to render)
    setTimeout(() => refreshAndReport(), 5000);
});

// Turned on or off in the popup while this tab stays open. Turning it on
// scrapes like the 5-minute refresh does (it waits while the tab is in use);
// turning it off stops a scrape in progress before its next project switch.
try {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync' || !changes.serviceEnabled) return;
        if (!extensionAlive()) { stopTimers(); return; }
        const on = collectingFrom(changes.serviceEnabled.newValue);
        if (on === collecting) return;
        collecting = on;
        if (on) {
            startTimers();
            setTimeout(() => refreshAndReport(true), 3000);
        } else {
            stopTimers();
        }
    });
} catch {}
