#!/usr/bin/env node
/**
 * verify-hero-tagline.mjs — behaviour gate for the `conversation.hero.tagline`
 * seam added by `patch-hero-brand-tagline.mjs`.
 *
 * WHAT IT PROVES (and what it does not)
 * -------------------------------------
 * The seam is TWO edits, and this gate checks both against the INSTALLED bundle:
 *
 *   1. DECLARATION (edit B). The `conversation.content` factory's `children`
 *      table declares `conversation.hero.tagline` as `{ kind: "single",
 *      scope: "root" }`. This is the check whose absence shipped a blank-screen
 *      regression (2026-09-17): HeroShell's `renderSlot` is
 *      `boundFactoryRenderSlot`, which throws `SlotOwnershipError("slot '…' is
 *      not declared by this Factory")` for any key missing from that table. The
 *      throw happens during render, so the whole blank-session view — hero AND
 *      composer — unmounts. A recording `renderSlot` stub cannot see this check,
 *      which is exactly why the old version of this script passed a broken
 *      bundle. The table is read by brace-matching and EVALUATED, so it asserts
 *      the real object, not a text marker.
 *   2. CALL (edit A). The extracted, real `HeroShell` runs against a recording
 *      `renderSlot` and is asserted to:
 *        - call `renderSlot("conversation.hero.tagline", { fallbackText,
 *          headlineClassName }, { fallback })` in the headline's position;
 *        - hand the occupant the locale headline and the hero headline class;
 *        - keep `t("hero.headline")` as the slot fallback (a stock harness with
 *          no occupant renders the unchanged "Into the Unknown" headline).
 *
 * It does NOT prove the browser wiring end to end (occupant mount → painted
 * pixels) — that is the founder's eye on a reloaded page after a restart.
 *
 * Usage: node scripts/verify-hero-tagline.mjs [--harness build/harness | --app "/Applications/Mitsumeru.app"]
 * Exit 0 = seam declared and behaving. Exit 1 = missing or misbehaving.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const MARKER = 'conversation.hero.tagline'
const FACTORY_NAME = 'name: "conversation.content"'
const argv = process.argv.slice(2)
const appFlag = argv.indexOf('--app')
const harnessFlag = argv.indexOf('--harness')
const appRoot = appFlag >= 0 ? argv[appFlag + 1] : '/Applications/Mitsumeru.app'
// Same two targets as the patch script: an installed app (field) or a staged
// harness tree (build). The build runs this as a gate — see prepare-harness.sh.
const harnessDir = harnessFlag >= 0 ? argv[harnessFlag + 1] : join(appRoot, 'Contents/Resources/harness')
const bundlePath = join(
  harnessDir,
  'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js',
)
const backupPath = `${bundlePath}.muen-unpatched`

if (!existsSync(bundlePath)) {
  console.error(`FAIL — no client bundle at ${bundlePath}`)
  process.exit(1)
}
const source = readFileSync(bundlePath, 'utf8')

// ── 1. the seam is present in the shipped bytes ─────────────────────────────
if (!source.includes(MARKER)) {
  console.error(`FAIL — seam "${MARKER}" is not in ${bundlePath}`)
  console.error('       run: node 05-dsh-core/patches/patch-hero-brand-tagline.mjs')
  process.exit(1)
}

/** Brace-match the `children` table of the conversation factory definition. */
function childrenLiteralOf(text) {
  const factoryIdx = text.indexOf(FACTORY_NAME)
  if (factoryIdx < 0) return null
  const childrenIdx = text.indexOf('children: {', factoryIdx)
  if (childrenIdx < 0) return null
  const openIdx = childrenIdx + 'children: '.length
  let depth = 0
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(openIdx, i + 1)
    }
  }
  return null
}

// ── 2. DECLARATION: the factory must declare the seat (edit B) ──────────────
// Without this, HeroShell's renderSlot throws SlotOwnershipError at render time
// and the blank-session view (hero + composer) is blank. Evaluate the real table
// rather than grepping for a marker: a marker can be present while the table is
// not, which is precisely the regression this gate exists for.
const literal = childrenLiteralOf(source)
if (literal === null) {
  console.error('FAIL — could not locate the conversation factory children table; the bundle layout changed, re-derive this check')
  process.exit(1)
}
let children
try {
  children = new Function(`return (${literal})`)()
} catch (error) {
  console.error(`FAIL — the factory children table does not evaluate: ${error.message}`)
  process.exit(1)
}
const declaredProblems = []
const declared = children[MARKER]
if (declared === undefined) {
  declaredProblems.push(
    `the factory children table does NOT declare "${MARKER}" — boundFactoryRenderSlot would throw ` +
    `SlotOwnershipError at render, blanking the blank-session view`,
  )
} else {
  if (declared.kind !== 'single') declaredProblems.push(`declared kind is ${JSON.stringify(declared.kind)}, expected "single"`)
  if (declared.scope !== 'root') declaredProblems.push(`declared scope is ${JSON.stringify(declared.scope)}, expected "root"`)
}
if (children['conversation.hero.brand.mark'] === undefined) {
  declaredProblems.push('the hero brand-mark seat is gone from the factory children table')
}
if (declaredProblems.length > 0) {
  console.error('FAIL — seam declared incorrectly:')
  for (const problem of declaredProblems) console.error(`       - ${problem}`)
  console.error('       fix: node 05-dsh-core/patches/patch-hero-brand-tagline.mjs   (repairs an A-only bundle)')
  process.exit(1)
}

// ── 3. CALL: extract the real HeroShell and run it ──────────────────────────
const start = source.indexOf('function HeroShell(')
if (start < 0) {
  console.error('FAIL — HeroShell not found; the bundle layout changed, re-derive this check')
  process.exit(1)
}
// Heroes end at the `//#endregion` that closes their region.
const end = source.indexOf('//#endregion', start)
if (end < 0) {
  console.error('FAIL — could not find the end of the HeroShell region')
  process.exit(1)
}
const heroShellSource = source.slice(start, end)

// Minimal stubs — only what the extracted region references. `.jsxs` takes an
// ARRAY of children (that is why the headline row is a jsxs and the text node a
// jsx), so keep them distinct to avoid silently un-nesting children.
const jsx = (type, props) => ({ type, props })
const jsxs = (type, props) => ({ type, props })
function HeroFishStub() { return { type: 'HeroFishStub', props: {} } }
const heroCss = { root: 'root', stack: 'stack', headline: 'HERO_HEADLINE_CLASS', titleGroup: 'titleGroup', previewBadge: 'previewBadge', body: 'body', fishHitbox: 'hitbox', fish: 'fish' }

const calls = []
function renderSlot(name, ownerProps, options) {
  calls.push({ name, ownerProps, options })
  return { type: 'slot', name, ownerProps, rendered: options && options.fallback }
}

const t = (key) => (key === 'hero.headline' ? 'HEADLINE_TEXT' : key)

const makeHeroShell = new Function(
  'react_jsx_runtime', 'HeroFish', 'HeroShell_module_css_default', 'renderSlot', 't', 'react',
  `${heroShellSource}\nreturn HeroShell`,
)({ jsx, jsxs }, HeroFishStub, heroCss, renderSlot, t, { useState: (v) => [v, () => {}] })

// Uncontrolled render (no React needed for the assertion).
const tree = makeHeroShell({ t, renderSlot })

const taglineCall = calls.find((call) => call.name === MARKER)
if (!taglineCall) {
  console.error('FAIL — HeroShell did not render the tagline seam')
  console.error(`       slot calls seen: ${calls.map((c) => c.name).join(', ') || '(none)'}`)
  process.exit(1)
}
const problems = []
if (taglineCall.ownerProps.fallbackText !== 'HEADLINE_TEXT') {
  problems.push(`fallbackText was ${JSON.stringify(taglineCall.ownerProps.fallbackText)}, expected the locale headline`)
}
if (taglineCall.ownerProps.headlineClassName !== heroCss.headline) {
  problems.push(`headlineClassName was ${JSON.stringify(taglineCall.ownerProps.headlineClassName)}, expected the hero headline class`)
}
if (taglineCall.options === undefined || taglineCall.options.fallback !== 'HEADLINE_TEXT') {
  problems.push('slot fallback is not the locale headline — an empty hero would render blank on a stock harness')
}
// The headline row must still contain the mark seam + titleGroup.
const names = calls.map((c) => c.name)
if (!names.includes('conversation.hero.brand.mark')) problems.push('the hero brand-mark seam is gone')
if (!names.includes(MARKER)) problems.push(`${MARKER} missing`)
// Tree sanity: the hero renders stack > [headlineRow, body] and the headline row
// keeps the mark seat first, the title group (which now holds the seam) second.
const propsOf = (node) => (node && (node.props || node.PROPS))
// The root's children are [stack, composer-children] — unwrap to the stack div.
const rootChildren = propsOf(tree) && propsOf(tree).children
const stack = Array.isArray(rootChildren) ? rootChildren[0] : rootChildren
const stackChildren = propsOf(stack) && propsOf(stack).children
const headlineRow = Array.isArray(stackChildren) ? stackChildren[0] : undefined
const rowChildren = propsOf(headlineRow) && propsOf(headlineRow).children
const titleGroup = Array.isArray(rowChildren) ? rowChildren[1] : undefined
if (!titleGroup || propsOf(titleGroup).className !== heroCss.titleGroup) {
  problems.push('headline row structure changed: titleGroup is not the second child')
}

if (problems.length > 0) {
  console.error('FAIL — seam present but misbehaving:')
  for (const problem of problems) console.error(`       - ${problem}`)
  process.exit(1)
}

// ── 4. REGISTRATION: the REAL slots service must accept the seat + occupant ──
// Text assertions cannot prove the declaration is wired the way the runtime
// reads it, so run the actual SlotCore from the installed harness: register the
// factory with the installed children table, then take the exact two steps the
// occupant takes (spec exists; register is accepted) and the exact step the
// renderer takes (the factory definition carries the key). A second, A-only
// table is the negative control: it must be rejected.
const slotsLibPath = join(
  harnessDir,
  'node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js',
)
const serviceProblems = []
if (!existsSync(slotsLibPath)) {
  serviceProblems.push(`slots service not found at ${slotsLibPath} — cannot prove the registration path`)
} else {
  const { SlotCore } = await import(pathToFileURL(slotsLibPath).href)
  const childrenWithout = { ...children }
  delete childrenWithout[MARKER]

  const attempt = (table) => {
    const core = new SlotCore()
    core.registerFactory({ name: 'conversation.content', scope: 'session-maybe', children: table }, () => null)
    const definition = core.factory('conversation.content')
    let registerError = null
    try {
      core.register({ name: MARKER }, () => null)
    } catch (error) {
      registerError = error.message
    }
    return { core, definition, registerError }
  }

  const good = attempt(children)
  if (good.core.spec(MARKER) === undefined) {
    serviceProblems.push('the slots service has no spec for the seam after the factory declaration')
  }
  // The exact object boundFactoryRenderSlot reads: definition.children?.[key].
  if (good.definition === undefined || good.definition.children?.[MARKER] === undefined) {
    serviceProblems.push('the factory definition does not carry the seam key — boundFactoryRenderSlot would throw SlotOwnershipError')
  }
  if (good.registerError !== null) {
    serviceProblems.push(`the slots service refused the occupant registration: ${good.registerError}`)
  }

  const broken = attempt(childrenWithout)
  if (broken.registerError === null) {
    serviceProblems.push('negative control failed: the slots service accepted an occupant for an undeclared seat')
  }
  if (broken.definition?.children?.[MARKER] !== undefined) {
    serviceProblems.push('negative control failed: an A-only table still exposed the seam key')
  }
}

if (serviceProblems.length > 0) {
  console.error('FAIL — the installed slots service does not accept the seam:')
  for (const problem of serviceProblems) console.error(`       - ${problem}`)
  process.exit(1)
}

console.log(`OK — ${bundlePath}`)
console.log(`     factory "${FACTORY_NAME.split('"')[1]}" declares "${MARKER}" as ${JSON.stringify(declared)} — no SlotOwnershipError.`)
console.log(`     HeroShell renders "${MARKER}" with fallbackText + headlineClassName,`)
console.log('     and keeps the locale headline as the slot fallback (stock harness unchanged).')
console.log('     The installed slots service declares the seat and accepts an occupant;')
console.log('     an A-only table is rejected (negative control).')
if (existsSync(backupPath)) {
  console.log(`     revert with: mv "${backupPath}" "${bundlePath}"`)
}
