#!/usr/bin/env bash
# Chrome with CDP for real-machine testing (2026-10-22).
# Dedicated debug profile: first run needs a one-time Discord login
# (QR from the phone is fastest); the profile persists afterwards.
#
# Usage: scripts/devtools-chrome.sh [url ...]
#   extra args open as tabs after launch (defaults: the test guild's
#   #general and the web-test host UI).
set -euo pipefail

PORT=9222
PROFILE="$HOME/.chrome-debug-profile"
GUILD_URL="https://discord.com/channels/1562450757805146123/1562450758576766989"
HOST_URL="http://127.0.0.1:3081"

if curl -s -o /dev/null "http://127.0.0.1:${PORT}/json/version"; then
  echo "CDP already listening on :${PORT} — reusing the running Chrome"
else
  echo "launching Chrome (debug profile ${PROFILE})…"
  nohup "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --remote-debugging-port="${PORT}" \
    --user-data-dir="${PROFILE}" \
    >/tmp/chrome-debug.log 2>&1 &
  for _ in $(seq 1 20); do
    curl -s -o /dev/null "http://127.0.0.1:${PORT}/json/version" && break
    sleep 0.5
  done
fi

if ! curl -s -o /dev/null "http://127.0.0.1:${PORT}/json/version"; then
  echo "FAIL: CDP endpoint never came up (see /tmp/chrome-debug.log)" >&2
  exit 1
fi
echo "CDP ready: $(curl -s http://127.0.0.1:${PORT}/json/version | head -c 120)"

# Open tabs (PUT — Chrome ≥ 111 rejects GET on /json/new).
open_tab() {
  curl -s -X PUT "http://127.0.0.1:${PORT}/json/new?${1}" >/dev/null || \
    curl -s "http://127.0.0.1:${PORT}/json/new?${1}" >/dev/null || true
}
if [ "$#" -gt 0 ]; then
  for url in "$@"; do open_tab "${url}"; done
else
  open_tab "${GUILD_URL}"
  open_tab "${HOST_URL}"
fi

echo "tabs: Discord #general + web-test host (or your URLs)"
echo
if [ ! -f "${PROFILE}/DiscordLoggedIn" ]; then
  echo "First run reminder: log into Discord once in this profile (QR is fastest)"
  echo "— the login persists across runs."
fi
echo "Next: CDP driver scripts talk to ws://127.0.0.1:${PORT} (anchor discord.com/channels/ tabs)."
