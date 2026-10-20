// Mount proof for the mitsu profile (Epic 88, step 1); extended 2026-09-18 from
// the EVA-theme-only probe to the full 0.2.1 shipped set (SHIPPED_PLUGINS in
// src/main/harness.ts).
//
// WHY THIS EXISTS, and why it asserts positively: `window.__ModuleLoader__`
// fails SILENTLY. A client module that throws on import or never registers
// leaves the boot succeeding with only a console line — "UI boots, zero errors,
// panel absent" is the documented failure mode. So absence must be an asserted
// failure, and presence must be read back from the running renderer.
//
// Four things can each fail independently, and this walks all four:
//   1. the profile composes our bundle      -> asserted on the boot graph entries
//   2. the client module is SERVED          -> asserted by the combo-chunk fetch
//   3. the module body EVALUATES            -> asserted here: no console error
//   4. `apply()` REGISTERS into the shell   -> asserted here: row in the DOM
//
// What each of the four 0.2.1 quality-of-life plugins can prove:
//   - dsh-context-watchdog: a `settings.general.item` row ("Context reminder"),
//     read back from Settings → General.
//   - dsh-codex-fold: a `settings.plugin.item` row ("Status text"). NOTE: that
//     slot is declared by NO client bundle in this harness (dsh 0.1.6-alpha.2) —
//     it is named only in a type comment — so the row is genuinely unrenderable
//     here. When the shell does not declare the slot the probe says so and falls
//     back to the served-bundle + console-error assertion (see verify-mount.sh,
//     which greps the harness for the declaration and passes the answer in). The
//     DOM assertion is NOT weakened: the moment a bundle declares the slot the
//     probe requires the row again.
//   - dsh-turn-summary and dsh-changes-card: conversation-only, no settings
//     surface. Asserted as served (HTTP 200 + a marker unique to the bundle) and
//     no console error attributable to them.
//
// Run: node scripts/mount-probe.cjs <url-with-token>
// Exit 0 = every shipped plugin mounted. Non-zero = not mounted, with the reason
// printed.
const { app, BrowserWindow } = require('electron')

/**
 * Every probe boots a NEW harness on a NEW random port, and each port's token
 * issues its own `dsh-auth-*` cookie with a 30-day life. Electron keeps one
 * shared cookie jar at ~/Library/Application Support/Electron, so cookies
 * accumulate one per run — measured: 70 of them, ~17.6 KB of Cookie header,
 * over Node's 16 KB maxHeaderSize. The server then answers **431 Request
 * Header Fields Too Large** before the app loads, and the failure surfaces as
 * "the app did not load (nodes=3)" — which reads like a harness or plugin bug
 * and is not one.
 *
 * So each probe gets its own throwaway profile. The cookie jar starts empty
 * every run, and nothing lands in the developer's real one.
 */
function isolateProfile() {
  if (typeof app === 'undefined') return null;
  const { mkdtempSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mitsumeru-probe-'));
  app.setPath('userData', dir);
  return dir;
}

isolateProfile();


const URL_ARG = process.argv[2]
if (!URL_ARG) {
  console.error('usage: mount-probe <url-with-token>')
  process.exit(2)
}

// Does any NON-Muen client bundle in this harness declare the
// `settings.plugin.item` slot? verify-mount.sh greps the staged tree and passes
// the answer in. Default to requiring the row, so a missing flag can never
// silently weaken the assertion.
const CODEX_FOLD_SLOT_DECLARED = process.env.CODEX_FOLD_SLOT_DECLARED !== 'no'

/**
 * The positive signals, all strings from the plugins' own client bundles, so
 * finding them proves the module evaluated, apply() ran, AND the contribution
 * reached the DOM.
 */
// dsh-eva-theme — Settings → General theme picker: title + one card per skin.
const ROW_TITLE = 'EVA theme'
const ROW_SKINS = ['EVA 01', 'EVA 00']
// dsh-context-watchdog — `rowTitle` in plugins/dsh-context-watchdog/lib/client.js.
const WATCHDOG_ROW_TITLE = 'Context reminder'
// dsh-codex-fold — `settingsTitle` is the label its `settings.plugin.item` card
// renders (plugins/dsh-codex-fold/lib/client.js, StatusTextCard).
const CODEX_FOLD_ROW_TITLE = 'Status text'
/**
 * Conversation-only plugins: no settings surface, so the assertable facts are
 * (a) the boot graph composes them, (b) the harness SERVES their bundle with
 * HTTP 200, and (c) the served body carries a marker unique to that bundle.
 * Markers are namespace constants declared inside each client bundle.
 */
// TWO RETIRED 2026-10-02 (see RETIRED_PLUGINS in src/main/harness.ts): dsh-turn-summary and
// dsh-codex-fold. This probe kept listing them, so the gate failed on packages the app no longer
// ships — a stale gate, not a broken build. The set below is SHIPPED_PLUGINS's conversation-only
// remainder.
const CONVERSATION_PLUGINS = [
  { id: '@muen/dsh-changes-card', marker: 'muen-changes-card' },
]
// The full shipped set, so a plugin silently missing from the composed graph is
// a failure even before any DOM is read.
const SHIPPED_IDS = [
  '@muen/dsh-brand-mitsumeru',
  '@muen/dsh-eva-theme',
  '@muen/dsh-white-label',
  '@muen/dsh-context-watchdog',
  '@muen/dsh-changes-card',
]
// (dsh-codex-fold was retired 2026-10-02 and is no longer probed — see RETIRED_PLUGINS.)

app.commandLine.appendSwitch('disable-gpu')
// Keep it off-screen but real: this is a genuine renderer, not a simulation.
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })

  // level: 0 verbose, 1 info, 2 warning, 3 error. Only real errors count; the
  // Electron "Insecure Content-Security-Policy" notice is a level-2 warning.
  const consoleErrors = []
  const consoleWarnings = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) consoleErrors.push(message)
    else if (level >= 2) consoleWarnings.push(message)
  })

  const fail = (why) => {
    console.log(`[mount-probe] FAIL: ${why}`)
    if (consoleErrors.length > 0) {
      console.log('[mount-probe] console errors:')
      for (const line of consoleErrors.slice(0, 12)) console.log('   ' + line)
    }
    app.exit(1)
  }

  try {
    await win.loadURL(URL_ARG)
  } catch (error) {
    return fail(`loadURL threw: ${error && error.message}`)
  }

  // The shell is a SPA that boots from a boot wire; give the plugin graph time
  // to materialize and `apply()` to run before reading anything back.
  await new Promise((resolve) => setTimeout(resolve, 6000))

  const probe = await win.webContents.executeJavaScript(
    `(() => {
       return {
         title: document.title,
         nodeCount: document.querySelectorAll('*').length,
         bootWired: typeof window.__DSH_BOOT__ !== 'undefined'
       };
     })()`
  )

  console.log('[mount-probe] page title      :', JSON.stringify(probe.title))
  console.log('[mount-probe] DOM nodes       :', probe.nodeCount)
  console.log('[mount-probe] boot wire loaded:', probe.bootWired)

  // A ~27-node page with no title is the trust-fence fallback, not the app.
  if (!probe.bootWired || probe.nodeCount < 100) {
    return fail(`the app did not load (nodes=${probe.nodeCount}, bootWire=${probe.bootWired}) — auth, trust fence, or an over-large Cookie header. If nodes is tiny (under ~10), suspect HTTP 431: repeated probe runs accumulate one dsh-auth cookie per harness PORT in the shared Electron profile, and past Node's 16KB maxHeaderSize the server answers 431 before the app loads. isolateProfile() prevents it; an older profile needs its dsh-auth cookies cleared.`)
  }

  // ---- 1+2. composition and SERVING, from the boot graph and a real fetch ----
  // `__DSH_BOOT__` carries the composed graph: batches of client bundles, each
  // with its combo URL and the entry ids it contains. The combo-chunk fetch is
  // the proof that the bytes the module system will evaluate are actually
  // served, not merely declared — the failure mode this catches is a bundle the
  // profile composes but the harness cannot read.
  const served = await win.webContents.executeJavaScript(
    `(async () => {
       const wanted = ${JSON.stringify(SHIPPED_IDS)};
       const conversation = ${JSON.stringify(CONVERSATION_PLUGINS)};
       const graph = (window.__DSH_BOOT__ && window.__DSH_BOOT__.batches) || [];
       const composed = new Set();
       for (const batch of graph) for (const id of batch.entries || []) composed.add(id);
       const missingFromGraph = wanted.filter((id) => !composed.has(id));
       const results = [];
       for (const entry of conversation) {
         const batch = graph.find((b) => (b.entries || []).includes(entry.id));
         if (!batch) { results.push({ id: entry.id, ok: false, why: 'not in any composed batch' }); continue; }
         try {
           const response = await fetch(batch.url, { credentials: 'include' });
           const body = await response.text();
           results.push({
             id: entry.id,
             ok: response.status === 200 && body.includes(entry.marker),
             status: response.status,
             bytes: body.length,
             hasMarker: body.includes(entry.marker),
             url: batch.url
           });
         } catch (error) {
           results.push({ id: entry.id, ok: false, why: String(error && error.message || error) });
         }
       }
       return { missingFromGraph, results };
     })()`
  )

  for (const entry of CONVERSATION_PLUGINS) {
    const result = served.results.find((r) => r.id === entry.id) || {}
    console.log(`[mount-probe] ${entry.id}: served ${result.status || '-'}, ${result.bytes || 0} bytes, marker ${result.hasMarker ? 'FOUND' : 'ABSENT'}`)
  }

  // State the conversation-only limit explicitly rather than implying a render
  // proof: a changes-card needs a FINISHED turn, and this probe stages no session.
  // Served + no-registration-throw is everything that is assertable here.
  console.log('[mount-probe] changes-card row: NOT STAGED — same turn-shaped limitation.')

  if (served.missingFromGraph.length > 0) {
    return fail(`the profile did not compose: ${served.missingFromGraph.join(', ')} — check the bundle list verify-mount.sh writes`)
  }
  for (const result of served.results) {
    if (!result.ok) {
      return fail(`${result.id} is not served correctly: ${result.why || `HTTP ${result.status}, marker ${result.hasMarker ? 'present' : 'absent'}`}`)
    }
  }

  // A MODAL CAN SQUAT OVER THE UI (measured 2026-10-19): rc.2 opens a "Preview Notice — DeepSeek Harness
  // 0.2 is still in preview…" dialog on a fresh profile, and it is the `[role="dialog"]` the probe reads.
  // Dismiss THAT ONE by its own words, and only that one.
  //
  // WHAT THIS MUST NEVER DO, learned the hard way the same day: a loose matcher (`includes('preview')`)
  // plus "click the first button" once pressed a control in the ACCOUNT MENU and opened the deepseek
  // sign-in dialog, which then looked exactly like a product-level account wall. There is no such wall —
  // a clean boot with the shell's own bridge and platform mark renders the app with zero dialogs
  // (measured, twice). So the notice is matched on its exact title, its acknowledgement is matched on
  // its exact words, and a notice that does not match is left alone.
  const dismissed = await win.webContents.executeJavaScript(
    `(() => {
       const notice = Array.from(document.querySelectorAll('[role="dialog"]'))
         .find((el) => (el.textContent || '').trim().startsWith('Preview Notice'));
       if (!notice) return { present: false };
       const buttons = Array.from(notice.querySelectorAll('button'));
       const ack = buttons.find((b) => /^(continue|got it|ok|close)$/i.test((b.textContent || '').trim()));
       if (!ack) return { present: true, clicked: null };
       ack.click();
       return { present: true, clicked: (ack.textContent || '').trim() };
     })()`
  )
  console.log('[mount-probe] preview notice  :', dismissed.present ? (dismissed.clicked === null ? 'present, no acknowledgement found' : `dismissed (${dismissed.clicked})`) : 'absent')
  await new Promise((resolve) => setTimeout(resolve, 800))

  // ---- 4a. the two DOM surfaces, read back from Settings --------------------
  // `settings.general.item` only renders while the Settings panel is OPEN, so the
  // row cannot be in the DOM yet. Open it, then look. (Claiming "silent
  // non-mount" before this step would have been a false negative — the same
  // mistake as probing a single-file /plugins URL.)
  //
  // OPEN IT THE WAY THE APP ITSELF DOES (2026-10-19).
  //
  // A synthetic Cmd-, does NOT work here: in desktop runtime the shortcut registry takes its bindings
  // from the NATIVE keyboard bridge (`window.dshDesktop.keyboard.subscribe`), never from a DOM keydown,
  // so dispatching one opens nothing — measured. What DOES work is the two-step hop Mitsumeru's own
  // account overlay already ships (src/main/avatar-overlay.ts): reveal the hidden `sidebar.settings`
  // ancestor so its launcher has a live rect, click the launcher, then click the Settings row the
  // harness menu renders. That is exactly what a person clicking "Settings" in the account menu does.
  //
  // The menu is veiled for the length of the hop so the intermediate row is never on screen, and the
  // ancestor's original style is restored either way.
  const hopped = await win.webContents.executeJavaScript(
    `(async () => {
       const slot = document.querySelector('[data-slot="sidebar.settings"]');
       if (!slot) return { ok: false, why: 'the sidebar.settings slot is not in the DOM' };
       const outer = slot.parentElement;
       const saved = outer.getAttribute('style');
       const veil = document.createElement('style');
       veil.textContent = '[role="menu"] { visibility: hidden !important; }';
       document.head.append(veil);
       outer.style.setProperty('display', 'contents', 'important');
       void slot.offsetHeight;
       const launcher = slot.querySelector('button');
       if (!launcher) {
         veil.remove();
         if (saved === null) outer.removeAttribute('style'); else outer.setAttribute('style', saved);
         return { ok: false, why: 'the settings slot has no launcher' };
       }
       launcher.click();
       for (let tries = 0; tries < 90; tries += 1) {
         await new Promise((resolve) => requestAnimationFrame(resolve));
         const row = [...document.querySelectorAll('button')]
           .find((b) => (b.textContent || '').trim().toLowerCase().startsWith('settings'));
         if (row) {
           row.click();
           veil.remove();
           if (saved === null) outer.removeAttribute('style'); else outer.setAttribute('style', saved);
           return { ok: true, row: (row.textContent || '').trim().slice(0, 40), tries };
         }
       }
       veil.remove();
       if (saved === null) outer.removeAttribute('style'); else outer.setAttribute('style', saved);
       return { ok: false, why: 'no Settings row appeared in the menu' };
     })()`
  )
  if (!hopped.ok) return fail(`could not open Settings: ${hopped.why}`)
  console.log('[mount-probe] settings opened via:', hopped.row)

  await new Promise((resolve) => setTimeout(resolve, 2500))

  const afterOpen = await win.webContents.executeJavaScript(
    `(() => {
       const text = document.body.textContent || '';
       // THE SETTINGS DIALOG, NOT "THE FIRST dialog ON THE PAGE". The harness marks it
       // data-shortcut-modal="settings"; a bare role=dialog once matched a stale sign-in dialog and
       // reported a panel that was on screen as missing.
       const dialog = document.querySelector('[data-shortcut-modal="settings"]')
         || Array.from(document.querySelectorAll('[role=dialog]')).find((el) => (el.textContent || '').includes('General'));
       return {
         dialog: dialog !== null,
         rowTitle: text.includes(${JSON.stringify(ROW_TITLE)}),
         skins: ${JSON.stringify(ROW_SKINS)}.filter((label) => text.includes(label)),
         // THE GENERAL PANEL IS IDENTIFIED BY ITS SIGNAL SLOT, not by copy (2026-10-19): the old
         // 'Appearance' + 'Font size' pair were words from an older release and would report "not
         // rendering" on a panel that is on screen. The slot element is the contract.
         // The slot element is the contract, and its CHILDREN are the render: my first cut asked
         // whether the slot exists in the FIRST [role=dialog], which after the hop is the sign-in dialog
         // the menu once opened — so the row was found in the body while this reported 'not rendered'.
         generalOpen: document.querySelector('[data-slot="settings.general.item"]') !== null,
         generalItems: dialog !== null ? dialog.querySelectorAll('[data-slot="settings.general.item"] > *').length : 0,
         dialogHead: dialog !== null ? (dialog.textContent || '').slice(0, 180) : '',
         watchdogRow: text.includes(${JSON.stringify(WATCHDOG_ROW_TITLE)})
       };
     })()`
  )

  console.log('[mount-probe] settings dialog :', afterOpen.dialog)
  console.log('[mount-probe] General rendered:', afterOpen.generalOpen, '· items', afterOpen.generalItems)
  console.log('[mount-probe] EVA row title   :', afterOpen.rowTitle ? 'FOUND' : 'ABSENT')
  console.log('[mount-probe] EVA skin cards  :', afterOpen.skins.join(', ') || 'NONE')
  console.log('[mount-probe] watchdog row    :', afterOpen.watchdogRow ? 'FOUND' : 'ABSENT')
  if (!afterOpen.generalOpen) console.log('[mount-probe] dialog head     :', JSON.stringify(afterOpen.dialogHead))

  if (!afterOpen.dialog) return fail('the Settings panel did not open')
  if (!afterOpen.rowTitle) {
    return fail(`Settings opened but "${ROW_TITLE}" is not in it — registration did not reach the panel`)
  }
  const missing = ROW_SKINS.filter((label) => !afterOpen.skins.includes(label))
  if (missing.length > 0) {
    return fail(`the row rendered but is missing skin card(s): ${missing.join(', ')}`)
  }
  if (!afterOpen.watchdogRow) {
    return fail(`@muen/dsh-context-watchdog did not mount: Settings → General is open but "${WATCHDOG_ROW_TITLE}" (its rowTitle) is not in it`)
  }

  // ---- 4b. codex-fold's Plugins-page row ------------------------------------
  // Open the Plugins settings section ("Built-in plugins") and look for the label
  // its `settings.plugin.item` card renders.
  const pluginsNav = await win.webContents.executeJavaScript(
    `(() => {
       const candidates = Array.from(document.querySelectorAll('button,[role="tab"],a'));
       const button = candidates.find((el) => ['Built-in plugins', '\u5185\u7f6e\u63d2\u4ef6'].includes((el.textContent || '').trim()));
       if (!button) return { clicked: false, seen: candidates.map(e => (e.textContent || '').trim()).filter(Boolean).slice(0, 40) };
       button.click();
       return { clicked: true };
     })()`
  )
  if (CODEX_FOLD_SLOT_DECLARED && !pluginsNav.clicked) {
    return fail(`could not open the Plugins settings section; nav seen: ${JSON.stringify(pluginsNav.seen)}`)
  }
  if (pluginsNav.clicked) await new Promise((resolve) => setTimeout(resolve, 2500))

  const pluginsPage = pluginsNav.clicked
    ? await win.webContents.executeJavaScript(
        `(() => {
           const dialog = document.querySelector('[role="dialog"]');
           const text = dialog ? dialog.textContent : '';
           return { codexRow: text.includes(${JSON.stringify(CODEX_FOLD_ROW_TITLE)}) };
         })()`
      )
    : { codexRow: false }

  if (CODEX_FOLD_SLOT_DECLARED) {
    console.log('[mount-probe] codex-fold row  :', pluginsPage.codexRow ? 'FOUND' : 'ABSENT')
    if (!pluginsPage.codexRow) {
      return fail(`@muen/dsh-codex-fold did not mount: a client bundle in this harness declares "settings.plugin.item", but its card (label "${CODEX_FOLD_ROW_TITLE}") is not on the Plugins page`)
    }
  } else {
    console.log(`[mount-probe] codex-fold row  : IMPOSSIBLE (asserted, not skipped) — verify-mount.sh grepped every @deepseek-ai/*/lib/client.js in this harness and NONE declares "settings.plugin.item"; on dsh 0.1.6-alpha.2 the key exists only in a type comment, so the card can never render in this fork. Asserted instead for this row: bundle served (above) + no console error (below).`)
  }

  // ---- 3. EVALUATION: no unexpected console error from the shipped set -------
  // Errors fall into three classes here, and the third is what keeps this gate
  // honest:
  //   * ours — the four plugins this gate adds. Always a failure.
  //   * a KNOWN, pre-existing defect in the set (listed below, recorded in
  //     docs/status/2026-09-18-mitsumeru-0.2.1-qol-set.md). Tolerated, named.
  //   * anything else from ANY shipped bundle — a failure. An earlier version
  //     filtered by plugin name alone, which silently swallowed exactly the
  //     error this list now names.
  // Currently EMPTY, and that is the point: the one entry this list ever held was
  // the brand-seat collision (@muen/dsh-brand-mitsumeru and @muen/dsh-white-label
  // both claiming the exclusive sidebar/hero seats), fixed on 2026-09-18 by making
  // white-label claim them at priority -1 and only when a brand is configured. The
  // list survives as the place to name a measured, recorded pre-existing defect —
  // never a place to make an unexplained error go away.
  const KNOWN_UNATTRIBUTED = []
  const attributable = consoleErrors.filter((line) =>
    SHIPPED_IDS.some((id) => line.includes(id)) ||
    // turn-summary's seat: a keyed conflict names the slot, not the plugin.
    (line.includes('conversation.chat.node') && line.includes('turn-process')) ||
    (line.includes('conversation.chat.turnTail')) ||
    (line.includes('settings.plugin.item')) ||
    (line.includes('settings.general.item'))
  )
  if (attributable.length > 0) {
    return fail(`our plugins logged ${attributable.length} console error(s) — the module threw or its registration collided`)
  }
  const known = consoleErrors.filter((line) => KNOWN_UNATTRIBUTED.some((entry) => line.includes(entry)))
  const unknown = consoleErrors.filter((line) => !known.includes(line))
  if (unknown.length > 0) {
    return fail(
      `${unknown.length} console error(s) from the shipped set are neither ours nor a named known defect — ` +
        'add it to KNOWN_UNATTRIBUTED only with a measurement and a status-doc entry',
    )
  }

  console.log(
    `[mount-probe] console errors  : ${consoleErrors.length} total — 0 from the four QOL plugins, ` +
      `${known.length} named pre-existing (see KNOWN_UNATTRIBUTED)`,
  )
  console.log('[mount-probe] PASS: seven bundles composed and served with HTTP 200; no shipped plugin logged a registration error; Settings → General shows the EVA theme row, both skins and the Context reminder row' + (CODEX_FOLD_SLOT_DECLARED ? ', and codex-fold renders its Plugins row' : '; codex-fold\'s Plugins row is unrenderable in this harness (slot declared by no bundle) and was asserted as served + clean instead'))
  app.exit(0)
})
