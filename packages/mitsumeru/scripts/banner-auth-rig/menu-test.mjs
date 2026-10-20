/**
 * Epic 92 menu test: row + click-open menu (DeepSeek Desktop pattern) with
 * Language switcher and Sign out. Usage:
 *   node menu-test.mjs <cdpPort> <outDir>
 * Requires a signed-in instance (deep link delivered by the caller first).
 * Verifies: menu opens on click, the Language submenu draws the harness's CATALOG (read from
 * `<html data-muen-languages>`, published by `@muen/dsh-localize` — it drew a hardcoded
 * `en`/`zh` pair until 2026-10-12), the check marks, live language switch (html lang flip +
 * menu labels), switch back, sign out.
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('/Users/thuypham/.kun/hand-me-up-os/node_modules/playwright')

const [port, outDir] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let browser
for (let attempt = 0; attempt < 45; attempt++) {
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    break
  } catch {
    await sleep(1000)
  }
}
if (browser === undefined) throw new Error('no CDP')

let page = null
for (let attempt = 0; attempt < 60 && page === null; attempt++) {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (!p.url().startsWith('http://')) continue
      const ok = await Promise.race([
        p.evaluate(() => typeof window.mitsumeru?.auth?.user === 'function').catch(() => false),
        new Promise((resolve) => setTimeout(() => resolve(false), 5000))
      ])
      if (ok) { page = p; break }
    }
    if (page !== null) break
  }
  if (page === null) await sleep(1000)
}
if (page === null) throw new Error('no auth-bridge page')
console.log(`[menu] attached: ${page.url()}`)

const state = () =>
  Promise.race([
    page.evaluate(() => {
      const root = document.getElementById('mitsumeru-avatar-overlay')
      if (root === null) return { injected: false }
      const row = root.querySelector('.mua-row')
      const menu = root.querySelector('.mua-menu')
      const sub = root.querySelector('.mua-sub')
      const img = root.querySelector('.mua-avatar img')
      const badge = root.querySelector('.mua-pro')
      const checked = root.querySelector('.mua-opt[aria-checked="true"]')
      return {
        injected: true,
        rowLabel: row?.querySelector('.mua-label')?.textContent ?? '',
        aria: row?.getAttribute('aria-label') ?? '',
        signedIn: img !== null && img.complete && img.naturalWidth > 0,
        proVisible: badge !== null && badge.style.display !== 'none',
        menuOpen: menu?.getAttribute('data-open') === '1',
        subOpen: sub?.getAttribute('data-open') === '1',
        checkedLocale: checked?.getAttribute('data-locale') ?? null,
        menuLabels: {
          settings: root.querySelector('.mua-menu [role="menuitem"] span')?.textContent ?? '',
          language: root.querySelector('.mua-lang span')?.textContent ?? '',
          signOut: root.querySelector('.mua-signout span')?.textContent ?? ''
        },
        optionLocales: [...root.querySelectorAll('.mua-opt')].map((opt) => opt.getAttribute('data-locale')),
        optionLabels: [...root.querySelectorAll('.mua-opt')].map((opt) => (opt.querySelector('span')?.textContent ?? '')),
        mirror: (() => {
          try {
            return JSON.parse(document.documentElement.dataset.muenLanguages ?? 'null')
          } catch {
            return null
          }
        })(),
        htmlLang: document.documentElement.lang
      }
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('state timeout')), 10000))
  ])

const waitFor = async (predicate, label, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs
  let last = 'nothing yet'
  while (Date.now() < deadline) {
    try {
      const s = await state()
      if (predicate(s)) return s
      last = JSON.stringify(s)
    } catch (err) {
      last = String(err)
    }
    await sleep(250)
  }
  throw new Error(`timeout waiting for ${label}; last=${last}`)
}

const shoot = async (name) => {
  await sleep(400)
  await page.screenshot({ path: join(outDir, `menu-${name}.png`) })
  console.log(`[menu] ${name}: ${JSON.stringify(await state())}`)
}

// 1. Signed-in row.
const signedIn = await waitFor((s) => s.signedIn && s.rowLabel.length > 0, 'signed-in row', 60000)
console.log(`[menu] row: ${JSON.stringify(signedIn)}`)
await shoot('row')

// 2. Click row -> menu opens. Guarded: the row TOGGLES, so an unconditional
// click closes a menu a previous run left open (measured 2026-10-20).
if (!(await state()).menuOpen) await page.click('.mua-row')
const opened = await waitFor((s) => s.menuOpen, 'menu open', 10000)
console.log(`[menu] opened: ${JSON.stringify(opened)}`)
await shoot('open')

// 2b. NORMALIZE to English. The chosen language persists, so a rig re-run after
// a run that ended on 中文 would otherwise fail step 3 on a stale expectation
// (measured 2026-10-20). A test that only passes from a wiped profile is not a
// gate.
const before = await state()
if (before.checkedLocale !== null && before.checkedLocale !== 'en') {
  if (!before.menuOpen) await page.click('.mua-row')
  await waitFor((s) => s.menuOpen, 'menu open for normalize', 10000)
  await page.click('.mua-menu .mua-lang')
  await waitFor((s) => s.subOpen, 'submenu for normalize', 10000)
  await page.click('.mua-opt[data-locale="en"]')
  await waitFor((s) => s.htmlLang.startsWith('en') && !s.menuOpen, 'normalized to en', 20000)
  console.log('[menu] normalized to en before the assertions')
}

// 3. Language -> submenu, English checked. Settings and Sign out are also
// `.mua-item`, and Settings is appended FIRST, so take the row by its stable
// hook — an ordinal selector here silently opened Settings instead.
if (!(await state()).menuOpen) await page.click('.mua-row')
await waitFor((s) => s.menuOpen, 'menu open', 10000)
await page.click('.mua-menu .mua-lang')
const sub = await waitFor((s) => s.subOpen && s.checkedLocale === 'en', 'language submenu (en checked)', 10000)
console.log(`[menu] submenu: ${JSON.stringify(sub)}`)
await shoot('language')

// 3b. The rows are the harness's CATALOG, not the pair the harness happens to ship.
if (sub.mirror === null || sub.mirror.length === 0) {
  console.log('[menu] no catalog mirror on this page — the built-in pair is all it can draw (a stock DSH, or a profile without @muen/dsh-localize)')
  if (sub.optionLocales.length !== 2) throw new Error(`no mirror, so the menu must fall back to the built-in two; it drew ${JSON.stringify(sub.optionLocales)}`)
} else {
  const mirrorIds = sub.mirror.map((row) => row.id).join(',')
  const rowIds = sub.optionLocales.join(',')
  if (mirrorIds !== rowIds) throw new Error(`the menu is not drawing the catalog: rows=[${rowIds}] mirror=[${mirrorIds}]`)
  if (sub.optionLocales.length <= 2) throw new Error(`the catalog holds ${sub.optionLocales.length} language(s) — the plugin that publishes it is probably not installed`)
  console.log(`[menu] catalog: ${sub.optionLocales.length} languages (${rowIds}) — labels: ${JSON.stringify(sub.optionLabels)}`)
}

// 4. Pick 中文 -> live switch: html lang flips, menu labels follow.
await page.click('.mua-opt[data-locale="zh"]')
const zh = await waitFor(
  // The row label is the ACCOUNT NAME while signed in (changed 2026-10-02), so the
  // switch is asserted on what actually localizes: the document language and the
  // menu's own labels.
  (s) => s.htmlLang.startsWith('zh') && !s.menuOpen && s.menuLabels.language === '语言',
  'live switch to zh',
  20000
)
console.log(`[menu] switched: ${JSON.stringify(zh)}`)
await shoot('zh')

// 5. Reopen and switch back to English.
await page.click('.mua-row')
await waitFor((s) => s.menuOpen, 'menu reopened', 10000)
await page.click('.mua-menu .mua-lang')
await waitFor((s) => s.subOpen, 'submenu reopened', 10000)
await page.click('.mua-opt[data-locale="en"]')
const backEn = await waitFor(
  (s) => s.htmlLang.startsWith('en') && !s.menuOpen && s.menuLabels.language === 'Language',
  'switch back to en',
  20000
)
console.log(`[menu] back to en: ${JSON.stringify(backEn)}`)

// 6. Sign out from the menu (real click — menu is click-open).
await page.click('.mua-row')
await waitFor((s) => s.menuOpen, 'menu for signout', 10000)
await page.click('.mua-signout')
// Sign out does not leave a signed-out overlay behind: the shell gates the whole
// app, so this page (and the avatar it drew) goes away and the window returns to
// the sign-in page. Assert the fact that matters — the session is gone — by
// asking the bridge, and tolerate the page detaching mid-poll.
const userAfter = async () => {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      try {
        const u = await p.evaluate(() => window.mitsumeru?.auth?.user?.() ?? null)
        if (u !== undefined) return u
      } catch {
        // page navigating or gone
      }
    }
  }
  return undefined
}
let cleared = null
const deadline = Date.now() + 20000
while (Date.now() < deadline) {
  const u = await userAfter()
  if (u === null) {
    cleared = u
    break
  }
  await sleep(300)
}
if (cleared !== null) throw new Error('sign out did not clear the session')
console.log('[menu] signed out: the session is cleared (window is back at the sign-in page)')
await shoot('signedout')

console.log('[menu] done')
try {
  await browser.close()
} catch {
  // gone
}
process.exit(0)
