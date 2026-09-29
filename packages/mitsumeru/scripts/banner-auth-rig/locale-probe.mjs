/**
 * Probe the harness settings wire to pin the settings/update payload shape,
 * and check whether the language switch applies live (html lang flip) or
 * needs a reload. Usage: node locale-probe.mjs <cdpPort>
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('/Users/thuypham/.kun/hand-me-up-os/node_modules/playwright')

const port = process.argv[2]
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
        p.evaluate(() => true).catch(() => false),
        new Promise((resolve) => setTimeout(() => resolve(false), 5000))
      ])
      if (ok) { page = p; break }
    }
    if (page !== null) break
  }
  if (page === null) await sleep(1000)
}
if (page === null) throw new Error('no http page')

const report = await page.evaluate(async () => {
  const out = { lang: document.documentElement.lang, results: [] }
  const call = async (label, payload) => {
    try {
      const res = await fetch('/api/settings/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method: 'settings/update',
          payload
        })
      })
      const text = await res.text()
      out.results.push({ label, status: res.status, body: text.slice(0, 400) })
      return { res, text }
    } catch (error) {
      out.results.push({ label, error: String(error) })
      return { res: null, text: '' }
    }
  }

  // candidate 1: args-wrapped
  const r1 = await call('args-wrapped', { args: { ns: 'locale', patch: { preference: 'zh' } } })
  let shape = r1.text.includes('"ok":true') || r1.text.includes('"ok": true') ? 'args-wrapped' : null

  // candidate 2: flat
  if (shape === null) {
    const r2 = await call('flat', { ns: 'locale', patch: { preference: 'zh' } })
    shape = r2.text.includes('"ok":true') || r2.text.includes('"ok": true') ? 'flat' : null
  }
  out.winner = shape ?? 'none'
  out.langAfter = document.documentElement.lang
  return out
})
console.log(JSON.stringify(report, null, 2))

// live switch check: does html lang (or visible UI) flip without reload?
await sleep(2500)
const after = await page.evaluate(() => ({
  lang: document.documentElement.lang,
  title: document.title
}))
console.log('after 2.5s:', JSON.stringify(after))
await browser.close().catch(() => undefined)
process.exit(0)
