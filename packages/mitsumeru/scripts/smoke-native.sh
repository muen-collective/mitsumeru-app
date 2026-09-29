#!/usr/bin/env bash
# Native closure + title surface, in the PACKAGED app (Epic 86 T7 open items).
#
# T7 handed two questions forward. Both are answered by running the artifact we
# ship rather than the source tree:
#
#   1. Native postinstall scripts. pnpm blocks them by default, and the harness
#      child runs under Electron-as-node, whose NODE_MODULE_VERSION differs from
#      the system node's — an ABI-bound addon would fail in that context and
#      nowhere else. Importing the modules is NOT sufficient evidence: the only
#      blocked postinstall that matters (@deepseek-ai/dsh-subprocess-local) just
#      restores the executable bit on node-pty's spawn-helper, so a closure that
#      lost it still requires cleanly and fails when a pty is first spawned.
#      Hence a real spawn, a real FFI call, and a real image encode.
#   2. Brand title. The harness UI title differs by form (published tarball vs a
#      build from a checkout). Which one the npm closure serves is recorded here,
#      because that is the surface the brand work in Epic 80/85 has to rewrite.
#
# A control runs beside the load tests: the same addon, re-signed ad hoc, loads
# in the same process. It does, because the app carries Electron's default
# `disable-library-validation` entitlement. The check asserts the entitlement and
# the behaviour agree — so tightening the entitlement later fails here and forces
# the change to be deliberate — rather than endorsing either state.
set -uo pipefail
cd "$(dirname "$0")/.." # packages/mitsumeru

APP=release/mac-arm64/Mitsumeru.app
BIN="$APP/Contents/MacOS/Mitsumeru"
H="$APP/Contents/Resources/harness/node_modules"
[ -x "$BIN" ] || { echo "[FAIL] $BIN missing — run pnpm package:mac first"; exit 1; }

WORK=$(mktemp -d -t mitsumeru-native)
status=0
ok()  { echo "[PASS] $1"; }
bad() { echo "[FAIL] $1"; status=1; }

APP_TEAM=$(codesign -dv "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')
PRODUCT=$(node -p "require('./package.json').productName")

# --- the ABI the harness child actually runs under ---------------------------

APP_ABI=$(ELECTRON_RUN_AS_NODE=1 "$BIN" -e 'console.log(process.versions.node + " modules=" + process.versions.modules)' 2>/dev/null)
SYS_ABI=$(node -e 'console.log(process.versions.node + " modules=" + process.versions.modules)')
echo "abi: harness child runs node $APP_ABI; system node $SYS_ABI"

# --- 1a. the installer pnpm blocked ------------------------------------------

# node-pty's own `install`/`postinstall` are blocked too, but it ships
# prebuilds; the one whose absence is silent is this one.
SPAWN_HELPER="$H/node-pty/prebuilds/darwin-arm64/spawn-helper"
if [ -x "$SPAWN_HELPER" ]; then
  ok "blocked postinstall: node-pty spawn-helper is executable ($(stat -f '%Sp' "$SPAWN_HELPER"))"
else
  bad "blocked postinstall: node-pty spawn-helper missing or not executable — pty spawn would fail at runtime"
fi

# --- 1b. signed by the same identity as the app ------------------------------

# sharp's pair is versioned by upstream; resolve the real filenames so a
# closure bump cannot fail this check with a stale fixture name (broke on the
# 0.2.0-rc.2 re-pin: 0.35.4/8.18.6 → 0.35.5/8.18.7).
SHARP_NODE=$(basename "$(ls "$H"/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-*.node 2>/dev/null | head -1)")
SHARP_VIPS=$(basename "$(ls "$H"/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.*.dylib 2>/dev/null | head -1)")

for lib in \
  "node-pty/prebuilds/darwin-arm64/pty.node" \
  "node-pty/prebuilds/darwin-arm64/spawn-helper" \
  "@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node" \
  "@img/sharp-darwin-arm64/lib/$SHARP_NODE" \
  "@img/sharp-libvips-darwin-arm64/lib/$SHARP_VIPS" \
  "@deepseek-ai/node-addon-system-darwin-arm64/bin/system.node"; do
  name=$(basename "$lib")
  sig=$(codesign -dv "$H/$lib" 2>&1)
  team=$(echo "$sig" | sed -n 's/^TeamIdentifier=//p')
  if [ "$team" = "$APP_TEAM" ] && echo "$sig" | grep -q 'flags=0x10000(runtime)'; then
    ok "signed: $name — same team, hardened runtime"
  else
    bad "signed: $name — team '${team:-none}' / flags '$(echo "$sig" | sed -n 's/.*flags=\([^ ]*\).*/\1/p' | head -1)'"
  fi
done

# --- 1c. and the addons actually work, not merely import ---------------------

PTY=$(ELECTRON_RUN_AS_NODE=1 "$BIN" -e '
process.env.NODE_PATH = process.argv[1];
require("module").Module._initPaths();
const pty = require("node-pty");
let out = "";
const p = pty.spawn("/bin/sh", ["-c", "printf PTY_OK; tty"], { name: "xterm-color", cols: 80, rows: 24, env: process.env });
p.onData((d) => { out += d; });
p.onExit(({ exitCode }) => {
  const text = out.replace(/\r/g, "");
  console.log(text.includes("PTY_OK") && /\/dev\/tty/.test(text) && exitCode === 0 ? "RESULT spawned " + JSON.stringify(text.trim()) : "RESULT fail exit=" + exitCode + " out=" + JSON.stringify(text));
  process.exit(0);
});
setTimeout(() => { console.log("RESULT fail timeout out=" + JSON.stringify(out)); process.exit(0); }, 8000);
' "$H" 2>&1)
case "$PTY" in
  "RESULT spawned "*) ok "node-pty: real pty spawned — ${PTY#RESULT spawned }" ;;
  *) bad "node-pty: pty spawn failed — ${PTY:-no output}" ;;
esac

KOFFI=$(ELECTRON_RUN_AS_NODE=1 "$BIN" -e '
process.env.NODE_PATH = process.argv[1];
require("module").Module._initPaths();
const koffi = require("koffi");
const getpid = koffi.load("libc.dylib").func("int getpid()");
console.log(getpid() === process.pid ? "RESULT called v" + koffi.version : "RESULT wrong-pid");
' "$H" 2>&1)
case "$KOFFI" in
  "RESULT called "*)
    ok "koffi: called libc through FFI (${KOFFI#RESULT called })"
    ;;
  *) bad "koffi: FFI call failed — ${KOFFI:-no output}" ;;
esac

SHARP=$(ELECTRON_RUN_AS_NODE=1 "$BIN" -e '
process.env.NODE_PATH = process.argv[1];
require("module").Module._initPaths();
const sharp = require("sharp");
sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } } })
  .png()
  .toBuffer()
  .then((buf) => console.log(buf.length > 0 ? "RESULT encoded vips=" + sharp.versions.vips : "RESULT empty"))
  .catch((e) => console.log("RESULT fail " + String(e.message).split("\n")[0]));
' "$H" 2>&1)
case "$SHARP" in
  "RESULT encoded "*)
    ok "sharp: encoded a PNG through libvips (${SHARP#RESULT encoded })"
    ;;
  *) bad "sharp: encode failed — ${SHARP:-no output}" ;;
esac

# --- 1d. posture: is same-team loading enforced? -----------------------------

ENTITLEMENTS=$(codesign -d --entitlements - --xml "$APP" 2>/dev/null | plutil -convert xml1 -o - - 2>/dev/null)

# The control: the same addon, stripped of our signature and re-signed ad hoc.
# A missing control file must not read as "rejected" — that would turn a broken
# check into a passing verdict.
ADHOC_SRC="$H/node-pty/prebuilds/darwin-arm64/pty.node"
if [ -f "$ADHOC_SRC" ]; then
  cp "$ADHOC_SRC" "$WORK/adhoc.node"
  codesign --force --sign - "$WORK/adhoc.node" >/dev/null 2>&1
  ADHOC=$(ELECTRON_RUN_AS_NODE=1 "$BIN" -e '
const path = process.argv[1];
if (!require("node:fs").existsSync(path)) { console.log("control-missing"); process.exit(0); }
try { require(path); console.log("loaded"); }
catch (e) { console.log("rejected " + String(e.message).split("\n")[0].slice(0, 80)); }
' "$WORK/adhoc.node" 2>&1)
else
  ADHOC=control-missing
fi

case "$ADHOC" in
  control-missing)
    bad "posture: ad-hoc control could not run (no addon at $ADHOC_SRC) — no verdict on library validation" ;;
  loaded)
    if echo "$ENTITLEMENTS" | grep -q 'disable-library-validation'; then
      ok "posture: library validation OFF (entitlement present) — an ad-hoc-signed addon loads too; recorded, not endorsed"
    else
      bad "posture: no disable-library-validation entitlement, yet an ad-hoc-signed addon loaded"
    fi ;;
  rejected*)
    if echo "$ENTITLEMENTS" | grep -q 'disable-library-validation'; then
      bad "posture: entitlement says library validation is off, yet the ad-hoc addon was rejected ($ADHOC)"
    else
      ok "posture: library validation enforces the same team (ad-hoc addon rejected)"
    fi ;;
  *)
    bad "posture: unexpected control output: $ADHOC" ;;
esac

# --- 2. the title surface of the harness the npm closure serves --------------

TITLES=$(node --input-type=module -e '
import { readFileSync } from "node:fs";
const list = /HARNESS_TITLES = \[([^\]]+)\]/.exec(readFileSync("src/shared/identity.ts", "utf8"))?.[1] ?? "";
console.log(list.split(",").map((s) => s.trim().replace(/^.|.$/g, "")).filter(Boolean).join("|"));
')
MITSUMERU_SMOKE=1 \
MITSUMERU_DSH_HOME="$WORK/state" \
MITSUMERU_LOG_DIR="$WORK/logs" \
MITSUMERU_UPDATE_DISABLE=1 \
"$BIN" >"$WORK/run.log" 2>&1 &
PID=$!
for _ in $(seq 1 90); do
  grep -q 'smoke-quit' "$WORK/run.log" && break
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
kill -TERM "$PID" 2>/dev/null
for _ in $(seq 1 15); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
kill -9 "$PID" 2>/dev/null

SERVED=$(sed -n 's/^\[mitsumeru\] window-title //p' "$WORK/run.log" | tail -1)
if [ -n "$SERVED" ] && [[ "|$TITLES|" == *"|$SERVED|"* ]]; then
  ok "brand: the npm-installed harness serves \"$SERVED\" — the title the brand work must rewrite"
else
  bad "brand: harness title \"${SERVED:-none}\" is not one of ($TITLES)"
fi

# The splash is ours, so it carries the product name — and never the pilot's
# codename, which is exactly how `wrap-pilot` reached a user-visible title once.
SPLASH=$(sed -n 's/^\[mitsumeru\] window-title //p' "$WORK/run.log" | head -1)
if [ "$SPLASH" = "$PRODUCT" ]; then
  ok "brand: splash title is the product name ($SPLASH)"
else
  bad "brand: splash title is \"${SPLASH:-none}\" — expected \"$PRODUCT\""
fi

if grep -rq 'wrap-pilot' "$APP/Contents/Resources/app" 2>/dev/null; then
  bad "brand: the pilot codename 'wrap-pilot' still ships inside the app bundle"
else
  ok "brand: no pilot codename in the shipped bundle"
fi

echo "native smoke: log in $WORK"
exit "$status"
