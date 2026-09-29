/**
 * Epic 92 sign-in flow driver: attach over CDP, assert the avatar overlay
 * through signed-out -> (deep link lands elsewhere) -> signed-in -> sign-out.
 *
 * Usage: node auth-shot.mjs <cdpPort> <outDir>
 * The deep link itself is delivered by the caller (open -a ... mitsumeru://)
 * after this script prints READY_FOR_DEEPLINK.
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
if (browser === undefined) throw new Error(`could not connect to CDP on ${port}`)

const findPage = async () => {
  for (let attempt = 0; attempt < 60; attempt++) {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        if (!page.url().startsWith('http://')) continue
        const ok = await Promise.race([
          page.evaluate(() => typeof window.mitsumeru?.auth?.user === 'function').catch(() => false),
          new Promise((resolve) => setTimeout(() => resolve(false), 5000))
        ])
        if (ok) return page
      }
    }
    await sleep(1000)
  }
  throw new Error('no page with the auth bridge found')
}

const page = await findPage()
console.log(`[auth] attached: ${page.url()}`)

const state = () =>
  Promise.race([
    page.evaluate(() => {
      const root = document.getElementById('mitsumeru-avatar-overlay')
      if (root === null) return { injected: false }
      // Reshaped in Epic 92's menu commit: the clickable element is .mua-row,
      // the avatar lives in .mua-avatar, and Sign out moved into .mua-menu.
      const row = root.querySelector('.mua-row')
      const badge = root.querySelector('.mua-pro')
      const img = root.querySelector('.mua-avatar img')
      const menu = root.querySelector('.mua-menu')
      return {
        injected: true,
        aria: row?.getAttribute('aria-label') ?? '',
        hasImg: img !== null,
        imgLoaded: img !== null && img.complete && img.naturalWidth > 0,
        proVisible: badge !== null && badge.style.display !== 'none',
        menuOpen: menu?.getAttribute('data-open') === '1',
        initial: root.querySelector('.mua-initial')?.textContent ?? null
      }
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('state evaluate timed out')), 10000))
  ])

const shoot = async (name) => {
  await sleep(500)
  const path = join(outDir, `auth-${name}.png`)
  await page.screenshot({ path })
  console.log(`[auth] ${name}: ${JSON.stringify(await state())} -> ${path}`)
}

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

// 1. Overlay injected, signed out.
await waitFor((s) => s.injected, 'overlay injection', 60000)
const signedOut = await waitFor((s) => s.initial === 'M' || s.aria.includes('Sign in'), 'signed-out orb', 15000)
console.log(`[auth] signed out: ${JSON.stringify(signedOut)}`)
await shoot('signedout')

// 2. Caller delivers the deep link now.
console.log('[auth] READY_FOR_DEEPLINK')

// 3. Exchange lands -> push -> avatar + PRO badge.
const signedIn = await waitFor((s) => s.hasImg && s.proVisible, 'signed-in avatar + PRO badge', 60000)
console.log(`[auth] signed in: ${JSON.stringify(signedIn)}`)
await shoot('signedin')

// 4. Sign Out — the menu is click-open now (Epic 92 reshape).
await page.click('#mitsumeru-avatar-overlay .mua-row')
await waitFor((s) => s.menuOpen, 'menu open for sign-out', 10000)
await page.click('#mitsumeru-avatar-overlay .mua-signout')
const backOut = await waitFor((s) => s.initial === 'M', 'signed out again', 15000)
console.log(`[auth] signed out again: ${JSON.stringify(backOut)}`)
await shoot('signedout-after')

console.log('[auth] done')
try {
  await browser.close()
} catch {
  // connection already gone
}
process.exit(0)
