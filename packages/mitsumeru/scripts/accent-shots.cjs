// Accent preview shots: apply an accent pair, open Settings, scroll our row into
// view, and capture. Both modes, several accents.
//
// Deliberately reports the resolved tokens alongside each PNG: a screenshot is for
// a human to judge, and the token values are what a machine can check. Neither
// replaces the other.
//
// Run: node scripts/accent-shots.cjs <url-with-token> <out-dir>
const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const [URL_ARG, OUT_DIR] = process.argv.slice(2)
mkdirSync(OUT_DIR, { recursive: true })

const K_LIGHT = 'mitsumeru-appearance:accent-light'
const K_DARK = 'mitsumeru-appearance:accent-dark'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// name, dark accent, light accent. `null` means "unset" (dsh default).
const CASES = [
  { name: 'default', dark: null, light: null },
  { name: 'eva', dark: '#765898', light: '#a0d6f1' },  // EVA's own pair: purple / pale blue
  { name: 'teal-vivid', dark: '#2dd4bf', light: '#2dd4bf' }, // same hex both modes
  { name: 'amber', dark: '#fbbf24', light: null },     // light side DERIVED
  { name: 'purple-blue', dark: '#8b7cf6', light: '#2563eb' }
]

app.commandLine.appendSwitch('disable-gpu')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })

  // Seed storage, reload, then open Settings and scroll to our row.
  const prepare = async (c) => {
    await win.loadURL(URL_ARG)
    await win.webContents.executeJavaScript(
      `(() => { try {
         const set = (k, v) => v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
         set(${JSON.stringify(K_LIGHT)}, ${JSON.stringify(c.light)});
         set(${JSON.stringify(K_DARK)}, ${JSON.stringify(c.dark)});
         return true;
       } catch (e) { return String(e) } })()`
    )
    await win.loadURL(URL_ARG)
    await wait(5200)
    await win.webContents.executeJavaScript(
      `(() => {
         const b = Array.from(document.querySelectorAll('button'))
           .find((el) => ['Settings', '\u8bbe\u7f6e'].includes((el.textContent || '').trim()));
         if (b) b.click();
         return true;
       })()`
    )
    await wait(1600)
  }

  const setMode = async (scheme) => {
    await win.webContents.executeJavaScript(
      `(() => {
         const label = ${JSON.stringify(scheme === 'light' ? 'Light' : 'Dark')};
         const cube = Array.from(document.querySelectorAll('[role="dialog"] button'))
           .find((el) => (el.textContent || '').trim() === label);
         if (cube) cube.click();
         return true;
       })()`
    )
    await wait(900)
  }

  /** Scroll our row to the middle of the panel so the shot shows it. */
  const reveal = async () => {
    const found = await win.webContents.executeJavaScript(
      `(() => {
         const dlg = document.querySelector('[role="dialog"]');
         if (!dlg) return { ok: false };
         // Our row is the one whose text contains the accent title or a hex value.
         const nodes = Array.from(dlg.querySelectorAll('div'));
         const row = nodes.find((n) => /^#([0-9a-f]{6})$/i.test((n.textContent || '').trim()) === false
           && (n.textContent || '').includes('Accent /') ) // fallback below
           || nodes.find((n) => ['Accent', '\u5f3a\u8c03\u8272'].some((t) => (n.textContent || '').trim() === t));
         const target = row || null;
         if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center' });
         return { ok: target !== null };
       })()`
    )
    await wait(700)
    return found
  }

  const rows = []
  for (const scheme of ['light', 'dark']) {
    for (const c of CASES) {
      await prepare(c)
      await setMode(scheme)
      const shown = await reveal()

      const measured = await win.webContents.executeJavaScript(
        `(() => {
           const cs = getComputedStyle(document.body);
           const p = (n) => cs.getPropertyValue(n).trim();
           return { dark: document.body.hasAttribute('data-ds-dark-theme'),
                    brand: p('--dsw-alias-brand-primary'),
                    fill: p('--dsw-alias-button-primary-fill'),
                    hover: p('--dsw-alias-interactive-bg-hover') };
         })()`
      )

      const file = join(OUT_DIR, `${scheme}-${c.name}.png`)
      writeFileSync(file, (await win.webContents.capturePage()).toPNG())
      rows.push({ scheme, accent: c.name, seeded: c, revealed: shown.ok, file, ...measured })
      console.log('SHOT ' + JSON.stringify({ scheme, accent: c.name, dark: measured.dark,
        brand: measured.brand, fill: measured.fill, hover: measured.hover, rowFound: shown.ok }))
    }
  }

  writeFileSync(join(OUT_DIR, 'measurements.json'), JSON.stringify(rows, null, 2))
  console.log('wrote ' + rows.length + ' shots to ' + OUT_DIR)
  app.exit(0)
})
