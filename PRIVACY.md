# Privacy Policy - Prism Rainmeter Widget Pack

_Last updated: October 2026_

## Summary

The Prism browser extension reads AI service usage data from your existing
browser sessions and writes it to a local file that the Rainmeter widget
pack reads to display usage on your desktop. **Your usage data never
leaves your machine.** The extension's only network requests go to the AI
services themselves. There are no servers, no analytics, no telemetry, and
no third parties. The one exception is a handful of settings (listed
below): if you use browser sync, your browser copies them to your
other signed-in browsers.

## What the extension does

When you install the extension and the companion Rainmeter widget pack,
the extension:

1. Once per minute, wakes up its background service worker via the
   Manifest V3 `chrome.alarms` API.
2. Sends `fetch()` requests to claude.ai, chatgpt.com and the Claude
   Console at platform.claude.com, and to gemini.google.com when your
   browser has a Google sign-in cookie (OpenAI Platform and Google AI
   Studio are covered in item 4). Your browser attaches the session
   cookies it already has for those sites. For a service you are not
   signed in to, the request carries no session and returns no usage
   data. Each service can be turned off under **Data collection** in the
   popup's Settings (all are on by default). A service that is off is not
   contacted at all: the extension sends it no requests, does not read
   its cookies, its content script (item 4) stays idle on its pages, and
   its desktop widget shows it as not connected until you turn it back
   on. The **Services** switches above that section only show or hide
   rows in the popup and do not change what is collected.
3. Extracts a small set of values from each response: current plan name,
   usage percentages, reset times, and API spend (month to date, today and
   yesterday). The Claude plan name comes from claude.ai's
   `/api/organizations` list, read every few hours: from your
   organization's entry the extension uses only its ID and its plan fields
   (capabilities, rate-limit tier, billing and subscription type), and it
   leaves the plan name blank when it does not recognize them. At the Debug
   log level, those plan fields are written to the log when the plan is
   not recognized.
4. For data that is not exposed via a clean API - the Gemini plan badge
   and the Google AI Studio spend page - a small content script reads the
   values from the rendered page DOM. The Gemini script only looks at the
   page's top bar for the plan badge. The AI Studio script reads the spend
   page's cost, spend cap, tier and project names; to read every project
   it switches the page's project selector (and its time range and model
   filters) itself, then puts your choices back. On OpenAI Platform, a
   content script hands the sign-in token the site keeps in its own
   storage to the service worker, which then fetches your spend from
   `api.openai.com` (see Authentication credentials below). These scripts
   only run on those sites, while you have them open, and do nothing for
   a service turned off under Data collection. (Gemini's usage
   percentages are instead fetched from `gemini.google.com`'s own internal
   usage endpoint - the same one the site's Usage page uses.)
5. Sends the extracted values to a small native messaging host bundled
   with the widget pack, which writes them to a local file in the
   Rainmeter `@Resources` folder (see Files on your disk below).
6. Caches the same values in `chrome.storage.local` so the popup can
   display them without re-fetching, and so a widget can keep showing its
   last good reading through a brief network error. Turning a service off
   does not delete what is already cached for it: while it is off, that
   data is neither sent to the native host nor shown in the popup, and the
   first reading after the service is turned back on replaces it (removing
   the extension deletes it).

## What data is processed

| Category | Examples | Where it goes |
|---|---|---|
| Plan name | "Max", "Pro", "Free" | Local data file + host/bridge logs + popup cache |
| Usage stats | "Session 10%", "Weekly 56%" | Local data file + host/bridge logs + popup cache |
| Reset times | "Resets Sat 9:00 PM" | Local data file + popup cache |
| API spend | "$1.94 this month" | Local data file + host/bridge logs (month-to-date totals) + popup cache |
| Google AI Studio details | Spend cap, tier, project names | Local data file (spend cap, tier and the selected project's name) + popup cache |
| Org UUIDs | Claude and Claude Console organization IDs | Local cache only (used to build subsequent API URLs; shown in the log only at the Debug level) |
| Session token | Gemini anti-CSRF token + page build/session IDs | Local cache only (used to call Gemini's usage endpoint) |
| OpenAI session key | Dashboard key issued by `api.openai.com` | Service-worker memory only (see Authentication credentials) |
| Internal logs | "Fetch success: MTD=$1.94" | Local cache only (visible on the popup's Logs tab; up to 200 entries; can be cleared there or turned off) |
| User settings | Log level, which services are turned on under Data collection, which services the popup shows and in what order, the selected Google AI Studio project | `chrome.storage.sync` (see Where your data goes) |

## What data is NOT collected

- Your name, email address, age, or other personal identifiers
- Health or medical information
- Credit card numbers, bank details, or payment methods
- Passwords (the extension never sees a password)
- Personal communications - the extension does not collect, store or
  send your chat messages, prompts, or AI responses
- Location, IP address, or device fingerprinting
- Web browsing history (the log does not record the addresses of the
  pages you visit)
- Mouse, keyboard, or scroll activity
- Page content other than the specific values listed above: the Gemini
  content script only looks at the page's top bar for the plan badge
  word, and the AI Studio content script only reads the spend page's
  cost, spend cap, tier and project names (plus its own filter settings,
  so it can put them back). No other page text is stored or sent.

## Authentication credentials

To make authenticated requests, the extension relies on:

- The session cookies your browser has already set on each AI service's
  domain. The browser attaches them to the extension's requests; the
  extension does not read them itself, with two exceptions: claude.ai's
  `lastActiveOrg` cookie, which holds your Claude organization ID
  (otherwise the ID comes from claude.ai's `/api/organizations`), and
  Google's `SID` cookie on `gemini.google.com`, which is only checked for
  existence (its value is never stored or logged).
- For OpenAI Platform, an Auth0 JWT that the website itself stores in
  `localStorage` (or `sessionStorage`). The content script on
  `platform.openai.com` hands it to the service worker, which uses it as a
  request bearer token.
- For OpenAI Platform, the dashboard session key that `api.openai.com`
  returns in exchange for that JWT (the same exchange `platform.openai.com`
  makes itself). It is used only as the bearer token for the spend
  request, and is held in service-worker memory only: it is dropped when
  the service worker stops, the key is rejected or ChatGPT API is turned
  off under Data collection, then obtained again. The
  key itself is never stored. At the Debug log level, the log notes when a
  key was obtained, with its last six characters.
- For ChatGPT, the access token that `chatgpt.com` issues to
  its own web app via `/api/auth/session` (used as a request bearer token
  to read your Codex usage limits). It is requested fresh on each refresh,
  held in memory only for that request, and never stored or logged.
- For Gemini, an anti-CSRF token and the page's build/session identifiers
  embedded in the `gemini.google.com` HTML. These are required to call
  Gemini's internal usage endpoint, and are cached in `chrome.storage.local`
  so the extension does not have to re-download the page on every refresh.

These credentials are **only sent to the service that issued them** (for
example, the OpenAI Platform token goes only to `api.openai.com`, the
service it was issued for). Apart from the cached Gemini tokens and the
Claude organization ID from `lastActiveOrg` (an identifier, not a secret),
they are not written to extension storage; only the Debug log holds the
last six characters of the OpenAI session key. None of them is ever sent
to the native host or to any third party.

## Where your data goes

- **The AI services themselves**: outgoing requests to the service that
  set the cookie or issued the token (claude.ai, platform.claude.com,
  chatgpt.com, api.openai.com, gemini.google.com). These are the same
  requests the services' own web pages make.
- **Local browser storage**: `chrome.storage.local`, which stays on this
  device and is accessible only to this extension, and
  `chrome.storage.sync`, which holds only the settings listed above. When
  browser sync is on, your browser copies `chrome.storage.sync` through
  your browser account to your other signed-in browsers; otherwise it
  stays on this device too.
- **Local native host**: a small Windows process (`com.prism.usage`) that
  ships with the widget pack and writes the data file, plus a diagnostic
  log, to your Rainmeter `@Resources` folder.
- **The widget pack on your desktop**: the Rainmeter widgets read that
  data file to render the numbers.

That is the entire data flow. There are no remote servers operated by
the extension author. There is no analytics service. There is no
telemetry endpoint.

## Files on your disk

The widget pack writes these files. They stay on your machine, and the
extension never reads them back. (If you keep the pack or your Documents
folder in a cloud-synced location such as OneDrive, that service syncs
them like any other file there.)

| File | What it holds | Size |
|---|---|---|
| `ConsumerData.inc`, in the Prism `@Resources` folder Rainmeter shows | The latest values the widgets display | A few KB, replaced on every update |
| `NativeHost.log`, next to it | One line per update with the time, plan names, session percentages and API month-to-date totals, plus host start and stop lines | Renamed to `NativeHost.log.old` past 1 MB |
| `Setup\launch.log` | One line each time the browser starts the native host, with the time and the calling extension's ID | Renamed to `launch.log.old` past 1 MB |
| `Setup\bridge.log` | The bridge poller's status lines, including plan names, session percentages and Claude API spend for the data it delivers | Trimmed to the last 1000 lines past about 200 KB |
| `Setup\com.prism.usage.json` | The native-host manifest Setup writes (no usage data) | Fixed |

While it swaps in a new `ConsumerData.inc`, the host also keeps a
temporary copy for under a second. `Remove.bat` deletes the logs and
resets the data file to a "Not connected" stub; deleting the pack folder
removes everything.

## Third parties

There are none.

The extension does not embed any third-party libraries that phone home,
does not use Google Analytics or similar, does not load any code from
the network, and does not transmit any data to any party other than the
AI service that already knows your usage (because you have an account
with them). Browser sync of the settings above is done by your browser,
not by the extension.

## Permissions, briefly

| Permission | Why |
|---|---|
| `alarms` | Schedule the periodic background refresh (Manifest V3 requirement) |
| `storage` | Cache fetched values and logs, store user settings |
| `cookies` | Read the `lastActiveOrg` cookie on claude.ai to find your Claude organization ID (cached locally, and shown in the log only at the Debug level), and check whether a Google `SID` cookie exists, to tell if you are signed in to Google and so to Gemini (its value is not stored). Session cookies are attached to requests through the host permissions, not this permission. |
| `nativeMessaging` | Send the extracted values to the native host that writes the Rainmeter data file |
| Host permissions on AI service domains | Make the authenticated fetch() requests (the browser attaches your existing session cookies to them), and run the content scripts on `gemini.google.com`, `platform.openai.com` and `aistudio.google.com` |

## Open source

The extension's full source code is available in this repository under
the GPL v3 license. You can read every line of code that processes your
data.

## Changes to this policy

If a future version of the extension materially changes what data it
processes, this file will be updated and the change will be noted in the
release notes.

## Contact

For questions about this policy or the extension's data handling, open
an issue at:
https://github.com/ThePieMonster/Prism-Rainmeter-Widget-Pack/issues
