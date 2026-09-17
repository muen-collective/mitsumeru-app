// Reference capture: the ASK-USER option card — checkbox + selected row — under an
// accent, in both modes.
//
// WHY CONSTRUCTED MARKUP: the card only renders during a live ask-user prompt, which
// needs a real agent turn and is not reproducible on demand. So this builds the card
// from the SHIPPED class names, inside the REAL app page, on the REAL stylesheet, so
// every token resolves exactly as it would in a live prompt. It is the real CSS and
// the real token values; only the trigger is synthetic. The measurements printed are
// therefore exact, and the screenshot is representative rather than incidental.
//
// The question being answered: does the checkbox still read (near-black on light /
// near-white on dark), and does selection still read as branded?
const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const [URL_ARG, OUT_DIR] = process.argv.slice(2)
mkdirSync(OUT_DIR, { recursive: true })
const K_LIGHT = 'mitsumeru-appearance:accent-light'
const K_DARK = 'mitsumeru-appearance:accent-dark'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// The shipped class names, read from dsh-client-ui-user-questions.
const CARD = 'Mbwy4a_card'
const OPTION = 'Mbwy4a_option'
const OPTION_SELECTED = 'Mbwy4a_optionSelected'
const CHECKBOX = 'Mbwy4a_checkbox'
const CHECKBOX_CHECKED = 'Mbwy4a_checkboxChecked'
const OPTION_COPY = 'Mbwy4a_optionCopy'
const OPTION_LABEL = 'Mbwy4a_optionLabel'

const CASES = [
  { name: 'default', light: null, dark: null },
  { name: 'eva', light: '#a0d6f1', dark: '#765898' },
  { name: 'amber', light: null, dark: '#fbbf24' },
  { name: 'indigo', light: '#4f83f2', dark: '#4f83f2' }
]

app.commandLine.appendSwitch('disable-gpu')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })

  const out = []
  for (const scheme of ['light', 'dark']) {
    for (const c of CASES) {
      await win.loadURL(URL_ARG)
      await win.webContents.executeJavaScript(
        `(() => { try {
           const set = (k, v) => v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
           set(${JSON.stringify(K_LIGHT)}, ${JSON.stringify(c.light)});
           set(${JSON.stringify(K_DARK)}, ${JSON.stringify(c.dark)});
           return true } catch (e) { return String(e) } })()`
      )
      await win.loadURL(URL_ARG)
      await wait(5000)

      // A fresh DSH_HOME shows dsh's first-run "Internal Testing Notice" modal, which
      // sits ABOVE the page and swallowed the first captures — a modal on top is not
      // a measurement of the card. Dismiss it, then probe.
      const dismissed = await win.webContents.executeJavaScript(
        `(() => {
           const labels = ['Continue', '\u7ee7\u7eed', 'Got it', 'OK', 'Close'];
           let handled = 0;
           for (const dlg of Array.from(document.querySelectorAll('[role="dialog"]'))) {
             const btn = Array.from(dlg.querySelectorAll('button'))
               .find((b) => labels.includes((b.textContent || '').trim()));
             if (btn) btn.click();
             else if (dlg.parentElement) dlg.parentElement.removeChild(dlg);
             handled += 1;
           }
           return handled;
         })()`
      )
      await wait(900)

      // Force the mode via dsh's own preference, then build the card markup.
      const measured = await win.webContents.executeJavaScript(
        `(async () => {
           const t = window.__DSH_BOOT__ && document.body; // page loaded
           // Switch mode by attribute: the presenter toggles this attribute, and it
           // is the same one our token override keys off.
           const want = ${JSON.stringify(scheme)};
           document.body.toggleAttribute('data-ds-dark-theme', want === 'dark');

           const host = document.createElement('div');
           host.id = '__mitsu_probe_card';
           host.style.cssText = 'position:fixed;left:24px;top:24px;z-index:99999;width:520px';
           host.innerHTML = \`
             <div class="${CARD}">
               <div style="padding:12px">
                 <div class="${OPTION} ${OPTION_SELECTED}" data-probe="selected">
                   <span class="${CHECKBOX} ${CHECKBOX_CHECKED}" data-probe="checkbox-selected">
                     <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                       <path d="M2.5 6.2l2.2 2.2L9.5 3.6" fill="none" stroke="currentColor" stroke-width="1.8"
                             stroke-linecap="round" stroke-linejoin="round"/>
                     </svg>
                   </span>
                   <span class="${OPTION_COPY}">
                     <span class="${OPTION_LABEL}">Selected option (checkbox checked)</span>
                   </span>
                 </div>
                 <div class="${OPTION}" data-probe="unselected">
                   <span class="${CHECKBOX}" data-probe="checkbox-unselected"></span>
                   <span class="${OPTION_COPY}">
                     <span class="${OPTION_LABEL}">Unselected option</span>
                   </span>
                 </div>
               </div>
             </div>\`;
           document.body.appendChild(host);

           const g = (el, prop) => el ? getComputedStyle(el).getPropertyValue(prop).trim() : null;
           const box = document.querySelector('[data-probe="checkbox-selected"]');
           const boxBefore = box ? getComputedStyle(box, '::before') : null;
           const sel = document.querySelector('[data-probe="selected"]');
           const card = host.querySelector('.${CARD}');

           return {
             dark: document.body.hasAttribute('data-ds-dark-theme'),
             tickColor: g(box, 'color'),
             boxBg: boxBefore ? boxBefore.backgroundColor : null,
             boxBorder: boxBefore ? boxBefore.borderTopColor : null,
             rowBg: g(sel, 'background-color'),
             cardBg: g(card, 'background-color')
           };
         })()`
      )

      // Crop to the card. A full-page shot renders the checkbox at ~14px, which is
      // not reviewable at any zoom. The rect is read back from the page so it tracks
      // the markup rather than being a guessed region.
      const rect = await win.webContents.executeJavaScript(
        `(() => {
           const host = document.getElementById('__mitsu_probe_card');
           if (!host) return null;
           const r = host.getBoundingClientRect();
           return { x: Math.floor(r.x) - 10, y: Math.floor(r.y) - 10,
                    width: Math.ceil(r.width) + 20, height: Math.ceil(r.height) + 20 };
         })()`
      )
      const file = join(OUT_DIR, `checkbox-${scheme}-${c.name}.png`)
      const image = rect ? await win.webContents.capturePage(rect) : await win.webContents.capturePage()
      writeFileSync(file, image.toPNG())
      out.push({ scheme, accent: c.name, dismissed, cropped: rect !== null, ...measured })
      console.log('CB ' + JSON.stringify({ scheme, accent: c.name, dismissed, cropped: rect !== null,
        dark: measured.dark, tick: measured.tickColor, boxBg: measured.boxBg,
        rowBg: measured.rowBg, cardBg: measured.cardBg }))
    }
  }
  writeFileSync(join(OUT_DIR, 'checkbox-measurements.json'), JSON.stringify(out, null, 2))
  app.exit(0)
})
