#!/usr/bin/env bash
# Notarization (Epic 86 T10).
#
# Order matters, and it is the whole content of this script:
#   1. submit the signed .app (zipped) and staple the ticket to it;
#   2. re-package dmg + zip FROM that stapled app, so the copy inside each
#      artifact carries the ticket already;
#   3. submit + staple the dmg as well, because `spctl -a -t open` on a dmg
#      checks the dmg, not the app inside it.
#
# Why not `mac.notarize: true` in electron-builder.yml: the dmg and the zip are
# built before any ticket exists, and a zip cannot be stapled after the fact —
# its checksum is written into latest-mac.yml at build time, so regenerating it
# would break the update feed. Notarizing first and packaging second is the only
# order where all three artifacts agree.
#
# Credentials come from the login keychain or the environment, never the repo:
#   pnpm store:credentials                    # once: writes the keychain profile
#   NOTARY_PROFILE=asuka-notary pnpm notarize
# or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID.
# The store step goes through scripts/store-notary-credentials.sh rather than a pasted
# one-liner: bracketed placeholders read as "substitute here" in prose but are redirection
# operators in zsh, and a parse error there looks exactly like a credentials problem.
set -euo pipefail
cd "$(dirname "$0")/.." # packages/mitsumeru

# ── which architecture this run owns ────────────────────────────────────────
# One invocation per arch, because each app is notarized and stapled as its own
# bundle and then repackaged into its own artifacts. Everything this run writes is
# confined to $SUFFIX, so the other arch's dmg/zip/manifest survive it.
#
# The previous shape was single-arch by construction: it deleted EVERY
# release/*.dmg, *.zip and *-mac.yml and repacked only from release/mac-arm64.
# That is exactly how a two-arch release silently became arm64-only — 0.2.0 and
# 0.2.1 both shipped that way, and the build log said nothing.
ARCH=arm64
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH=$2; shift 2 ;;
    --arch=*) ARCH=${1#*=}; shift ;;
    *) echo "[FAIL] notarize: unknown argument: $1"; exit 1 ;;
  esac
done
case "$ARCH" in
  arm64) APP_DIR=mac-arm64; SUFFIX=-arm64 ;;
  x64)   APP_DIR=mac;       SUFFIX='' ;;
  *) echo "[FAIL] notarize: unsupported --arch $ARCH (expected arm64 or x64)"; exit 1 ;;
esac
APP="release/$APP_DIR/Mitsumeru.app"
VERSION=$(node -p "require('./package.json').version")
echo "notarize: arch $ARCH → $APP"

if [ -n "${NOTARY_PROFILE:-}" ]; then
  AUTH=(--keychain-profile "$NOTARY_PROFILE")
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  AUTH=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
else
  # Nothing was NAMED — which is not the same as nothing being stored, and saying
  # "no credentials" for both cost real time on 2026-09-24: the stored
  # `asuka-notary` profile was live and working the whole time (notarytool history
  # showed every release accepted); the failure was only that this run did not name
  # it. So probe the name this repo STORES under before concluding anything.
  #
  # `store-notary-credentials.sh` defaults to `asuka-notary`, and that asymmetry —
  # store defaults, notarize requires an explicit name — is the trap. `security`
  # cannot help here: notarytool keeps its item out of reach of a plain keychain
  # search, while `notarytool history` answers for a named profile. It is a read:
  # no submission, and no credential is printed.
  DEFAULT_PROFILE="${NOTARY_PROFILE:-asuka-notary}"
  if xcrun notarytool history --keychain-profile "$DEFAULT_PROFILE" >/dev/null 2>&1; then
    {
      echo "[FAIL] notarization profile was not named — nothing was submitted."
      echo "  But '$DEFAULT_PROFILE' IS stored in this keychain and works."
      echo "  Run:  NOTARY_PROFILE=$DEFAULT_PROFILE pnpm notarize:[x64|arm64]"
    } >&2
    exit 2
  fi

  cat >&2 <<'MSG'
[FAIL] no notarization credentials — nothing was submitted, and the keychain holds
       no stored notarytool profile under the default name.
  Store them once:  pnpm store:credentials
  Then run:         NOTARY_PROFILE=asuka-notary pnpm notarize
  (or export APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID)
  Signing without notarization still works: pnpm package:mac
MSG
  exit 2
fi

[ -d "$APP" ] || { echo "[FAIL] $APP missing — run pnpm package:mac:$ARCH first"; exit 1; }

# The identity is read back from the app that was just signed, so this script
# never carries a name either. `Authority=` is the leaf certificate.
IDENTITY=$(codesign -dvvv "$APP" 2>&1 | sed -n 's/^Authority=//p' | head -1)
[ -n "$IDENTITY" ] || { echo "[FAIL] $APP carries no signing authority — sign it first"; exit 1; }
echo "notarize: signing as $IDENTITY"

submit() {
  echo "notarize: submitting $1"
  xcrun notarytool submit "$1" "${AUTH[@]}" --wait --timeout 45m
}

# --- 1. the app -------------------------------------------------------------

APP_ZIP="release/.notarize-$VERSION-app.zip"
rm -f "$APP_ZIP"
# ditto, not zip: it preserves the symlinks and resource forks inside the
# bundle, and notarytool rejects an archive that does not match the bundle.
ditto -c -k --keepParent "$APP" "$APP_ZIP"
submit "$APP_ZIP"
echo "notarize: stapling $APP"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
rm -f "$APP_ZIP"

# --- 2. repackage from the stapled app --------------------------------------

echo "notarize: repackaging dmg + zip from the stapled app"
# The old artifacts are deleted first, on purpose. electron-builder decides an
# existing archive is "up to date" and skips rewriting it — measured 2026-09-10:
# `skipped archiving reason=Archive file is up to date` on the zip, leaving one
# built before the staple, whose app carries no ticket ("does not have a ticket
# stapled to it", on the extracted copy). spctl still called that copy `accepted`
# because it could reach Apple and ask. Deleting first makes the rewrite
# unavoidable, which is the entire point of repackaging from the stapled app.
# Only THIS arch's artifacts, plus the channel manifest this run is about to
# replace. The other arch's artifacts are the product of its own run and must
# survive — deleting them is what made 0.2.0 and 0.2.1 arm64-only.
rm -f "release/Mitsumeru-$VERSION$SUFFIX.dmg" "release/Mitsumeru-$VERSION$SUFFIX.dmg.blockmap" \
      "release/Mitsumeru-$VERSION$SUFFIX-mac.zip" "release/Mitsumeru-$VERSION$SUFFIX-mac.zip.blockmap" \
      release/latest-mac.yml release/dev-mac.yml
# `--$ARCH` is load-bearing, not decoration. Without it electron-builder packages
# for the HOST architecture rather than the app it was handed — measured
# 2026-09-19: `--prepackaged release/mac/Mitsumeru.app` (the Intel app) produced
# ARM64 artifacts on this machine, reused the existing arm64 zip as "up to date",
# and the archive was named in this run's manifest rewrite. The x64 app never
# became a dmg at all, and only the caller's existence check noticed.
npx electron-builder --mac dmg zip "--$ARCH" --prepackaged "$APP" --publish never

# --- 2b. the update manifest ------------------------------------------------
#
# The manifest is deleted above with the archives and re-sorted here, for two
# measured reasons:
#
#   * it is written by the same tooling that decided an "up to date" archive
#     could be skipped, so it can end up describing a build that no longer
#     exists. The first published release proved it (2026-09-10): the manifest
#     was from an earlier run, its sha512 did not match the zip, and the only
#     reason nothing failed is that discovery and version comparison do not read
#     the checksum. Any real download would have.
#   * with the github provider, electron-builder names it `latest-mac.yml` even
#     for a `-dev` version, while the client asks for `dev-mac.yml` (the generic
#     provider it replaced derived the name from the version). Renaming here
#     keeps ONE rule — the version names the channel — instead of pinning
#     `channel:` in electron-builder.yml, which would be a second source of the
#     same fact, free to drift from the version.
MANIFEST=$(ls release/latest-mac.yml release/*-mac.yml 2>/dev/null | head -1 || true)
[ -n "$MANIFEST" ] || { echo "[FAIL] the repackage wrote no update manifest"; exit 1; }
# Kept as this arch's FRAGMENT rather than published as the feed: a two-arch feed
# is one file listing both arches' artifacts, and electron-builder writes one
# manifest per invocation. `pnpm manifest:merge` assembles the feed from these.
FRAGMENT="release/.manifest-$ARCH.yml"
mv "$MANIFEST" "$FRAGMENT"
echo "notarize: manifest $(basename "$MANIFEST") → $(basename "$FRAGMENT") (the feed is merged across arches after both runs)"

# --- 3. the dmg -------------------------------------------------------------

# This arch's dmg, by name: with both arches in release/, `ls -t` picks whichever
# was written last — which is how the wrong image gets signed and stapled.
DMG="release/Mitsumeru-$VERSION$SUFFIX.dmg"
[ -f "$DMG" ] || { echo "[FAIL] the repackage wrote no $DMG"; exit 1; }
# electron-builder does not sign the dmg (verified 2026-09-10: `codesign -dv` on
# the artifact says "code object is not signed at all"), and an unsigned disk
# image cannot be notarized — so sign it here, with a timestamp, first.
echo "notarize: signing $DMG"
codesign --sign "$IDENTITY" --timestamp --force "$DMG"
submit "$DMG"
echo "notarize: stapling $DMG"
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"

# --- 3b. the manifest's dmg entry -------------------------------------------
#
# The dmg's bytes are not final when the repackage writes the manifest: signing
# it and stapling a ticket onto it both change the file, so the entry the builder
# wrote describes a dmg that no longer exists. The gate caught exactly this on
# the first run of the corrected pipeline (sha512 and size both off). The zip
# needs no equivalent treatment — nothing touches it after the repackage, which
# is why its entry already matched.
#
# Patched rather than regenerated: the rest of the file is the builder's output
# and is correct, and rewriting the whole manifest by hand would put our own
# idea of the format between the client and its own tooling.
MANIFEST="$FRAGMENT"
DMG_SHA=$(openssl dgst -sha512 -binary "$DMG" | openssl base64 -A)
DMG_SIZE=$(stat -f %z "$DMG")
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const [file, url, sha, size] = process.argv.slice(1);
const lines = readFileSync(file, "utf8").split("\n");
let inEntry = false;
let patched = 0;
for (let i = 0; i < lines.length; i++) {
  const entry = /^\s*-\s*url:\s*(.+?)\s*$/.exec(lines[i]);
  if (entry) { inEntry = entry[1] === url; continue; }
  if (!inEntry) continue;
  if (/^\s+sha512:\s*\S+\s*$/.test(lines[i])) { lines[i] = `    sha512: ${sha}`; patched++; }
  else if (/^\s+size:\s*\d+\s*$/.test(lines[i])) { lines[i] = `    size: ${size}`; patched++; }
}
// Two lines or nothing: a manifest whose shape changed must fail here, not ship
// with one entry silently unpatched.
if (patched !== 2) { console.error(`[FAIL] expected to patch 2 lines in ${file}, patched ${patched}`); process.exit(1); }
writeFileSync(file, lines.join("\n"));
console.log(`notarize: manifest ${url} → ${size}B, sha512 updated`);
' "$MANIFEST" "$(basename "$DMG")" "$DMG_SHA" "$DMG_SIZE"

echo "notarize: done — $ARCH: $DMG"
echo "notarize: fragment written: $FRAGMENT"
echo "notarize: once BOTH arches have run: pnpm manifest:merge && pnpm verify:release"
