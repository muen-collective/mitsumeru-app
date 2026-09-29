/**
 * Attach to the packaged Mitsumeru over CDP, watch for update-banner states,
 * and screenshot each one that appears.
 *
 * Usage: node shot.mjs <cdpPort> <outDir> <scenario>
 *   scenario: current | error | downloaded
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('/Users/thuypham/.kun/hand-me-up-os/node_modules/playwright')

const [port, outDir, scenario] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// CDP comes up a few seconds after launch — retry instead of failing the run.
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
const contexts = browser.contexts()

const findPage = async () => {
  for (let attempt = 0; attempt < 60; attempt++) {
    for (const ctx of contexts) {
      for (const page of ctx.pages()) {
        // Only the harness page: the splash (file://) still carries the
        // preload bridge, but attaching to it races the splash->harness
        // navigation and a mid-navigation evaluate hangs.
        if (!page.url().startsWith('http://')) continue
        const hasBridge = await Promise.race([
          page.evaluate(() => typeof window.mitsumeru?.updateStatus === 'function').catch(() => false),
          new Promise((resolve) => setTimeout(() => resolve(false), 5000))
        ])
        if (hasBridge) return page
      }
    }
    await sleep(1000)
  }
  throw new Error('no page with the mitsumeru bridge found')
}

const page = await findPage()
console.log(`[shot] attached: ${page.url()}`)

const bannerState = () => {
  // Bound every evaluate: a dropped CDP session must fail the run, not hang it.
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('bannerState evaluate timed out')), 10000)
  })
  return Promise.race([
    page.evaluate(() => {
      const el = document.getElementById('mitsumeru-update-banner')
      if (el === null) return { injected: false }
      const bar = el.querySelector('.mub-bar')
      const style = el.querySelector('style')
      return {
        injected: true,
        visible: el.style.display !== 'none',
        text: el.querySelector('.mub-text')?.textContent ?? '',
        hasRestart: el.querySelector('.mub-primary')?.style.display !== 'none',
        hasLink: el.querySelector('.mub-link')?.style.display !== 'none',
        // Layout probes: stylesheet parsed, bar is the spec's 36 px.
        cssApplied: style?.sheet !== null && style?.sheet !== undefined && style.sheet.cssRules.length > 2,
        barHeight: bar !== null ? bar.getBoundingClientRect().height : 0
      }
    }),
    timeout
  ])
}

const shoot = async (name) => {
  // Let the 240 ms slide-in finish — a mid-animation shot measures short.
  await sleep(600)
  const path = join(outDir, `${scenario}-${name}.png`)
  await page.screenshot({ path })
  console.log(`[shot] ${name}: ${JSON.stringify(await bannerState())} -> ${path}`)
}

const waitFor = async (predicate, label, timeoutMs = 45000) => {
  const deadline = Date.now() + timeoutMs
  let last = 'nothing yet'
  while (Date.now() < deadline) {
    // A transient evaluate timeout (navigation, CDP hiccup) must not kill the
    // run — keep polling until the deadline.
    try {
      const s = await bannerState()
      if (predicate(s)) return s
      last = JSON.stringify(s)
    } catch (err) {
      last = String(err)
    }
    await sleep(250)
  }
  throw new Error(`timeout waiting for ${label}; last=${last}`)
}

// Wait for injection.
await waitFor((s) => s.injected, 'banner injection', 60000)
console.log('[shot] banner injected')

if (scenario === 'current') {
  // The manual path: a person asks. checking chip first (racy), then the 3 s
  // "up to date" flash — both only appear for a manual trigger.
  await page.evaluate(() => {
    void window.mitsumeru.checkForUpdates()
  })
  // Poll fast for the checking chip.
  const chipSeen = await (async () => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const s = await bannerState()
      if (s.visible && s.text.includes('Checking')) {
        await shoot('checking')
        return true
      }
      await sleep(80)
    }
    return false
  })()
  if (!chipSeen) console.log('[shot] checking chip not caught (check was fast)')
  await waitFor((s) => s.visible && s.text.includes('Up to date'), 'current flash', 10000)
  await shoot('current')
  // Confirm the flash self-hides.
  await sleep(3500)
  const after = await bannerState()
  console.log(`[shot] flash auto-hid: ${String(!after.visible)}`)
} else if (scenario === 'error') {
  // Background startup check finds 9.9.9, auto-download 404s -> error strip
  // (shown because a download had already started).
  await waitFor((s) => s.visible, 'error strip', 60000)
  await shoot('error')
} else if (scenario === 'downloaded') {
  // Accept either the live download or a cache-hit straight to ready — then
  // shoot whichever states actually appear.
  const first = await waitFor(
    (s) => s.visible && (s.text.includes('Downloading') || s.text.includes('is ready')),
    'downloading or downloaded strip',
    90000
  )
  if (first.text.includes('Downloading')) {
    await shoot('downloading')
    await waitFor((s) => s.visible && s.text.includes('is ready'), 'downloaded strip', 90000)
  }
  await shoot('downloaded')
  // The failed-restart phase (click Restart Now -> install-error strip) was
  // proven in an earlier run; it is skipped here so the modal offer dialog
  // cannot race the capture. See artifacts/downloaded-install-failed.png.
} else {
  throw new Error(`unknown scenario ${scenario}`)
}

console.log('[shot] done')
try {
  await browser.close()
} catch {
  // connection already gone — the app may have quit after install
}
process.exit(0)
