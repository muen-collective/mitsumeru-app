#!/usr/bin/env bash
# verify:artifacts — what is INSIDE each distributable.
#
# verify-release.sh proves the artifacts are signed, notarized and stapled;
# verify-arch.sh proves the .app directories are the architecture they claim. Neither
# opens the files a client downloads. That is a real gap for this release, whose whole
# subject is architecture: a dmg or an installer is built from an app directory, and a
# stale or wrong-target archive would pass every check above while handing a client a
# build that cannot start. (Measured 2026-09-19: electron-builder's repackage step,
# invoked without an arch flag, produced arm64 artifacts for an Intel app and reused an
# existing arm64 zip as "up to date".)
#
# So each archive is opened and the app inside it is read:
#   * the Mach-O/PE architecture of the app binary;
#   * the harness native addon it must load, present;
#   * the OTHER architecture's addon, absent — the wrong-target staging defect;
#   * for Windows, the plugin set, since the installer is the only path a Windows
#     client has and its payload is a nested 7z.
#
# Usage: bash scripts/verify-artifacts.sh
set -euo pipefail
cd "$(dirname "$0")/.." # packages/mitsumeru

VERSION=$(node -p "require('./package.json').version")
status=0
ok()  { echo "[PASS] $1"; }
bad() { echo "[FAIL] $1"; status=1; }

# The filename carries the architecture: arm64 artifacts are suffixed, x64 are not
# (that is how electron-builder names them, and what the update feed lists).
expected_arch() { case "$1" in *-arm64*) echo arm64 ;; *) echo x86_64 ;; esac; }
addon_for()     { case "$1" in arm64) echo darwin-arm64 ;; *) echo darwin-x64 ;; esac; }
other_for()     { case "$1" in arm64) echo darwin-x64 ;; *) echo darwin-arm64 ;; esac; }

check_app() { # check_app <label> <path-to-.app>
  local label=$1 app=$2 want got addon other h
  want=$(expected_arch "$label")
  got=$(lipo -archs "$app/Contents/MacOS/Mitsumeru" 2>/dev/null || true)
  if [ "$got" = "$want" ]; then ok "$label: app is $got"; else bad "$label: app is '${got:-unreadable}', expected $want"; fi
  h="$app/Contents/Resources/harness/node_modules"
  addon=$(addon_for "$want"); other=$(other_for "$want")
  if [ -d "$h/node-addon-require-builtin-$addon" ]; then ok "$label: carries the $addon addon"; else bad "$label: no $addon addon — it cannot load its own harness"; fi
  if [ -d "$h/node-addon-require-builtin-$other" ]; then bad "$label: also carries $other (staged for the wrong target)"; else ok "$label: $other absent"; fi
}

for zip in "release/Mitsumeru-$VERSION-mac.zip" "release/Mitsumeru-$VERSION-arm64-mac.zip"; do
  if [ ! -f "$zip" ]; then bad "missing $(basename "$zip")"; continue; fi
  t=$(mktemp -d)
  if ditto -x -k "$zip" "$t" >/dev/null 2>&1 && [ -d "$t/Mitsumeru.app" ]; then
    check_app "$(basename "$zip")" "$t/Mitsumeru.app"
  else
    bad "$(basename "$zip"): could not extract an app"
  fi
  rm -rf "$t"
done

for dmg in "release/Mitsumeru-$VERSION.dmg" "release/Mitsumeru-$VERSION-arm64.dmg"; do
  if [ ! -f "$dmg" ]; then bad "missing $(basename "$dmg")"; continue; fi
  m=$(mktemp -d)
  if hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$m" >/dev/null 2>&1; then
    inner=$(ls -d "$m"/*.app 2>/dev/null | head -1 || true)
    if [ -n "$inner" ]; then check_app "$(basename "$dmg")" "$inner"; else bad "$(basename "$dmg"): no .app inside the image"; fi
    hdiutil detach "$m" >/dev/null 2>&1 || true
  else
    bad "$(basename "$dmg"): could not mount"
  fi
  rmdir "$m" 2>/dev/null || true
done

# ── the Windows installer ───────────────────────────────────────────────────
# NSIS: the installer is a stub plus `$PLUGINSDIR/app-64.7z`, which holds the app the
# user ends up with. Opening the nested archive is the only way to see it.
EXE="release/Mitsumeru Setup $VERSION.exe"
if [ ! -f "$EXE" ]; then
  bad "missing $(basename "$EXE")"
else
  # 7-Zip ships inside electron-builder's tool cache; a missing tool is a failure to
  # check, never a silent pass.
  Z=$(ls "$HOME"/Library/Caches/electron-builder/7zip@*/7zip-*/bin/7zz 2>/dev/null | head -1 || true)
  [ -n "$Z" ] || Z=$(command -v 7zz 7z 2>/dev/null | head -1 || true)
  if [ -z "$Z" ]; then
    bad "windows: no 7z available to open $(basename "$EXE") — install one (brew install sevenzip)"
  else
    t=$(mktemp -d)
    if "$Z" e "$EXE" -o"$t" '$PLUGINSDIR/app-64.7z' -y >/dev/null 2>&1 \
       && "$Z" x "$t/app-64.7z" -o"$t/app" -y >/dev/null 2>&1; then
      arch=$(file -b "$t/app/Mitsumeru.exe" 2>/dev/null | grep -o 'x86-64\|Aarch64' | head -1 || true)
      if [ "$arch" = "x86-64" ]; then ok "windows: the payload app is x86-64"; else bad "windows: the payload app is '${arch:-unreadable}'"; fi
      w="$t/app/resources/harness/node_modules"
      if [ -d "$w/node-addon-require-builtin-win32-x64-msvc" ]; then ok "windows: payload carries the win32-x64 addon"; else bad "windows: payload has no win32-x64 addon"; fi
      if [ -d "$w/node-addon-require-builtin-darwin-arm64" ] || [ -d "$w/node-addon-require-builtin-darwin-x64" ]; then
        bad "windows: payload carries macOS addons (staged for the wrong target)"
      else
        ok "windows: no macOS addons in the payload"
      fi
      n=$(ls "$w/@muen" 2>/dev/null | wc -l | tr -d ' ')
      if [ "$n" = "7" ]; then ok "windows: payload ships all seven @muen plugins"; else bad "windows: payload ships $n @muen plugins, expected 7"; fi
    else
      bad "windows: could not unpack the NSIS payload from $(basename "$EXE")"
    fi
    rm -rf "$t"
  fi
fi

[ "$status" = "0" ] && echo "verify:artifacts — every archive holds the build it claims"
exit "$status"
