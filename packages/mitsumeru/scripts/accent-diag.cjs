// One-shot: apply accent(s), report the resolved tokens in BOTH modes, and shoot PNGs.
const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const [URL_ARG, OUT_DIR] = process.argv.slice(2)
mkdirSync(OUT_DIR, { recursive: true })
const KEY = 'mitsumeru-appearance:accent'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
app.commandLine.appendSwitch('disable-gpu')

const CASES = [
  { name: 'default', hex: null },
  { name: 'teal',    hex: '#2dd4bf' },
  { name: 'amber',   hex: '#fbbf24' },
  { name: 'azure',   hex: '#0071e3' }
]

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })

  const out = []
  for (const scheme of ['light', 'dark']) {
    for (const c of CASES) {
      await win.loadURL(URL_ARG)
      await win.webContents.executeJavaScript(
        `(() => { try {
           ${c.hex === null ? `localStorage.removeItem(${JSON.stringify(KEY)})`
                            : `localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(c.hex)})`};
           return true;
         } catch (e) { return String(e) } })()`)
      await win.loadURL(URL_ARG)
      await wait(5200)

      // dsh's own Appearance row: click the cube whose label IS the mode name.
      const modeResult = await win.webContents.executeJavaScript(`(() => {
        const trigger = Array.from(document.querySelectorAll('button'))
          .find(b => ['Settings','\u8bbe\u7f6e'].includes((b.textContent||'').trim()))
        if (trigger) trigger.click()
        return true
      })()`)
      await wait(1500)
      const clicked = await win.webContents.executeJavaScript(`(() => {
        const label = ${JSON.stringify(scheme === 'light' ? 'Light' : 'Dark')}
        const cube = Array.from(document.querySelectorAll('[role="dialog"] button'))
          .find(b => (b.textContent||'').trim() === label)
        if (!cube) return { found:false, labels: Array.from(document.querySelectorAll('[role="dialog"] button')).map(b=>(b.textContent||'').trim()).filter(Boolean).slice(0,20) }
        cube.click()
        return { found:true }
      })()`)
      await wait(1500)

      const m = await win.webContents.executeJavaScript(`(() => {
        const cs = getComputedStyle(document.body)
        const p = n => cs.getPropertyValue(n).trim()
        return {
          isDark: document.body.hasAttribute('data-ds-dark-theme'),
          brand: p('--dsw-alias-brand-primary'),
          fill: p('--dsw-alias-button-primary-fill'),
          hover: p('--dsw-alias-interactive-bg-hover')
        }
      })()`)

      const file = join(OUT_DIR, `${scheme}-${c.name}.png`)
      writeFileSync(file, (await win.webContents.capturePage()).toPNG())
      out.push({ scheme, accent: c.name, picked: c.hex, modeClicked: clicked.found, ...m })
      console.log('ROW ' + JSON.stringify({ scheme, accent: c.name, picked: c.hex, dark: m.isDark, brand: m.brand, fill: m.fill, hover: m.hover, cubeFound: clicked.found }))
    }
  }
  writeFileSync(join(OUT_DIR, 'measurements.json'), JSON.stringify(out, null, 2))
  app.exit(0)
})
