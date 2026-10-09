import type { BrowserWindow } from 'electron'

import { UPDATE_FEED_URL } from '../shared/identity'
import type { UpdateStatus } from '../shared/update-status'

/**
 * The update banner (Epic 91) — a strip at the top of the harness window that
 * surfaces the updater's state, so a user hears about an update from the app
 * instead of from the person who shipped it.
 *
 * Shell-owned by decision: the updater's state lives in the main process and
 * `quitAndInstall()` is an Electron API, so a DSH plugin cannot drive any of
 * this. The banner is injected into the harness page (the same window, the
 * same preload) and talks to the existing `mitsumeru:update-*` IPC through the
 * `window.mitsumeru` bridge the preload already exposes.
 *
 * The page-side script is a self-contained function stringified into
 * `executeJavaScript` — same pattern as the lockdown/click probes. It must not
 * reference anything outside its own body: at runtime there is no module left.
 * Positioning and the bar's critical styles are also set inline so a CSP that
 * rejected the <style> element would degrade the looks, never the behaviour.
 */

/** Idempotent: a full reload re-injects, a duplicate call does not double up. */
export function injectUpdateBanner(win: BrowserWindow, log: (message: string) => void): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  const script = `(${bannerPageScript.toString()})(${JSON.stringify(UPDATE_FEED_URL)})`
  void win.webContents
    .executeJavaScript(script)
    .then(() => log('update-banner-injected'))
    .catch((error: unknown) => {
      // A banner that will not inject is a lost notification, never a boot
      // failure — the harness must not care.
      log(`update-banner-inject-failed ${error instanceof Error ? error.message : String(error)}`)
    })
}

/**
 * Runs IN the harness page's main world (executeJavaScript, not a script tag).
 *
 * Visibility matrix (Epic 91 §3):
 *   checking/current  → only when the person asked (manual/menu), because a
 *                       cadence check finding the app current must not flash a
 *                       strip at someone who did not ask;
 *   available/downloading/downloaded → always: an update exists or is ready;
 *   error              → the person asked, or an update was in flight when it
 *                       failed — a download that died mid-flight, or a restart
 *                       that failed after "ready". A background offline check
 *                       stays a log line (10 s strip when it is shown at all);
 *   idle/disabled      → never.
 *
 * Dismiss hides until the next state change (state+version), exactly as the
 * epic specifies — the transient chips are never dismissible.
 */
function bannerPageScript(feedUrl: string): void {
  const ROOT_ID = 'mitsumeru-update-banner'
  if (document.getElementById(ROOT_ID) !== null) return

  interface BannerBridge {
    updateStatus?: () => Promise<UpdateStatus>
    onUpdateStatus?: (cb: (status: UpdateStatus) => void) => (() => void) | undefined
    checkForUpdates?: () => Promise<UpdateStatus>
    restartToUpdate?: () => Promise<boolean>
  }
  const bridge = (window as unknown as { mitsumeru?: BannerBridge }).mitsumeru
  if (bridge === undefined || bridge.updateStatus === undefined || bridge.onUpdateStatus === undefined) return

  const root = document.createElement('div')
  root.id = ROOT_ID
  root.setAttribute('role', 'status')
  root.setAttribute('aria-live', 'polite')
  // Inline so the strip is positioned even if the stylesheet were rejected.
  root.style.position = 'fixed'
  root.style.top = '0'
  root.style.left = '0'
  root.style.right = '0'
  root.style.zIndex = '2147483647'
  root.style.display = 'none'

  const style = document.createElement('style')
  // OWNERSHIP TAG — same defect as the account row, same fix; see the long note
  // in avatar-overlay.ts. The harness's client module system claims every
  // untagged <style> for whichever plugin bundle materializes next and deletes
  // style[data-plugin=<that plugin>] when that plugin goes away, which would
  // strip this strip's CSS (animation, sizing, buttons) and leave it as raw
  // text and full-size controls until the app restarted.
  style.setAttribute('data-plugin', 'mitsumeru-shell')
  style.setAttribute('data-plugin-css', 'mitsumeru-update-banner')
  style.textContent = `
    #${ROOT_ID} { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: #f2f2f2; }
    #${ROOT_ID} .mub-bar {
      position: relative; display: flex; align-items: center; gap: 10px;
      box-sizing: border-box; height: 36px; padding: 0 12px;
      background: #191a1a; border-bottom: 1px solid #2a2b2b;
      animation: mub-slide 240ms ease-out;
    }
    @keyframes mub-slide { from { transform: translateY(-100%); } to { transform: none; } }
    #${ROOT_ID} .mub-spin {
      flex: none; width: 10px; height: 10px; border-radius: 50%;
      border: 2px solid #444; border-top-color: #ff0000; animation: mub-spin 900ms linear infinite;
    }
    @keyframes mub-spin { to { transform: rotate(360deg); } }
    #${ROOT_ID} .mub-text { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #${ROOT_ID} .mub-actions { flex: none; display: flex; align-items: center; gap: 8px; }
    #${ROOT_ID} .mub-link { color: #f2f2f2; font-size: 11px; }
    #${ROOT_ID} .mub-link:hover { color: #fff; }
    #${ROOT_ID} .mub-btn {
      appearance: none; font: inherit; font-size: 11px; padding: 5px 10px;
      border: 1px solid #3a3b3b; border-radius: 3px;
      background: transparent; color: #f2f2f2; cursor: pointer;
    }
    #${ROOT_ID} .mub-btn:hover { background: #262727; }
    #${ROOT_ID} .mub-primary { background: #f2f2f2; color: #000000; border-color: #f2f2f2; }
    #${ROOT_ID} .mub-primary:hover { background: #ffffff; }
    #${ROOT_ID} .mub-close {
      appearance: none; font: inherit; font-size: 12px; line-height: 1;
      padding: 4px 6px; border: 0; background: transparent; color: #606060; cursor: pointer;
    }
    #${ROOT_ID} .mub-close:hover { color: #f2f2f2; }
    #${ROOT_ID} .mub-track {
      position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
      background: #2a2b2b; display: none;
    }
    #${ROOT_ID} .mub-fill { height: 100%; width: 0; background: #f2f2f2; transition: width 120ms linear; }
    @media (prefers-reduced-motion: reduce) {
      #${ROOT_ID} .mub-bar { animation: none; }
      #${ROOT_ID} .mub-spin { animation: none; }
      #${ROOT_ID} .mub-fill { transition: none; }
    }
  `

  const bar = document.createElement('div')
  bar.className = 'mub-bar'
  bar.style.background = '#191a1a'
  bar.style.color = '#f2f2f2'

  const spin = document.createElement('span')
  spin.className = 'mub-spin'
  spin.style.display = 'none'

  const text = document.createElement('span')
  text.className = 'mub-text'

  const actions = document.createElement('span')
  actions.className = 'mub-actions'

  const link = document.createElement('a')
  link.className = 'mub-link'
  link.href = feedUrl
  link.target = '_blank'
  link.rel = 'noreferrer'
  link.textContent = 'Release notes'
  link.style.display = 'none'

  const restart = document.createElement('button')
  restart.className = 'mub-btn mub-primary'
  restart.type = 'button'
  restart.textContent = 'Restart Now'
  restart.style.display = 'none'
  restart.addEventListener('click', () => {
    void bridge.restartToUpdate?.()
  })

  const retry = document.createElement('button')
  retry.className = 'mub-btn'
  retry.type = 'button'
  retry.textContent = 'Retry'
  retry.style.display = 'none'
  retry.addEventListener('click', () => {
    void bridge.checkForUpdates?.()
  })

  const close = document.createElement('button')
  close.className = 'mub-close'
  close.type = 'button'
  close.setAttribute('aria-label', 'Dismiss update banner')
  close.textContent = '✕'
  close.style.display = 'none'

  const track = document.createElement('div')
  track.className = 'mub-track'
  const fill = document.createElement('div')
  fill.className = 'mub-fill'
  track.appendChild(fill)

  actions.append(link, restart, retry, close)
  bar.append(spin, text, actions, track)
  root.append(style, bar)
  ;(document.body ?? document.documentElement).appendChild(root)

  let last: UpdateStatus = { state: 'idle', at: Date.now() }
  // What the strip showed before this status — the only way to tell a
  // background error (silence) from a download that died mid-flight (show).
  let previous: UpdateStatus = last
  let dismissedKey: string | null = null
  let hideTimer: ReturnType<typeof setTimeout> | undefined

  const keyOf = (s: UpdateStatus): string => `${s.state}:${s.version ?? ''}`

  close.addEventListener('click', () => {
    dismissedKey = keyOf(last)
    root.style.display = 'none'
  })

  const render = (s: UpdateStatus): void => {
    last = s
    const asked = s.trigger === 'manual' || s.trigger === 'menu'
    const transient = s.state === 'checking' || s.state === 'current'
    let visible = false
    let hideAfter: number | undefined

    if (s.state === 'checking') {
      visible = asked
    } else if (s.state === 'current') {
      visible = asked
      hideAfter = 3000
    } else if (s.state === 'available' || s.state === 'downloading' || s.state === 'downloaded') {
      visible = true
    } else if (s.state === 'error') {
      // Show when the person asked OR an update was already in flight: a
      // download that died mid-flight, and — measured in the 9.9.9 test run —
      // a restart that failed after "ready". Hiding that one would leave the
      // user believing they were updating while nothing happened.
      const updateWasInFlight =
        previous.state === 'available' || previous.state === 'downloading' || previous.state === 'downloaded'
      visible = asked || updateWasInFlight
      hideAfter = 10000
    }
    // idle / disabled → stay hidden.

    if (visible && !transient && keyOf(s) === dismissedKey) visible = false

    if (hideTimer !== undefined) {
      clearTimeout(hideTimer)
      hideTimer = undefined
    }
    if (!visible) {
      root.style.display = 'none'
      previous = s
      return
    }

    spin.style.display = 'none'
    link.style.display = 'none'
    restart.style.display = 'none'
    retry.style.display = 'none'
    close.style.display = 'none'
    track.style.display = 'none'

    switch (s.state) {
      case 'checking': {
        spin.style.display = 'block'
        text.textContent = 'Checking for updates…'
        break
      }
      case 'current': {
        text.textContent = `✓ Up to date (v${s.version ?? ''})`
        break
      }
      case 'available': {
        text.textContent = `Update v${s.version ?? ''} available — preparing download…`
        link.style.display = 'inline'
        close.style.display = 'inline-block'
        break
      }
      case 'downloading': {
        const percent = s.percent ?? 0
        text.textContent = `Downloading v${s.version ?? ''}… ${String(percent)}%`
        track.style.display = 'block'
        fill.style.width = `${String(percent)}%`
        close.style.display = 'inline-block'
        break
      }
      case 'downloaded': {
        text.textContent = `v${s.version ?? ''} is ready — restart to update`
        restart.style.display = 'inline-block'
        close.style.display = 'inline-block'
        break
      }
      case 'error': {
        const firstLine = (s.message ?? '').split('\n')[0]
        text.textContent = `Update check failed${firstLine === '' ? '' : ` — ${firstLine.slice(0, 140)}`}`
        retry.style.display = 'inline-block'
        close.style.display = 'inline-block'
        break
      }
      default: {
        break // idle / disabled never reach here (visible stays false)
      }
    }

    root.style.display = 'block'
    if (hideAfter !== undefined) {
      hideTimer = setTimeout(() => {
        root.style.display = 'none'
      }, hideAfter)
    }
    previous = s
  }

  bridge.onUpdateStatus(render)
  void bridge.updateStatus()?.then(render).catch(() => undefined)
}
