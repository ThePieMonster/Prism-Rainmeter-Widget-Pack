"""
Prism Bridge Poller
====================
Workaround for a bug in Chrome's native messaging dispatcher.

Background
----------
The Prism Chrome extension's service worker (background.js) fetches AI usage
data every minute and tries to forward it to the native messaging host
(NativeHost.bat -> NativeHost.ps1) via chrome.runtime.sendNativeMessage.
That host writes ConsumerData.inc, which Rainmeter reads.

In some Chrome installs (observed on Chrome 147.x), sendNativeMessage and
connectNative both fail in 0-1ms with "Specified native messaging host not
found" -- even though the registry entry, manifest file, allowed_origins,
file paths, and executable are all correctly configured (verified by piping
a test message to the host directly). The failure is fast and synchronous,
suggesting Chrome rejects the lookup at a layer above manifest validation
(possibly a cached negative result that survives extension reload).

This script bypasses that broken bridge:
  1. Reads the SW's most-recent `lastPayload` from chrome.storage.local
     (LevelDB files in Local Extension Settings/<extension-id>/)
  2. Pipes it (length-prefixed JSON) directly to NativeHost.ps1, the same
     host script NativeHost.bat runs for Chrome
  3. Native host writes ConsumerData.inc; Rainmeter picks it up

It never sends a payload older than the last one it sent or saw delivered
(another profile's old cache can briefly be the newest readable record), and
it skips a payload older than MAX_PAYLOAD_AGE_SEC (Chrome closed or still
starting): the newest readable record can then be another browser's or
profile's old cache, and ConsumerData.inc already holds the last data that
was delivered. The cost: in a new pack folder, or after Remove.bat reset
ConsumerData.inc, the widgets show the disconnected state until Chrome runs,
not the last cached payload.

When Chrome's native messaging works correctly (e.g. after a Chrome restart
or extension reload that clears the cache), the SW writes ConsumerData.inc
directly. Extension 1.3+ then stores the outcome of its own host run
(`lastNativeResult`, stamped with the payload's timestamp), and this script
skips every payload the SW delivered itself. A payload with no stored outcome
is left alone until it is SW_GRACE_SEC old, so this script does not start a
host while the SW's own host run is still going (two at once race for
ConsumerData.inc and the host log). After a failed SW run it sends on the
next poll. An older extension stores no outcome, so each of its payloads is
still delivered a second time, about 20-50 s after the SW did: the same
data, but twice the host launches.

Usage
-----
Long-running loop, polls every POLL_INTERVAL_SEC seconds:

    pythonw BridgePoll.py

Started automatically at user logon by the "Prism Bridge Poller" scheduled
task that Install.ps1 registers. To stop it:
  - `Stop-ScheduledTask 'Prism Bridge Poller'` (PowerShell) stops the
    instance the task started; the task starts it again at the next logon
  - Remove.bat removes the task and stops the poller
  - re-running Setup.bat stops every running poller (from any pack folder)
    and starts this folder's again
A poller started some other way (by hand, or by Setup.bat when the task could
not start) is the process whose command line runs BridgePoll.py. Its image is
pythonw.exe (pythonw3.x.exe for Microsoft Store Python), so
`taskkill /im pythonw.exe` can miss it and also kills unrelated pythonw
processes. From PowerShell:

    Get-CimInstance Win32_Process -Filter "Name LIKE 'python%' AND CommandLine LIKE '%BridgePoll.py%'" |
        ForEach-Object { Stop-Process -Id $_.ProcessId }

It also stops on its own when NativeHost.ps1 is gone (pack folder deleted or
moved), or when the host's browser registration was removed by a Remove.bat
(this release's or an older one) that could not stop this poller. While the
registration is gone it sends nothing, so it never writes live data over the
disconnected stub Remove.bat left. It exits once either state has lasted
HOST_MISSING_EXIT_PASSES polls in a row.

All paths are derived from the script's own location (no machine-specific
hardcoding). Scans every "Default" and "Profile N" profile of Chrome (stable,
Beta, Dev, Canary), Edge and Brave for both the Web Store extension ID and
the dev-sideload ID, and uses the newest cached payload.
"""
import glob
import json
import os
import re
import struct
import subprocess
import sys
import time

try:
    import winreg
except ImportError:  # not Windows: the registration check is skipped
    winreg = None

# --- Paths derived from this script's location -----------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
NATIVE_HOST = os.path.join(SCRIPT_DIR, 'NativeHost.ps1')
LOG = os.path.join(SCRIPT_DIR, 'bridge.log')

# Run the host the way NativeHost.bat does, but without the .bat: Popen runs
# a .bat through cmd /c and only quotes a path that contains a space, so a
# pack path such as C:\R&D\... (or one with ^ , ; = or %VAR%) is split by cmd
# and the host never starts. Chrome itself still launches NativeHost.bat.
# The host never reads the origin arguments Chrome passes to the .bat.
POWERSHELL = os.path.join(
    os.environ.get('SystemRoot', r'C:\Windows'),
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
)
if not os.path.isfile(POWERSHELL):
    POWERSHELL = 'powershell.exe'  # PATH lookup, as NativeHost.bat does
HOST_COMMAND = [
    POWERSHELL, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', NATIVE_HOST,
]

# The host's registration, as Install.ps1 writes it (HKCU) and Uninstall.ps1
# removes it. Chrome Beta/Dev/Canary read the same key as Chrome.
HOST_REG_KEYS = (
    r'Software\Google\Chrome\NativeMessagingHosts\com.prism.usage',
    r'Software\Microsoft\Edge\NativeMessagingHosts\com.prism.usage',
    r'Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.prism.usage',
)

# --- Where to look for the extension's chrome.storage.local ----------------
# Both the Web Store extension and the dev-key sideload have known
# deterministic IDs. Whichever one is installed and has data wins.
EXTENSION_IDS = (
    'nmlnncddmhjfiahelimfgajdidcobajc',  # Chrome Web Store
    'ngdncfjjadjdlanmigdmmmbjmokemdif',  # dev sideload (manifest.json key)
)
# Chrome Beta/Dev/Canary (SxS) keep their own User Data folders. This script
# launches the host itself, so it can serve the extension from any of them.
CHROME_USER_DATA_ROOTS = (
    os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome\User Data'),
    os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome Beta\User Data'),
    os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome Dev\User Data'),
    os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome SxS\User Data'),
    os.path.expandvars(r'%LOCALAPPDATA%\Microsoft\Edge\User Data'),
    os.path.expandvars(r'%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data'),
)

# --- Loop tuning -----------------------------------------------------------
POLL_INTERVAL_SEC = 30  # half the SW's 60s alarm so we never miss an update
LOG_MAX_BYTES = 200_000
LOG_KEEP_LINES = 1000

# The SW stores a payload every minute while Chrome runs. One older than this
# means Chrome is closed or still starting, so it is skipped: it can be another
# browser's or profile's old cache, and ConsumerData.inc already holds the
# last data that was delivered.
MAX_PAYLOAD_AGE_SEC = 600
# The SW stores each payload right before its own host run, and extension
# 1.3+ stores that run's outcome after it (lastNativeResult). A payload with
# no outcome yet is left for a later poll until it is this old, so the bridge
# does not run a host next to the SW's: longer than the SW waits for a host
# reply (15 s), and short enough that a 30 s poll still lands before the next
# minute's payload replaces it.
SW_GRACE_SEC = 20
# A payload or last-handled timestamp further ahead of the clock than this was
# written before the clock was set back. Ignore it, or it would outrank every
# new payload until real time caught up. A payload once seen that far ahead
# stays ignored (see _future_ts).
CLOCK_SKEW_SEC = 120
# Exit once NativeHost.ps1 has been missing (pack deleted or moved), or its
# registration removed, this many polls in a row. Several polls ride out an
# in-place re-extract.
HOST_MISSING_EXIT_PASSES = 10

REQUIRED_KEYS = ('claude', 'chatgpt', 'gemini', 'claudeApi', 'chatgptApi', 'geminiApi')
CREATE_NO_WINDOW = 0x08000000


def log(msg):
    ts = time.strftime('%Y-%m-%d %H:%M:%S')
    line = f'[{ts}] {msg}\n'
    try:
        if os.path.exists(LOG) and os.path.getsize(LOG) > LOG_MAX_BYTES:
            with open(LOG, 'r', encoding='utf-8') as f:
                lines = f.readlines()
            with open(LOG, 'w', encoding='utf-8') as f:
                f.writelines(lines[-LOG_KEEP_LINES:])
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(line)
    except Exception:
        pass
    try:
        print(line, end='')
    except Exception:
        pass


def _iso_utc(epoch):
    """UTC time as 'YYYY-MM-DDTHH:MM:SS', the to-the-second prefix of the SW's
    toISOString() timestamps, so the two compare correctly as strings."""
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(epoch))


def find_extension_storage_dirs():
    """Yield every Local Extension Settings/<id> dir we should scan."""
    for root in CHROME_USER_DATA_ROOTS:
        try:
            profiles = os.listdir(root)
        except OSError:
            continue
        # Same filter as Install.ps1: profile folders are 'Default' and
        # 'Profile N', where N only goes up as profiles are created (deleted
        # numbers are never reused). Skips 'Guest Profile' / 'System Profile'.
        for profile in profiles:
            name = profile.lower()
            if name != 'default' and not name.startswith('profile '):
                continue
            for ext_id in EXTENSION_IDS:
                d = os.path.join(root, profile, 'Local Extension Settings', ext_id)
                if os.path.isdir(d):
                    yield d


def _json_objects_after(data, key):
    """Yield each JSON object stored right after `key` in raw LevelDB bytes
    (a chrome.storage.local value follows its key within a few bytes)."""
    for m in re.finditer(re.escape(key), data):
        pos = m.end()
        window = data[pos:pos + 30]
        brace_off = window.find(b'{')
        if brace_off < 0:
            continue
        json_start = pos + brace_off

        # Walk braces with string-awareness to find the close brace
        depth = 0
        in_str = False
        esc = False
        end = -1
        for i in range(json_start, min(json_start + 20000, len(data))):
            c = data[i]
            if esc:
                esc = False
                continue
            if c == 0x5c and in_str:  # backslash inside string
                esc = True
                continue
            if c == 0x22:  # quote
                in_str = not in_str
                continue
            if in_str:
                continue
            if c == 0x7b:
                depth += 1
            elif c == 0x7d:
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break

        if end < 0:
            continue

        try:
            snippet = data[json_start:end].decode('utf-8', errors='strict')
            parsed = json.loads(snippet)
        except Exception:
            continue
        if isinstance(parsed, dict):
            yield parsed


# Timestamps of records once seen stamped later than max_ts. They stay ignored
# after real time catches up: max_ts moves forward every pass, so otherwise the
# records written before a clock step back would pass it one by one, outrank
# the SW's real payloads and be sent. Empty in normal operation; after a step
# it holds only the few such records still readable in a .log.
_future_ts = set()


def _scan_one_dir(ext_dir, max_ts=None):
    """Return (timestamp, payload, outcomes) for the most recent lastPayload
    found in this extension storage dir, or (None, None, outcomes). Records
    stamped later than max_ts, now or on an earlier pass, are ignored.
    outcomes maps a payload timestamp to True when the SW's own host run
    delivered that payload (a lastNativeResult with ok true, extension 1.3+),
    or False when the SW stored only failed runs for it."""
    files = (
        glob.glob(os.path.join(ext_dir, '*.log'))
        + glob.glob(os.path.join(ext_dir, '*.ldb'))
    )
    files.sort(key=os.path.getmtime, reverse=True)

    best = None
    best_ts = None
    outcomes = {}

    for f in files:
        try:
            with open(f, 'rb') as fh:
                data = fh.read()
        except Exception:
            continue

        for parsed in _json_objects_after(data, b'lastPayload'):
            ts = parsed.get('timestamp')
            if not ts or not isinstance(ts, str):
                continue
            if not all(k in parsed for k in REQUIRED_KEYS):
                continue
            if ts in _future_ts:
                continue  # was ahead of the clock on an earlier pass
            if max_ts is not None and ts > max_ts:
                _future_ts.add(ts)
                continue  # written before the clock was set back
            if best_ts is None or ts > best_ts:
                best = parsed
                best_ts = ts

        # Only ok === true means the host wrote ConsumerData.inc
        for result in _json_objects_after(data, b'lastNativeResult'):
            ts = result.get('timestamp')
            if not ts or not isinstance(ts, str):
                continue
            outcomes[ts] = outcomes.get(ts, False) or result.get('ok') is True

    return best_ts, best, outcomes


def extract_last_payload(max_ts=None):
    """Find the most recent lastPayload across every browser/profile/extension,
    ignoring any stamped later than max_ts. Return (payload, delivered):
    delivered is True when the SW that stored it delivered it itself, False
    when the SW's own host run failed, and None when no outcome is stored
    (run still going, extension older than 1.3, or record not readable)."""
    best = None
    best_ts = None
    delivered = None
    for d in find_extension_storage_dirs():
        ts, p, outcomes = _scan_one_dir(d, max_ts)
        if ts and (best_ts is None or ts > best_ts):
            best, best_ts = p, ts
            delivered = outcomes.get(ts)
    return best, delivered


def send_to_host(payload):
    """Pipe length-prefixed JSON to NativeHost.ps1. Return parsed response or None."""
    js = json.dumps(payload).encode('utf-8')
    prefix = struct.pack('<I', len(js))
    try:
        proc = subprocess.Popen(
            HOST_COMMAND,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=CREATE_NO_WINDOW,
        )
        proc.stdin.write(prefix + js)
        proc.stdin.close()
        resp_prefix = proc.stdout.read(4)
        if len(resp_prefix) < 4:
            err = proc.stderr.read().decode('utf-8', errors='replace')
            log(f'Host wrote no response (got {len(resp_prefix)} prefix bytes). stderr: {err[:300]}')
            return None
        resp_len = struct.unpack('<I', resp_prefix)[0]
        resp = proc.stdout.read(resp_len).decode('utf-8', errors='replace')
        proc.wait(timeout=10)
        return json.loads(resp)
    except Exception as e:
        log(f'send_to_host failed: {type(e).__name__}: {e}')
        return None


_last_skip_logged = None  # ts of the last skip we logged, so each is logged once


def _log_skip(ts, msg):
    global _last_skip_logged
    if ts != _last_skip_logged:
        _last_skip_logged = ts
        log(msg)


# True while the SW delivers its payloads itself, so that is logged once
# each time it starts instead of once a minute
_sw_delivering = False


def one_pass(last_seen_ts):
    """One poll. last_seen_ts is the newest payload already handled: sent by
    this script, delivered by the SW itself, or skipped as stale."""
    global _sw_delivering
    now = time.time()
    future_cutoff = _iso_utc(now + CLOCK_SKEW_SEC)
    if last_seen_ts is not None and last_seen_ts > future_cutoff:
        # The clock was ahead when we handled this and has been set back
        # since. Forget it, or every new payload would look older than it.
        log(f'Clock moved back: forgetting last handled ts={last_seen_ts}')
        last_seen_ts = None

    payload, delivered = extract_last_payload(future_cutoff)
    if not payload:
        log('No payload found in any extension storage dir')
        return last_seen_ts

    new_ts = payload.get('timestamp')
    if new_ts == last_seen_ts:
        return last_seen_ts  # SW hasn't fetched anything new yet
    if last_seen_ts is not None and new_ts < last_seen_ts:
        # Never go backwards. Only raw .log records are readable, so right
        # after the active profile's log is flushed into a compressed .ldb
        # table, the newest readable payload can be an old one from another
        # browser/profile. Wait for the SW's next write instead.
        _log_skip(new_ts, f'Ignoring older payload ts={new_ts} (last handled ts={last_seen_ts})')
        return last_seen_ts
    if new_ts < _iso_utc(now - MAX_PAYLOAD_AGE_SEC):
        # Chrome is closed or still starting, and this can be another
        # browser's or profile's old cache. Leave ConsumerData.inc (the last
        # data delivered) alone, and treat this payload as seen.
        _log_skip(new_ts, f'Skipping stale payload ts={new_ts} (older than {MAX_PAYLOAD_AGE_SEC}s)')
        return new_ts
    if delivered:
        # Native messaging works: the SW's own host run already wrote this
        # payload, so running the host again would only double the launches.
        if not _sw_delivering:
            _sw_delivering = True
            log(f'Extension delivered ts={new_ts} itself; skipping the payloads it delivers')
        return new_ts
    if delivered is None and new_ts > _iso_utc(now - SW_GRACE_SEC):
        # No outcome stored yet: the SW's own host run may still be going,
        # and a second host next to it would race it for ConsumerData.inc
        # and the host log. Look again next poll. (An extension older than
        # 1.3 never stores one, so its payloads are just sent a bit later.)
        return last_seen_ts

    _sw_delivering = False
    resp = send_to_host(payload)
    if resp and resp.get('ok'):
        c = payload.get('claude', {})
        cg = payload.get('chatgpt', {})
        g = payload.get('gemini', {})
        ca = payload.get('claudeApi', {})
        log(
            f"OK ts={new_ts} -> "
            f"Claude={c.get('PlanName')}/{c.get('SessionPercent')}% "
            f"ChatGPT={cg.get('PlanName')}/{cg.get('SessionPercent')}% "
            f"Gemini={g.get('PlanName')}/{g.get('SessionPercent')}% "
            f"ClaudeApi=${ca.get('MonthTotal')}"
        )
        return new_ts
    log(f'Host returned: {resp}')
    return last_seen_ts


def host_registered():
    """True if any browser has the host registered (HKCU), False if none
    has, None if that cannot be told (not Windows, registry error)."""
    if winreg is None:
        return None
    for sub in HOST_REG_KEYS:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, sub):
                return True
        except FileNotFoundError:
            continue
        except OSError:
            return None
    return False


def main():
    log(
        f'--- Bridge poller started '
        f'(pid={os.getpid()}, interval={POLL_INTERVAL_SEC}s, '
        f'host={NATIVE_HOST}, powershell={POWERSHELL}) ---'
    )
    last_ts = None
    host_missing = 0
    was_registered = False
    unregistered = 0
    while True:
        # Only a registration that goes away counts: one that was never seen
        # (registry write failed, poller started by hand) changes nothing.
        registered = host_registered()
        if registered:
            was_registered = True
        if registered is False and was_registered:
            unregistered += 1
        else:
            unregistered = 0

        if not os.path.isfile(NATIVE_HOST):
            # Pack folder deleted or moved: this poller is stale and has no
            # host left to run. Exit (freeing its working directory) instead
            # of polling forever.
            host_missing += 1
            if host_missing == 1:
                log(f'Native host not found at {NATIVE_HOST}; will exit if it stays missing')
            if host_missing >= HOST_MISSING_EXIT_PASSES:
                log(f'Native host still missing after {host_missing} polls; exiting')
                return 0
        elif unregistered:
            # Remove.bat (this release's or an older one) removed the host's
            # registration and reset ConsumerData.inc to the disconnected
            # stub, but could not stop this poller. Send nothing, so live
            # data never lands on the stub, and exit if it stays removed.
            host_missing = 0
            if unregistered == 1:
                log('Native host registration removed (Remove.bat?); not sending, will exit if it stays removed')
            if unregistered >= HOST_MISSING_EXIT_PASSES:
                log(f'Native host still unregistered after {unregistered} polls; exiting')
                return 0
        else:
            host_missing = 0
            try:
                last_ts = one_pass(last_ts)
            except Exception as e:
                log(f'Loop iteration crashed: {type(e).__name__}: {e}')
        time.sleep(POLL_INTERVAL_SEC)


if __name__ == '__main__':
    sys.exit(main() or 0)
