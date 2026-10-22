#!/usr/bin/env bash
# Pre-release real-machine suite (2026-10-22): one command, full feature
# coverage, ordered so each stage leaves the next one's state behind.
#
# Preconditions:
#   - debug Chrome running with Discord logged in (scripts/devtools-chrome.sh)
#   - web-test host on 3081 with DSH_DISCORD_TRACE=1 → /tmp/web-test-3081.log
#   - DISCORD_BOT_TOKEN exported
# Env:
#   GUILD (default 1562450757805146123) / BOUND_CHANNEL (a workspace-bound
#   channel id) / UNBOUND_CHANNEL (for the bind stage; it WILL be bound)
set -uo pipefail

GUILD="${GUILD:-1562450757805146123}"
BOUND_CHANNEL="${BOUND_CHANNEL:-1562614126172184586}"
UNBOUND_CHANNEL="${UNBOUND_CHANNEL:-1562450758576766989}"
TRACE="${TRACE:-/tmp/web-test-3081.log}"
HERE="$(cd "$(dirname "$0")" && pwd)"

pass=0; fail=0
stage() {
  echo
  echo "═══ $1 ═══"
  shift
  if "$@"; then pass=$((pass+1)); echo "STAGE OK"; else fail=$((fail+1)); echo "STAGE FAIL"; fi
}

stage "REST smoke (identity, commands, D1 wire+math, probe)" \
  env DISCORD_BOT_TOKEN="$DISCORD_BOT_TOKEN" node "$HERE/real-machine-smoke.mjs" --guild "$GUILD" --channel "$BOUND_CHANNEL"

stage "ack latency: /model show" \
  node "$HERE/devtools-cdp-ack.mjs" '/model show'

stage "ack latency: /project list" \
  node "$HERE/devtools-cdp-ack.mjs" '/project list'

stage "ack latency: /queue list (thread-less refusal is a pass shape)" \
  node "$HERE/devtools-cdp-ack.mjs" '/queue list'

stage "bind flow: autocomplete → confirm → commit (unbound channel)" \
  env CHANNEL_ID="$UNBOUND_CHANNEL" node "$HERE/devtools-cdp-bind.mjs"

stage "mention E2E: thread → tool rows → streaming → finalize + trace" \
  env CHANNEL_ID="$BOUND_CHANNEL" node "$HERE/devtools-cdp-mention.mjs" '列出当前目录的文件名,一句话即可' --trace "$TRACE"

echo
echo "════════ RESULT: $pass passed, $fail failed ════════"
exit $fail
