#!/usr/bin/env bash
# Release gate (Epic 86 T10). Machine-run, no eyeballing:
#
#   codesign --verify --deep --strict   the whole bundle, nested code included
#   codesign -dvvv                      WHO signed it, and was it timestamped
#   spctl -a -t exec                    Gatekeeper on the app
#   spctl -a -t open                    Gatekeeper on the dmg a person downloads,
#     --context context:primary-signature   which needs that context spelled out
#   stapler validate                    is the notarization ticket attached
#
# Prints [PASS]/[FAIL] per check, exits non-zero on any failure. Before
# `pnpm notarize` has run, the Gatekeeper and stapler lines are expected to
# fail with `source=Unnotarized Developer ID` — that is the honest state of the
# build, and the reason this script exists instead of a manual click-through.
#
# Two things this script learned the hard way, both measured 2026-09-10:
#   * a disk image must be assessed as a primary signature
#     (`--context context:primary-signature`); without it Gatekeeper answers
#     `rejected / source=Insufficient Context` for a dmg that is perfectly
#     notarized — a false negative in the gate, not a bad artifact;
#   * an artifact's own ticket says nothing about the app inside it, so the zip
#     and the dmg are opened and their contents checked too;
#   * a manifest can describe a build that no longer exists. The first published
#     release (2026-09-10) shipped a `dev-mac.yml` from an earlier run whose
#     sha512 did not match the zip it named: discovery, channel matching and
#     version comparison all passed, because none of them reads the checksum —
#     a real download would have failed. The manifest is checked here now, entry
#     by entry, against the bytes on disk.
set -uo pipefail
cd "$(dirname "$0")/.." # packages/mitsumeru

# ── both architectures, one invocation each ─────────────────────────────────
# The release ships arm64 AND x64, so "the app" is no longer a single path. With
# no argument this script runs itself once per arch and requires BOTH to pass;
# with `--arch` it checks one. Per-arch rather than a loop inside one run, so that
# every existing assertion — the staple inside the zip, the app inside the dmg,
# each manifest entry's sha512 — applies to EACH build. That is exactly what was
# missing when an arm64-only feed shipped beside an Intel app that could not
# start: the gate only ever looked at release/*arm64.*.
if [ "${1:-}" != "--arch" ] && [ "${1:-}" != "--arch="* ]; then
  bash "$0" --arch x64 && bash "$0" --arch arm64
  exit $?
fi
ARCH=${2:-x64}
case "$ARCH" in
  x64) APP=release/mac/Mitsumeru.app; SUFFIX='' ;;
  arm64) APP=release/mac-arm64/Mitsumeru.app; SUFFIX=-arm64 ;;
  *) echo "[FAIL] verify-release: unsupported --arch $ARCH (expected x64 or arm64)"; exit 1 ;;
esac
VERSION=$(node -p "require('./package.json').version")
DMG="release/Mitsumeru-$VERSION$SUFFIX.dmg"
ZIP="release/Mitsumeru-$VERSION$SUFFIX-mac.zip"
echo "── release gate: $ARCH ──"
status=0
check() { # check <description> <command...>
  local what="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "[PASS] $what"
  else
    echo "[FAIL] $what"
    status=1
  fi
}

[ -d "$APP" ] || { echo "[FAIL] $APP missing — run pnpm package:mac:$ARCH"; exit 1; }

# This arch's two artifacts, and no third one. `release/` accumulates across
# builds, and a mixed directory is how a stale dmg or zip gets published next to
# the current one — both `ls -t | head -1` and the publish step's globs would take
# it without complaint. Measured 2026-09-10: a 0.1.1-dev build left the previous
# 0.1.0-dev dmg and zip in place, and only `pnpm check:label` noticed.
if [ -f "$DMG" ] && [ -f "$ZIP" ]; then
  echo "[PASS] artifacts: $ARCH has one dmg and one zip"
else
  echo "[FAIL] artifacts: $ARCH is missing $DMG or $ZIP — run pnpm package:mac:$ARCH && pnpm notarize:$ARCH"
  status=1
fi
all_dmg=$(ls release/*.dmg 2>/dev/null | wc -l | tr -d ' ')
all_zip=$(ls release/*.zip 2>/dev/null | wc -l | tr -d ' ')
if [ "$all_dmg" = "2" ] && [ "$all_zip" = "2" ]; then
  echo "[PASS] artifacts: exactly two dmgs and two zips in release/ (one per arch)"
else
  echo "[FAIL] artifacts: ${all_dmg} dmg and ${all_zip} zip in release/ — expected one of each per arch, and no stale leftovers"
  status=1
fi

check "app: codesign --verify --deep --strict" codesign --verify --deep --strict "$APP"
check "app: Gatekeeper (spctl -a -t exec)" spctl -a -t exec "$APP"

# Signing identity: the point of asserting this instead of trusting the config
# is that an unsigned or wrongly-signed build must not reach a download link.
identity=$(codesign -dvvv "$APP" 2>&1 | sed -n 's/^Authority=//p' | head -1)
team=$(codesign -dvvv "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p' | head -1)
if [ -n "$team" ]; then
  echo "[PASS] app: signed by ${identity:-unknown} (team $team)"
else
  echo "[FAIL] app: no TeamIdentifier — not signed with a Developer ID"
  status=1
fi

# A timestamp is what notarization needs; without it the ticket cannot be issued.
#
# Read into a variable and matched with a shell pattern, never `codesign | grep
# -q`: this script runs under `pipefail`, grep -q exits at the first match, and
# the resulting SIGPIPE makes the whole pipeline look failed — which is exactly
# how this check reported "no timestamp" on a correctly timestamped app.
sig=$(codesign -dvvv "$APP" 2>&1)
case "$sig" in
  *Timestamp=*)
    echo "[PASS] app: signature carries a secure timestamp"
    ;;
  *)
    echo "[FAIL] app: signature has no timestamp (notarization would be refused)"
    status=1
    ;;
esac

# Every Mach-O inside the shipped harness must be signed too — a notarization
# submission fails on the first unsigned binary it finds, and the harness is a
# separate tree (24 445 files, 10 of them code).
unsigned=''
while IFS= read -r f; do
  fileSig=$(codesign -dv "$f" 2>&1)
  case "$fileSig" in
    *TeamIdentifier=*) ;;
    *) unsigned="${unsigned}${f}"$'\n' ;;
  esac
done < <(find "$APP/Contents/Resources/harness" -type f -print0 2>/dev/null \
  | xargs -0 file 2>/dev/null | grep -i 'Mach-O' | cut -d: -f1)

if [ -z "$unsigned" ]; then
  echo "[PASS] harness: every Mach-O binary is signed"
else
  echo "[FAIL] harness: unsigned binaries:"
  echo "$unsigned" | sed 's/^/         /'
  status=1
fi

if [ -n "$DMG" ]; then
  # A dmg has to be assessed as a primary signature. Plain `spctl -a -t open`
  # answers `rejected / source=Insufficient Context` for a notarized image,
  # which is a false negative; with the context it reports the true source
  # (`Notarized Developer ID`, or `no usable signature` when unsigned).
  check "dmg: Gatekeeper (spctl -a -t open)" spctl -a -t open --context context:primary-signature "$DMG"
  check "dmg: stapler validate" xcrun stapler validate "$DMG"
  check "app: stapler validate" xcrun stapler validate "$APP"
else
  echo "[FAIL] no dmg in release/ — run pnpm package:mac"
  status=1
fi

# What a person actually runs is the app *inside* the archive, and an unstapled copy
# still reports `accepted` from spctl for as long as it can reach Apple to ask — so
# each archive is opened and its contents checked, not just the archive itself. This
# is the check that was missing on 2026-09-10: electron-builder decided the existing
# zip was up to date and skipped rewriting it, so `pnpm notarize` shipped a zip
# holding a pre-staple app while every artifact-level check stayed green.
if [ -n "$ZIP" ]; then
  tmp=$(mktemp -d)
  if ditto -x -k "$ZIP" "$tmp" >/dev/null 2>&1; then
    check "zip: app inside carries a stapled ticket" xcrun stapler validate "$tmp/Mitsumeru.app"
    check "zip: app inside passes Gatekeeper" spctl -a -t exec "$tmp/Mitsumeru.app"
  else
    echo "[FAIL] zip: could not extract $ZIP"
    status=1
  fi
  rm -rf "$tmp"
else
  echo "[FAIL] no zip in release/ — the update feed serves the zip"
  status=1
fi

if [ -n "$DMG" ]; then
  mnt=$(mktemp -d)
  if hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$mnt" >/dev/null 2>&1; then
    inner=$(ls -d "$mnt"/*.app 2>/dev/null | head -1 || true)
    if [ -n "$inner" ]; then
      check "dmg: app inside carries a stapled ticket" xcrun stapler validate "$inner"
      check "dmg: app inside passes Gatekeeper" spctl -a -t exec "$inner"
    else
      echo "[FAIL] dmg: no .app inside the image"
      status=1
    fi
    hdiutil detach "$mnt" >/dev/null 2>&1 || true
  else
    echo "[FAIL] dmg: could not mount $DMG"
    status=1
  fi
  rmdir "$mnt" 2>/dev/null || true
fi

# ---- the update manifest ----------------------------------------------------
#
# The manifest is what an update actually downloads against: `path:` names the
# archive and each entry's `sha512`/`size` is the checksum the client verifies.
# The name matters too, and for a reason that is not obvious: the client asks for
# `<channel>-mac.yml`, where the channel comes from the version — while the
# github provider writes `latest-mac.yml` regardless. `notarize.sh` renames it;
# this is where that rename is checked.
MANIFEST=$(ls release/*-mac.yml 2>/dev/null | head -1 || true)
if [ -z "$MANIFEST" ]; then
  echo "[FAIL] manifest: no *-mac.yml in release/ — the feed has nothing to serve"
  status=1
else
  channel=$(node -p "const v = require('./package.json').version; v.includes('-') ? v.split('-')[1].split('.')[0] : 'latest'")
  if [ "$(basename "$MANIFEST")" = "$channel-mac.yml" ]; then
    echo "[PASS] manifest: named $(basename "$MANIFEST") — the file a $channel client asks for"
  else
    echo "[FAIL] manifest: $(basename "$MANIFEST") — a $channel client asks for $channel-mac.yml"
    status=1
  fi

  # Parsed with a small reader rather than a yaml dependency: the shape is fixed
  # (`- url:` then `sha512:` then `size:` under `files:`), and a reader that
  # silently matches nothing must not read as a pass — which is why the absence of
  # an entry is a failure below, not a skip.
  entries=$(node --input-type=module -e '
import { readFileSync } from "node:fs";
const rows = [];
let current = null;
for (const line of readFileSync(process.argv[1], "utf8").split("\n")) {
  const url = /^\s*-\s*url:\s*(.+?)\s*$/.exec(line);
  if (url) { current = { url: url[1] }; continue; }
  if (current === null) continue;
  const sha = /^\s+sha512:\s*(\S+)\s*$/.exec(line);
  if (sha) { current.sha512 = sha[1]; continue; }
  const size = /^\s+size:\s*(\d+)\s*$/.exec(line);
  if (size) { rows.push(`${current.url}\t${current.sha512 ?? ""}\t${size[1]}`); current = null; }
}
console.log(rows.join("\n"));
' "$MANIFEST")

  for artifact in "$ZIP" "$DMG"; do
    [ -n "$artifact" ] || continue
    name=$(basename "$artifact")
    row=$(printf '%s\n' "$entries" | awk -F'\t' -v n="$name" '$1 == n')
    if [ -z "$row" ]; then
      echo "[FAIL] manifest: has no entry for $name"
      status=1
      continue
    fi
    sha=$(printf '%s' "$row" | cut -f2)
    size=$(printf '%s' "$row" | cut -f3)
    actual_sha=$(openssl dgst -sha512 -binary "$artifact" | openssl base64 -A)
    actual_size=$(stat -f %z "$artifact")
    if [ "$sha" = "$actual_sha" ] && [ "$size" = "$actual_size" ]; then
      echo "[PASS] manifest: $name — sha512 and size match the artifact"
    else
      echo "[FAIL] manifest: $name — manifest says ${size}B/${sha:0:12}…, disk has ${actual_size}B/${actual_sha:0:12}…"
      status=1
    fi
  done

  # And the feed must describe BOTH architectures. A manifest listing one is the
  # 0.2.0/0.2.1 shape: an Intel client finds no suitable file and silently stays
  # on whatever it has, which looks like "no update available" rather than a bug.
  entry_count=$(printf '%s\n' "$entries" | grep -c . || true)
  if [ "$entry_count" = "4" ]; then
    echo "[PASS] manifest: lists all four artifacts (a zip and a dmg per arch)"
  else
    echo "[FAIL] manifest: lists ${entry_count} artifact(s), expected 4 — x64 and arm64, zip and dmg. Run pnpm manifest:merge after both arches' notarize runs"
    status=1
  fi
fi

exit "$status"
