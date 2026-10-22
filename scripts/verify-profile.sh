#!/usr/bin/env bash
# Verification profile recipe (rev 2, 2026-10-22 — rewritten after the
# first real-machine deployment taught three lessons the hard way):
#
#   1. NEVER pin dsh-base/dsh-web-app in profile dependencies: the nested
#      duplicate copies of host-internal packages break the settings
#      singleton ("The acknowledgement could not be saved"). The bundles
#      LIST plus Node's upward resolution is enough.
#   2. `dsh plugin rm` removes the row from the bundles LIST too — a fresh
#      profile must have its package.json written in full, by hand.
#   3. The adapter's settings live in the profile's cordis.patch.yml
#      `config:` block (that is where card saves land) — pre-seeding it
#      skips the whole settings-card dance.
#
# Usage: scripts/verify-profile.sh <adapter-tarball> <guild-id> <user-id>
set -euo pipefail

TARBALL="${1:?usage: verify-profile.sh <adapter-tarball> <guild-id> <user-id>}"
TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
GUILD="${2:?guild id}"
OPERATOR="${3:?your discord user id}"
PROFILE="web-test"
DIR="$HOME/.dsh/profiles/${PROFILE}"
PORT=3081

if pgrep -f "profile ${PROFILE}" >/dev/null; then
  echo "stopping the running ${PROFILE} host first (plugin rm/add races its lock)"
  pkill -f "profile ${PROFILE}" || true
  sleep 2
fi

mkdir -p "${DIR}"
cd "${DIR}"

cat > package.json <<JSON
{
  "name": "dsh-profile-${PROFILE}",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@addozhang/dsh-discord"
      ]
    }
  },
  "dependencies": {
    "@addozhang/dsh-discord": "file:${TARBALL}"
  }
}
JSON

# Lesson from the pnpm 11 gates: placeholders block every install.
cat > pnpm-workspace.yaml <<'YAML'
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
allowBuilds:
  '@deepseek-ai/dsh-subprocess-local': true
  '@google/genai': true
  koffi: true
  node-pty: true
  protobufjs: true
YAML

# Pre-seed the adapter config (same shape card saves produce). The
# token stays in ~/.dsh/.credentials.yaml (DSH_DISCORD_BOT_TOKEN slot).
cat > cordis.patch.yml <<YAML
- id: dsh-discord
  name: "@addozhang/dsh-discord"
  config:
    allowedGuildIds:
      - "${GUILD}"
    memberUserIds:
      - "${OPERATOR}"
    hostOperatorUserIds:
      - "${OPERATOR}"
    language: auto
YAML

echo "==> installing adapter from ${TARBALL}"
pnpm install --no-frozen-lockfile >/dev/null

INSTALLED=$(node -e "console.log(require('./node_modules/@addozhang/dsh-discord/package.json').version)")
echo "==> adapter ${INSTALLED} installed (verify it matches the tarball)"

echo
echo "Start (trace on):  DSH_DISCORD_TRACE=1 dsh --profile ${PROFILE} --no-open --port ${PORT} > /tmp/${PROFILE}-${PORT}.log 2>&1 &"
echo "Smoke:             DISCORD_BOT_TOKEN=… node scripts/real-machine-smoke.mjs --guild ${GUILD} --channel <id>"
echo "Mention E2E:       node scripts/devtools-cdp-mention.mjs 'task…' --trace /tmp/${PROFILE}-${PORT}.log"
echo
echo "Cleanup when done (single-host red line):"
echo "  pkill -f 'profile ${PROFILE}'; rm -rf ${DIR} /tmp/${PROFILE}-${PORT}.log"
