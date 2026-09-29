/**
 * Epic 92 secondary checks. Usage:
 *   node auth-verify.mjs <cdpPort> <outDir> <expectBadge: yes|no>
 * Waits for signed-in (avatar image), asserts the PRO badge expectation,
 * screenshots, then signs out and screenshots the returned M orb.
 * The caller delivers sign-in first (deep link / restored session).
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('/Users/thuypham/.kun/hand-me-up-os/node_modules/playwright')

const [port, outDir, expectBadge] = process.argv.slice(2)
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
if (browser === undefined) throw new Error(`no CDP on ${port}`)

let page = null
for (let attempt = 0; attempt < 60 && page === null; attempt++) {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (!p.url().startsWith('http://')) continue
      const ok = await Promise.race([
        p.evaluate(() => typeof window.mitsumeru?.auth?.user === 'function').catch(() => false),
        new Promise((resolve) => setTimeout(() => resolve(false), 5000))
      ])
      if (ok) {
        page = p
        break
      }
    }
    if (page !== null) break
  }
  if (page === null) await sleep(1000)
}
if (page === null) throw new Error('no auth-bridge page')

const state = () =>
  Promise.race([
    page.evaluate(() => {
      const root = document.getElementById('mitsumeru-avatar-overlay')
      if (root === null) return { injected: false }
      // Menu reshape (Epic 92): the clickable element is .mua-row and the
      // avatar lives in .mua-avatar; .mua-orb is gone.
      const row = root.querySelector('.mua-row')
      const img = root.querySelector('.mua-avatar img')
      const badge = root.querySelector('.mua-pro')
      return {
        injected: true,
        signedIn: img !== null && img.complete && img.naturalWidth > 0,
        proVisible: badge !== null && badge.style.display !== 'none',
        aria: row?.getAttribute('aria-label') ?? ''
      }
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('state timeout')), 10000))
  ])

const waitFor = async (predicate, label, timeoutMs) => {
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

const wantBadge = expectBadge === 'yes'
const keepSession = process.argv.includes('--no-signout')
const shotName = process.argv[5]
const inState = await waitFor((s) => s.signedIn && s.proVisible === wantBadge, `signed in (badge ${expectBadge})`, 90000)
console.log(`[verify] signed in: ${JSON.stringify(inState)}`)
await sleep(400)
await page.screenshot({ path: join(outDir, `auth-${shotName ?? (wantBadge ? 'pro' : 'free')}.png`) })

if (keepSession) {
  console.log('[verify] session kept (--no-signout)')
  console.log('[verify] done')
  try {
    await browser.close()
  } catch {
    // gone
  }
  process.exit(0)
}

// Sign out lives inside the click-open menu (display:none until open), which
// fails Playwright's visibility actionability — drive the listener directly.
await page.evaluate(() => document.querySelector('#mitsumeru-avatar-overlay .mua-signout')?.click())
const outState = await waitFor((s) => !s.signedIn, 'signed out', 15000)
console.log(`[verify] signed out: ${JSON.stringify(outState)}`)
console.log('[verify] done')
try {
  await browser.close()
} catch {
  // gone
}
process.exit(0)
