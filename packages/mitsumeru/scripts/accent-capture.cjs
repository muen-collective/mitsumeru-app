// Accent preview: capture the REAL app with an accent applied, in both modes.
//
// Why a real renderer and not a mock-up: the question being decided is what the
// accent does to real surfaces — primary buttons, selected rows, hover tint — and
// those only exist in the app. A design mock would show the tokens, not the result.
//
// It also reports the COMPUTED token values, because a screenshot cannot be
// asserted on and I cannot see one. The measurements are the objective half; the
// PNGs are for a human to judge.
//
// Run: node scripts/accent-capture.cjs <url-with-token> <out-dir>
const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const [URL_ARG, OUT_DIR] = process.argv.slice(2)
if (!URL_ARG || !OUT_DIR) {
  console.error('usage: accent-capture <url-with-token> <out-dir>')
  process.exit(2)
}
mkdirSync(OUT_DIR, { recursive: true })

const KEY = 'mitsumeru-appearance:accent'
const ACCENTS = [
  { name: 'none', hex: null },
  { name: 'teal', hex: '#2dd4bf' },
  { name: 'amber', hex: '#fbbf24' },
  { name: 'azure', hex: '#0071e3' }
]

app.commandLine.appendSwitch('disable-gpu')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })

  const rows = []

  for (const scheme of ['light', 'dark']) {
    for (const accent of ACCENTS) {
      // Seed the stored accent BEFORE load: the row reads storage on register, so
      // this exercises the real persistence path rather than a test hook.
      await win.loadURL(URL_ARG)
      await win.webContents.executeJavaScript(
        `window.localStorage.${accent.hex === null ? `removeItem(${JSON.stringify(KEY)})` : `setItem(${JSON.stringify(KEY)}, ${JSON.stringify(accent.hex)})`}; true`
      )
      await win.loadURL(URL_ARG)
      await wait(5000)

      // Open Settings, then pick the mode cube (dsh's own Appearance row).
      await win.webContents.executeJavaScript(
        `(() => {
           const trigger = Array.from(document.querySelectorAll('button'))
             .find((el) => ['Settings', '\u8bbe\u7f6e'].includes((el.textContent || '').trim()));
           if (trigger) trigger.click();
           return true;
         })()`
      )
      await wait(1200)
      await win.webContents.executeJavaScript(
        `(() => {
           const label = ${JSON.stringify(scheme === 'light' ? 'Light' : 'Dark')};
           const cube = Array.from(document.querySelectorAll('button'))
             .find((el) => (el.textContent || '').trim() === label);
           if (cube) cube.click();
           return true;
         })()`
      )
      await wait(1200)

      // Objective half: what the tokens actually resolve to right now.
      const measured = await win.webContents.executeJavaScript(
        `(() => {
           const cs = getComputedStyle(document.body);
           const pick = (n) => cs.getPropertyValue(n).trim();
           return {
             dark: document.body.hasAttribute('data-ds-dark-theme'),
             brand: pick('--dsw-alias-brand-primary'),
             fill: pick('--dsw-alias-button-primary-fill'),
             hover: pick('--dsw-alias-interactive-bg-hover')
           };
         })()`
      )

      const file = join(OUT_DIR, `${scheme}-${accent.name}.png`)
      const image = await win.webContents.capturePage()
      writeFileSync(file, image.toPNG())
      rows.push({ scheme, accent: accent.name, hex: accent.hex, file, ...measured })
      console.log(
        `${scheme.padEnd(5)} ${accent.name.padEnd(6)} dark=${String(measured.dark).padEnd(5)} brand=${measured.brand.padEnd(22)} fill=${measured.fill.padEnd(22)} hover=${measured.hover}`
      )
    }
  }

  writeFileSync(join(OUT_DIR, 'measurements.json'), JSON.stringify(rows, undefined, 2))
  console.log(`\ncaptured ${rows.length} states into ${OUT_DIR}`)
  app.exit(0)
})
