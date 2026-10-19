<div align="center">

<img src="Extension/icon128.png" alt="Prism logo" width="96" height="96">

# Prism

**A Rainmeter widget pack for tracking AI service usage on your desktop**

*Live consumer-plan usage and API spend for Claude, ChatGPT, and Gemini - read straight from your authenticated browser session, with no API keys to manage.*

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-0078D4.svg)](#requirements)
[![Rainmeter 4.5+](https://img.shields.io/badge/Rainmeter-4.5%2B-orange.svg)](https://www.rainmeter.net/)
[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Install-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/prism-rainmeter/nmlnncddmhjfiahelimfgajdidcobajc)
[![Version 1.3.0](https://img.shields.io/badge/Version-1.3.0-green.svg)](#)

</div>

---

## Contents

- [Overview](#overview)
- [Widgets](#widgets)
  - [Clock](#clock)
  - [Consumer Plan Usage](#consumer-plan-usage)
  - [API Platform Usage](#api-platform-usage)
- [Visual Styles](#visual-styles)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [How It Works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Privacy](#privacy)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

Prism puts seven small Rainmeter widgets on your desktop:

| Category | Widgets |
|----------|---------|
| **Clock** | Digital clock with day, date, AM/PM |
| **Consumer plans** | Claude, ChatGPT, Gemini |
| **API platforms** | Claude API spend, ChatGPT API spend, Gemini API spend |

Every widget shares the same style/theme system - switch all of them between four visual styles and dark/light themes from any widget's right-click menu.

The AI usage data is pulled by a small Chrome/Edge extension that talks to the services' own internal endpoints using your existing browser session. There is **no API key configuration**, no cookie pasting, and no third-party server in the loop - the extension talks to a Native Messaging host that writes the `.inc` data file Rainmeter reads.

---

## Widgets

### Clock

`Clock/Clock.ini` - large time, AM/PM, day-of-week, and abbreviated date. Resizes itself to fit each style's frame.

### Consumer Plan Usage

Horizontal-bar widgets that display your **paid consumer plan** usage in real time:

| Widget | Service | Bars |
|--------|---------|------|
| `Claude/Claude.ini` | Claude (Pro / Max) | 5-hour session limit + 7-day weekly limit |
| `ChatGPT/ChatGPT.ini` | ChatGPT (Plus / Pro) | 5-hour session limit + weekly limit (Codex usage, shown as % used) |
| `Gemini/Gemini.ini` | Gemini (Pro / Ultra) | 5-hour usage limit + weekly limit |

Each widget falls back gracefully if the service exposes only plan status (no usage numbers) - you'll see the plan name without a progress bar.

When no new data has arrived for 10 minutes (browser closed, extension turned off, PC asleep), a widget doesn't pass its last reading off as live: the bars dim and a small "updated 25m ago" note appears under them (a plan-only widget shows "Last updated 25m ago" instead). The percentages and reset times are then from that last update. The widget goes back to normal within a minute or two of the next update.

### API Platform Usage

Tracks **developer-platform** spend, separate from consumer plans:

| Widget | Source | Metric |
|--------|--------|--------|
| `ClaudeApi/ClaudeApi.ini` | `platform.claude.com` | Month-to-date USD + today + yesterday |
| `ChatGPTApi/ChatGPTApi.ini` | `platform.openai.com` | Month-to-date USD + today + yesterday |
| `GeminiApi/GeminiApi.ini` | `aistudio.google.com/spend` | Month-to-date USD + monthly spend cap (when set) + project |

Claude API spend is fetched every minute. ChatGPT API and Gemini API spend are read through the sites themselves, so they refresh (about every 5 minutes) only while you have `platform.openai.com` or `aistudio.google.com/spend` open in a tab; in between, the widgets keep the last reading. To read every Gemini API project, the AI Studio script switches the spend page's project selector itself, then puts your project and filters back, and it waits while you're using that tab. Pick one project or **All Projects** for the widget in the extension popup's **Settings**.

"Today" and "Yesterday" are UTC days. When an API widget shows a reading that isn't live, it adds a small note next to "Month to date". It says "cached" when:

- **Claude API** - after a network or server error it shows its last reading (up to 24 hours old) and labels its rows "Last sync day" / "Day before".
- **ChatGPT API** - its reading was taken on an earlier UTC day (the site hasn't been open since); its rows then read "Last sync day" / "Day before".
- **Gemini API** - the last scrape couldn't read every project.

Once the reading is more than an hour old, the note says how old instead, e.g. "updated 3h ago": no update has arrived (browser closed, PC asleep), or, for ChatGPT API and Gemini API, the site hasn't been open in a tab. Keep `platform.openai.com` or `aistudio.google.com/spend` open in a (pinned) tab to keep those readings current. If no update arrives before the UTC day ends, the Claude API and ChatGPT API rows also switch to "Last sync day" / "Day before".

The stale thresholds (10 minutes for the consumer widgets, an hour for the API widgets) are the `iStaleAfter` value, in seconds, near the top of each widget's `.ini`.

---

## Visual Styles

All widgets share four visual styles, each available in dark and light themes:

| Style | Look |
|-------|------|
| **Minimal** | No background, floating text with subtle shadow |
| **Glassmorphism** | Translucent glass panel, thin light border, rounded corners |
| **Cyberpunk** | Dark surface, neon cyan/magenta text, monospace |
| **Material Design** | Elevated card, drop shadow, bold Roboto |

Right-click any widget → pick a style or theme → **all widgets refresh together**. The selection lives in `@Resources/Settings.inc` (see [Upgrading](#upgrading) for how it carries over to a new release).

---

## Requirements

- **Windows 10 / 11**
- **[Rainmeter](https://www.rainmeter.net/) 4.5 or newer**
- **Google Chrome, Microsoft Edge, or Brave** (for the usage extension)
- One or more of: a logged-in `claude.ai` / `chatgpt.com` / `gemini.google.com` session, and/or a logged-in `platform.claude.com` / `platform.openai.com` / `aistudio.google.com` session
- Optional fonts (used by some styles):
  - **Segoe UI Light** - ships with Windows
  - **[JetBrains Mono](https://www.jetbrains.com/lp/mono/)** - Cyberpunk style
  - **[Roboto](https://fonts.google.com/specimen/Roboto)** - Material style

---

## Installation

### Prerequisites

- **[Rainmeter](https://www.rainmeter.net/) 4.5+** must already be installed.
- **Google Chrome, Edge, or Brave** signed in to whichever AI services you want to track.
- **[Python 3.10+](https://www.python.org/downloads/)** is optional, only used by the bridge fallback (see [How It Works](#how-it-works)). Setup finds python.org installs (per-user or for all users, through their registry entries or default install folders) and any `pythonw.exe` on `PATH`, which covers the Microsoft Store and Python install manager versions. If it finds none, it says so and skips the bridge.

### Quick install (most users)

1. **Install the Chrome extension** from the Web Store:

   [![Install on Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Install%20Now-4285F4?logo=googlechrome&logoColor=white&style=for-the-badge)](https://chromewebstore.google.com/detail/prism-rainmeter/nmlnncddmhjfiahelimfgajdidcobajc)

2. **Download the latest release** (or clone this repo) and **double-click `Setup\Setup.bat`**. Run it from your own account, not as administrator: everything it sets up is per user.

`Setup.bat` runs `Install.ps1`, which:
- Writes the Native Messaging host manifest and registers it with Chrome, Edge, and Brave
- Links (or copies) the `Prism\` skins folder into Rainmeter's Skins folder (the `SkinPath` in Rainmeter's settings, normally `Documents\Rainmeter\Skins\`). If Rainmeter is installed but has never run, Setup starts it once first so it can create that folder and install its default skins (or asks you to, when it can't)
- Starts Rainmeter if it isn't running, refreshes it (`!RefreshApp`), then loads every Prism widget (`!ActivateConfig`). Widgets you unloaded yourself stay unloaded
- Stops any bridge poller that is already running (from any Prism folder), then sets up this folder's poller (Chrome workaround) as an at-logon scheduled task and starts it

After that the widgets appear on your desktop and start updating within ~60 seconds. Right-click any widget to reposition, change style/theme, or unload widgets you don't want.

### Developer install (working from a clone)

Use this if you're modifying the extension or skins:

1. Clone the repo to wherever you keep code (e.g. `C:\GIT\Prism-Rainmeter-Widget-Pack`).
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and pick the `Extension\` folder.
3. **Double-click `Setup\Setup.bat`**.

`Install.ps1` reads the `key` field in `manifest.json`, derives the sideload extension ID, and adds it to `allowed_origins` alongside the Web Store ID, so the Web Store build and the sideload build can both talk to the same native host. Those are the only two IDs it allows; it never adds an installed extension because of its name. It also creates a directory junction from `Prism` in Rainmeter's Skins folder (normally `Documents\Rainmeter\Skins\Prism`) back to the repo's `Prism\` folder, so any edits you make in the repo show up live.

### Upgrading

1. **Extract the new release into a new folder**, and keep the old folder until step 2 is done: Setup copies your style/theme from it. (Extracting over the old folder works too, but it replaces `Prism\@Resources\Settings.inc`, so your style/theme goes back to Glassmorphism Dark. Pick it again from any widget's right-click menu.)
2. **Double-click the new folder's `Setup\Setup.bat`.** It points Rainmeter's `Prism` link at the new folder, carries your style/theme over from the old one, stops the old bridge poller and starts the new one.
3. **Delete the old folder** once you're happy with the new release. **Don't run the old folder's `Remove.bat`**: in releases before v1.3 it also removes the new install. (Running it *before* the new `Setup.bat` is harmless.) From v1.3 on, `Remove.bat` in a folder that is no longer the active install only cleans up that folder's own leftovers and tells you which folder is active.

The extension updates itself from the Chrome Web Store, separately from the widget pack. Right after an upgrade into a new folder the widgets may say "Not connected" until the browser is open and the extension sends fresh data, which takes up to a minute.

### Uninstall

Double-click `Setup\Remove.bat` in the folder you last ran `Setup.bat` from. It stops and unregisters the bridge-poller scheduled task, removes the native-host registry entries, deletes the pack's logs (see [Privacy](#privacy)), resets `ConsumerData.inc` to a disconnected stub (so the widgets show "Not connected" instead of stale numbers), and triggers `!RefreshApp` so the change is visible immediately. It only removes the install that belongs to its own folder: if `Setup.bat` was last run from another Prism folder, that install is left in place and `Remove.bat` tells you where it is.

Then remove the extension from `chrome://extensions`. To remove the widgets too, unload them in Rainmeter, delete the `Prism` folder in Rainmeter's Skins folder (normally a junction, so deleting it removes only the link), and delete the extracted pack folder.

---

## Usage

- **Move a widget** - drag it with the left mouse button.
- **Switch style or theme** - right-click any widget → pick from the menu. All widgets update together.
- **Open a service's own page** - right-click the `ClaudeApi` or `ChatGPTApi` widget → "Open Cost Dashboard", the `GeminiApi` widget → "Open Spend Dashboard", or the `Claude` widget → "Open Usage Page".
- **Inspect the extension** - click the Prism icon in Chrome's toolbar to see live status, a log feed, and an export-logs button (helpful when reporting issues).
- **Popup settings** - the popup's **Settings** tab picks the Gemini API project (or **All Projects**) and the log level. Each service in its **Services** list (drag to reorder) has two switches. **Show** only shows or hides its row in the popup; a hidden service is still read and its widget keeps updating. To stop the extension from contacting a service at all, turn off its **Collect** switch (every service is on by default): its widget then shows it as not connected until you turn it back on, and the next update after that brings its data back.

---

## How It Works

### Data pipeline

```
   Browser tab (claude.ai, chatgpt.com, …)
                  │
                  ▼
   Chrome extension service worker (background.js)
       └─ chrome.alarms fires every minute
       └─ fetch() to each service's internal usage endpoint
       └─ caches result to chrome.storage.local (`lastPayload`)
                  │
       ┌──────────┴──────────┐
       │                     │
       ▼                     ▼  (fallback path, see below)
   Native Messaging      BridgePoll.py
   (sendNative-          (every 30 s)
    Message)                 │
       │                     │  reads lastPayload from
       │                     │  chrome.storage.local
       ▼                     ▼
   Setup\NativeHost.ps1 (length-prefixed JSON over stdio)
       └─ writes @Resources\ConsumerData.inc atomically
                  │
                  ▼
   Rainmeter @IncludeConsumer + per-widget [measureAutoRefresh]
       └─ widgets repaint within ~60 seconds
```

The host writes into the Prism skin folder Rainmeter actually shows: `<Skins>\Prism\@Resources`, where `<Skins>` is the `SkinPath` in `%APPDATA%\Rainmeter\Rainmeter.ini` (normally `Documents\Rainmeter\Skins`). Setup links that `Prism` folder to the pack, so the data normally lands in the pack's own `Prism\@Resources`. Each widget includes `@Resources\ConsumerDefaults.inc` (every key at its disconnected value) right before `ConsumerData.inc`, so a key the data file lacks, or the whole file before the first sync, falls back to its disconnected value instead of showing a raw variable name.

### Why two paths to the host?

The direct `chrome.runtime.sendNativeMessage` path is what the extension uses by default and what works for most installs. On some Chrome builds (observed on Chrome 147.x), that call fails fast with "Specified native messaging host not found" even though every layer of the configuration is correct (likely a cached negative result Chrome holds onto across extension reloads).

When that happens, the service worker still fetches data successfully and writes it to `chrome.storage.local`. **`BridgePoll.py`** is a small Python loop (set up by `Install.ps1` as an at-logon scheduled task) that reads that cache every 30 seconds and pipes it directly to the same native host script (`NativeHost.ps1`) the SW would have reached. Result: widgets stay live regardless of which path is working.

If the direct path is healthy, the bridge stays out of the way. Extension 1.3+ records the outcome of each of its own host runs, so the bridge skips every payload the extension delivered itself. It leaves a payload with no recorded outcome alone for about 20 seconds (so it doesn't run a host next to the extension's), and sends it if the extension's run failed or never reported back. An older extension records nothing, so the bridge delivers each of its payloads a second time, 20-50 seconds later: the same data, but twice the host launches. The bridge never sends a payload older than one it already handled, or one more than 10 minutes old (the browser is closed), so with the browser closed the widgets keep the last data that was delivered, and in a freshly installed folder they show "Not connected" until the browser runs.

The bridge is optional. Skip it by uninstalling Python or unregistering the `Prism Bridge Poller` scheduled task; the direct native-messaging path works fine on unaffected Chrome builds.

### Why a Chrome extension?

Consumer-plan usage (Claude Pro/Max, ChatGPT Plus, Gemini Pro/Ultra) **isn't exposed on any public API** - it only lives on the service's own dashboard. The extension runs in the same security context as your browser tabs, so it can hit the same internal endpoints those dashboards use, with the same cookies/JWT you already have. What it reads stays on your machine (see [Privacy](#privacy)).

### Style system

Every style file (`@Resources/Styles/{Style}-{Theme}.inc`) defines the same set of variables - colors, fonts, dimensions, corner radii. Each widget includes the active one dynamically:

```ini
@IncludeSettings=#@#Settings.inc
@IncludeStyle=#@#Styles\#CurrentStyle#-#CurrentTheme#.inc
```

Switching style/theme rewrites `Settings.inc` and refreshes all skins, so visual updates are global and instant.

---

## Troubleshooting

**Widget says "Not connected"**
Make sure you're signed into the corresponding service in the same browser where the extension is loaded. Right after an install or upgrade, give it a minute with the browser open. Open the extension popup → **Logs** to see what the last fetch returned. Click **Refresh** to retry immediately.

**Widget says "Active - no usage data available"**
The service is logged in but doesn't report usage windows for your plan or account type, or its usage endpoint changed. The plan badge is still useful confirmation that auth is working.

**Claude shows no plan name**
The plan is read every few hours from claude.ai's `/api/organizations`, for the organization whose usage the widget shows. The extension names Free, Pro, Max (both the 5x and 20x tiers show as "Max"), Team and Enterprise; when claude.ai reports a plan it doesn't recognize, the label stays blank (the popup shows "Active") instead of guessing. To see what claude.ai returned, set the log level to `debug` in the popup's **Settings** and look for the "Could not determine plan" line on the **Logs** tab.

**Gemini shows no plan name, or the wrong one**
The plan badge is read from `gemini.google.com` in your default Google account (the one without `/u/1/` in the address). Open Gemini in that account once so the extension can pick it up.

**Numbers haven't updated in a while**
A widget whose data is more than 10 minutes old (an hour for the API widgets) shows an "updated N ago" note, and the consumer widgets dim their bars (see [Widgets](#widgets)). Make sure the browser with the extension is running; the widgets catch up within a minute or two. Each widget self-refreshes once a minute. If the number is genuinely stale while the browser runs, the upstream fetch is probably failing - check the extension popup's log feed. Use **Copy** or **Export** to share logs. After a network error or a temporary server error, a consumer widget keeps its last good reading for up to 15 minutes (the popup then says "Cached ... ago"), and the Claude API widget falls back to its last reading with a "cached" note, instead of flipping to "Not connected". The ChatGPT API and Gemini API widgets only refresh while their site is open in a tab (see [API Platform Usage](#api-platform-usage)).

**"Native host not found" in Chrome console / extension popup**
First, re-run `Setup\Setup.bat` and click **Reload** on the Prism extension card at `chrome://extensions`. If the error keeps coming back even after reload, your Chrome install is hitting the bug the bridge poller works around. That's normal, and as long as widgets are updating you can ignore the error. Confirm the bridge is alive by checking `Setup\bridge.log` for recent `OK ts=...` lines (while the direct path works, it logs once that the extension is delivering the data itself and then stays quiet, so no recent lines is normal there), and that a `pythonw.exe` (`pythonw3.x.exe` for Microsoft Store Python) is running with `BridgePoll.py` in its command line.

**Bridge poller not running**
The at-logon scheduled task starts it at your next sign-in, but you can start it now from PowerShell with:
```powershell
Start-ScheduledTask 'Prism Bridge Poller'
```
or just re-run `Setup\Setup.bat`, which prints the Python it found under the scheduled-task line ("Python 3.10+ not found" means the bridge was skipped). The poller also stops by itself, after about 5 minutes, when its pack folder is deleted or moved, or when `Remove.bat` has removed the native host's registration.

**Style changes aren't applying to all widgets**
Make sure you're right-clicking on a Prism widget (not a different skin). The context-menu actions write to `@Resources/Settings.inc` and trigger `!Refresh *` on every loaded skin.

**Style/theme went back to Glassmorphism Dark after an upgrade**
Extracting a release over the old folder, or deleting the old folder before running the new `Setup.bat`, replaces or removes `Settings.inc`. Pick your style and theme again from any widget's right-click menu. Setup carries them over only from an old folder that still exists (see [Upgrading](#upgrading)).

**Clock text overflows the frame in some styles**
The widget should auto-fit, but very long locale dates can break narrow frames. The default uses abbreviated month (`%b`) - if you've customized `Clock.ini`, keep an eye on width.

---

## Privacy

- All data fetches happen in **your** browser, using **your** existing cookies and tokens.
- Nothing is sent to any third-party server. The only network calls are to `claude.ai`, `chatgpt.com`, `gemini.google.com`, `platform.claude.com`, `platform.openai.com`, `api.openai.com`, and `aistudio.google.com` - the same domains you'd visit by hand.
- Once a minute the extension sends requests to `claude.ai`, `chatgpt.com` and `platform.claude.com`, and to `gemini.google.com` when the browser is signed in to Google; only the services you're signed in to return data. To stop it contacting a service, turn off that service's **Collect** switch in the popup's Settings: it then sends no requests there, its content script stays idle on that site, and its widget shows it as not connected. (The **Show** switches only hide popup rows.) Data already cached for a service you turn off stays in the extension's local storage, unused, until the first reading after you turn it back on replaces it.
- The extension's local storage holds the latest usage and spend snapshots (plus each service's last good reading, reused through brief errors), the Claude and Claude Console org IDs and Gemini session tokens it needs to call those services, the detected plan names, the outcome of its last native-host write, and a rolling buffer of up to 200 log entries. You can clear the logs from the popup's **Logs** tab, or set the log level to Off; removing the extension deletes everything else.
- The popup's settings (log level, which services are collected (the Collect switches), which are shown and in what order, and the selected Gemini API project) live in the browser's sync storage, so if you use browser sync, your browser copies them to your other signed-in browsers. Turning a service off on one browser therefore turns it off on the others too.
- The widget pack writes these files on disk, all local only. `Remove.bat` deletes the logs and resets the data file, and deleting the pack folder removes everything:
  - `ConsumerData.inc` in the `Prism\@Resources` folder Rainmeter shows: the values the widgets display.
  - `NativeHost.log` next to it: one line per update with the time, plan names, session percentages and API month-to-date totals. Renamed to `NativeHost.log.old` past 1 MB.
  - `Setup\launch.log`: one line each time the browser starts the native host, with the calling extension's ID (the bridge runs the host directly, so its runs aren't listed). Renamed to `launch.log.old` past 1 MB.
  - `Setup\bridge.log`: the bridge poller's status lines, including plan names, session percentages and Claude API spend for the data it delivers. Trimmed to the last 1000 lines past about 200 KB.
  - `Setup\com.prism.usage.json`: the native-host manifest Setup writes (no usage data).

---

## Contributing

Issues and PRs are welcome - particularly for:

- New style packs (just add a matching pair of `Styles/{Name}-Dark.inc` / `{Name}-Light.inc` files)
- Adapters for additional AI services or dashboards
- Bug reports with extension logs attached (use **Export** in the extension popup → attach the `.txt` file). Look it over first: it includes your plan names and spend, and at the Debug level also your account IDs

If you're working on the extension, the popup's **Logs** tab is your friend - set the log level to `debug` in **Settings** to see the full fetch lifecycle.

---

## License

[GPL v3](https://www.gnu.org/licenses/gpl-3.0) - free to use, modify, and redistribute under the same license. See `LICENSE` for the full text.
