#!/usr/bin/env bash
#
# host-surface-audit.sh — diff the plugin's host touchpoints against a dsh release.
#
# The 0.1.6 migration proved that host upgrades break in ways static types cannot
# express (signal positions, envelope shapes, dispatch reachability). This script
# mechanically greps each touchpoint in the target dsh's installed tree and prints
# a three-color report, so "what changed?" is a 30-second answer instead of a
# two-week archaeology session.
#
# Usage:
#   scripts/host-surface-audit.sh                    # audit the latest alpha
#   scripts/host-surface-audit.sh 0.1.6-alpha.2       # audit a specific version
#   scripts/host-surface-audit.sh --latest            # audit the latest stable
#
# Exit code: 0 = all OK, 1 = any touchpoint MISSING or CHANGED.

set -euo pipefail

VERSION="${1:-alpha}"
if [[ "$VERSION" == "--latest" ]]; then
  VERSION="latest"
fi

WORK_DIR="$(mktemp -d /tmp/dsh-audit.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

# ── install the target dsh ──────────────────────────────────────────────────
echo "Installing @deepseek-ai/dsh@$VERSION …"
(cd "$WORK_DIR" && npm init -y >/dev/null 2>&1 && npm install "@deepseek-ai/dsh@$VERSION" --no-fund --no-audit --silent 2>/dev/null)

DEEPSEEK_DIR="$WORK_DIR/node_modules/@deepseek-ai"

if [[ ! -d "$DEEPSEEK_DIR" ]]; then
  echo "FATAL: install failed — $DEEPSEEK_DIR not found"
  exit 1
fi

echo "Auditing touchpoints against $(node -e "console.log(require('$WORK_DIR/node_modules/@deepseek-ai/dsh/package.json').version)") …"
echo ""

# ── helpers ──────────────────────────────────────────────────────────────────
OK=0; CHANGED=0; MISSING=0

check() {
  local label="$1" expect="$2" actual="$3"
  if [[ "$actual" == "$expect" ]]; then
    echo "  ✓ $label"
    OK=$((OK+1))
  elif [[ -z "$actual" || "$actual" == "NOT_FOUND" ]]; then
    echo "  ✗ $label — MISSING (expected: $expect)"
    MISSING=$((MISSING+1))
  else
    echo "  ⚠ $label — CHANGED: expected [$expect] got [$actual]"
    CHANGED=$((CHANGED+1))
  fi
}

check_grep() {
  local dir="$1" pattern="$2"
  if grep -qr "$pattern" "$dir" 2>/dev/null; then
    echo "FOUND"
  else
    echo "NOT_FOUND"
  fi
}

# ── 1. inject services (8) ─────────────────────────────────────────────────
echo "── 1. Inject services ──"
# 0.1.7 lesson: the receiver parameter name (ctx vs ownerContext) and quote
# style both drift; match any identifier as the receiver and either quote.
for svc in sessionController workspaceController sessionQuery webServer credentials settings connection commands permissionPresets; do
  actual=$(check_grep "$DEEPSEEK_DIR" "super([A-Za-z]*, ['\"]$svc['\"]")
  check "service '$svc'" "FOUND" "$actual"
done
# storageDomain registers via domainCtx.provide (not a Service subclass);
# bare "(" is literal in BRE and "." swallows either quote style.
actual=$(check_grep "$DEEPSEEK_DIR" 'provide(.storageDomain')
check "service 'storageDomain'" "FOUND" "$actual"
echo ""

# ── 2. sessionController methods ────────────────────────────────────────────
SESSION_DIR="$DEEPSEEK_DIR/dsh-api-session-controller"
if [[ ! -d "$SESSION_DIR" ]]; then
  SESSION_DIR=$(find "$DEEPSEEK_DIR" -maxdepth 1 -name "*session-controller" -type d | head -1)
fi
echo "── 2. sessionController methods ──"
for m in prompt create cancel updateQueue selectModel modelCatalog follow control resolveAgent; do
  actual=$(check_grep "$SESSION_DIR" "$m(")
  check "method '$m'" "FOUND" "$actual"
done
# list(signal) — bare single-param
if grep -qr "list(signal)" "$SESSION_DIR/lib/index.js" 2>/dev/null; then
  echo "  ✓ method 'list' (signal-only signature)"
  OK=$((OK+1))
else
  found=$(check_grep "$SESSION_DIR" "list(")
  check "method 'list' (signal-only)" "FOUND:signal-only" "$found:$(grep -o 'list([^)]*' "$SESSION_DIR/lib/index.js" 2>/dev/null | head -1)"
fi
echo ""

# ── 3. workspaceController ──────────────────────────────────────────────────
WS_DIR="$DEEPSEEK_DIR/dsh-api-workspace-controller"
if [[ ! -d "$WS_DIR" ]]; then
  WS_DIR=$(find "$DEEPSEEK_DIR" -maxdepth 1 -name "*workspace-controller" -type d | head -1)
fi
echo "── 3. workspaceController ──"
for m in create rename archiveSession unarchiveSession insertBefore follow; do
  actual=$(check_grep "$WS_DIR" "$m(")
  check "method '$m'" "FOUND" "$actual"
done
# baseline must NOT exist as a unary
if grep -qE "^\tbaseline\(\)" "$WS_DIR/lib/index.js" 2>/dev/null; then
  echo "  ⚠ baseline() unary exists — face uses follow-first-frame; may simplify"
  CHANGED=$((CHANGED+1))
else
  echo "  ✓ baseline() correctly absent (follow-first-frame model)"
  OK=$((OK+1))
fi
echo ""

# ── 4. ask services (service-boundary patches) ──────────────────────────────
echo "── 4. Ask services ──"
APPROVAL_DIR="$DEEPSEEK_DIR/dsh-user-approval"
actual=$(check_grep "$APPROVAL_DIR" "async request(")
check "approval.request()" "FOUND" "$actual"
actual=$(check_grep "$APPROVAL_DIR" "approval/request")
check "approval/request waterfall" "FOUND" "$actual"
QS_DIR="$DEEPSEEK_DIR/dsh-user-questions"
actual=$(check_grep "$QS_DIR" "async ask(")
check "userQuestions.ask()" "FOUND" "$actual"
echo ""

# ── 4b. permission surface (/permission command path) ──────────────────────
echo "── 4b. Permission surface ──"
COMMANDS_DIR="$DEEPSEEK_DIR/dsh-commands"
actual=$(check_grep "$COMMANDS_DIR" "execute(agent")
check "commands.execute(agent, line, attachments, signal)" "FOUND" "$actual"
PRESETS_DIR="$DEEPSEEK_DIR/dsh-permission-presets"
actual=$(check_grep "$PRESETS_DIR" "catalog()")
check "permissionPresets.catalog()" "FOUND" "$actual"
actual=$(check_grep "$PRESETS_DIR" "currentValue")
check "permissions projection view {currentValue}" "FOUND" "$actual"
actual=$(check_grep "$PRESETS_DIR" 'name: "permission"')
check "/permission command registration" "FOUND" "$actual"
actual=$(check_grep "$PRESETS_DIR" "permission/preset")
check "durable permission/preset event" "FOUND" "$actual"
echo ""

# ── 5. settings exports ─────────────────────────────────────────────────────
echo "── 5. Settings exports ──"
SETTINGS_JS="$DEEPSEEK_DIR/dsh-settings/lib/index.js"
# SettingsProvider was replaced by SettingsForms in 0.1.7's profile-backed
# forms refactor; SettingsNamespace (our only import) must survive either way.
for sym in SettingsForms SettingsConflictError redactSecrets; do
  if grep -q "$sym" "$SETTINGS_JS" 2>/dev/null; then
    echo "  ✓ export '$sym'"
    OK=$((OK+1))
  else
    echo "  ✗ export '$sym' — MISSING"
    MISSING=$((MISSING+1))
  fi
done
# The settings forms API the adapter's startup contract pins (0.6.x line):
# describe feeds resolveLanguage's locale read; update is the service-side
# landing of every card write.
for member in describe update; do
  if grep -q "$member(" "$SETTINGS_JS" 2>/dev/null; then
    echo "  ✓ settings forms '$member'"
    OK=$((OK+1))
  else
    echo "  ✗ settings forms '$member' — MISSING"
    MISSING=$((MISSING+1))
  fi
done
# Generational marker: installSection served the 0.1.6 installSection adapter
# line (0.5.x); its absence marks the Config-driven forms generation.
if grep -q "installSection" "$SETTINGS_JS" 2>/dev/null; then
  echo "  ✓ installSection present (0.1.6-generation host; serves adapter 0.5.x)"
  OK=$((OK+1))
else
  echo "  ⚠ installSection absent — Config-driven forms generation (adapter 0.5.x line cannot load; 0.6.x migrated)"
  CHANGED=$((CHANGED+1))
fi
# removed symbols must STAY removed
for sym in settingsNamespace installSettingsSection; do
  if grep -q "$sym" "$SETTINGS_JS" 2>/dev/null; then
    echo "  ⚠ '$sym' re-appeared (was removed in 0.1.6)"
    CHANGED=$((CHANGED+1))
  else
    echo "  ✓ '$sym' correctly absent"
    OK=$((OK+1))
  fi
done
echo ""

# ── 6. client type packages ─────────────────────────────────────────────────
echo "── 6. Client type packages ──"
for pkg in dsh-client-ui-settings dsh-client-ui-slots dsh-client-ui-renderer; do
  if [[ -d "$DEEPSEEK_DIR/$pkg" ]]; then
    echo "  ✓ package '$pkg'"
    OK=$((OK+1))
  else
    echo "  ✗ package '$pkg' — MISSING"
    MISSING=$((MISSING+1))
  fi
done
# dsh-client-store is published separately (not a dsh dependency) — check the registry
STORE_VER=$(npm view "@deepseek-ai/dsh-client-store" version 2>/dev/null || echo "NOT_FOUND")
if [[ "$STORE_VER" != "NOT_FOUND" ]]; then
  echo "  ✓ package 'dsh-client-store' (registry: $STORE_VER)"
  OK=$((OK+1))
else
  echo "  ✗ package 'dsh-client-store' — MISSING from registry"
  MISSING=$((MISSING+1))
fi
# dead packages must stay dead
for pkg in dsh-client-runtime dsh-host-apiproxy; do
  if [[ -d "$DEEPSEEK_DIR/$pkg" ]]; then
    echo "  ⚠ package '$pkg' re-appeared"
    CHANGED=$((CHANGED+1))
  else
    echo "  ✓ package '$pkg' correctly absent"
    OK=$((OK+1))
  fi
done
echo ""

# ── 7. event envelope shape ─────────────────────────────────────────────────
echo "── 7. Event envelope (journal records) ──"
if grep -q '"event"' "$SESSION_DIR/lib/typert.host.js" 2>/dev/null && grep -q 'records' "$SESSION_DIR/lib/typert.host.js" 2>/dev/null; then
  echo "  ✓ double-envelope {type:'event', records:[...]} present"
  OK=$((OK+1))
else
  echo "  ⚠ envelope shape may have changed — inspect manually"
  CHANGED=$((CHANGED+1))
fi
# snapshot frame
if grep -q '"snapshot"' "$SESSION_DIR/lib/typert.host.js" 2>/dev/null; then
  echo "  ✓ snapshot opening frame present"
  OK=$((OK+1))
else
  echo "  ⚠ snapshot frame missing — catch-up model changed"
  CHANGED=$((CHANGED+1))
fi
echo ""

# ── summary ──────────────────────────────────────────────────────────────────
echo "════════════════════════════════════════"
echo "  ✓ OK: $OK   ⚠ CHANGED: $CHANGED   ✗ MISSING: $MISSING"
echo "════════════════════════════════════════"

if [[ $MISSING -gt 0 || $CHANGED -gt 0 ]]; then
  echo ""
  echo "Next steps:"
  [[ $MISSING -gt 0 ]] && echo "  - MISSING items need code changes before this host version can load the plugin"
  [[ $CHANGED -gt 0 ]] && echo "  - CHANGED items need real-machine verification (see AGENTS.md '0.1.6 Host 面的事实')"
  exit 1
fi
echo "All touchpoints OK — no adapter changes needed for this host version."
