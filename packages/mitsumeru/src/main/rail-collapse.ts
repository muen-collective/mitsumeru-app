import type { BrowserWindow } from 'electron'

/**
 * Full sidebar collapse (founder, 2026-10-12: *"dsh left rail collapse all the
 * way, this is the design I always wanted … it solves name label problem"*).
 *
 * WHAT IS ALREADY THERE, AND WHAT IS NOT
 *
 * The rail's collapse machinery ships in the pinned harness and is identical in
 * the official DSH app: the same `ui-sidebar` / `ui-layout` bundles, the same
 * 1024px auto-collapse, the same Cmd+B toggle, the same collapsed styling
 * (36px rows, the New-session label clipped to zero). Nothing here re-creates
 * that; Cmd+B already collapses the rail today.
 *
 * The one difference is the FINAL WIDTH. `@deepseek-ai/dsh-client-ui-layout`
 * computes it as:
 *
 *   collapsedWidth = darwin || data-windows-titlebar ? 0 : 56
 *
 * `0` hides the column entirely; `56` leaves the icon rail. The left side of
 * that expression reads `document.documentElement.dataset.platform`, which the
 * official shell's preload sets and this shell's does not — so in Mitsumeru the
 * collapsed rail stops at the icon column.
 *
 * WHY WE DO NOT SIMPLY SET `data-platform`
 *
 * Because that attribute is not decoration — it is the whole desktop-shell
 * contract. `@deepseek-ai/dsh-client-shortcuts`' `detectEnvironment()` reads it
 * as:
 *
 *   runtime: desktop === undefined ? 'web' : 'desktop'
 *
 * and the `desktop` runtime makes the shortcut registry expect bindings owned by
 * a NATIVE bridge. Mitsumeru has no such bridge (the official app does, in its
 * own preload), so the registry fails, and because almost every UI bundle waits
 * on the `shortcuts` service the whole web boot never activates — measured
 * 2026-10-12: with the mark set at boot the frame does not mount at all
 * ("web boot: 25 entries did not activate … dsh-client-shortcuts: failed"),
 * without it the frame mounts normally. Marking the page is a port of the
 * desktop runtime, not a two-line change.
 *
 * WHAT THIS DOES INSTEAD
 *
 * Collapses the rail visually, on the web runtime the shell actually runs, by
 * rewriting ONLY the first grid track of the frame whenever the harness marks
 * the rail collapsed (`data-sidebar-collapsed` on the frame element). The track
 * is the harness's own signal, so this cannot desync from Cmd+B, the auto-collapse
 * breakpoint, or the drag handle: whatever the harness decides, we follow.
 *
 * Only the first token of `grid-template-columns` is replaced, so the centre
 * column and the right sidebar's track are left exactly as the harness computed
 * them. When the rail is not collapsed, the harness's own value is restored, so
 * expanding is untouched.
 *
 * Reaching the inline style is deliberate: the frame carries
 * `grid-template-columns` as an inline style, which outranks every stylesheet
 * rule, so a plain `insertCSS` override could not win without also republishing
 * the other tracks (which would break the right sidebar). Rewriting the single
 * token keeps the harness's own layout math authoritative for everything else.
 */

/** Idempotent: a full reload re-injects, a duplicate call does not double up. */
export function injectRailCollapse(win: BrowserWindow, log: (message: string) => void): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  const script = `(${railCollapsePageScript.toString()})()`
  void win.webContents
    .executeJavaScript(script)
    .then(() => log('rail-collapse-injected'))
    .catch((error: unknown) => {
      // A rail that stops at 56px is the pre-existing look, never a boot failure.
      log(`rail-collapse-inject-failed ${error instanceof Error ? error.message : String(error)}`)
    })
}

/**
 * Runs IN the harness page's main world (executeJavaScript, not a script tag).
 *
 * Self-contained by construction: it is stringified into `executeJavaScript`, so
 * it must not reference anything outside its body.
 */
function railCollapsePageScript(): void {
  const ROOT_ID = 'mitsumeru-rail-collapse'
  if (document.getElementById(ROOT_ID) !== null) return

  /** The frame element is the one that carries the inline grid template. */
  const findFrame = (): HTMLElement | null => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-sidebar-collapsed], [class*="_frame"]'))) {
      if (el.style.gridTemplateColumns !== '') return el
    }
    return null
  }

  /**
   * Rewrite the first track only, and only while the harness says collapsed.
   *
   * Nothing is stored and nothing is restored by hand: when the rail expands,
   * the harness writes its own value into the same inline property, and a
   * non-collapsed frame is left untouched here. That also makes the edit
   * self-cancelling — there is no cached value that could go stale and fight a
   * later layout.
   */
  const applied = (el: HTMLElement): void => {
    const value = el.style.gridTemplateColumns
    if (value === '') return
    if (!el.hasAttribute('data-sidebar-collapsed')) return

    const tracks = value.split(/\s+(?=minmax\(|[0-9.]+px|[0-9.]+fr|auto)/u)
    const want = `0px${tracks.length > 1 ? ' ' + tracks.slice(1).join(' ') : ''}`
    if (value !== want) el.style.gridTemplateColumns = want
  }

  // The frame mounts after the harness boots, and re-renders on every layout
  // change, so watch for it rather than assuming it exists at injection time.
  let frame: HTMLElement | null = null
  const observer = new MutationObserver(() => {
    const el = findFrame()
    if (el === null) return
    if (el !== frame) {
      frame = el
      applied(el)
      return
    }
    applied(el)
  })

  const attach = (): void => {
    const root = document.body ?? document.documentElement
    if (root === null) return
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'data-sidebar-collapsed']
    })
    const el = findFrame()
    if (el !== null) {
      frame = el
      applied(el)
    }
  }

  if (document.body === null) window.addEventListener('DOMContentLoaded', attach)
  else attach()

  const marker = document.createElement('div')
  marker.id = ROOT_ID
  marker.style.display = 'none'
  ;(document.body ?? document.documentElement).appendChild(marker)
}
