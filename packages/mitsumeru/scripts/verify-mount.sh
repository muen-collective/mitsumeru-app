#!/usr/bin/env bash
# verify:mount — do the plugins this app ships actually MOUNT? (Epic 88 C9)
#
# Retargeted 2026-09-12 from the retired dsh-mitsumeru-appearance plugin to
# dsh-eva-theme, then widened 2026-09-18 to the whole 0.2.1 shipped set: the
# throwaway profile now composes the SAME seven bundles as SHIPPED_PLUGINS in
# src/main/harness.ts, so this gate proves the shipped composition, not one
# representative package.
#
# Why this exists as a first-class gate rather than a manual check:
# `window.__ModuleLoader__` fails SILENTLY. A client module that throws on import,
# or that evaluates but never registers, leaves the boot succeeding with only a
# console line. "UI boots, zero errors, panel absent" is the documented failure
# mode, and it is indistinguishable from success by looking. So the check must
# assert POSITIVELY, read back from a real renderer, and be shown to fail.
#
# Hermetic on purpose. It builds a throwaway DSH_HOME, writes the profile the app
# would write, and boots that — which means every run also exercises the
# fresh-install path (`ensureProfile` + bundle resolution from the installation
# anchor) instead of trusting the developer's existing profile.
#
# Requires a prepared harness tree (`pnpm harness`) with our plugins vendored into
# it; the vendoring below is idempotent and mirrors scripts/prepare-harness.sh, so
# a dev tree works without a full rebuild.
set -euo pipefail
cd "$(dirname "$0")/.." # packages/mitsumeru

PROFILE=mitsu
ENTRY=build/harness/node_modules/@deepseek-ai/dsh/lib/bin.js
HARNESS=build/harness

# Mirror of SHIPPED_PLUGINS in src/main/harness.ts, in composition order. A
# plugin added there must be added here or the gate stops describing the build.
SHIPPED_PLUGINS=(
  dsh-brand-mitsumeru
  dsh-eva-theme
  dsh-white-label
  dsh-context-watchdog
  dsh-turn-summary
  dsh-changes-card
  dsh-codex-fold
)

[ -f "$ENTRY" ] || { echo "[FAIL] $ENTRY missing — run: pnpm harness"; exit 1; }

# --- vendor our plugins into the shipped tree (same as prepare-harness.sh) -----
# A profile bundle resolves from the installation anchor first, so anything we
# ship has to physically live in the harness node_modules. Idempotent: copying
# over the same paths each run is what keeps a dev tree usable without a full
# `pnpm harness`, and the extras (README/LICENSE/FORK.md, themes/) are copied so
# the vendored package matches the `files` list in its own manifest.
for pkg in "${SHIPPED_PLUGINS[@]}"; do
  src="plugins/$pkg"
  [ -d "$src" ] || { echo "[FAIL] shipped plugin missing: $src"; exit 1; }
  dest="$HARNESS/node_modules/@muen/$pkg"
  mkdir -p "$dest/lib"
  cp "$src/package.json" "$src/cordis.patch.yml" "$dest/"
  cp "$src"/lib/*.js "$dest/lib/"
  for extra in README.md LICENSE FORK.md; do
    if [ -f "$src/$extra" ]; then cp "$src/$extra" "$dest/"; fi
  done
  if [ -d "$src/themes" ]; then
    mkdir -p "$dest/themes"
    cp "$src"/themes/*.json "$dest/themes/"
  fi
done
echo "verify:mount vendored ${#SHIPPED_PLUGINS[@]} plugins: ${SHIPPED_PLUGINS[*]}"

# Does any NON-Muen client bundle in this harness declare the
# `settings.plugin.item` slot that dsh-codex-fold registers into? On the pinned
# dsh (0.1.6-alpha.2) none does — the key is named only in a type comment — so
# codex-fold's settings card is genuinely unrenderable and the probe falls back
# to served + console-error for it. Computed here (not hard-coded) so the probe
# starts REQUIRING the row the moment the shell declares the slot.
CODEX_FOLD_SLOT_DECLARED=no
BUNDLES_GREPPED=0
for bundle in "$HARNESS"/node_modules/@deepseek-ai/*/lib/client.js; do
  [ -f "$bundle" ] || continue
  BUNDLES_GREPPED=$((BUNDLES_GREPPED + 1))
  if grep -q -- 'settings.plugin.item' "$bundle"; then CODEX_FOLD_SLOT_DECLARED=yes; break; fi
done
echo "verify:mount settings.plugin.item: $CODEX_FOLD_SLOT_DECLARED ($BUNDLES_GREPPED shell client bundles grepped)"
if [ "$CODEX_FOLD_SLOT_DECLARED" = no ]; then
  echo "verify:mount ASSERTED: no @deepseek-ai/*/lib/client.js in this harness declares settings.plugin.item — codex-fold's settings card is unrenderable here, so the probe asserts served + console-error for that row instead."
fi

# --- throwaway home, with the profile the app writes ---------------------------
HOME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mitsumeru-verifymount-XXXXXX")
cleanup() {
  [ -n "${HARNESS_PID:-}" ] && kill "$HARNESS_PID" 2>/dev/null || true
  rm -rf "$HOME_DIR"
}
trap cleanup EXIT

MUEN_BUNDLES=()
for pkg in "${SHIPPED_PLUGINS[@]}"; do MUEN_BUNDLES+=("@muen/$pkg"); done

node --input-type=module -e '
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const [home, profile, ...bundles] = process.argv.slice(1)
const dir = join(home, "profiles", profile)
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, "package.json"), JSON.stringify({
  name: `dsh-profile-${profile}`,
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", ...bundles], patchReload: "live" } }
}, undefined, 2) + "\n")
writeFileSync(join(dir, "cordis.patch.yml"), "[]\n")
writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - .\n")
' "$HOME_DIR" "$PROFILE" "${MUEN_BUNDLES[@]}"

# The loader imports each entry from the PROFILE anchor, so the plugin must be
# reachable from the profile's node_modules — this is exactly what ensureProfile
# does in the app, and what `dsh plugin add` achieves with its own symlink.
# Without it the boot dies with
# `Cannot find package ... imported from <profileDir>`, even though resolveBundleDir
# already accepted the name from the installation tree.
mkdir -p "$HOME_DIR/profiles/$PROFILE/node_modules/@muen"
for pkg in "${SHIPPED_PLUGINS[@]}"; do
  ln -sfn "$(pwd)/$HARNESS/node_modules/@muen/$pkg" "$HOME_DIR/profiles/$PROFILE/node_modules/@muen/$pkg"
done

# --- boot it, and take the URL straight off the readiness line -----------------
LOG="$HOME_DIR/boot.log"
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
  echo "[FAIL] harness never printed a readiness line; log:"
  cat "$LOG"
  exit 1
fi
echo "verify:mount harness up at $URL"

# --- the renderer half --------------------------------------------------------
# Electron, not Chrome: it is the runtime this app actually ships on, so a pass
# here is a pass in the app's own engine (sandbox + contextIsolation included).
CODEX_FOLD_SLOT_DECLARED="$CODEX_FOLD_SLOT_DECLARED" \
  ./node_modules/.bin/electron scripts/mount-probe.cjs "$URL"
