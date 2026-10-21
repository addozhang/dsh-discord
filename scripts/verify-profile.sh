#!/usr/bin/env bash
# Verification profile recipe (2026-10-21). Turns the web-021rc2 baseline
# into one command per release line: isolated CLI profile with explicitly
# pinned host bundles (the shared hoisted root resolves stale lines
# otherwise), pre-approved build scripts, and cleanup.
#
# Usage: scripts/verify-profile.sh <dsh-version> [adapter-tarball]
#   dsh-version     exact @deepseek-ai/dsh version, e.g. 0.2.1-rc.2
#   adapter-tarball optional local tarball; default: npm <version-typed>
set -euo pipefail

VERSION="${1:?usage: verify-profile.sh <dsh-version> [adapter-tarball]}"
TARBALL="${2:-}"
PROFILE="web-verify-${VERSION//./-}"
BASE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dsh-verify-${VERSION}-XXXXXX")"

echo "==> isolated CLI in ${BASE_DIR}"
cd "${BASE_DIR}" && npm init -y >/dev/null
npm install --no-fund --no-audit "@deepseek-ai/dsh@${VERSION}" >/dev/null

echo "==> one-shot profile ${PROFILE} (explicit bundle pins)"
cat > pnpm-workspace.yaml <<'YAML'
allowBuilds:
  koffi: true
  node-pty: true
  protobufjs: true
  dsh-subprocess-local: true
  "@google/genai": true
YAML
"${BASE_DIR}/node_modules/.bin/dsh" --profile "${PROFILE}" --no-open --port 0 --version >/dev/null 2>&1 || true

# Pin the host bundles the profile resolves, so a shared hoisted root
# cannot mix release lines (AGENTS.md 2026-10-20).
DSH_BIN="${BASE_DIR}/node_modules/.bin/dsh"
"${DSH_BIN}" plugin --profile "${PROFILE}" add "dsh-base@${VERSION}" >/dev/null 2>&1 || true
"${DSH_BIN}" plugin --profile "${PROFILE}" add "dsh-web-app@${VERSION}" >/dev/null 2>&1 || true

echo "==> install adapter"
if [ -n "${TARBALL}" ]; then
  "${DSH_BIN}" plugin --profile "${PROFILE}" rm '@addozhang/dsh-discord' >/dev/null 2>&1 || true
  "${DSH_BIN}" plugin --profile "${PROFILE}" add "file:${TARBALL}"
else
  echo "(no tarball given — add it yourself, exact version, then verify node_modules version field)"
fi

echo
echo "Next:"
echo "  DSH_DISCORD_TRACE=1 ${DSH_BIN} --profile ${PROFILE} --no-open --port <n>"
echo "  Settings → Discord: token (portal DOM read, never chat-transcribed) + guild allowlist"
echo "  node <repo>/scripts/real-machine-smoke.mjs --guild <id> --channel <id>"
echo
echo "Cleanup when done (single-host red line — no other host may run this plugin):"
echo "  rm -rf ~/.dsh/profiles/${PROFILE} ${BASE_DIR}"
