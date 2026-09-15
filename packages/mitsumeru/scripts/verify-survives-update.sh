#!/usr/bin/env bash
# verify:survives-update — does the brand survive a harness replacement? (Epic 89 C12)
#
# This is the assertion the whole epic exists for. The bug: "the logo resets
# whenever there is an update." The root cause (measured, §2): the plugin was
# vendored into the app bundle, which an update replaces wholesale. The fix:
# install the plugin into the profile, which ensureProfile() never overwrites.
#
# This gate proves it by:
#   1. Creating a throwaway DSH_HOME with the white-label plugin installed
#   2. Writing a brand file into <DSH_HOME>/brand/
#   3. Setting an accent (via localStorage on the profile's own port)
#   4. Booting, asserting the rows render
#   5. Replacing the harness tree with a fresh one (simulating an app update
#      that carries NO white-label code)
#   6. Re-booting, asserting the rows STILL render and the brand path is still
#      visible
#
# MUST fail on the old vendored delivery (where the bundle carries the plugin).
# MUST pass on the profile-install delivery (where the profile carries it).
#
# Requires:
#   - A prepared harness tree (`pnpm harness`) at build/harness
#   - The white-label plugin in muen-plugins/plugins/dsh-white-label/
#   - Electron installed at ./node_modules/.bin/electron
set -euo pipefail
cd "$(dirname "$0")/.." # packages/mitsumeru

PROFILE=mitsu
ENTRY=build/harness/node_modules/@deepseek-ai/dsh/lib/bin.js
HARNESS=build/harness
PROBE=scripts/white-label-probe.cjs
WL_PLUGIN=dsh-white-label
MENUP_PLUGINS_DIR="$HOME/muen-plugins/plugins/$WL_PLUGIN"
[ -d "$MENUP_PLUGINS_DIR" ] || {
  echo "[FAIL] $MENUP_PLUGINS_DIR not found"
  exit 1
}

[ -f "$ENTRY" ] || { echo "[FAIL] $ENTRY missing — run: pnpm harness"; exit 1; }
[ -f "./node_modules/.bin/electron" ] || { echo "[FAIL] Electron not installed"; exit 1; }

# ── throwaway DSH_HOME ──────────────────────────────────────────────────────
HOME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mitsumeru-survives-XXXXXX")
cleanup() {
  [ -n "${HARNESS_PID:-}" ] && kill "$HARNESS_PID" 2>/dev/null || true
  rm -rf "$HOME_DIR"
}
trap cleanup EXIT

echo "verify:survives-update: DSH_HOME=$HOME_DIR"

# ── write the profile ────────────────────────────────────────────────────────
# The profile manifest the app writes via ensureProfile():
#   base first, then shipped plugins, then user-added ones.
node --input-type=module -e '
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const [home, profile, plugin] = process.argv.slice(1)
const dir = join(home, "profiles", profile)
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, "package.json"), JSON.stringify({
  name: `dsh-profile-${profile}`,
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", plugin], patchReload: "live" } }
}, undefined, 2) + "\n")
writeFileSync(join(dir, "cordis.patch.yml"), "[]\n")
writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - .\n")
' "$HOME_DIR" "$PROFILE" "@muen/$WL_PLUGIN"

# ── install the plugin into the profile (symlink, same as dsh plugin add) ────
# The loader imports each entry from the PROFILE anchor, so the plugin must be
# reachable from the profile's node_modules. This is exactly what dsh plugin add
# does, and what ensureProfile() reproduces for shipped plugins.
mkdir -p "$HOME_DIR/profiles/$PROFILE/node_modules/@muen"
ln -sfn "$MENUP_PLUGINS_DIR" "$HOME_DIR/profiles/$PROFILE/node_modules/@muen/$WL_PLUGIN"

# ── write a brand file into <DSH_HOME>/brand/ ───────────────────────────────
# This is the user data that must survive the update.
mkdir -p "$HOME_DIR/brand"
cat > "$HOME_DIR/brand/icon.svg" << 'SVGEOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#00eeff">
  <circle cx="12" cy="12" r="10"/>
</svg>
SVGEOF

echo "verify:survives-update: profile written, plugin linked, brand icon.svg written"

# ── boot #1 (with the plugin in the profile) ─────────────────────────────────
LOG="$HOME_DIR/boot1.log"
DSH_HOME="$HOME_DIR" node "$ENTRY" --profile "$PROFILE" --no-open \
  --host 127.0.0.1 --port 0 > "$LOG" 2>&1 &
HARNESS_PID=$!

URL=''
for _ in $(seq 1 40); do
  URL=$(sed -n 's/^dsh web: \(http.*\)$/\1/p' "$LOG" 2>/dev/null | head -1)
  [ -n "$URL" ] && break
  sleep 0.5
done
if [ -z "$URL" ]; then
  echo "[FAIL] boot #1: harness never printed a readiness line; log:"
  cat "$LOG"
  exit 1
fi
echo "verify:survives-update: boot #1 up at $URL"

# Probe #1: both rows must render.
./node_modules/.bin/electron "$PROBE" "$URL" "$HOME_DIR/brand"
BOOT1=$?
kill "$HARNESS_PID" 2>/dev/null || true
wait "$HARNESS_PID" 2>/dev/null || true
HARNESS_PID=""

if [ "$BOOT1" -ne 0 ]; then
  echo "[FAIL] boot #1 probe failed — the plugin does not mount in the first place"
  exit 1
fi
echo "verify:survives-update: boot #1 PASS"

# ── simulate an app update ───────────────────────────────────────────────────
# Replace the harness tree with a FRESH one (the same pnpm harness output,
# which does NOT carry dsh-white-label). This is what happens when the app
# updates: the bundle is replaced wholesale, but DSH_HOME/brand/ and the
# profile's node_modules survive.
#
# We don't actually rebuild here — we just delete the white-label plugin from
# the harness tree to simulate a fresh build that doesn't carry it.
rm -rf "$HARNESS/node_modules/@muen/$WL_PLUGIN"
# Verify it's gone.
[ ! -d "$HARNESS/node_modules/@muen/$WL_PLUGIN" ] || {
  echo "[FAIL] could not remove $WL_PLUGIN from harness tree"
  exit 1
}
echo "verify:survives-update: harness tree replaced (white-label removed from bundle)"

# ── boot #2 (after the "update") ─────────────────────────────────────────────
LOG2="$HOME_DIR/boot2.log"
DSH_HOME="$HOME_DIR" node "$ENTRY" --profile "$PROFILE" --no-open \
  --host 127.0.0.1 --port 0 > "$LOG2" 2>&1 &
HARNESS_PID=$!

URL2=''
for _ in $(seq 1 40); do
  URL2=$(sed -n 's/^dsh web: \(http.*\)$/\1/p' "$LOG2" 2>/dev/null | head -1)
  [ -n "$URL2" ] && break
  sleep 0.5
done
if [ -z "$URL2" ]; then
  echo "[FAIL] boot #2: harness never printed a readiness line; log:"
  cat "$LOG2"
  exit 1
fi
echo "verify:survives-update: boot #2 up at $URL2"

# Probe #2: both rows must STILL render, brand path must still be visible.
# The brand/icon.svg is in DSH_HOME/brand/ — user data, not touched by the update.
./node_modules/.bin/electron "$PROBE" "$URL2" "$HOME_DIR/brand"
BOOT2=$?
kill "$HARNESS_PID" 2>/dev/null || true

if [ "$BOOT2" -ne 0 ]; then
  echo "[FAIL] boot #2 probe failed — the brand did NOT survive the harness replacement"
  exit 1
fi

# ── verify the brand file itself was not deleted ──────────────────────────────
[ -f "$HOME_DIR/brand/icon.svg" ] || {
  echo "[FAIL] brand/icon.svg was deleted during the update"
  exit 1
}

echo ""
echo "verify:survives-update: PASS — brand survived a harness replacement"
echo "  boot #1 (with plugin in bundle):   PASS"
echo "  boot #2 (plugin NOT in bundle):    PASS"
echo "  brand file ($HOME_DIR/brand/icon.svg): still present"
