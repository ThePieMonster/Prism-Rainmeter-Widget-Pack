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
// ==========================================================================

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

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

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

function getAllComboboxes() { return [...document.querySelectorAll('[role="combobox"]')]; }
function getProjectCombobox() { return document.querySelector('ms-project-selector [role="combobox"]') || getAllComboboxes()[0] || null; }
function getTimeRangeCombobox() { return getAllComboboxes()[1] || null; }
function getModelCombobox() { return getAllComboboxes()[2] || null; }

// Close any open Material dropdown by clicking the backdrop overlay.
async function closeDropdown() {
    const backdrop = document.querySelector('.cdk-overlay-backdrop');
    if (backdrop) { backdrop.click(); await wait(300); return; }
    // Fallback: press Escape then click empty area
    document.activeElement?.blur();
    document.querySelector('.cdk-overlay-container')?.click();
    await wait(300);
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
    // The combobox text when closed is just the selected value
    // but when open it includes all options — grab the mat-select-value or first text node
    const valEl = combo.querySelector('.mat-mdc-select-value, .mat-select-value');
    const raw = valEl ? valEl.textContent?.trim() : combo.textContent?.trim()?.split('\n')[0];
    return (raw || '').toUpperCase();
}

// Scrape dollar values visible on the page for the currently selected project.
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
            // Find "Total cost" followed by a dollar value
            const tcMatch = cardText.match(/Total\s+cost[\s\S]*?\$\s*([\d,]+\.\d{2})/i);
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
        cost: totalCost !== null ? totalCost : 0,
        spendCapUsed: spendCapUsed !== null ? spendCapUsed : 0,
        spendCap: spendCap !== null ? spendCap : 0,
        hasCap: spendCap !== null && spendCap > 0
    };
}

// ---------------------------------------------------------------------------
//  Ensure filters are set to "This Month" + "All Models"
// ---------------------------------------------------------------------------

async function selectComboboxOption(combobox, desiredText) {
    // Check current value — use the inner value element if available
    const valEl = combobox.querySelector('.mat-mdc-select-value, .mat-select-value');
    const current = valEl ? valEl.textContent?.trim() : combobox.textContent?.trim()?.split('\n')[0];
    if (current?.toLowerCase() === desiredText.toLowerCase()) return true; // already correct

    await closeDropdown(); // ensure no stale dropdown from a previous call
    combobox.click();
    await wait(600);

    const listbox = document.querySelector('[role="listbox"]');
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

    const modelCombo = getModelCombobox();
    if (modelCombo) {
        const set = await selectComboboxOption(modelCombo, 'All Models');
        if (set) await prismLog('debug', 'gemini_api', 'Model filter confirmed: All Models');
    }

    // Final safety — close any residual dropdown before project iteration begins
    await closeDropdown();
}

// ---------------------------------------------------------------------------
//  Project iteration: scrape all projects
// ---------------------------------------------------------------------------

async function scrapeAllProjects() {
    await closeDropdown(); // ensure clean state before touching project dropdown
    const combo = getProjectCombobox();
    if (!combo) {
        await prismLog('warn', 'gemini_api', 'No project combobox found');
        const cost = scrapeCurrentProjectCost();
        return { projects: [{ name: 'Default', ...cost }], originalIndex: 0 };
    }

    // Read the currently selected project name from the combobox value
    const valEl = combo.querySelector('.mat-mdc-select-value, .mat-select-value');
    const originalName = (valEl ? valEl.textContent?.trim() : combo.textContent?.trim()?.split('\n')[0]) || 'Unknown';

    // Open the dropdown to read all project options
    combo.click();
    await wait(500);

    const listbox = document.querySelector('[role="listbox"]');
    const optionEls = listbox ? [...listbox.querySelectorAll('[role="option"]')] : [];

    if (optionEls.length === 0) {
        await closeDropdown();
        const cost = scrapeCurrentProjectCost();
        return { projects: [{ name: originalName, ...cost }], originalIndex: 0 };
    }

    const projectNames = optionEls.map(el => el.textContent?.trim() || '');
    const originalIndex = projectNames.indexOf(originalName);
    await prismLog('debug', 'gemini_api', `Found ${projectNames.length} projects: ${projectNames.join(', ')}`);

    // Close the dropdown before iterating
    await closeDropdown();

    const projects = [];

    for (let i = 0; i < projectNames.length; i++) {
        const name = projectNames[i];

        // If this is the currently selected project, scrape without switching
        if (name === originalName) {
            const cost = scrapeCurrentProjectCost();
            projects.push({ name, ...cost });
            await prismLog('debug', 'gemini_api', `Project "${name}": $${cost.cost.toFixed(2)}`);
            continue;
        }

        // Switch to a different project via the combobox
        // Open project dropdown with retry — Angular can be slow after multiple switches
        let targetOption = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            await closeDropdown();
            await wait(300);
            combo.click();
            await wait(600 + attempt * 200); // progressively longer waits

            const freshListbox = document.querySelector('[role="listbox"]');
            const freshOptions = freshListbox ? [...freshListbox.querySelectorAll('[role="option"]')] : [];
            targetOption = freshOptions.find(el => el.textContent?.trim() === name);
            if (targetOption) break;

            if (attempt < 3) {
                await prismLog('debug', 'gemini_api', `Option "${name}" not found (attempt ${attempt}/3), retrying...`);
            }
        }

        if (!targetOption) {
            await prismLog('warn', 'gemini_api', `Could not find option for project "${name}" after 3 attempts`);
            await closeDropdown();
            projects.push({ name, cost: 0, spendCapUsed: 0, spendCap: 0, hasCap: false });
            continue;
        }

        targetOption.click();
        await wait(2500); // Wait for page to load new project's data

        const cost = scrapeCurrentProjectCost();
        projects.push({ name, ...cost });
        await prismLog('debug', 'gemini_api', `Project "${name}": $${cost.cost.toFixed(2)}`);
    }

    // Restore original project selection if we ended on a different one
    const lastName = projects[projects.length - 1]?.name;
    if (projects.length > 1 && lastName !== originalName) {
        combo.click();
        await wait(500);
        const restoreListbox = document.querySelector('[role="listbox"]');
        const restoreOptions = restoreListbox ? [...restoreListbox.querySelectorAll('[role="option"]')] : [];
        const restoreOption = restoreOptions.find(el => el.textContent?.trim() === originalName);
        if (restoreOption) {
            restoreOption.click();
            await wait(500);
        } else {
            await closeDropdown();
        }
    }

    return { projects, originalIndex: Math.max(originalIndex, 0) };
}

// ---------------------------------------------------------------------------
//  Main: scrape and report (with mutex to prevent concurrent runs)
// ---------------------------------------------------------------------------

let scrapeInProgress = false;

async function refreshAndReport() {
    // Only scrape on the /spend page
    if (!/\/spend\b/.test(location.pathname)) return;
    // Prevent concurrent runs — our own project switching changes the URL
    // which would trigger the SPA watcher and spawn overlapping scrapes.
    if (scrapeInProgress) return;
    scrapeInProgress = true;

    try {
        // Make sure we're looking at "This Month" + "All Models" before scraping
        await ensureFilters();

        const tier = scrapeTier();
        const periodLabel = scrapePeriodLabel();
        const { projects, originalIndex } = await scrapeAllProjects();

        // Compute "All" aggregate
        const allTotal = projects.reduce((sum, p) => sum + p.cost, 0);
        const allCapUsed = projects.reduce((sum, p) => sum + p.spendCapUsed, 0);
        const allCap = projects.reduce((sum, p) => sum + p.spendCap, 0);

        const summary = {
            Connected: 1,
            Tier: tier,
            PeriodLabel: periodLabel || 'THIS MONTH',
            HasData: projects.some(p => p.cost > 0) ? 1 : 0,
            AllTotal: allTotal.toFixed(2),
            AllCapUsed: allCapUsed.toFixed(2),
            AllCap: allCap.toFixed(2),
            Projects: projects.map(p => ({
                name: p.name,
                cost: p.cost.toFixed(2),
                spendCapUsed: p.spendCapUsed.toFixed(2),
                spendCap: p.spendCap.toFixed(2),
                hasCap: p.hasCap
            })),
            ProjectNames: projects.map(p => p.name),
            OriginalIndex: originalIndex
        };

        await prismLog('info', 'gemini_api', `Scraped ${projects.length} projects: allTotal=$${summary.AllTotal} tier=${tier}`);
        try {
            await chrome.runtime.sendMessage({ type: 'gemini_api_update', summary });
        } catch {}
    } catch (e) {
        await prismLog('error', 'gemini_api', 'Scrape exception: ' + e.message);
    } finally {
        scrapeInProgress = false;
    }
}

// Sentinel log
console.log('[Prism:gemini_api] content script loaded on', location.href);
prismLog('info', 'gemini_api', `Content script loaded on ${location.href}`).catch(() => {});

// Initial scrape after page settles (give extra time for Angular to render)
setTimeout(refreshAndReport, 5000);
// Re-scrape every 5 minutes
setInterval(refreshAndReport, 5 * 60 * 1000);

// Re-scrape when user navigates within the SPA (but NOT when we're mid-scrape,
// since our own project switching changes the ?project= URL param)
let lastPathname = location.pathname;
setInterval(() => {
    // Only watch the pathname, not the search params (which change during iteration)
    if (location.pathname !== lastPathname) {
        lastPathname = location.pathname;
        setTimeout(refreshAndReport, 3000);
    }
}, 2000);
