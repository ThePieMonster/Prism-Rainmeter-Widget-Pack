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
  2. Pipes it (length-prefixed JSON) directly to NativeHost.bat
  3. Native host writes ConsumerData.inc; Rainmeter picks it up

When Chrome's native messaging works correctly (e.g. after a Chrome restart
or extension reload that clears the cache), the SW writes ConsumerData.inc
directly. This script then becomes harmless redundancy: it sees the same
payload it just saw, skips the host call, and waits.

Usage
-----
Long-running loop, polls every POLL_INTERVAL_SEC seconds:

    pythonw BridgePoll.py

Started automatically at user logon by the "Prism Bridge Poller" scheduled
task that Install.ps1 registers. Stop with: taskkill /im pythonw.exe /f
or via Task Scheduler.

All paths are derived from the script's own location -- no machine-specific
hardcoding. Tries both the Web Store extension ID and the dev-sideload ID;
uses whichever has cached data.
"""
import glob
import json
import os
import re
import struct
import subprocess
import sys
import time

# --- Paths derived from this script's location -----------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
NATIVE_HOST = os.path.join(SCRIPT_DIR, 'NativeHost.bat')
LOG = os.path.join(SCRIPT_DIR, 'bridge.log')

# --- Where to look for the extension's chrome.storage.local ----------------
# Both the Web Store extension and the dev-key sideload have known
# deterministic IDs. Whichever one is installed and has data wins.
EXTENSION_IDS = (
    'nmlnncddmhjfiahelimfgajdidcobajc',  # Chrome Web Store
    'ngdncfjjadjdlanmigdmmmbjmokemdif',  # dev sideload (manifest.json key)
)
CHROME_USER_DATA_ROOTS = (
    os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome\User Data'),
    os.path.expandvars(r'%LOCALAPPDATA%\Microsoft\Edge\User Data'),
    os.path.expandvars(r'%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data'),
)
PROFILE_NAMES = ('Default', 'Profile 1', 'Profile 2', 'Profile 3', 'Profile 4')

# --- Loop tuning -----------------------------------------------------------
POLL_INTERVAL_SEC = 30  # half the SW's 60s alarm so we never miss an update
LOG_MAX_BYTES = 200_000
LOG_KEEP_LINES = 1000

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


def find_extension_storage_dirs():
    """Yield every Local Extension Settings/<id> dir we should scan."""
    for root in CHROME_USER_DATA_ROOTS:
        if not os.path.isdir(root):
            continue
        for profile in PROFILE_NAMES:
            for ext_id in EXTENSION_IDS:
                d = os.path.join(root, profile, 'Local Extension Settings', ext_id)
                if os.path.isdir(d):
                    yield d


def _scan_one_dir(ext_dir):
    """Return the (timestamp, payload) tuple for the most recent lastPayload
    found in this extension storage dir, or (None, None)."""
    files = (
        glob.glob(os.path.join(ext_dir, '*.log'))
        + glob.glob(os.path.join(ext_dir, '*.ldb'))
    )
    files.sort(key=os.path.getmtime, reverse=True)

    best = None
    best_ts = None

    for f in files:
        try:
            with open(f, 'rb') as fh:
                data = fh.read()
        except Exception:
            continue

        for m in re.finditer(rb'lastPayload', data):
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

            ts = parsed.get('timestamp')
            if not ts or not all(k in parsed for k in REQUIRED_KEYS):
                continue
            if best_ts is None or ts > best_ts:
                best = parsed
                best_ts = ts

    return best_ts, best


def extract_last_payload():
    """Find the most recent lastPayload across every browser/profile/extension."""
    best = None
    best_ts = None
    for d in find_extension_storage_dirs():
        ts, p = _scan_one_dir(d)
        if ts and (best_ts is None or ts > best_ts):
            best, best_ts = p, ts
    return best


def send_to_host(payload):
    """Pipe length-prefixed JSON to NativeHost.bat. Return parsed response or None."""
    js = json.dumps(payload).encode('utf-8')
    prefix = struct.pack('<I', len(js))
    try:
        proc = subprocess.Popen(
            [NATIVE_HOST],
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


def one_pass(last_seen_ts):
    payload = extract_last_payload()
    if not payload:
        log('No payload found in any extension storage dir')
        return last_seen_ts

    new_ts = payload.get('timestamp')
    if new_ts == last_seen_ts:
        return last_seen_ts  # SW hasn't fetched anything new yet

    resp = send_to_host(payload)
    if resp and resp.get('ok'):
        c = payload.get('claude', {})
        cg = payload.get('chatgpt', {})
        g = payload.get('gemini', {})
        ca = payload.get('claudeApi', {})
        log(
            f"OK ts={new_ts} -> "
            f"Claude={c.get('PlanName')}/{c.get('SessionPercent')}% "
            f"ChatGPT={cg.get('PlanName')} Gemini={g.get('PlanName')} "
            f"ClaudeApi=${ca.get('MonthTotal')}"
        )
        return new_ts
    log(f'Host returned: {resp}')
    return last_seen_ts


def main():
    log(
        f'--- Bridge poller started '
        f'(pid={os.getpid()}, interval={POLL_INTERVAL_SEC}s, '
        f'host={NATIVE_HOST}) ---'
    )
    last_ts = None
    while True:
        try:
            last_ts = one_pass(last_ts)
        except Exception as e:
            log(f'Loop iteration crashed: {type(e).__name__}: {e}')
        time.sleep(POLL_INTERVAL_SEC)


if __name__ == '__main__':
    sys.exit(main() or 0)
