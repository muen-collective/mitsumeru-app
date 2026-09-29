/**
 * One-shot banner probe: read the update-banner state over CDP and print it.
 * Usage: node probe.mjs <cdpPort>
 * Used to check whether the main process is blocked (modal offer dialog)
 * or the banner is reachable while an update sits in `downloaded`.
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('/Users/thuypham/.kun/hand-me-up-os/node_modules/playwright')

const b = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2]}`)
for (const c of b.contexts()) {
  for (const p of c.pages()) {
    if (!p.url().startsWith('http://')) continue
    const t = Date.now()
    const r = await Promise.race([
      p.evaluate(() => {
        const el = document.getElementById('mitsumeru-update-banner')
        if (el === null) return { injected: false }
        return {
          injected: true,
          vis: el.style.display !== 'none',
          text: el.querySelector('.mub-text')?.textContent ?? '',
          restart: el.querySelector('.mub-primary')?.style.display !== 'none'
        }
      }),
      new Promise((res) => setTimeout(() => res('EVAL-TIMEOUT'), 6000))
    ])
    console.log('probe:', JSON.stringify(r), `${Date.now() - t}ms`)
  }
}
await b.close()
