#!/usr/bin/env node
/**
 * patch-hero-brand-tagline.mjs — add the `conversation.hero.tagline` seam to the
 * vendored client bundle of `@deepseek-ai/dsh-client-ui-conversation`.
 *
 * WHY A PATCH
 * -----------
 * The blank-session hero ("Into the Unknown") renders its headline as plain
 * `t("hero.headline")` text inside HeroShell. There is NO slot there, and a
 * plugin cannot create one: the client Slots service exposes `inject`/`register`
 * only — a slot must be DECLARED by a parent entry before any renderer may call
 * it. Verified 2026-09-05 (and again 2026-09-17, see below):
 *
 *   - live slot tree (Slots.listSubTree) has no tagline/subtitle seam anywhere:
 *     `sidebar.brand.mark`, `sidebar.brand.name`, `conversation.hero.brand.mark`
 *     are the only brand seats.
 *   - `ctx.locale.register('conversation', 'en', …)` throws — the runtime keeps
 *     ONE dictionary per (namespace, locale), and `dsh-client-ui-conversation`
 *     already owns the `conversation` namespace. So the headline string cannot be
 *     remapped from a plugin either.
 *
 * So the seam has to be added to the UI package. This script performs that
 * additive edit, and `@muen/dsh-white-label` (Settings → Brand → Hero tagline)
 * is its occupant.
 *
 * WHERE IT RUNS (this copy)
 * -------------------------
 * Vendored from mitsu `05-dsh-core/patches/patch-hero-brand-tagline.mjs` — keep
 * the two in sync. This copy is the one the BUILD uses: `prepare-harness.sh`
 * runs it against the staged `build/harness` tree, BEFORE electron-builder signs
 * and packages the app, so the seam is inside the signature. Patching an
 * installed bundle after the fact (`--app`) is the field repair path and costs
 * the signature: `codesign --verify` reports "a sealed resource is missing or
 * invalid" naming the edited file, and Gatekeeper can no longer assess the app.
 *
 * THE SEAM IS TWO EDITS, NOT ONE (measured the hard way, 2026-09-17)
 * -----------------------------------------------------------------
 * A version of this script that ONLY wrapped the headline blanked every new
 * session — no hero, no composer. Reason, read from the installed renderer
 * (`@deepseek-ai/dsh-client-ui-renderer`): HeroShell is a component of the
 * `conversation.content` FACTORY, so its `renderSlot` is `boundFactoryRenderSlot`,
 * which refuses any key missing from the factory's own declaration:
 *
 *     const declared = definition.children?.[key]
 *     if (declared === void 0) throw new SlotOwnershipError(
 *       `slot '${key}' is not declared by this Factory`)
 *
 * The throw happens during render, so the whole blank-session view (composer
 * included) unmounts. `renderSlot` is NOT a plugin-extensible escape hatch: the
 * slot must be declared in the factory's `children` table first. Hence:
 *
 *   EDIT A — wrap the headline text node in `renderSlot("conversation.hero.tagline", …)`
 *   EDIT B — add `"conversation.hero.tagline": { kind: "single", scope: "root" }`
 *            to the `children` table of the `conversation.content` factory
 *            definition (registered by `defineFactory`, right beside the
 *            existing `conversation.hero.brand.mark` seat).
 *
 * Edit A alone is a render-time crash. Edit B alone declares a seat nothing
 * renders. Both are applied, and re-running this script REPAIRS a bundle that an
 * older, A-only version of it already touched.
 *
 * Edit A passes:
 *   - fallbackText       — the locale headline, so an occupant can re-render it
 *   - headlineClassName  — HeroShell's headline class, so the tagline inherits
 *                          the shipped hero typography instead of guessing it
 * and keeps `t("hero.headline")` as the slot fallback.
 *
 * UPSTREAM EQUIVALENT (preferred long-term — upstream this instead of patching)
 * ----------------------------------------------------------------------------
 * packages/client/ui-conversation/src/client/…:
 *   1. declare the child in the `conversation.content` factory's `children` map;
 *   2. in skeleton/HeroShell.tsx replace the headline text node:
 *        - children: [jsx("span", { children: t("hero.headline") }), …]
 *        + children: [jsx("span", {
 *        +   children: renderSlot("conversation.hero.tagline",
 *        +     { fallbackText: t("hero.headline"), headlineClassName: HeroShell_module_css_default.headline },
 *        +     { fallback: t("hero.headline") }),
 *        + }), …]
 *
 * The fallback keeps upstream behavior exactly: with no occupant the headline
 * renders as before, and with an empty `brandTagline` the occupant re-renders
 * the same `fallbackText` itself (so the words never vanish).
 *
 * Invariants: idempotent (each edit is marker-checked independently), atomic
 * (write to a temp file + rename), and verified before the original is replaced
 * — the result must parse, and the factory's `children` table must actually
 * evaluate to an object carrying the tagline seat.
 *
 * Usage:
 *   node patches/patch-hero-brand-tagline.mjs --harness build/harness   # build (prepare-harness.sh)
 *   node patches/patch-hero-brand-tagline.mjs --harness build/harness --check
 *   node patches/patch-hero-brand-tagline.mjs                           # default installed app
 *   node patches/patch-hero-brand-tagline.mjs --app "/Applications/Mitsumeru Dev.app"
 *
 * Exit 0 = patched, repaired or already patched. Exit 1 = could not patch
 * (nothing written).
 *
 * After running it, run the behaviour gate:
 *   node scripts/verify-hero-tagline.mjs --harness build/harness
 */

import { copyFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MARKER = 'conversation.hero.tagline'
// Edit A is present when HeroShell CALLS the seam; edit B when the factory
// DECLARES it. The two markers are disjoint (a call has `renderSlot("…", {`,
// a declaration has `"…": {`), which is what lets a repair target just one.
const SEAM_CALL_MARKER = `renderSlot("${MARKER}"`
const DECLARATION_MARKER = `"${MARKER}": {`
const FACTORY_NAME = 'name: "conversation.content"'
const BRAND_MARK_DECL = '"conversation.hero.brand.mark": {'
const PACKAGE = '@deepseek-ai/dsh-client-ui-conversation'
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
 * Read the `children` table of the `conversation.content` factory definition as
 * source text, by brace-matching from `children: {` (the literal has no braces
 * inside strings, so depth counting is exact).
 * @param {string} source - bundle text
 * @returns {string | null} the object literal, braces included
 */
function childrenLiteralOf(source) {
  const factoryIdx = source.indexOf(FACTORY_NAME)
  if (factoryIdx < 0) return null
  const childrenIdx = source.indexOf('children: {', factoryIdx)
  if (childrenIdx < 0) return null
  const openIdx = childrenIdx + 'children: '.length
  let depth = 0
  for (let i = openIdx; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(openIdx, i + 1)
    }
  }
  return null
}

/**
 * Evaluate the factory's `children` table. Returns null when it cannot be read
 * or parsed — callers treat that as a hard failure, never as "probably fine".
 * @param {string} source - bundle text
 * @returns {Record<string, { kind?: string, scope?: string }> | null}
 */
function readChildrenTable(source) {
  const literal = childrenLiteralOf(source)
  if (literal === null) return null
  try {
    const table = new Function(`return (${literal})`)()
    return table && typeof table === 'object' ? table : null
  } catch {
    return null
  }
}

if (!existsSync(bundlePath)) fail(`no client bundle at ${bundlePath} (wrong --app path?)`)
const before = readFileSync(bundlePath, 'utf8')

// ── 1. what is already applied? ─────────────────────────────────────────────
// The two edits are checked independently on purpose: a bundle patched by the
// earlier A-only version of this script has the call but not the declaration,
// and that combination is a render-time crash. Re-running must repair it.
const hasCall = before.includes(SEAM_CALL_MARKER)
const hasDeclaration = before.includes(DECLARATION_MARKER)
if (hasCall && hasDeclaration) {
  const table = readChildrenTable(before)
  if (table === null || table[MARKER] === undefined) {
    fail('markers present but the factory children table does not carry the seam — bundle is inconsistent; reinstall the bundle and patch again')
  }
  console.log(`OK (already patched) — ${bundlePath}`)
  console.log(`     seam "${MARKER}" is called by HeroShell and declared by the "${FACTORY_NAME.split('"')[1]}" factory.`)
  process.exit(0)
}

let after = before

// ── 2. EDIT B — declare the seat in the factory's children table ────────────
if (!hasDeclaration) {
  const occurrences = after.split(BRAND_MARK_DECL).length - 1
  if (occurrences !== 1) {
    fail(`expected exactly one ${BRAND_MARK_DECL} declaration; found ${occurrences} — upstream layout changed; re-derive the patch`)
  }
  const keyIdx = after.indexOf(BRAND_MARK_DECL)
  const openIdx = keyIdx + BRAND_MARK_DECL.length - 1
  let depth = 0
  let closeIdx = -1
  for (let i = openIdx; i < after.length; i += 1) {
    const ch = after[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) { closeIdx = i; break }
    }
  }
  if (closeIdx < 0) fail('could not find the end of the hero brand-mark declaration')
  if (after.slice(closeIdx + 1, closeIdx + 2) !== ',') {
    fail('the hero brand-mark declaration is not followed by a comma — refusing to edit')
  }
  const lineStart = after.lastIndexOf('\n', keyIdx) + 1
  // Copy the sibling seat's exact text (indentation included) and swap the key,
  // so the new entry is formatted identically however the bundle was emitted.
  const siblingText = after.slice(lineStart, closeIdx + 2)
  if (!/kind:\s*"single"/.test(siblingText) || !/scope:\s*"root"/.test(siblingText)) {
    fail(`hero brand-mark declaration has an unexpected shape, refusing to copy it: ${JSON.stringify(siblingText.slice(0, 120))}`)
  }
  const newEntryText = siblingText.replace(BRAND_MARK_DECL, `"${MARKER}": {`)
  after = after.slice(0, closeIdx + 2) + '\n' + newEntryText + after.slice(closeIdx + 2)
}

// ── 3. EDIT A — wrap the headline text node in the seam ─────────────────────
if (!hasCall) {
  // `t("hero.headline")` is READ exactly once in an unpatched bundle (the locale
  // dictionaries hold the key as a quoted property, not as this call), and it is
  // the HeroShell headline. A structural walk is deliberately avoided: the
  // bundled `titleGroup` has no `children: [` array of its own (it compiles to a
  // variadic `.jsxs(...)` argument list), so array-anchored matching would land
  // on the fishHitbox. The exact source line is asserted instead, so an upstream
  // refactor fails loudly rather than editing the wrong place.
  const HEADLINE_READ = 't("hero.headline")'
  if (after.split(HEADLINE_READ).length - 1 !== 1) {
    fail(`expected exactly one ${HEADLINE_READ} read; found ${after.split(HEADLINE_READ).length - 1} — upstream layout changed; re-derive the patch`)
  }
  const nodeIdx = after.indexOf(HEADLINE_READ)
  const lineStart = after.lastIndexOf('\n', nodeIdx) + 1
  const lineEnd = after.indexOf('\n', nodeIdx)
  if (lineEnd < 0) fail('anchors missing: unterminated headline line')
  const originalLine = after.slice(lineStart, lineEnd)
  if (!originalLine.trim().startsWith('children: [(0, react_jsx_runtime.jsx)("span", { children: ' + HEADLINE_READ)) {
    fail(`headline line has an unexpected shape, refusing to edit: ${JSON.stringify(originalLine.trim().slice(0, 120))}`)
  }
  const indent = originalLine.slice(0, originalLine.length - originalLine.trimStart().length)
  const replacementLine = [
    `${indent}children: [(0, react_jsx_runtime.jsx)("span", {`,
    `${indent}\tchildren: renderSlot("${MARKER}", {`,
    `${indent}\t\tfallbackText: ${HEADLINE_READ},`,
    `${indent}\t\theadlineClassName: HeroShell_module_css_default.headline`,
    `${indent}\t}, { fallback: ${HEADLINE_READ} })`,
    `${indent}}), (0, react_jsx_runtime.jsx)("span", {`,
  ].join('\n')
  after = after.slice(0, lineStart) + replacementLine + after.slice(lineEnd)
}

// ── 4. verify before touching the original ──────────────────────────────────
if (!after.includes(SEAM_CALL_MARKER)) fail('seam call missing from the would-be result — refusing to write')
if (!after.includes(DECLARATION_MARKER)) fail('seam declaration missing from the would-be result — refusing to write')
const table = readChildrenTable(after)
if (table === null) fail('could not evaluate the factory children table in the would-be result — refusing to write')
if (table[MARKER] === undefined) {
  fail('the would-be result does not declare the seam in the factory children table — HeroShell would throw SlotOwnershipError')
}
if (table[MARKER].kind !== 'single') {
  fail(`seam declared with kind ${JSON.stringify(table[MARKER].kind)}; expected "single"`)
}
if (table[MARKER].scope !== 'root') {
  fail(`seam declared with scope ${JSON.stringify(table[MARKER].scope)}; expected "root"`)
}
const brandMark = table['conversation.hero.brand.mark']
if (brandMark === undefined) fail('the would-be result lost the hero brand-mark declaration')

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
