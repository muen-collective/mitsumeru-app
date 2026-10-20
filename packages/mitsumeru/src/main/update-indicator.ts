import type { BrowserWindow } from 'electron'

import { UPDATE_FEED_URL } from '../shared/identity'
import type { UpdateStatus } from '../shared/update-status'

/**
 * The update indicator — a small pill beside the avatar row (bottom-left of the
 * harness window), modeled on DSH Desktop's `DesktopUpdateIndicator`. Replaces
 * the old full-width strip (Epic 91): the strip took permanent screen space
 * across the top of the window and read as a banner, while this stays invisible
 * until there is something to say and then sits in the account area where
 * app-level actions belong.
 *
 * Shell-owned by decision: the updater's state lives in the main process and
 * `quitAndInstall()` is an Electron API, so a DSH plugin cannot drive any of
 * this. The indicator is injected into the harness page (the same window, the
 * same preload) and talks to the existing `mitsumeru:update-*` IPC through the
 * `window.mitsumeru` bridge the preload already exposes.
 *
 * The page-side script is a self-contained function stringified into
 * `executeJavaScript` — same pattern as the avatar overlay and lockdown/click
 * probes. It must not reference anything outside its own body: at runtime there
 * is no module left.
 *
 * Visibility matrix (carried over from the banner, Epic 91 §3):
 *   checking/current  → only when the person asked (manual/menu)
 *   available/downloading/verifying/downloaded → always
 *   error             → the person asked, or an update was in flight
 *   idle/disabled     → never
 *
 * Click action depends on state:
 *   downloaded → restartToUpdate()
 *   error      → checkForUpdates()
 *   available  → open release notes
 *   busy       → not clickable
 */

/** Idempotent: a full reload re-injects, a duplicate call does not double up. */
export function injectUpdateIndicator(win: BrowserWindow, log: (message: string) => void): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  const script = `(${indicatorPageScript.toString()})(${JSON.stringify(UPDATE_FEED_URL)})`
  void win.webContents
    .executeJavaScript(script)
    .then(() => log('update-indicator-injected'))
    .catch((error: unknown) => {
      // An indicator that will not inject is a lost notification, never a boot
      // failure — the harness must not care.
      log(`update-indicator-inject-failed ${error instanceof Error ? error.message : String(error)}`)
    })
}

/**
 * Runs IN the harness page's main world (executeJavaScript, not a script tag).
 */
function indicatorPageScript(feedUrl: string): void {
  const ROOT_ID = 'mitsumeru-update-indicator'
  if (document.getElementById(ROOT_ID) !== null) return

  interface IndicatorBridge {
    updateStatus?: () => Promise<UpdateStatus>
    onUpdateStatus?: (cb: (status: UpdateStatus) => void) => (() => void) | undefined
    checkForUpdates?: () => Promise<UpdateStatus>
    restartToUpdate?: () => Promise<boolean>
  }
  const bridge = (window as unknown as { mitsumeru?: IndicatorBridge }).mitsumeru
  if (bridge === undefined || bridge.updateStatus === undefined || bridge.onUpdateStatus === undefined) return
  const b = bridge

  // ---- DOM -----------------------------------------------------------------

  const style = document.createElement('style')
  // OWNERSHIP TAG — same as the avatar overlay: the harness's client module
  // system claims untagged <style> elements for whichever plugin bundle
  // materializes next and deletes style[data-plugin=<that plugin>] when that
  // plugin goes away. `mitsumeru-shell` is ours, so no plugin id can equal it.
  style.setAttribute('data-plugin', 'mitsumeru-shell')
  style.setAttribute('data-plugin-css', 'mitsumeru-update-indicator')
  style.textContent = `
    #${ROOT_ID} {
      box-sizing: border-box;
      display: inline-grid;
      grid-template-columns: 14px max-content;
      align-items: center;
      column-gap: 5px;
      height: 28px;
      padding: 0 8px;
      border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #ff0000) 25%, transparent);
      border-radius: var(--dsw-radius-sm, 8px);
      background: color-mix(in srgb, var(--dsw-alias-brand-primary, #ff0000) 10%, transparent);
      color: var(--dsw-alias-brand-primary, #ff0000);
      font: 500 12px/18px inherit;
      white-space: nowrap;
      cursor: pointer;
      flex: none;
      text-align: left;
      transition: background 100ms ease, opacity 100ms ease;
    }
    #${ROOT_ID}[aria-disabled='true'] { cursor: default; opacity: 0.75; }
    #${ROOT_ID}:hover:not([aria-disabled='true']) {
      background: color-mix(in srgb, var(--dsw-alias-brand-primary, #ff0000) 18%, transparent);
    }
    #${ROOT_ID}:active:not([aria-disabled='true']) { opacity: 0.7; transform: scale(0.97); }
    #${ROOT_ID} .mui-icon {
      display: grid; place-items: center;
      width: 14px; height: 14px;
    }
    #${ROOT_ID} .mui-spin {
      width: 11px; height: 11px; border-radius: 50%;
      border: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #ff0000) 30%, transparent);
      border-top-color: var(--dsw-alias-brand-primary, #ff0000);
      animation: mui-spin 800ms linear infinite;
    }
    @keyframes mui-spin { to { transform: rotate(360deg); } }
    #${ROOT_ID} .mui-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--dsw-alias-brand-primary, #ff0000);
    }
    @media (prefers-reduced-motion: reduce) {
      #${ROOT_ID} .mui-spin { animation: none; }
      #${ROOT_ID}:active:not([aria-disabled='true']) { transform: none; }
    }
  `
  document.head.appendChild(style)

  const btn = document.createElement('button')
  btn.id = ROOT_ID
  btn.type = 'button'
  btn.setAttribute('role', 'status')
  btn.setAttribute('aria-live', 'polite')
  btn.style.display = 'none'

  const icon = document.createElement('span')
  icon.className = 'mui-icon'
  icon.setAttribute('aria-hidden', 'true')

  const labelEl = document.createElement('span')

  btn.append(icon, labelEl)

  // ---- Placement -----------------------------------------------------------

  // The indicator sits inside the avatar row as a flex child, to the right of
  // the label — the same slot DSH gives its own indicator beside the account
  // button. The avatar overlay is injected separately and may not have run yet,
  // so fall back to a fixed position above the avatar and move in when the row
  // appears.
  let attached = false

  function tryAttach(): boolean {
    if (attached) return true
    const row = document.querySelector('#mitsumeru-avatar-overlay .mua-row')
    if (row === null) return false
    row.appendChild(btn)
    attached = true
    return true
  }

  if (!tryAttach()) {
    btn.style.position = 'fixed'
    btn.style.left = '16px'
    btn.style.bottom = '60px'
    btn.style.zIndex = '2147483646'
    document.body.appendChild(btn)

    const observer = new MutationObserver(() => {
      if (tryAttach()) {
        btn.style.position = ''
        btn.style.left = ''
        btn.style.bottom = ''
        btn.style.zIndex = ''
        observer.disconnect()
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  // Prevent clicks from bubbling to the avatar row's menu handler.
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    // Action is assigned per-state in render().
  })

  // ---- State & rendering ---------------------------------------------------

  let previous: UpdateStatus = { state: 'idle', at: 0 }
  let hideTimer: ReturnType<typeof setTimeout> | undefined

  function render(s: UpdateStatus): void {
    const asked = s.trigger === 'manual' || s.trigger === 'menu'

    let visible = false
    if (s.state === 'checking' || s.state === 'current') {
      visible = asked
    } else if (s.state === 'available' || s.state === 'downloading' || s.state === 'verifying' || s.state === 'downloaded') {
      visible = true
    } else if (s.state === 'error') {
      // Show when the person asked OR an update was already in flight — a
      // download that died mid-flight, or a restart that failed after "ready".
      // Hiding that one would leave the user believing they were updating
      // while nothing happened.
      const updateWasInFlight =
        previous.state === 'available' || previous.state === 'downloading' || previous.state === 'downloaded'
      visible = asked || updateWasInFlight
    }
    // idle / disabled → hidden.

    if (hideTimer !== undefined) {
      clearTimeout(hideTimer)
      hideTimer = undefined
    }

    if (!visible) {
      btn.style.display = 'none'
      previous = s
      return
    }

    // Icon
    icon.textContent = ''
    const busy = s.state === 'checking' || s.state === 'downloading' || s.state === 'verifying'
    if (s.state === 'error') {
      const dot = document.createElement('span')
      dot.className = 'mui-dot'
      icon.appendChild(dot)
    } else if (busy) {
      const spin = document.createElement('span')
      spin.className = 'mui-spin'
      icon.appendChild(spin)
    } else if (s.state === 'downloaded') {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('width', '14')
      svg.setAttribute('height', '14')
      svg.setAttribute('viewBox', '0 0 14 14')
      svg.setAttribute('fill', 'none')
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', 'M3 7.5l3 3 5-5')
      path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-width', '1.5')
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')
      svg.appendChild(path)
      icon.appendChild(svg)
    } else {
      // Download arrow (available)
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('width', '14')
      svg.setAttribute('height', '14')
      svg.setAttribute('viewBox', '0 0 14 14')
      svg.setAttribute('fill', 'none')
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', 'M7 2v7M4 6.5L7 9.5l3-3M3 11.5h8')
      path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-width', '1.5')
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')
      svg.appendChild(path)
      icon.appendChild(svg)
    }

    // Label
    let text = ''
    switch (s.state) {
      case 'checking':
        text = 'Checking…'
        break
      case 'current':
        text = s.version !== undefined && s.version !== '' ? `✓ Up to date (v${s.version})` : '✓ Up to date'
        break
      case 'available':
        text = s.version !== undefined && s.version !== '' ? `Update v${s.version} available` : 'Update available'
        break
      case 'downloading':
        text = `Downloading… ${String(Math.floor(s.percent ?? 0))}%`
        break
      case 'verifying':
        text = s.version !== undefined && s.version !== '' ? `Verifying v${s.version}…` : 'Verifying…'
        break
      case 'downloaded':
        text = 'Restart to update'
        break
      case 'error': {
        const firstLine = (s.message ?? '').split('\n')[0]
        text = firstLine === '' ? 'Retry' : `Retry — ${firstLine.slice(0, 60)}`
        break
      }
    }
    labelEl.textContent = text
    btn.title = text
    btn.setAttribute('aria-label', text)

    // Click action
    if (s.state === 'downloaded') {
      btn.setAttribute('aria-disabled', 'false')
      btn.onclick = () => { void b.restartToUpdate?.() }
    } else if (s.state === 'error') {
      btn.setAttribute('aria-disabled', 'false')
      btn.onclick = () => { void b.checkForUpdates?.() }
    } else if (s.state === 'available') {
      btn.setAttribute('aria-disabled', 'false')
      btn.onclick = () => { window.open(feedUrl, '_blank', 'noreferrer') }
    } else {
      btn.setAttribute('aria-disabled', 'true')
      btn.onclick = null
    }

    btn.style.display = 'inline-grid'

    // "Up to date" hides after 2 s — the person asked, saw the answer, done.
    if (s.state === 'current') {
      hideTimer = setTimeout(() => {
        btn.style.display = 'none'
      }, 2000)
    }

    previous = s
  }

  bridge.onUpdateStatus(render)
  void bridge.updateStatus()?.then(render).catch(() => undefined)
}
