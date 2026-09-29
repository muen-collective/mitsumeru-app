/**
 * Epic 92 menu test: row + click-open menu (DeepSeek Desktop pattern) with
 * Language switcher and Sign out. Usage:
 *   node menu-test.mjs <cdpPort> <outDir>
 * Requires a signed-in instance (deep link delivered by the caller first).
 * Verifies: menu opens on click, English/中文 submenu with check, live
 * language switch (html lang flip + menu labels), switch back, sign out.
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

// 2. Click row -> menu opens.
await page.click('.mua-row')
const opened = await waitFor((s) => s.menuOpen, 'menu open', 10000)
console.log(`[menu] opened: ${JSON.stringify(opened)}`)
await shoot('open')

// 3. Language -> submenu, English checked. (First .mua-item is Language;
// Sign out shares the class.)
await page.locator('.mua-menu .mua-item').first().click()
const sub = await waitFor((s) => s.subOpen && s.checkedLocale === 'en', 'language submenu (en checked)', 10000)
console.log(`[menu] submenu: ${JSON.stringify(sub)}`)
await shoot('language')

// 4. Pick 中文 -> live switch: html lang flips, menu labels follow.
await page.click('.mua-opt[data-locale="zh"]')
const zh = await waitFor(
  (s) => s.htmlLang.startsWith('zh') && !s.menuOpen && s.rowLabel.includes('已登录'),
  'live switch to zh',
  20000
)
console.log(`[menu] switched: ${JSON.stringify(zh)}`)
await shoot('zh')

// 5. Reopen and switch back to English.
await page.click('.mua-row')
await waitFor((s) => s.menuOpen, 'menu reopened', 10000)
await page.locator('.mua-menu .mua-item').first().click()
await waitFor((s) => s.subOpen, 'submenu reopened', 10000)
await page.click('.mua-opt[data-locale="en"]')
const backEn = await waitFor(
  (s) => s.htmlLang.startsWith('en') && !s.menuOpen && s.rowLabel.includes('Signed in'),
  'switch back to en',
  20000
)
console.log(`[menu] back to en: ${JSON.stringify(backEn)}`)

// 6. Sign out from the menu (real click — menu is click-open).
await page.click('.mua-row')
await waitFor((s) => s.menuOpen, 'menu for signout', 10000)
await page.click('.mua-signout')
const outState = await waitFor((s) => !s.signedIn && s.rowLabel.includes('Sign in'), 'signed out', 15000)
console.log(`[menu] signed out: ${JSON.stringify(outState)}`)
await shoot('signedout')

console.log('[menu] done')
try {
  await browser.close()
} catch {
  // gone
}
process.exit(0)
