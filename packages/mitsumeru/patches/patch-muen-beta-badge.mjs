#!/usr/bin/env node
/**
 * patch-muen-beta-badge.mjs — give every `@muen/*` plugin the same
 * "Experimental" badge DSH gives its own preview plugins.
 *
 * WHY A PATCH
 * -----------
 * The Plugins page derives the badge from ONE name-prefix check, not from a
 * manifest flag (measured on the shipped 0.2.1-alpha.2 bundles,
 * `dsh-client-ui-plugin-manager/lib/client.js`):
 *
 *     beta: pkg.name.startsWith("@deepseek-ai/dsh-experimental-")
 *
 * There is no `experimental` field in any official plugin's package.json, and
 * `packageText` reads only `pkg.name` for this decision. Both renderers (the
 * list `PackageCard` and the open `PackageDetail`) consume the same predicate,
 * so the one line is the whole mechanism.
 *
 * Our plugins are `@muen/*`, so they can never match upstream's prefix. The
 * founder's call (2026-10-10): "dsh uses experimental badge, we should do the
 * same w our plugins for consistency". This patch adds an OR clause for the
 * `@muen/` scope — same Tag, same tone, same locales (`statusBeta` is already
 * translated: "Experimental" / "实验性"), no client copy of our own.
 *
 * Scope-wide on purpose: like DSH, the badge tracks a NAMESPACE, not a
 * per-plugin flag. Every Muen plugin is pre-1.0 and moving; a stable Muen
 * plugin should one day drop the badge by leaving the rule, not by editing
 * this script per package.
 *
 * WHERE IT RUNS
 * -------------
 * Same contract as `patch-hero-brand-tagline.mjs`: this copy is the one the
 * BUILD uses — `prepare-harness.sh` runs it against the staged `build/harness`
 * tree BEFORE electron-builder signs, so the edit is inside the signature.
 * Patching an installed app afterwards costs the seal (codesign names the
 * edited file, Gatekeeper can no longer assess the app) — field repair only.
 *
 * Vendored from mitsu `05-dsh-core/patches/patch-muen-beta-badge.mjs` — keep
 * the two in sync.
 *
 * Invariants: idempotent (marker-checked), guarded (exactly one unpatched
 * occurrence and an exact trimmed line shape, or nothing is written), atomic
 * (temp file + rename), and the would-be result must PARSE before the
 * original is replaced.
 *
 * Usage:
 *   node patches/patch-muen-beta-badge.mjs --harness build/harness           # build
 *   node patches/patch-muen-beta-badge.mjs --harness build/harness --check   # gate
 *   node patches/patch-muen-beta-badge.mjs --app "/Applications/Mitsumeru.app" # field
 *
 * Exit 0 = patched, already patched, or (--check) verified patched.
 * Exit 1 = could not patch / not patched (nothing written).
 */

import { copyFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PACKAGE = '@deepseek-ai/dsh-client-ui-plugin-manager'
const BETA_LINE_ORIGINAL = 'beta: pkg.name.startsWith("@deepseek-ai/dsh-experimental-")'
const BETA_LINE_PATCHED = `${BETA_LINE_ORIGINAL} || pkg.name.startsWith("@muen/")`
const DEFAULT_APP = '/Applications/Mitsumeru.app'

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const noBackup = argv.includes('--no-backup')
const appFlag = argv.indexOf('--app')
const harnessFlag = argv.indexOf('--harness')
const appRoot = appFlag >= 0 ? argv[appFlag + 1] : DEFAULT_APP

// Two targets, one bundle path (same CLI shape as the hero patch):
//   --app "<bundle>"   an INSTALLED app — field repair, costs the signature
//   --harness "<dir>"  a STAGED harness tree — the build path (prepare-harness.sh)
const harnessDir = harnessFlag >= 0 ? argv[harnessFlag + 1] : join(appRoot, 'Contents/Resources/harness')

const bundlePath = join(harnessDir, 'node_modules', ...PACKAGE.split('/'), 'lib', 'client.js')

function fail(message) {
  console.error(`FAIL — ${message}`)
  process.exit(1)
}

if (!existsSync(bundlePath)) fail(`no client bundle at ${bundlePath} (wrong --app path?)`)
const before = readFileSync(bundlePath, 'utf8')

// ── 1. already patched? ─────────────────────────────────────────────────────
// The patched line CONTAINS the original as its prefix, so this check must run
// first — otherwise an already-patched bundle would count two "originals".
const patched = before.includes(BETA_LINE_PATCHED)
if (patched) {
  if (checkOnly) {
    console.log(`OK (patched) — ${bundlePath}`)
    console.log(`     beta covers both upstream's experimental prefix and the @muen/ scope.`)
    process.exit(0)
  }
  console.log(`OK (already patched) — ${bundlePath}`)
  process.exit(0)
}

// ── 2. --check on an unpatched bundle is a gate failure ─────────────────────
if (checkOnly) {
  console.error(`NOT PATCHED — ${bundlePath}`)
  console.error(`       expected the @muen/ OR clause beside upstream's experimental prefix.`)
  console.error(`       fix: node patches/patch-muen-beta-badge.mjs${harnessFlag >= 0 ? ` --harness ${harnessDir}` : ''}`)
  process.exit(1)
}

// ── 3. guard: exactly one unpatched occurrence, exact line shape ────────────
const occurrences = before.split(BETA_LINE_ORIGINAL).length - 1
if (occurrences !== 1) {
  fail(`expected exactly one ${JSON.stringify(BETA_LINE_ORIGINAL)}; found ${occurrences} — upstream layout changed; re-derive the patch`)
}
const betaIdx = before.indexOf(BETA_LINE_ORIGINAL)
const lineStart = before.lastIndexOf('\n', betaIdx) + 1
const lineEnd = before.indexOf('\n', betaIdx)
if (lineEnd < 0) fail('anchors missing: unterminated beta line')
const originalLine = before.slice(lineStart, lineEnd)
if (originalLine.trim() !== BETA_LINE_ORIGINAL) {
  fail(`beta line has an unexpected shape, refusing to edit: ${JSON.stringify(originalLine.trim())}`)
}
const indent = originalLine.slice(0, originalLine.length - originalLine.trimStart().length)
const after = before.slice(0, lineStart) + `${indent}${BETA_LINE_PATCHED}` + before.slice(lineEnd)

// ── 4. verify before touching the original ──────────────────────────────────
if (!after.includes(BETA_LINE_PATCHED)) fail('patched beta line missing from the would-be result — refusing to write')
const probePath = join(tmpdir(), `muen-beta-badge-probe-${process.pid}.js`)
writeFileSync(probePath, after, 'utf8')
try {
  execFileSync(process.execPath, ['--check', probePath], { stdio: 'pipe' })
} catch (error) {
  fail(`patched bundle is not valid JavaScript — original untouched\n${error.stderr ? error.stderr.toString() : error.message}`)
} finally {
  unlinkSync(probePath)
}

const tmpPath = `${bundlePath}.muen-patch.tmp`
writeFileSync(tmpPath, after, 'utf8')

// ── 5. backup + atomic replace ──────────────────────────────────────────────
// Build path: no sidecar (the staged tree is packaged as it stands — a backup
// would ship inside the signed app). Field path: keep one for one-command revert.
const backupPath = `${bundlePath}.muen-unpatched`
if (noBackup) {
  if (existsSync(backupPath)) unlinkSync(backupPath)
} else if (!existsSync(backupPath)) {
  copyFileSync(bundlePath, backupPath)
  console.log(`backup — ${backupPath}`)
}
renameSync(tmpPath, bundlePath)

console.log(`OK — patched ${bundlePath}`)
console.log(`     beta now covers "@muen/" as well as upstream's experimental prefix (${statSync(bundlePath).size} bytes)`)
console.log(`     Verify:  node patches/patch-muen-beta-badge.mjs${harnessFlag >= 0 ? ` --harness ${harnessDir}` : ''} --check`)
if (noBackup) {
  console.log('     Staged tree: electron-builder packages and signs this as-is, so the')
  console.log('     badge rule is inside the app signature — no post-install patch.')
} else {
  console.log('     Restart the app, then hard-refresh the page (Cmd+Shift+R): the client')
  console.log('     bundle is served with an immutable revision, so the page must reload.')
  console.log(`     To revert: mv "${backupPath}" "${bundlePath}"`)
}
