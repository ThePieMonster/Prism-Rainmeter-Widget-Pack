# Privacy Policy - Prism Rainmeter Widget Pack

_Last updated: June 2026_

## Summary

The Prism browser extension reads AI service usage data from your existing
browser sessions and writes it to a local file that the Rainmeter widget
pack reads to display usage on your desktop. **Nothing is ever sent off
your machine.** There are no servers, no analytics, no telemetry, and no
third parties.

## What the extension does

When you install the extension and the companion Rainmeter widget pack,
the extension:

1. Once per minute, wakes up its background service worker via the
   Manifest V3 `chrome.alarms` API.
2. Sends `fetch()` requests to the AI services you have authorized
   (Claude, ChatGPT, Gemini, and their developer APIs), using the session
   cookies your browser already has from being logged in to those sites.
3. Extracts a small set of values from each response: current plan name,
   usage percentage, reset time, API credit balance, recent spend.
4. For data that is not exposed via a clean API - the Gemini plan badge
   and the OpenAI Platform / Google AI Studio dashboards - a small content
   script reads the values from the rendered page DOM. (Gemini's usage
   percentages are instead fetched from `gemini.google.com`'s own internal
   usage endpoint - the same one the site's Usage page uses.)
5. Sends the extracted values to a small native messaging host bundled
   with the widget pack, which writes them to a local file in the
   Rainmeter `@Resources` folder.
6. Caches the same values in `chrome.storage.local` so the popup can
   display them without re-fetching.

## What data is processed

| Category | Examples | Where it goes |
|---|---|---|
| Plan name | "Max", "Pro", "Free" | Local file + popup cache |
| Usage stats | "Session 10%", "Weekly 56%" | Local file + popup cache |
| Reset times | "Resets Sat 9:00 PM" | Local file + popup cache |
| API spend | "$1.94 this month" | Local file + popup cache |
| Org UUIDs | Claude / OpenAI account IDs | Local cache only (used to build subsequent API URLs) |
| Session token | Gemini anti-CSRF token + page build/session IDs | Local cache only (used to call Gemini's usage endpoint) |
| Internal logs | "Fetch success: MTD=$1.94" | Local cache only (visible on the popup's Logs tab) |
| User settings | Log level | `chrome.storage.sync` |

## What data is NOT collected

- Your name, email address, age, or other personal identifiers
- Health or medical information
- Credit card numbers, bank details, or payment methods
- Passwords (the extension never sees a password)
- Personal communications - the extension does not read your chat
  messages, prompts, or AI responses
- Location, IP address, or device fingerprinting
- Web browsing history
- Mouse, keyboard, or scroll activity
- Page content other than the specific plan/quota text the content
  scripts are designed to extract

## Authentication credentials

To make authenticated requests, the extension reads:

- The session cookies your browser has already set on each AI service's
  domain (used as request credentials).
- For OpenAI Platform, an Auth0 JWT that the website itself stores in
  `localStorage` (used as a request bearer token).
- For Gemini, an anti-CSRF token and the page's build/session identifiers
  embedded in the `gemini.google.com` HTML. These are required to call
  Gemini's internal usage endpoint, and are cached in `chrome.storage.local`
  so the extension does not have to re-download the page on every refresh.

These credentials are **only used to make same-origin requests to the
service that issued them**. Apart from the cached Gemini token noted above,
they are not written to extension storage. None of them are ever sent to
the native host, sent to any third party, or moved off your machine.

## Where your data goes

- **Same-origin AI service**: outgoing fetch requests to the service that
  set the cookie (e.g. claude.ai, chatgpt.com). These are the same
  requests your browser already makes when you load those sites.
- **Local browser storage**: `chrome.storage.local` and
  `chrome.storage.sync`, accessible only to this extension on your
  machine.
- **Local native host**: a small Windows process (`com.prism.usage`) that
  ships with the widget pack and writes a single text file to your
  Rainmeter `@Resources` folder.
- **The widget pack on your desktop**: the Rainmeter widgets read that
  text file to render the numbers.

That is the entire data flow. There are no remote servers operated by
the extension author. There is no analytics service. There is no
telemetry endpoint.

## Third parties

There are none.

The extension does not embed any third-party libraries that phone home,
does not use Google Analytics or similar, does not load any code from
the network, and does not transmit any data to any party other than the
AI service that already knows your usage (because you have an account
with them).

## Permissions, briefly

| Permission | Why |
|---|---|
| `alarms` | Schedule the periodic background refresh (Manifest V3 requirement) |
| `storage` | Cache fetched values, store user settings |
| `cookies` | Attach your existing session cookies to outgoing fetch() requests |
| `nativeMessaging` | Send the extracted values to the native host that writes the Rainmeter data file |
| Host permissions on AI service domains | Make the authenticated fetch() requests |

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
