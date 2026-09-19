#!/usr/bin/env bash
# Build the harness resource the packaged app spawns.
#
# Ship shape: `Resources/harness/node_modules/**` — a flat, self-contained,
# symlink-free node_modules tree.
#   - pnpm's workspace layout is a symlink farm (deps are siblings in the
#     virtual store), and electron-builder copies resources as plain files, so
#     the tree is materialized with the hoisted linker instead of copied.
#   - the harness is executed by node as a child process, so nothing about it
#     may live inside an asar archive (asar: false in electron-builder.yml).
#
# The staged install is pinned (overrides) to the closure the dev smoke signs
# off on — the workspace's own resolved set — and the result is checked back
# against it. Upstream publishes ranges, so a plain fresh resolve drifts the
# day a newer prerelease lands (0.1.5-rc.1 did, measured 2026-09-11); a
# drifted tree fails the build here instead of reaching the field.
set -euo pipefail
cd "$(dirname "$0")/.." # packages/mitsumeru

OUT=build/harness
# The stage must live OUTSIDE the workspace: pnpm run from anywhere inside a
# workspace member operates on the whole workspace, and a `--prod` install
# there strips this package's own devDependencies. Off to the side it sees a
# single plain project.
STAGE=${TMPDIR:-/tmp}/mitsumeru-harness-stage
STORE=$(pnpm store path)
VERSION=$(node -p "require('./package.json').dependencies['@deepseek-ai/dsh']")

# ── target platform + arch ──────────────────────────────────────────────────
# The tree is staged ONE TARGET AT A TIME, because electron-builder's
# extraResources copies this single tree into every target it builds. Staging on
# the host alone is exactly why the Intel and Windows builds never worked: pnpm
# links only the CURRENT platform's optional dependencies, so the x64 app shipped
# darwin-arm64 native addons (`node-addon-require-builtin-darwin-arm64`) and an
# x86_64 process cannot load arm64 code. Measured 2026-09-18 in the build log,
# which names every platform-specific dependency it could not bundle.
#
# Defaults are the host, so a plain `pnpm harness` still means "the dev machine".
TARGET_OS=$(node -p 'process.platform')
TARGET_CPU=$(node -p 'process.arch')
while [ $# -gt 0 ]; do
  case "$1" in
    --os) TARGET_OS=$2; shift 2 ;;
    --cpu) TARGET_CPU=$2; shift 2 ;;
    --os=*) TARGET_OS=${1#*=}; shift ;;
    --cpu=*) TARGET_CPU=${1#*=}; shift ;;
    *) echo "[FAIL] prepare-harness: unknown argument: $1"; exit 1 ;;
  esac
done
case "$TARGET_OS" in
  darwin|win32|linux) ;;
  *) echo "[FAIL] prepare-harness: unsupported --os $TARGET_OS"; exit 1 ;;
esac
case "$TARGET_CPU" in
  arm64|x64|ia32) ;;
  *) echo "[FAIL] prepare-harness: unsupported --cpu $TARGET_CPU"; exit 1 ;;
esac
echo "harness resource: staging for $TARGET_OS/$TARGET_CPU (host is $(node -p 'process.platform')/$(node -p 'process.arch'))"

rm -rf "$OUT" "$STAGE"
mkdir -p "$STAGE"
# Pin every package of the closure to the version the pinned dsh release itself
# declares. Upstream publishes ranges (`^0.1.5-alpha.2`), so without this the
# stage resolves whatever prerelease is newest at install time and the build
# ships a resolution nobody chose (0.1.5-rc.1 drifted in that way, measured
# 2026-09-11).
#
# The list comes from the pinned @deepseek-ai/dsh@$VERSION manifest's own
# dependencies — resolved through the store, so no network call — which makes the
# pins and the closure check below agree by construction: both describe the SAME
# release. Reading a lockfile instead does not work: the workspace store and
# node_modules/.pnpm/lock.yaml both still list the previous closure for one
# install after a re-pin (measured on the alpha.2 -> rc.2 re-pin).
#
# The pins go in pnpm-workspace.yaml, not package.json: pnpm 11 no longer reads
# package.json#pnpm and warns when it finds it (measured the same day — the first
# attempt at this fix put them there and was silently ignored).
node --input-type=module -e '
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [version, outFile, yamlFile, targetOs, targetCpu] = process.argv.slice(1)
const store = "../../node_modules/.pnpm"

// The release itself, then the versions it declares. The closure is closed under
// its own dependencies, so one level is the whole list.
const dshDir = readdirSync(store).find((d) => d.startsWith(`@deepseek-ai+dsh@${version}`))
if (dshDir === undefined) {
  console.error(`[FAIL] @deepseek-ai/dsh@${version} is not in the store — run pnpm install`)
  process.exit(1)
}
const dsh = JSON.parse(readFileSync(join(store, dshDir, "node_modules/@deepseek-ai/dsh/package.json"), "utf8"))

const overrides = {}
// Pin the release itself absolutely.
overrides["@deepseek-ai/dsh"] = version

// Walk the store: every @deepseek-ai/* package that was resolved when pnpm
// installed dsh gets pinned to the EXACT version the store resolved. This
// catches transitive deps (e.g. dsh-web-app -> dsh-web-frontend) whose ^ ranges
// would otherwise drift to a newer prerelease during the staged install.
const pnpmDir = join(store, "..")
const pnpmStoreDirs = readdirSync(pnpmDir)
for (const dir of pnpmStoreDirs) {
  const m = dir.match(/^@deepseek-ai\+(.+)@(.+?)_/)
  if (!m) continue
  const [, pkgName, storeVersion] = m
  const pkgFullName = `@deepseek-ai/${pkgName}`
  // Only pin packages that this DSH release actually declares (direct or
  // transitive). If a @deepseek-ai/* package in the store is from an older
  // closure that this release no longer uses, including it would be harmless
  // but noisy — skip it.
  if (overrides[pkgFullName] !== undefined) continue
  overrides[pkgFullName] = storeVersion
}

// Also pin from dsh direct declarations: these are authoritative even when
// the store directory name is mangled (scoped packages).
for (const [name, range] of Object.entries(dsh.dependencies ?? {})) {
  if (!name.startsWith("@deepseek-ai/")) continue
  if (overrides[name] !== undefined) continue
  overrides[name] = range.replace(/^[~^]/u, "")
}

writeFileSync(outFile, JSON.stringify({
  name: "mitsumeru-harness-resource",
  private: true,
  description: "Throwaway manifest for the packaged harness tree. Not published.",
  dependencies: { "@deepseek-ai/dsh": version },
}, null, 2) + "\n")
writeFileSync(yamlFile, "overrides:\n" + Object.entries(overrides)
  .map(([name, v]) => `  ${JSON.stringify(name)}: ${JSON.stringify(v)}`)
  .join("\n") + "\n" +
  // Native optional dependencies for the TARGET, not for the host. This is the
  // line that decides whether an Intel or Windows build can start at all:
  // without it pnpm resolves `os`/`cpu` for the machine doing the staging.
  // (No apostrophes in this block: it is a single-quoted shell argument.)
  "supportedArchitectures:\n  os:\n    - " + JSON.stringify(targetOs) +
  "\n  cpu:\n    - " + JSON.stringify(targetCpu) + "\n")
' "$VERSION" "$STAGE/package.json" "$STAGE/pnpm-workspace.yaml" "$TARGET_OS" "$TARGET_CPU"

# ignore-scripts: the harness's native addons (node-pty, koffi) are denied in
# pnpm-workspace.yaml and the stock web profile boots without them.
(cd "$STAGE" && pnpm install --prod \
  --config.node-linker=hoisted \
  --config.ignore-scripts=true \
  --config.store-dir="$STORE" \
  --config.confirm-modules-purge=false \
  --reporter=append-only)

mkdir -p "$OUT"
cp "$STAGE/package.json" "$OUT/package.json"
cp -R "$STAGE/node_modules" "$OUT/node_modules"
rm -rf "$OUT/node_modules/.bin" "$STAGE"

# --- our own plugins, vendored into the tree ---------------------------------
# A profile bundle is resolved from the INSTALLATION anchor first, then from the
# profile directory (dsh-app-boot's resolveBundleDir). Our plugins live in this
# repo, so they are in neither — which fails the boot with `cannot resolve profile
# bundle "@muen/dsh-brand-mitsumeru"`. Vendoring them into the shipped
# node_modules puts them at the installation anchor, where every other bundle is
# resolved from, and keeps them versioned with the app that ships them.
#
# Copied from source, not installed: these packages have no build step (the
# lib/*.js lazy-CJS shape dsh loads directly), so what is copied IS what is
# reviewed. Peer deps (react, cordis, the ui-* packages) are already in this tree.
#
# dsh-brand-mitsumeru is in this list for a reason worth stating: the sidebar
# brand seat is exclusive, and upstream mounts its own occupant there
# (ui-brand-official, inserted by dsh-web-app's patch). Our package's
# cordis.patch.yml disables that row and inserts ours, so it has to be a COMPOSED
# bundle — being present on disk is not enough — or the whale keeps the seat.
# See that file for the measurement.
#
# dsh-white-label is the appearance plugin (accent + brand), published from
# muen-plugins and vendored here so ensureProfile can symlink it into the profile
# on first boot.
#
# SEVEN packages as of 0.2.1, when the four Kun-parity quality-of-life plugins
# joined the set: dsh-turn-summary, dsh-changes-card, dsh-codex-fold and
# dsh-context-watchdog. All four are Client-only surfaces with empty Host halves
# (each lib/index.js says why), developed as workspace links in the dev profile
# and promoted to muen-plugins for this release. They are listed here in the order
# the dev profile composes them — context-watchdog, turn-summary, changes-card,
# codex-fold — so the shipped composition is the one that was dogfooded.
#
# dsh-codex-fold is a localized fork of the community dsh-auto-collapse 0.2.1
# (MIT). That community package is deliberately NOT shipped and must not be: both
# fold the same runs, so shipping the pair double-folds one conversation. Its
# LICENSE and FORK.md travel with the vendored copy for that reason.
#
# dsh-eva-theme is here for the same reason the brand plugin is: its
# cordis.patch.yml inserts the loader row, and being present on disk is not the
# same as being composed. Its client bundle may require only the web shell's
# seed module words — see the COMPATIBILITY note at the top of its
# lib/client.tpl.js for the measured list and the one import that broke in
# DSH Desktop 2.0.4.
for pkg in dsh-brand-mitsumeru dsh-eva-theme dsh-white-label dsh-context-watchdog dsh-turn-summary dsh-changes-card dsh-codex-fold; do
  src="plugins/$pkg"
  [ -d "$src" ] || { echo "[FAIL] shipped plugin missing: $src"; exit 1; }
  dest="$OUT/node_modules/@muen/$pkg"
  mkdir -p "$OUT/node_modules/@muen"
  rm -rf "$dest"
  mkdir -p "$dest/lib"
  cp "$src/package.json" "$src/cordis.patch.yml" "$dest/"
  cp "$src"/lib/*.js "$dest/lib/"
  # Documentation and licence travel with the vendored copy, so the package in
  # the tree matches the `files` list in its own manifest (the same reason a
  # theme's themes/ are copied) and a fork keeps its upstream licence beside its
  # code.
  for extra in README.md LICENSE FORK.md; do
    if [ -f "$src/$extra" ]; then cp "$src/$extra" "$dest/"; fi
  done
  # A theme plugin keeps its generated token tables in themes/. The client
  # bundle already inlines them (__SKINS__), so this is not load-bearing at
  # runtime — it is copied so the vendored package matches the `files` list in
  # its own manifest and can be read on disk when a theme is debugged.
  if [ -d "$src/themes" ]; then
    mkdir -p "$dest/themes"
    cp "$src"/themes/*.json "$dest/themes/"
  fi
  [ -f "$dest/lib/client.js" ] || { echo "[FAIL] $src has no client half"; exit 1; }
  [ -f "$src/cordis.patch.yml" ] || { echo "[FAIL] $src has no patch layer"; exit 1; }
  echo "harness resource: vendored @muen/$pkg"
done

links=$(find "$OUT" -type l | wc -l | tr -d ' ')
files=$(find "$OUT" -type f | wc -l | tr -d ' ')
echo "harness resource: $OUT — @deepseek-ai/dsh@$VERSION, $files files, $links symlinks"
[ "$links" = '0' ] || { echo "[FAIL] symlinks in the resource tree"; exit 1; }
[ -f "$OUT/node_modules/@deepseek-ai/dsh/lib/bin.js" ] || { echo "[FAIL] harness entry missing"; exit 1; }

# Closure identity: every package in the resource tree must BE the pinned release
# — i.e. each member's manifest must be the one that release pins, at the version
# that release pins. Nothing older or newer may be mixed in.
#
# The source is the pinned @deepseek-ai/dsh@$VERSION manifest's own dependency
# map (resolved through the store, no network call), so the check and the stage
# pins above describe the same release by construction. A store listing or a
# lockfile cannot be used here: both still list the previous closure for one
# install after a re-pin (measured 2026-09-11, on alpha.2 -> rc.2), which is
# exactly the confusion this check exists to prevent.
#
# Extras are a different failure and are checked differently: a package the tree
# did not need. A hoisted install can legitimately leave the closure files that no
# package asks for — those are data, not drift — so extras are reported rather
# than failing the build. Drift is what must fail.
node --input-type=module -e '
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const [, version] = process.argv
const store = "../../node_modules/.pnpm"
const dshDir = readdirSync(store).find((d) => d.startsWith(`@deepseek-ai+dsh@${version}`))
if (dshDir === undefined) {
  console.error(`[FAIL] @deepseek-ai/dsh@${version} is not in the store`)
  process.exit(1)
}
const dsh = JSON.parse(readFileSync(join(store, dshDir, "node_modules/@deepseek-ai/dsh/package.json"), "utf8"))

// What $VERSION declares for each @deepseek-ai package it pulls in.
const declared = new Map([["@deepseek-ai/dsh", version]])
for (const [name, range] of Object.entries(dsh.dependencies ?? {})) {
  if (!name.startsWith("@deepseek-ai/")) continue
  declared.set(name, range.replace(/^[~^]/u, ""))
}

const scopeDir = "build/harness/node_modules/@deepseek-ai"
const actual = new Map()
for (const dir of readdirSync(scopeDir)) {
  const manifest = JSON.parse(readFileSync(join(scopeDir, dir, "package.json"), "utf8"))
  actual.set(manifest.name, manifest.version)
}

const drifted = []
for (const [name, want] of declared) {
  const got = actual.get(name)
  if (got === undefined) drifted.push(`${name}: missing (release pins ${want})`)
  else if (got !== want) drifted.push(`${name}: ${got} (release pins ${want})`)
}

console.log(`closure: ${actual.size} @deepseek-ai/* packages (release pins ${declared.size})`)
if (drifted.length > 0) {
  console.error("drifted:", drifted)
  process.exit(1)
}
' "$VERSION"

# ── branding layer: the hero tagline seam ───────────────────────────────────
# `conversation.hero.tagline` is the seat @muen/dsh-white-label occupies to
# replace the blank-session headline (Settings → Brand → Hero tagline). It cannot
# come from a plugin: slot names live in the compiled render tree, and a parent
# factory has to DECLARE the child before any renderer may call it (an
# undeclared call throws SlotOwnershipError during render). So it is a narrow
# additive patch to the vendored client bundle.
#
# It runs HERE, on the staged tree, for two reasons: the edit is inside the
# signature electron-builder applies later, and a bundle without it cannot reach
# the field at all. Patching an installed app instead — which is how this was
# delivered on 2026-09-17 — costs the signature: `codesign --verify` then reports
# "a sealed resource is missing or invalid" naming the file, and Gatekeeper can
# no longer assess the app.
#
# --no-backup: whatever is in this tree gets packaged, so the sidecar
# `.muen-unpatched` copy the field path writes must not ship.
#
# The verifier is the gate, not a courtesy: it fails on an unpatched bundle AND
# on the A-only shape (call without declaration) that blanked every new session
# on 2026-09-17. A failed build here is the point.
node patches/patch-hero-brand-tagline.mjs --harness "$OUT" --no-backup
node scripts/verify-hero-tagline.mjs --harness "$OUT"
