#!/usr/bin/env bash
# verify:arch — is this app built for the architecture it claims, and does the
# harness inside it actually BOOT on that architecture?
#
# Why this is a gate rather than a build-log glance: electron-builder copies ONE
# staged harness tree into whatever it builds, so a single invocation can produce
# two apps for two architectures from one tree — and the loser silently carries the
# other architecture's native addons. Measured 2026-09-19: `--mac --x64` with a
# pinned `arch: [arm64, x64]` in electron-builder.yml produced release/mac
# (x86_64, correct) AND release/mac-arm64 — an arm64 app whose harness held
# node-addon-require-builtin-darwin-x64. Nothing in the build log says so; both
# apps "built successfully". An x86_64 addon cannot be loaded by an arm64 process,
# so the second app cannot start.
#
# Two checks, both read off the artifact:
#   1. the Mach-O binaries — the app and the harness addon it must load;
#   2. a real boot of the packaged harness, on the package's own Electron binary
#      (under Rosetta when the app is x86_64 on an arm64 host).
#
# Usage: bash scripts/verify-arch.sh <path/to/Mitsumeru.app> [x86_64|arm64]
set -euo pipefail
cd "$(dirname "$0")/.." # packages/mitsumeru

APP=${1:?usage: verify-arch.sh <path/to/Mitsumeru.app> [x86_64|arm64]}
WANT=${2:-}
[ -d "$APP" ] || { echo "[FAIL] no app at $APP"; exit 1; }
# Absolute, because the profile plugin symlinks below are built from this path — a
# relative one makes every link dangle, and the loader then reports the plugin as
# "Cannot find package", which reads like a product defect and is not.
APP=$(cd "$APP" && pwd)

APP_BIN="$APP/Contents/MacOS/Mitsumeru"
HARNESS="$APP/Contents/Resources/harness"
ENTRY="$HARNESS/node_modules/@deepseek-ai/dsh/lib/bin.js"
[ -f "$APP_BIN" ] || { echo "[FAIL] missing $APP_BIN"; exit 1; }
[ -f "$ENTRY" ] || { echo "[FAIL] missing $ENTRY — the harness resource is not in this app"; exit 1; }

# ---- 1. the binaries say which architecture this is -------------------------
APP_ARCH=$(lipo -archs "$APP_BIN" 2>/dev/null || file -b "$APP_BIN" | grep -oE 'x86_64|arm64' | head -1)
case "$APP_ARCH" in
  x86_64) ADDON=darwin-x64; OTHER=darwin-arm64 ;;
  arm64) ADDON=darwin-arm64; OTHER=darwin-x64 ;;
  *) echo "[FAIL] cannot read the app's architecture (lipo said '$APP_ARCH')"; exit 1 ;;
esac
if [ -n "$WANT" ] && [ "$APP_ARCH" != "$WANT" ]; then
  echo "[FAIL] app is $APP_ARCH, expected $WANT"; exit 1
fi
echo "verify:arch app        : $APP_ARCH ($APP)"

NEEDED="$HARNESS/node_modules/node-addon-require-builtin-$ADDON"
UNWANTED="$HARNESS/node_modules/node-addon-require-builtin-$OTHER"
[ -d "$NEEDED" ] || { echo "[FAIL] the harness has no $ADDON native addon — this app cannot load its own harness"; exit 1; }
if [ -d "$UNWANTED" ]; then
  echo "[FAIL] the harness ALSO carries $OTHER — this tree was staged for the wrong target"
  exit 1
fi
ADDON_FILE=$(find "$NEEDED" -name '*.node' | head -1)
ADDON_ARCH=$(file -b "$ADDON_FILE" | grep -oE 'x86_64|arm64' | head -1)
[ "$ADDON_ARCH" = "$APP_ARCH" ] || { echo "[FAIL] app is $APP_ARCH but its addon is $ADDON_ARCH"; exit 1; }
echo "verify:arch addon      : $(basename "$ADDON_FILE") is $ADDON_ARCH, and $OTHER is absent"

# ---- 2. boot the packaged harness, on the package's own runtime -------------
# The harness is a child process of this app's Electron, so booting it with THIS
# app's binary as node is the same runtime the field gets — including the
# architecture, which is the whole question. `--port 0` keeps it off any fixed port.
HOME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mitsumeru-verifyarch-XXXXXX")
LOG="$HOME_DIR/boot.log"
HARNESS_PID=''
cleanup() {
  [ -n "$HARNESS_PID" ] && kill "$HARNESS_PID" 2>/dev/null || true
  rm -rf "$HOME_DIR"
}
trap cleanup EXIT

# The profile the app writes, with this app's own vendored plugins linked in.
node --input-type=module -e '
import { mkdirSync, writeFileSync, symlinkSync, readdirSync } from "node:fs"
import { join } from "node:path"
const [home, profile, harness] = process.argv.slice(1)
const dir = join(home, "profiles", profile)
mkdirSync(join(dir, "node_modules", "@muen"), { recursive: true })
const vendor = join(harness, "node_modules", "@muen")
const plugins = readdirSync(vendor).map((n) => `@muen/${n}`)
writeFileSync(join(dir, "package.json"), JSON.stringify({
  name: `dsh-profile-${profile}`,
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", ...plugins], patchReload: "live" } }
}, undefined, 2) + "\n")
writeFileSync(join(dir, "cordis.patch.yml"), "[]\n")
writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - .\n")
for (const name of readdirSync(vendor)) {
  symlinkSync(join(vendor, name), join(dir, "node_modules", "@muen", name), "dir")
}
' "$HOME_DIR" mitsu "$HARNESS"

HOST_ARCH=$(uname -m)
RUN=()
if [ "$APP_ARCH" != "$HOST_ARCH" ]; then
  RUN=(arch "-$APP_ARCH")   # Rosetta, for an x86_64 app on an arm64 host
  echo "verify:arch boot       : under $(echo "${RUN[@]}") (host is $HOST_ARCH)"
fi

# `${RUN[@]+...}` and not plain `"${RUN[@]}"`: under `set -u` an EMPTY array expands
# as an unbound variable, which is exactly the native-architecture path (no Rosetta).
DSH_HOME="$HOME_DIR" ELECTRON_RUN_AS_NODE=1 ${RUN[@]+"${RUN[@]}"} "$APP_BIN" "$ENTRY" \
  --profile mitsu --no-open --host 127.0.0.1 --port 0 > "$LOG" 2>&1 &
HARNESS_PID=$!

URL=''
# Generous on purpose: when the app is x86_64 on an arm64 host every module in a
# 25 000-file tree is JIT-translated, so a boot that takes ~10s natively can take a
# minute or more. A short timeout here reads as "does not boot" and is wrong.
for _ in $(seq 1 120); do
  URL=$(sed -n 's/^dsh web: \(http.*\)$/\1/p' "$LOG" 2>/dev/null | head -1)
  [ -n "$URL" ] && break
  kill -0 "$HARNESS_PID" 2>/dev/null || break
  sleep 1
done
if [ -z "$URL" ]; then
  echo "[FAIL] the $APP_ARCH harness never printed a readiness line:"
  sed -n '1,40p' "$LOG"
  exit 1
fi
echo "verify:arch boot       : harness up at ${URL%%\?*}"

# The page is the last thing that proves the addons loaded — a harness that cannot
# load a native addon can still bind a port. Follow the redirect and keep the
# cookie: the readiness URL carries a one-time token that answers 303 and sets the
# `dsh-auth-*` cookie the real page needs (mount-probe.cjs documents the same flow).
CODE=$(curl -sL -c "$HOME_DIR/cookies" -b "$HOME_DIR/cookies" -o "$HOME_DIR/page.html" -w '%{http_code}' "$URL" || true)
[ "$CODE" = '200' ] || { echo "[FAIL] harness served HTTP $CODE"; sed -n '1,40p' "$LOG"; exit 1; }
SIZE=$(wc -c < "$HOME_DIR/page.html" | tr -d ' ')
[ "$SIZE" -gt 1000 ] || { echo "[FAIL] harness served $SIZE bytes"; exit 1; }

echo "verify:arch PASS: $APP_ARCH app, $APP_ARCH harness addon, $OTHER absent, harness boots and serves ($SIZE bytes) on its own runtime"
