<div align="center">

<img src="Extension/icon128.png" alt="Prism logo" width="96" height="96">

# Prism

**A Rainmeter widget pack for tracking AI service usage on your desktop**

*Live consumer-plan usage and API spend for Claude, ChatGPT, and Gemini - read straight from your authenticated browser session, with no API keys to manage.*

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-0078D4.svg)](#requirements)
[![Rainmeter 4.5+](https://img.shields.io/badge/Rainmeter-4.5%2B-orange.svg)](https://www.rainmeter.net/)
[![Chrome / Edge](https://img.shields.io/badge/Browser-Chrome%20%7C%20Edge-4285F4.svg)](#requirements)
[![Version 1.0.0](https://img.shields.io/badge/Version-1.0.0-green.svg)](#)

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
| `Gemini/Gemini.ini` | Gemini (Pro / Advanced) | Daily prompt cap |

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
- **Google Chrome or Microsoft Edge** (for the usage extension)
- One or more of: a logged-in `claude.ai` / `chatgpt.com` / `gemini.google.com` session, and/or a logged-in `platform.claude.com` / `platform.openai.com` / `aistudio.google.com` session
- Optional fonts (used by some styles):
  - **Segoe UI Light** - ships with Windows
  - **[JetBrains Mono](https://www.jetbrains.com/lp/mono/)** - Cyberpunk style
  - **[Roboto](https://fonts.google.com/specimen/Roboto)** - Material style

---

## Installation

### 1. Install the Rainmeter skins

1. Install [Rainmeter](https://www.rainmeter.net/).
2. Copy the entire `Prism` folder into `Documents\Rainmeter\Skins\`.
3. Open the Rainmeter Manager, expand **Prism**, and load the widgets you want (`Clock/Clock.ini`, `Claude/Claude.ini`, etc.).

### 2. Install the Chrome extension and native host

The AI usage widgets need a small Chrome/Edge extension plus a Native Messaging host. The extension ID is **deterministic** (baked into the manifest), so setup is one-click - you don't have to copy any IDs.

1. **Double-click** `Extension\Setup.bat`.
   This runs `Install.ps1`, which derives the extension ID from the public key in `manifest.json` and registers the native host with Chrome and Edge.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode** (toggle in the top-right).
4. Click **Load unpacked** and select the `Prism\Extension` folder.
5. Make sure you're signed in to the services you want to track in the same browser.
6. Click the Prism extension icon → hit **Refresh** to fetch immediately.

The extension wakes every minute via `chrome.alarms`, fetches usage data using your existing session, and pipes it through the native host into `@Resources/ConsumerData.inc`. Each Rainmeter widget polls that file and updates within a minute.

### Uninstall

Run `Extension\Uninstall.ps1` to remove the native-host registration. Then remove the extension from `chrome://extensions` and delete the `Prism` skin folder if you want it gone entirely.

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
                  │
                  │  Some services need page context (Auth0 JWT,
                  │  DOM scrape) - those go through a content script
                  │  that posts results back to the service worker.
                  ▼
   Native Messaging (length-prefixed JSON over stdio)
                  │
                  ▼
   nativehost\NativeHost.ps1
       └─ writes @Resources\ConsumerData.inc atomically
                  │
                  ▼
   Rainmeter @IncludeConsumer + per-widget [measureAutoRefresh]
       └─ widgets repaint within ~60 seconds
```

### Why a Chrome extension?

Consumer-plan usage (Claude Pro/Max, ChatGPT Plus, Gemini Advanced) **isn't exposed on any public API** - it only lives on the service's own dashboard. The extension runs in the same security context as your browser tabs, so it can hit the same internal endpoints those dashboards use, with the same cookies/JWT you already have. Nothing leaves your machine.

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

**Widget says "Active – no usage data available"**
The service is logged in but doesn't expose usage numbers for your plan tier (e.g., ChatGPT Free). The plan badge is still useful confirmation that auth is working.

**Numbers haven't updated in a while**
Each widget self-refreshes once a minute. If the number is genuinely stale, the upstream fetch is probably failing - check the extension popup's log feed. Use **Copy** or **Export** to share logs.

**"Native host not found" in Chrome console**
The native messaging host isn't registered. Re-run `Extension\Setup.bat` and reload the extension (toggle off/on in `chrome://extensions`).

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
