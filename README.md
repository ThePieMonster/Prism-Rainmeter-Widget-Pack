<div align="center">

<img src="Extension/icon128.png" alt="Prism logo" width="96" height="96">

# Prism

**A Rainmeter widget pack for tracking AI service usage on your desktop**

*Live consumer-plan usage and API spend for Claude, ChatGPT, and Gemini - read straight from your authenticated browser session, with no API keys to manage.*

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-0078D4.svg)](#requirements)
[![Rainmeter 4.5+](https://img.shields.io/badge/Rainmeter-4.5%2B-orange.svg)](https://www.rainmeter.net/)
[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Install-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/prism-rainmeter/nmlnncddmhjfiahelimfgajdidcobajc)
[![Version 1.2.0](https://img.shields.io/badge/Version-1.2.0-green.svg)](#)

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
| **API platforms** | Claude API spend, ChatGPT API spend, Gemini API requests |

Every widget shares the same style/theme system - switch all of them between four visual styles and dark/light themes from any widget's right-click menu.

The AI usage data is pulled by a small Chrome/Edge extension that talks to the services' own internal endpoints using your existing browser session. There is **no API key configuration**, no cookie pasting, and no third-party server in the loop - the extension talks to a Native Messaging host that writes a single `.inc` file Rainmeter reads.

---

## Widgets

### Clock

`Clock/Clock.ini` - large time, AM/PM, day-of-week, and abbreviated date. Resizes itself to fit each style's frame.

### Consumer Plan Usage

Horizontal-bar widgets that display your **paid consumer plan** usage in real time:

| Widget | Service | Bars |
|--------|---------|------|
| `Claude/Claude.ini` | Claude (Pro / Max) | 5-hour session limit + 7-day weekly limit |
| `ChatGPT/ChatGPT.ini` | ChatGPT (Plus / Pro) | 3-hour rolling message window |
| `Gemini/Gemini.ini` | Gemini (Pro / Ultra) | 5-hour usage limit + weekly limit |

Each widget falls back gracefully if the service exposes only plan status (no usage numbers) - you'll see the plan name without a progress bar.

### API Platform Usage

Tracks **developer-platform** spend or activity, separate from consumer plans:

| Widget | Source | Metric |
|--------|--------|--------|
| `ClaudeApi/ClaudeApi.ini` | `platform.claude.com` | Month-to-date USD + today + yesterday |
| `ChatGPTApi/ChatGPTApi.ini` | `platform.openai.com` | Month-to-date USD + today + yesterday |
| `GeminiApi/GeminiApi.ini` | `aistudio.google.com` | Tier (Free/Paid), project, request count |

Gemini API doesn't expose USD cost on the web dashboard (it lives in Google Cloud Billing, behind separate auth) - the widget surfaces request count, which is the metric Free-tier users actually need to watch.

---

## Visual Styles

All widgets share four visual styles, each available in dark and light themes:

| Style | Look |
|-------|------|
| **Minimal** | No background, floating text with subtle shadow |
| **Glassmorphism** | Frosted glass panel, blur, rounded corners |
| **Cyberpunk** | Dark surface, neon cyan/magenta glow, monospace |
| **Material Design** | Elevated card, drop shadow, bold Roboto |

Right-click any widget → pick a style or theme → **all widgets refresh together**. The selection lives in `@Resources/Settings.inc`.

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
- **[Python 3.10+](https://www.python.org/downloads/)** is optional, only used by the bridge fallback (see [How It Works](#how-it-works)). `Install.ps1` skips it silently if missing.

### Quick install (most users)

1. **Install the Chrome extension** from the Web Store:

   [![Install on Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Install%20Now-4285F4?logo=googlechrome&logoColor=white&style=for-the-badge)](https://chromewebstore.google.com/detail/prism-rainmeter/nmlnncddmhjfiahelimfgajdidcobajc)

2. **Download the latest release** (or clone this repo) and **double-click `Setup\Setup.bat`**.

`Setup.bat` runs `Install.ps1`, which:
- Writes the Native Messaging host manifest and registers it with Chrome, Edge, and Brave
- Links (or copies) the `Prism\` skins folder into `Documents\Rainmeter\Skins\`
- Tells Rainmeter to load every Prism widget (`!ActivateConfig`) and refresh all skins (`!RefreshApp`)
- Sets up the bridge poller (Chrome workaround) as an at-logon scheduled task and starts it

After that the widgets appear on your desktop and start updating within ~60 seconds. Right-click any widget to reposition, change style/theme, or unload widgets you don't want.

### Developer install (working from a clone)

Use this if you're modifying the extension or skins:

1. Clone the repo to wherever you keep code (e.g. `C:\GIT\Prism-Rainmeter-Widget-Pack`).
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and pick the `Extension\` folder.
3. **Double-click `Setup\Setup.bat`**.

`Install.ps1` reads the `key` field in `manifest.json`, derives the sideload extension ID, and adds it to `allowed_origins` alongside the Web Store ID, so the Web Store build and the sideload build can both talk to the same native host. It also creates a directory junction from `Documents\Rainmeter\Skins\Prism` back to the repo's `Prism\` folder, so any edits you make in the repo show up live.

### Uninstall

Double-click `Setup\Remove.bat`. It removes the native-host registry entries, unregisters the bridge-poller scheduled task, kills the running poller, resets `ConsumerData.inc` to a disconnected stub (so the widgets show "Not connected" instead of stale numbers), and triggers `!RefreshApp` so the change is visible immediately. Then remove the extension from `chrome://extensions` and delete the `Prism` skin folder if you want it gone entirely.

---

## Usage

- **Move a widget** - drag it with the left mouse button.
- **Switch style or theme** - right-click any widget → pick from the menu. All widgets update together.
- **Open the dashboard for an API widget** - right-click the `ClaudeApi`, `ChatGPTApi`, or `GeminiApi` widget → "Open Usage Dashboard".
- **Inspect the extension** - click the Prism icon in Chrome's toolbar to see live status, a log feed, and an export-logs button (helpful when reporting issues).

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

### Why two paths to the host?

The direct `chrome.runtime.sendNativeMessage` path is what the extension uses by default and what works for most installs. On some Chrome builds (observed on Chrome 147.x), that call fails fast with "Specified native messaging host not found" even though every layer of the configuration is correct (likely a cached negative result Chrome holds onto across extension reloads).

When that happens, the service worker still fetches data successfully and writes it to `chrome.storage.local`. **`BridgePoll.py`** is a small Python loop (set up by `Install.ps1` as an at-logon scheduled task) that reads that cache every 30 seconds and pipes it directly to the same native host the SW would have called. Result: widgets stay live regardless of which path is working. If the direct path is healthy, both paths see the same data (harmless redundancy).

The bridge is optional. Skip it by uninstalling Python or unregistering the `Prism Bridge Poller` scheduled task; the direct native-messaging path works fine on unaffected Chrome builds.

### Why a Chrome extension?

Consumer-plan usage (Claude Pro/Max, ChatGPT Plus, Gemini Pro/Ultra) **isn't exposed on any public API** - it only lives on the service's own dashboard. The extension runs in the same security context as your browser tabs, so it can hit the same internal endpoints those dashboards use, with the same cookies/JWT you already have. Nothing leaves your machine.

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
Make sure you're signed into the corresponding service in the same browser where the extension is loaded. Open the extension popup → **Logs** to see what the last fetch returned. Click **Refresh** to retry immediately.

**Widget says "Active - no usage data available"**
The service is logged in but doesn't expose usage numbers for your plan tier (e.g., ChatGPT Free). The plan badge is still useful confirmation that auth is working.

**Numbers haven't updated in a while**
Each widget self-refreshes once a minute. If the number is genuinely stale, the upstream fetch is probably failing - check the extension popup's log feed. Use **Copy** or **Export** to share logs.

**"Native host not found" in Chrome console / extension popup**
First, re-run `Setup\Setup.bat` and click **Reload** on the Prism extension card at `chrome://extensions`. If the error keeps coming back even after reload, your Chrome install is hitting the bug the bridge poller works around. That's normal, and as long as widgets are updating you can ignore the error. Confirm the bridge is alive by checking `Setup\bridge.log` for recent `OK ts=...` lines, and that `pythonw.exe` is running with `BridgePoll.py` in its command line.

**Bridge poller not running**
The at-logon scheduled task starts it on next login, but you can launch it immediately with:
```powershell
Start-Process 'C:\Program Files\Python311\pythonw.exe' -ArgumentList '"<repo>\Setup\BridgePoll.py"' -WindowStyle Hidden
```
or just re-run `Setup\Setup.bat`.

**Style changes aren't applying to all widgets**
Make sure you're right-clicking on a Prism widget (not a different skin). The context-menu actions write to `@Resources/Settings.inc` and trigger `!Refresh *` on every loaded skin.

**Clock text overflows the frame in some styles**
The widget should auto-fit, but very long locale dates can break narrow frames. The default uses abbreviated month (`%b`) - if you've customized `Clock.ini`, keep an eye on width.

---

## Privacy

- All data fetches happen in **your** browser, using **your** existing cookies and tokens.
- Nothing is sent to any third-party server. The only network calls are to `claude.ai`, `chatgpt.com`, `gemini.google.com`, `platform.claude.com`, `platform.openai.com`, `api.openai.com`, and `aistudio.google.com` - the same domains you'd visit by hand.
- The extension's local storage holds only the most recent usage snapshots and a rolling log buffer. Clear them any time from the extension popup.
- The native host writes a single `.inc` file under `Documents\Rainmeter\Skins\Prism\@Resources\`. Nothing else is touched on disk.

---

## Contributing

Issues and PRs are welcome - particularly for:

- New style packs (just add a matching pair of `Styles/{Name}-Dark.inc` / `{Name}-Light.inc` files)
- Adapters for additional AI services or dashboards
- Bug reports with extension logs attached (use **Export** in the extension popup → attach the `.txt` file)

If you're working on the extension, the popup's **Logs** tab is your friend - set the log level to `debug` in **Settings** to see the full fetch lifecycle.

---

## License

[GPL v3](https://www.gnu.org/licenses/gpl-3.0) - free to use, modify, and redistribute under the same license. See `LICENSE` for the full text.
