#!/usr/bin/env bash
# Update check, end to end (Epic 86 T12).
#
# Runs the PACKAGED app, because electron-updater is inactive in an unpackaged
# one (`update-check-skip updater-inactive`) — so a dev-mode assertion would
# prove nothing about what ships.
#
#   A. a local HTTP server stands in for the feed. Assert the app asks for
#      `dev-mac.yml` (the channel derived from the -dev version), that
#      the startup delay is 15 s + jitter, and that the version it is offered
#      matches the running one.
#   B. the same run against a closed port (the offline case). Assert a logged
#      failure, a retry scheduled, and an app that is still alive — an
#      unreachable feed must never be fatal.
#
# The feed is GitHub Releases (decided 2026-09-10). This smoke proves the client
# half against a local stand-in: scheduling, the channel file name, the -dev
# label, the offline path, and that the packaged config points at our repository.
# What it cannot prove is GitHub's own side — matching the channel against the
# tag's prerelease in `releases.atom`, which needs a really published release.
set -uo pipefail
cd "$(dirname "$0")/.." # packages/mitsumeru

APP=release/mac-arm64/Mitsumeru.app
BIN="$APP/Contents/MacOS/Mitsumeru"
[ -x "$BIN" ] || { echo "[FAIL] $BIN missing — run pnpm package:mac first"; exit 1; }

VERSION=$(node -p "require('./package.json').version")
# The manifest name is the channel electron-builder derived from this version: a
# `-dev` build publishes and asks for dev-mac.yml, a promoted build for
# latest-mac.yml. Asserting the real name is the point — the app must not be
# asking for a file the release never uploads.
case "$VERSION" in
  *-dev) CHANNEL_FILE=dev-mac.yml ;;
  *)     CHANNEL_FILE=latest-mac.yml ;;
esac
WORK=$(mktemp -d -t mitsumeru-updater)
PORT=$(( 45600 + RANDOM % 400 ))
FEED="http://127.0.0.1:$PORT"
status=0
ok()  { echo "[PASS] $1"; }
bad() { echo "[FAIL] $1"; status=1; }

# --- the stand-in feed -------------------------------------------------------

cat >"$WORK/feed.mjs" <<'JS'
// Minimal generic feed: logs every request path, answers any .yml with a
// manifest whose version is handed in on argv. Nothing here is part of the
// shipped app — it is the other end of the protocol, kept deliberately dumb.
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const [, , port, logFile, yml] = process.argv
createServer((req, res) => {
  appendFileSync(logFile, `${req.method} ${req.url}\n`)
  // The client appends ?noCache=<random>, so the path is what identifies the
  // manifest — matching on the whole url would 404 every request.
  if (req.url?.split('?')[0].endsWith('.yml')) {
    res.writeHead(200, { 'content-type': 'text/yaml' })
    res.end(yml)
    return
  }
  res.writeHead(404)
  res.end()
}).listen(Number(port), '127.0.0.1')
JS

run_case() { # run_case <name> <feed-url> <wait-for-pattern> <log>
  local name="$1" feed="$2" pattern="$3" log="$4"
  MITSUMERU_UPDATE_FEED="$feed" \
  MITSUMERU_DSH_HOME="$WORK/$name-state" \
  MITSUMERU_LOG_DIR="$WORK/$name-logs" \
  "$BIN" >"$log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 75); do
    grep -q "$pattern" "$log" && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  # Quit the way a person would: SIGTERM, then let the shell's own will-quit
  # path stop the harness child.
  kill -TERM "$pid" 2>/dev/null
  for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then
    bad "$name: app ignored SIGTERM"
    kill -9 "$pid" 2>/dev/null
  else
    ok "$name: app exited cleanly"
  fi
}

# --- A. feed reachable -------------------------------------------------------

# A manifest at the RUNNING version: the clean path, and the one that proves the
# client parsed what the feed served rather than merely logging a request.
cat >"$WORK/$CHANNEL_FILE" <<YML
version: $VERSION
files:
  - url: Mitsumeru-$VERSION-arm64-mac.zip
    sha512: $(node -e "console.log('0'.repeat(128))")
    size: 1
path: Mitsumeru-$VERSION-arm64-mac.zip
sha512: $(node -e "console.log('0'.repeat(128))")
releaseDate: '2026-09-10T00:00:00.000Z'
YML

# The packaged app-update.yml is the authoritative config in a real run (the
# override exists only so a smoke can point at this server), so the channel it
# records has to name the same file the client asks for. Checking both closes
# the gap that a stale/mismatched channel would otherwise hide behind the
# override.
# A `--dir` build ships without app-update.yml — electron-builder writes it only
# for the dmg/zip targets (measured, T12) — and an absent file would otherwise
# read as "provider=none, channel=latest", making a build look misconfigured when
# it is merely the wrong kind of build. Say which it is.
PACKAGED_CONFIG="$APP/Contents/Resources/app-update.yml"
if [ ! -f "$PACKAGED_CONFIG" ]; then
  bad "config: $PACKAGED_CONFIG is missing — a --dir build has no feed config; run pnpm package:mac"
fi

# With the generic provider the packaged config named the channel file, so a
# mismatch (channel: dev in an app whose version says otherwise) was a real
# failure mode worth asserting. With GitHub the field is gone: electron-builder
# writes only provider/owner/repo/releaseType, and the channel comes from the
# version at runtime (`0.1.0-dev` → `dev`) and from the release TAG at feed time.
# So the assertion inverts — a `channel:` here would be a second source of truth
# that can drift, and the version is the one that decides.
PACKAGED_CHANNEL=$(sed -n 's/^channel: //p' "$PACKAGED_CONFIG" 2>/dev/null | head -1)
if [ -z "$PACKAGED_CHANNEL" ]; then
  ok "config: no channel pinned in app-update.yml — version $VERSION is the only source, and it names $CHANNEL_FILE"
else
  bad "config: app-update.yml pins channel '$PACKAGED_CHANNEL' — with the github provider the version and the tag decide it, and a pinned copy drifts"
fi

# With the generic provider this was a url; with GitHub it is owner/repo, and a
# wrong pair is a silent failure mode — the app would poll somebody else's
# repository, or a 404 that looks like an offline machine.
IDENTITY_REPO=$(node --input-type=module -e '
import { readFileSync } from "node:fs";
const src = readFileSync("src/shared/identity.ts", "utf8");
const pick = (k) => new RegExp(`${k} = .([^\x27]+).`).exec(src)?.[1] ?? "";
console.log(`${pick("UPDATE_OWNER")}/${pick("UPDATE_REPO")}`);
')
PACKAGED_PROVIDER=$(sed -n 's/^provider: //p' "$PACKAGED_CONFIG" | head -1)
PACKAGED_OWNER=$(sed -n 's/^owner: //p' "$PACKAGED_CONFIG" | head -1)
PACKAGED_REPO=$(sed -n 's/^repo: //p' "$PACKAGED_CONFIG" | head -1)
if [ "$PACKAGED_PROVIDER" = github ] && [ "$PACKAGED_OWNER/$PACKAGED_REPO" = "$IDENTITY_REPO" ]; then
  ok "config: packaged feed targets github.com/$PACKAGED_OWNER/$PACKAGED_REPO"
else
  bad "config: packaged feed is provider='${PACKAGED_PROVIDER:-none}' '${PACKAGED_OWNER:-none}/${PACKAGED_REPO:-none}' — expected github '$IDENTITY_REPO'"
fi

node "$WORK/feed.mjs" "$PORT" "$WORK/requests.log" "$(cat "$WORK/$CHANNEL_FILE")" &
FEED_PID=$!
sleep 1

run_case online "$FEED" 'update-current\|update-check-result' "$WORK/online.log"
kill "$FEED_PID" 2>/dev/null

if grep -q "GET /$CHANNEL_FILE" "$WORK/requests.log"; then
  ok "online: app requested $CHANNEL_FILE from our feed"
else
  bad "online: no GET /$CHANNEL_FILE — requests seen: $(tr '\n' ' ' <"$WORK/requests.log")"
fi

# 15 s base plus 0–5 s jitter; the jitter is logged so it can be seen, not
# assumed.
delay=$(sed -n 's/.*update-check-scheduled delayMs=\([0-9]*\).*/\1/p' "$WORK/online.log" | head -1)
if [ -n "$delay" ] && [ "$delay" -ge 15000 ] && [ "$delay" -lt 20000 ]; then
  ok "online: startup check scheduled at ${delay}ms (15 s + jitter)"
else
  bad "online: startup delay '${delay:-none}' is outside 15000–19999 ms"
fi

if grep -q 'reason=startup' "$WORK/online.log"; then
  ok "online: first check is the startup one"
else
  bad "online: no startup-scheduled line"
fi

if grep -q "update-current version=$VERSION\|update-check-result current=$VERSION" "$WORK/online.log"; then
  ok "online: feed manifest parsed and compared against $VERSION"
else
  bad "online: app never reported the served version"
fi

if grep -q 'update-check-scheduled.*reason=cadence' "$WORK/online.log"; then
  ok "online: 6 h cadence scheduled after the check"
else
  bad "online: no cadence line after the check"
fi

if grep -qE 'version [0-9.]+-dev dev-build' "$WORK/online.log"; then
  ok "online: startup log carries the -dev label (T11)"
else
  bad "online: startup log is missing the -dev version label"
fi

# The version is what names the channel now that the packaged config carries
# none, so the app's own startup line is the place to see it decided.
if grep -q "update-feed .*channel=${CHANNEL_FILE%-mac.yml} " "$WORK/online.log"; then
  ok "online: app resolved channel ${CHANNEL_FILE%-mac.yml} from its version"
else
  bad "online: no update-feed line naming channel ${CHANNEL_FILE%-mac.yml}"
fi

# --- B. feed unreachable -----------------------------------------------------

DEAD_PORT=$(( PORT + 1 ))
run_case offline "http://127.0.0.1:$DEAD_PORT" 'update-check-scheduled.*reason=retry' "$WORK/offline.log"

if grep -q 'update-check-failed' "$WORK/offline.log"; then
  ok "offline: failure logged instead of thrown"
else
  bad "offline: no update-check-failed line"
fi

if grep -q 'update-check-scheduled.*reason=retry' "$WORK/offline.log"; then
  ok "offline: retry scheduled"
else
  bad "offline: no retry scheduled after the failure"
fi

if grep -q 'harness-ready http://127.0.0.1' "$WORK/offline.log"; then
  ok "offline: harness booted anyway"
else
  bad "offline: harness did not boot with the feed down"
fi

echo "update smoke: logs in $WORK"
exit "$status"
