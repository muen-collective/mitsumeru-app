/**
 * One-shot banner capture: read the update-banner state and screenshot it.
 * Usage: node capture.mjs <cdpPort> <outDir> <basename>
 * Used after the offer dialog has been answered (the main process is blocked
 * while the app-modal dialog is up, so capture must wait for the answer).
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
const require = createRequire(import.meta.url)
const { chromium } = require('/Users/thuypham/.kun/hand-me-up-os/node_modules/playwright')

const [port, outDir, name, waitText] = process.argv.slice(2)
const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
for (const c of b.contexts()) {
  for (const p of c.pages()) {
    if (!p.url().startsWith('http://')) continue
    if (waitText !== undefined) {
      const deadline = Date.now() + 150000
      for (;;) {
        const t = await p.evaluate(() => {
          const el = document.getElementById('mitsumeru-update-banner')
          return el === null ? '' : el.querySelector('.mub-text')?.textContent ?? ''
        })
        if (t.includes(waitText)) break
        if (Date.now() > deadline) {
          throw new Error(`timeout waiting for text '${waitText}'; last='${t}'`)
        }
        await new Promise((r) => setTimeout(r, 300))
      }
    }
    const st = await p.evaluate(() => {
      const el = document.getElementById('mitsumeru-update-banner')
      if (el === null) return { injected: false }
      const bar = el.querySelector('.mub-bar')
      const style = el.querySelector('style')
      return {
        injected: true,
        visible: el.style.display !== 'none',
        text: el.querySelector('.mub-text')?.textContent ?? '',
        hasRestart: el.querySelector('.mub-primary')?.style.display !== 'none',
        cssApplied:
          style?.sheet !== null && style?.sheet !== undefined && style.sheet.cssRules.length > 2,
        barHeight: bar !== null ? bar.getBoundingClientRect().height : 0
      }
    })
    console.log('state:', JSON.stringify(st))
    await new Promise((r) => setTimeout(r, 500))
    const path = join(outDir, `${name}.png`)
    await p.screenshot({ path })
    console.log('shot ->', path)
  }
}
await b.close()
