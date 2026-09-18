#!/usr/bin/env bash
# Distribution gate (Epic 87 A5). The one that closes the epic:
#
#   a person clicks a link on the marketing site, gets the dmg, installs it,
#   and the app is theirs
#
# Everything upstream of this gate stops at "the file we built is good". This
# one starts at "the file a stranger actually downloads", which is a different
# artifact and a different question:
#
#   1. the site resolves its download to the SAME release we just published
#   2. that link returns 200, and the bytes match the manifest's sha512
#   3. those bytes are notarized + stapled, and Gatekeeper accepts them
#
# WHY THIS EXISTS AS A GATE rather than a manual click-through:
# the marketing site carries TWO download sources — a static `href` fallback and
# a GitHub-API call that rewrites it at load — and only one of them is visible
# in a browser. Measured 2026-09-12: the site had been pointing at
# `muen-collective/mitsumeru-desktop` (the archived fork, v0.0.3-dev) for days
# after the product moved to `muen-collective/mitsumeru`. Every other gate
# passed, because none of them looks at the site. The hero CTA and the share
# link both said "Download", and the download was a retired app. A gate that
# reads the published release cannot catch that; only one that reads the site's
# own resolution can.
#
# The modal is also checked structurally: its asset-name regexes must match the
# app's real artifact names. The app's dmg is `Mitsumeru-<version>-arm64.dmg`
# and contains no `mac` token, so a regex written for the old fork's
# `mitsumeru-0.0.3-dev-mac-arm64.dmg` silently matches nothing and the
# "Recommended" row disappears from the panel. Silent, and invisible to curl.
#
# Usage:
#   pnpm verify:distribution                 # against the published site
#   SITE_URL=http://localhost:8899 pnpm verify:distribution   # local preview
#   SITE_URL=... EXPORT=1 pnpm verify:distribution  # write release/distribution.json
set -uo pipefail
cd "$(dirname "$0")/.." # packages/mitsumeru

SITE_URL="${SITE_URL:-https://mitsumeru.vercel.app/}"
# The canonical repo name, and it changed: the app repo was renamed from
# `mitsumeru` to `mitsumeru-app`, and `mitsumeru` now only redirects. The gate must
# expect the canonical name for two reasons: the GitHub API answers with canonical
# `browser_download_url`s, so the hero-fallback comparison below is an exact string
# match against them; and the retired-repo check flags any other name, so expecting
# the old name would flag the correct links. The app's own update feed
# (`electron-builder.yml` -> `app-update.yml`) still says `mitsumeru` and relies on
# the redirect — changing that is a build change, not a gate change.
EXPECT_REPO="${EXPECT_REPO:-muen-collective/mitsumeru-app}"
VERSION=$(node -p "require('./package.json').version")
status=0
ok()  { echo "[PASS] $1"; }
bad() { echo "[FAIL] $1"; status=1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/mitsumeru-dist-XXXXXX")
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

echo "verify:distribution — site $SITE_URL, expecting $EXPECT_REPO @ $VERSION"

# --- 1. the site loads -------------------------------------------------------

if ! curl -fsSL --max-time 30 "$SITE_URL" -o "$work/site.html"; then
  bad "site: $SITE_URL did not load"
  echo "  (a marketing site that is down is a distribution failure, not a network blip)"
  exit 1
fi
ok "site: $SITE_URL loaded ($(wc -c <"$work/site.html" | tr -d ' ') bytes)"

# --- 2. it points at the repo we actually ship from --------------------------
#
# Two independent sources, because fixing one and missing the other is the exact
# failure this gate was written for: the static hero `href`, and the GitHub API
# URLs the page fetches at load.

if grep -q "repos/$EXPECT_REPO/releases" "$work/site.html"; then
  ok "site: release API calls target $EXPECT_REPO"
else
  got=$(grep -oE 'repos/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/releases' "$work/site.html" | sort -u | head -3 | tr '\n' ' ')
  bad "site: release API calls do NOT target $EXPECT_REPO (found: ${got:-none})"
fi

# Any other muen-collective repo in a releases URL is a stale pointer. This is
# what catches `mitsumeru-desktop` without hardcoding its name.
stale=$(grep -oE 'github\.com/muen-collective/[A-Za-z0-9._-]+/releases' "$work/site.html" \
        | sed 's#.*/muen-collective/##; s#/releases##' | sort -u | grep -v "^$(basename "$EXPECT_REPO")$" || true)
if [ -z "$stale" ]; then
  ok "site: no download links to a retired repo"
else
  bad "site: download links still target a retired repo: $(echo "$stale" | tr '\n' ' ')"
fi

# The static fallback href — what a visitor gets when the API call does not
# resolve (offline, or rate-limited: 60 req/h per IP, and the page spends two).
HERO=$(grep -oE 'id="dlBtn"[^>]*href="[^"]*"' "$work/site.html" \
       | sed -n 's/.*href="\([^"]*\)".*/\1/p' | head -1)
if [ -n "$HERO" ]; then
  ok "site: hero CTA fallback href present"
else
  bad "site: no hero CTA fallback href found — the button has no offline target"
fi

# --- 3. the modal can classify the app's real artifacts ----------------------
#
# Structural, because this failure is silent in a browser: a non-matching regex
# removes the recommended row rather than erroring.

MAC_RE=$(grep -oE 'var MAC_RE = [^,;]+' "$work/site.html" | head -1 | sed 's/var MAC_RE = //')
if [ -n "$MAC_RE" ]; then
  # Run the page's own regex against our real asset name.
  if node -e "
    const re = eval('$MAC_RE'.replace(/^PLATFORMS\[0\]\.re\$/,'/arm64\\\\.dmg\$/i'));
    process.exit(re.test('Mitsumeru-$VERSION-arm64.dmg') ? 0 : 1);
  " 2>/dev/null; then
    ok "site: modal regex matches the app's real dmg name (Mitsumeru-$VERSION-arm64.dmg)"
  else
    bad "site: modal regex does NOT match Mitsumeru-$VERSION-arm64.dmg — the Recommended row would vanish"
  fi
else
  bad "site: could not find MAC_RE in the page — the modal's matching changed shape"
fi

# --- 4. resolve the latest release, the way the page does --------------------

api="https://api.github.com/repos/$EXPECT_REPO/releases?per_page=5"
if ! curl -fsSL --max-time 30 -H 'accept: application/vnd.github+json' "$api" -o "$work/rels.json"; then
  bad "release: GitHub API unreachable — cannot confirm what the site would resolve"
else
  if node -e "
    const rels = require('$work/rels.json');
    const a = (rels[0].assets||[]).find(x => /arm64\.dmg\$/.test(x.name));
    if (!a) process.exit(1);
    process.stdout.write(rels[0].tag_name + '\n' + a.browser_download_url + '\n');
  " > "$work/resolved.txt" 2>/dev/null; then
    TAG=$(sed -n 1p "$work/resolved.txt")
    LIVE_URL=$(sed -n 2p "$work/resolved.txt")
    ok "release: latest is $TAG, dmg resolves to $(basename "$LIVE_URL")"

    # The site's own API call picks the FIRST asset matching the mac regex, so
    # compare that against the static fallback: a mismatch means one of the two
    # paths hands out a different version depending on whether the fetch ran.
    if [ -n "$HERO" ] && [ "$HERO" != "$LIVE_URL" ]; then
      bad "site: hero fallback disagrees with the live release"
      echo "        fallback: $HERO"
      echo "        live    : $LIVE_URL"
      echo "        (update the static href in index.html to match)"
    else
      ok "site: hero fallback and live release agree on the same artifact"
    fi
  else
    bad "release: no arm64 dmg on the latest release"
  fi
fi

# --- 5. fetch the artifact the site actually serves --------------------------
#
# Through the site's own link, not the release API's: if the site hands out a
# different URL than the release publishes, that is the bug, and only this path
# reveals it.

TARGET="${HERO:-${LIVE_URL:-}}"
if [ -z "$TARGET" ]; then
  bad "download: no URL to test — the site exposed neither a fallback nor a live link"
else
  code=$(curl -sL --max-time 600 -o "$work/dl.dmg" -w '%{http_code}' "$TARGET")
  if [ "$code" = "200" ]; then
    ok "download: $(basename "$TARGET") returned 200 ($(wc -c <"$work/dl.dmg" | tr -d ' ') bytes)"
  else
    bad "download: HTTP $code from $TARGET"
  fi
fi

# --- 6. the bytes match the manifest the updater reads ----------------------
#
# A manifest can describe a build that no longer exists, and a download that
# does not match it installs fine and then fails to update. sha512 is the
# updater's own integrity check, so this is the number that matters.

if [ -f "$work/dl.dmg" ] && [ -n "${LIVE_URL:-}" ]; then
  if curl -fsSL --max-time 30 "${LIVE_URL%/*}/dev-mac.yml" -o "$work/dev-mac.yml" 2>/dev/null; then
    want=$(grep -A3 "$(basename "$LIVE_URL")" "$work/dev-mac.yml" | sed -n 's/^ *sha512: *//p' | head -1)
    got=$(openssl dgst -sha512 -binary "$work/dl.dmg" | openssl base64 -A)
    if [ -n "$want" ] && [ "$want" = "$got" ]; then
      ok "download: sha512 matches dev-mac.yml (the updater's own check)"
    elif [ -z "$want" ]; then
      bad "download: no sha512 for $(basename "$LIVE_URL") in dev-mac.yml"
    else
      bad "download: sha512 MISMATCH — the download does not match the update manifest"
    fi
  else
    bad "download: could not fetch dev-mac.yml next to the release asset"
  fi
fi

# --- 7. Gatekeeper on the downloaded copy -----------------------------------
#
# The epic-86 gate re-run against the DOWNLOADED artifact, because a file that
# was notarized on the build machine is not proof that the file a stranger gets
# carries the ticket — the staples ride inside the archive.

if [ -f "$work/dl.dmg" ]; then
  if spctl -a -t open --context context:primary-signature "$work/dl.dmg" >/dev/null 2>&1; then
    ok "download: Gatekeeper accepts the dmg (source=Notarized Developer ID)"
  else
    bad "download: Gatekeeper rejects the dmg"
    spctl -a -t open --context context:primary-signature -vv "$work/dl.dmg" 2>&1 | sed 's/^/        /' || true
  fi

  if mountpoint=$(hdiutil attach "$work/dl.dmg" -nobrowse -readonly 2>/dev/null | grep -o '/Volumes/.*' | head -1); then
    distapp=$(find "$mountpoint" -maxdepth 1 -name '*.app' 2>/dev/null | head -1)
    if [ -n "$distapp" ]; then
      if xcrun stapler validate "$distapp" >/dev/null 2>&1; then
        ok "download: the app inside is stapled"
      else
        bad "download: the app inside carries no stapled ticket"
      fi
      shipped=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$distapp/Contents/Info.plist" 2>/dev/null)
      if [ "$shipped" = "$VERSION" ]; then
        ok "download: the app inside reports $shipped"
      else
        bad "download: the app inside reports '${shipped:-unknown}', expected $VERSION"
      fi
    else
      bad "download: no .app in the dmg"
    fi
    hdiutil detach "$mountpoint" >/dev/null 2>&1 || true
  else
    bad "download: could not mount the dmg"
  fi
fi

# --- summary -----------------------------------------------------------------

echo
if [ "$status" = "0" ]; then
  echo "verify:distribution — all checks passed: $SITE_URL serves $VERSION from $EXPECT_REPO"
else
  echo "verify:distribution — FAILURES above. The marketing site is the first thing a"
  echo "                      client touches; a stale link here is a distribution bug,"
  echo "                      not a cosmetic one."
fi

if [ -n "${EXPORT:-}" ] && [ "$status" = "0" ]; then
  mkdir -p release
  node -e "
    const fs=require('fs');
    fs.writeFileSync('release/distribution.json', JSON.stringify({
      site: process.env.SITE_URL || 'https://mitsumeru.vercel.app/',
      repo: process.env.EXPECT_REPO || 'muen-collective/mitsumeru',
      version: '$VERSION',
      tag: '${TAG:-}',
      artifact: '$(basename "${TARGET:-}")',
      bytes: Number('$(wc -c <"$work/dl.dmg" 2>/dev/null | tr -d ' ' || echo 0)'),
      verifiedAt: new Date().toISOString()
    }, null, 2) + '\n');
  " && echo "wrote release/distribution.json"
fi

exit "$status"
