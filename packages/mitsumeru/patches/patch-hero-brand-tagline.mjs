#!/usr/bin/env node
/**
 * patch-hero-brand-tagline.mjs — add the `conversation.hero.tagline` seam to the
 * conversation HeroShell headline, so our brand plugin can put OUR line there
 * instead of the harness's locale string.
 *
 * WHY A PATCH
 * -----------
 * HeroShell is upstream code. Its headline text node is a plain `t("hero.headline")`
 * (`dsh-client-ui-conversation/lib/client.js`) and the only hero seats upstream
 * declares are `sidebar.brand.mark`, `sidebar.brand.name`, `conversation.hero.brand.mark`
 * and `conversation.hero.frame` — none of them around the headline. Without a seam the
 * brand plugin can restyle the hero but cannot change its words, and it must not
 * shadow upstream's factory (that is a SlotOwnershipError, not a style).
 *
 * So the shell patches ONE call site into a slot call and declares the slot in the
 * factory's own children table. Both edits are additive: an occupant changes the
 * words, no occupant leaves the stock harness rendering its locale string through
 * the slot's `fallbackText`.
 *
 * TWO EDITS, TWO MARKERS
 * ----------------------
 *   A. the call — HeroShell renders `renderSlot("conversation.hero.tagline", {
 *      fallbackText, headlineClassName }, { fallback })` where the headline read was
 *   B. the declaration — the `conversation.content` factory's children table gains
 *      `"conversation.hero.tagline": { kind: "single", scope: "root" }`
 *
 * The two are checked independently on purpose: a bundle patched by an A-only
 * version of this script has the call but not the declaration, and that combination
 * is a render-time crash. Re-running repairs it.
 *
 * SHAPE, NOT LINES (2026-11-12)
 * -----------------------------
 * Until 0.2.2-rc.1 the client bundles shipped pretty-printed, and this script matched
 * exact source lines. **0.2.2-rc.2 ships them minified** (conversation: 23,144 lines →
 * 26), and the first staging run on it failed loudly — `expected exactly one
 * "conversation.hero.brand.mark": { declaration; found 0` — which is the guard doing
 * its job rather than editing the wrong place.
 *
 * The anchors are therefore structural now, and both layouts are targeted:
 *   - the seat is found by its KEY and brace-matched, never by its line;
 *   - the new entry reuses the sibling's own value text, so `kind`/`scope` keep
 *     whatever quote style and spacing the bundle was emitted with;
 *   - the headline read is found as a CALL with either quote style, and the
 *     replacement is emitted compact for a minified bundle and spaced for a
 *     pretty-printed one.
 * Nothing depends on minified identifier names except `renderSlot` and the
 * `HeroShell_module_css_default.headline` class reference, both of which upstream
 * keeps (measured on 0.2.2-rc.2).
 *
 * WHERE IT RUNS
 * -------------
 * `prepare-harness.sh` runs this against the staged `build/harness` tree BEFORE
 * electron-builder signs, so the edit is inside the signature. Patching an installed
 * app afterwards costs the seal (codesign names the edited file, Gatekeeper can no
 * longer assess the app) — field repair only.
 *
 * Vendored from mitsu `05-dsh-core/patches/patch-hero-brand-tagline.mjs` — keep the
 * two in sync.
 *
 * Invariants: idempotent (marker-checked), guarded (exactly one anchor of each kind
 * and a validated sibling shape, or nothing is written), atomic (temp file + rename),
 * and the would-be result must PARSE and its children table must EVALUATE before the
 * original is replaced.
 *
 * Usage:
 *   node patches/patch-hero-brand-tagline.mjs --harness build/harness            # build
 *   node patches/patch-hero-brand-tagline.mjs --harness build/harness --check    # gate
 *   node patches/patch-hero-brand-tagline.mjs                                    # installed app
 *   node patches/patch-hero-brand-tagline.mjs --app "/Applications/Mitsumeru Dev.app"
 *
 * Exit 0 = patched, already patched, or (--check) verified patched.
 * Exit 1 = could not patch / not patched (nothing written).
 */

import { copyFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MARKER = 'conversation.hero.tagline'
const SEAT = 'conversation.hero.brand.mark'
// The first seat of the same children table, used to locate the table when the
// factory's `name` property is not in a shape we can match.
const TABLE_ANCHOR_SEAT = 'conversation.hero.frame'
const HEADLINE_CLASS = 'HeroShell_module_css_default.headline'
const PACKAGE = '@deepseek-ai/dsh-client-ui-conversation'

// A call carries the marker inside renderSlot(...); a declaration carries it as a
// quoted property key. Disjoint, so a repair can target just one edit.
const CALL_RE = () => /renderSlot\(\s*[`"]conversation\.hero\.tagline[`"]/
const DECL_RE = () => /"conversation\.hero\.tagline"\s*:/

const DEFAULT_APP = '/Applications/Mitsumeru.app'

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
// The build path (--harness) never wants the `.muen-unpatched` sidecar: the
// staged tree is what gets packaged, so the backup would ship inside the app.
const noBackup = argv.includes('--no-backup')
const appFlag = argv.indexOf('--app')
const harnessFlag = argv.indexOf('--harness')
const appRoot = appFlag >= 0 ? argv[appFlag + 1] : DEFAULT_APP

// Two targets, one bundle path:
//   --app "<bundle>"     an INSTALLED app — the field case, patching a running app
//   --harness "<dir>"    a STAGED harness tree — the build case (prepare-harness.sh)
const harnessDir = harnessFlag >= 0 ? argv[harnessFlag + 1] : join(appRoot, 'Contents/Resources/harness')

const bundlePath = join(
  harnessDir,
  'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js',
)

function fail(message) {
  console.error(`FAIL — ${message}`)
  process.exit(1)
}

/**
 * Index of the brace that closes the one at `openIdx`.
 * @param {string} source - bundle text
 * @param {number} openIdx - index of an opening brace
 * @returns {number} index of its partner, or -1
 */
function closingBrace(source, openIdx) {
  let depth = 0
  for (let i = openIdx; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * The `children` table that holds the hero seats, found from a seat key so it does
 * not depend on how the factory's `name` property is written.
 * @param {string} source - bundle text
 * @returns {{ open: number, close: number } | null} brace indices of the table
 */
function seatTable(source) {
  const anchor = source.indexOf(`"${TABLE_ANCHOR_SEAT}"`)
  if (anchor < 0) return null
  const childrenIdx = source.lastIndexOf('children:', anchor)
  if (childrenIdx < 0) return null
  const open = source.indexOf('{', childrenIdx)
  if (open < 0 || open > anchor) return null
  const close = closingBrace(source, open)
  return close < 0 ? null : { open, close }
}

/**
 * Evaluate the hero seats table from the bundle text.
 * @param {string} source - bundle text
 * @returns {Record<string, { kind?: string, scope?: string }> | null}
 */
function readSeatTable(source) {
  const table = seatTable(source)
  if (table === null) return null
  try {
    const value = new Function(`return (${source.slice(table.open, table.close + 1)})`)()
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

if (!existsSync(bundlePath)) fail(`no client bundle at ${bundlePath} (wrong --app path?)`)
const before = readFileSync(bundlePath, 'utf8')
// Emit the replacement in the layout the bundle uses. A minified bundle is a
// handful of very long lines; a pretty one is thousands of short ones.
const minified = before.split('\n').length < 200

// ── 1. what is already applied? ─────────────────────────────────────────────
const hasCall = CALL_RE().test(before)
const hasDeclaration = DECL_RE().test(before)
if (hasCall && hasDeclaration) {
  const table = readSeatTable(before)
  if (table === null || table[MARKER] === undefined) {
    fail('markers present but the hero seats table does not carry the seam — bundle is inconsistent; reinstall the bundle and patch again')
  }
  console.log(`OK (already patched) — ${bundlePath}`)
  console.log(`     seam "${MARKER}" is called by HeroShell and declared by the conversation.content factory.`)
  process.exit(0)
}

let after = before

// ── 2. EDIT B — declare the seat in the factory's children table ────────────
if (!hasDeclaration) {
  const seatKey = `"${SEAT}"`
  const occurrences = after.split(seatKey).length - 1
  if (occurrences !== 1) {
    fail(`expected exactly one ${seatKey} declaration; found ${occurrences} — upstream layout changed; re-derive the patch`)
  }
  const keyIdx = after.indexOf(seatKey)
  const colonIdx = after.indexOf(':', keyIdx + seatKey.length)
  const openIdx = after.indexOf('{', colonIdx)
  if (colonIdx < 0 || openIdx < 0) fail('could not find the hero brand-mark declaration body')
  const closeIdx = closingBrace(after, openIdx)
  if (closeIdx < 0) fail('could not find the end of the hero brand-mark declaration')

  const valueText = after.slice(openIdx, closeIdx + 1)
  if (!/kind:\s*[`"]single[`"]/.test(valueText) || !/scope:\s*[`"]root[`"]/.test(valueText)) {
    fail(`hero brand-mark declaration has an unexpected shape, refusing to copy it: ${JSON.stringify(valueText.slice(0, 120))}`)
  }
  // The entry must be followed by a comma to keep the object literal valid.
  let commaIdx = closeIdx + 1
  while (after[commaIdx] === ' ' || after[commaIdx] === '\n') commaIdx += 1
  if (after[commaIdx] !== ',') {
    fail('the hero brand-mark declaration is not followed by a comma — refusing to edit')
  }
  // Reuse the sibling's own indentation when the bundle is pretty-printed.
  const lineStart = after.lastIndexOf('\n', keyIdx) + 1
  const indent = minified ? '' : after.slice(lineStart, keyIdx)
  const entry = `${minified ? '' : '\n'}${indent}"${MARKER}":${minified ? '' : ' '}${valueText},`
  after = after.slice(0, commaIdx + 1) + entry + after.slice(commaIdx + 1)
}

// ── 3. EDIT A — render the headline through the seam ────────────────────────
if (!hasCall) {
  // The headline read is a CALL with the locale key; the dictionaries hold the key
  // as a quoted property, so the call form is unique in an unpatched bundle.
  const reads = [...after.matchAll(/\bt\(([`"])hero\.headline\1\)/g)]
  if (reads.length !== 1) {
    fail(`expected exactly one t("hero.headline") read; found ${reads.length} — upstream layout changed; re-derive the patch`)
  }
  const [read] = reads
  const quote = read[1]
  const headline = `t(${quote}hero.headline${quote})`
  const seam = minified
    ? `renderSlot(${quote}${MARKER}${quote},{fallbackText:${headline},headlineClassName:${HEADLINE_CLASS}},{fallback:${headline}})`
    : `renderSlot(${quote}${MARKER}${quote}, { fallbackText: ${headline}, headlineClassName: ${HEADLINE_CLASS} }, { fallback: ${headline} })`
  after = after.slice(0, read.index) + seam + after.slice(read.index + read[0].length)
}

// ── 4. verify before touching the original ──────────────────────────────────
if (!CALL_RE().test(after)) fail('seam call missing from the would-be result — refusing to write')
if (!DECL_RE().test(after)) fail('seam declaration missing from the would-be result — refusing to write')
const table = readSeatTable(after)
if (table === null) fail('could not evaluate the hero seats table in the would-be result — refusing to write')
if (table[MARKER] === undefined) {
  fail('the would-be result does not declare the seam in the factory children table — HeroShell would throw SlotOwnershipError')
}
if (table[MARKER].kind !== 'single') {
  fail(`seam declared with kind ${JSON.stringify(table[MARKER].kind)}; expected "single"`)
}
if (table[MARKER].scope !== 'root') {
  fail(`seam declared with scope ${JSON.stringify(table[MARKER].scope)}; expected "root"`)
}
if (table[SEAT] === undefined) fail('the would-be result lost the hero brand-mark declaration')

// Parse the would-be result without writing next to the app bundle (the file
// sandbox may refuse that, and --check should stay a read-only probe). The
// bundle ends in a `//# sourceMappingURL=` comment, so it must be parsed as a
// SCRIPT — wrapping it in a function would swallow the trailing `})`.
const probePath = join(tmpdir(), `muen-hero-tagline-probe-${process.pid}.js`)
writeFileSync(probePath, after, 'utf8')
try {
  execFileSync(process.execPath, ['--check', probePath], { stdio: 'pipe' })
} catch (error) {
  fail(`patched bundle is not valid JavaScript — original untouched\n${error.stderr ? error.stderr.toString() : error.message}`)
} finally {
  unlinkSync(probePath)
}

if (checkOnly) {
  console.log(`WOULD PATCH — ${bundlePath}`)
  console.log(`     ${PACKAGE} at ${statSync(bundlePath).size} bytes; call=${hasCall ? 'present' : 'missing'}, declaration=${hasDeclaration ? 'present' : 'missing'}; result parses.`)
  process.exit(0)
}

const tmpPath = `${bundlePath}.muen-patch.tmp`
writeFileSync(tmpPath, after, 'utf8')

// ── 5. backup + atomic replace ──────────────────────────────────────────────
// The field path keeps a `.muen-unpatched` copy beside the bundle for a
// one-command revert. The build path must not: the staged tree is packaged as
// it stands, so a sidecar copy would ship inside the app as dead weight (and is
// exactly the stray file `codesign --verify` named on the installed copy).
const backupPath = `${bundlePath}.muen-unpatched`
if (noBackup) {
  if (existsSync(backupPath)) unlinkSync(backupPath)
} else if (!existsSync(backupPath)) {
  copyFileSync(bundlePath, backupPath)
  console.log(`backup — ${backupPath}`)
}
renameSync(tmpPath, bundlePath)

console.log(`OK — patched ${bundlePath}`)
console.log(`     seam "${MARKER}": HeroShell call ${hasCall ? 'already present' : 'added'}, factory declaration ${hasDeclaration ? 'already present' : 'added'} (${before.length} → ${after.length} bytes)`)
console.log(`     Verify:  node scripts/verify-hero-tagline.mjs${harnessFlag >= 0 ? ` --harness ${harnessDir}` : ''}`)
if (noBackup) {
  console.log('     Staged tree: electron-builder packages and signs this as-is, so the')
  console.log('     seam is inside the app signature — no post-install patch, no broken seal.')
} else {
  console.log('     Restart the app, then hard-refresh the page (Cmd+Shift+R): the client')
  console.log('     bundle is served with an immutable revision, so the page must reload.')
  console.log(`     To revert: mv "${backupPath}" "${bundlePath}"`)
}
