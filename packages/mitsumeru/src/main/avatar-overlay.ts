import type { BrowserWindow } from 'electron'

import type { MuenUser } from '../shared/auth'

/**
 * The Muen avatar slot (Epic 92) — a 36 px orb in the lower-left of the
 * harness window, the position DeepSeek Desktop uses for its Google avatar.
 *
 *   signed out  -> an "M" mark; clicking it starts sign-in (opens the browser)
 *   signed in   -> the user's GitHub picture; PRO members carry a PRO badge;
 *                  hovering opens name / email / membership / Sign Out
 *
 * Shell-owned, same reasoning as the update banner (Epic 91): sign-in state is
 * the shell's keychain session, and a DSH plugin cannot reach it. Injected into
 * the harness page after load and driven through the `window.mitsumeru.auth`
 * bridge the preload exposes. The script is self-contained — it is stringified
 * into `executeJavaScript` and must not reference anything outside its body.
 */

/** Idempotent: a full reload re-injects, a duplicate call does not double up. */
export function injectAvatarOverlay(win: BrowserWindow, log: (message: string) => void): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  const script = `(${avatarPageScript.toString()})()`
  void win.webContents
    .executeJavaScript(script)
    .then(() => log('avatar-overlay-injected'))
    .catch((error: unknown) => {
      // No avatar is a missing affordance, never a boot failure.
      log(`avatar-overlay-inject-failed ${error instanceof Error ? error.message : String(error)}`)
    })
}

/**
 * Runs IN the harness page's main world. Initial state comes from
 * `auth.user()` (one pull), later changes are pushed through `auth.onAuthChange`
 * — the main process tells the overlay the moment a sign-in completes or the
 * session is cleared, so the orb never shows a stale identity.
 */
function avatarPageScript(): void {
  const ROOT_ID = 'mitsumeru-avatar-overlay'
  if (document.getElementById(ROOT_ID) !== null) return

  interface AuthBridge {
    signIn?: () => Promise<void>
    signOut?: () => Promise<void>
    user?: () => Promise<MuenUser | null>
    onAuthChange?: (cb: (user: MuenUser | null) => void) => (() => void) | undefined
  }
  const bridge = (window as unknown as { mitsumeru?: { auth?: AuthBridge } }).mitsumeru?.auth
  if (bridge === undefined || bridge.user === undefined || bridge.onAuthChange === undefined) return

  const root = document.createElement('div')
  root.id = ROOT_ID
  root.setAttribute('role', 'group')
  root.setAttribute('aria-label', 'Muen account')
  // Inline so the orb keeps its position even if the stylesheet were rejected.
  root.style.position = 'fixed'
  root.style.left = '16px'
  root.style.bottom = '16px'
  root.style.zIndex = '2147483647'

  const style = document.createElement('style')
  style.textContent = `
    #${ROOT_ID} { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: #f2f2f2; }
    #${ROOT_ID} .mua-orb {
      position: relative; width: 36px; height: 36px; padding: 0;
      border-radius: 50%; border: 1px solid #3a3b3b; overflow: visible;
      background: #191a1a; color: #f2f2f2; cursor: pointer;
      font: inherit; font-size: 15px; font-weight: 700; line-height: 34px;
      text-align: center; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
    }
    #${ROOT_ID} .mua-orb:hover { border-color: #606060; }
    #${ROOT_ID} .mua-orb img {
      position: absolute; inset: 0; width: 36px; height: 36px;
      border-radius: 50%; object-fit: cover;
    }
    #${ROOT_ID} .mua-pro {
      position: absolute; right: -6px; top: -6px; z-index: 2;
      padding: 1px 4px; border-radius: 3px;
      background: #ff0000; color: #ffffff;
      font-size: 8px; font-weight: 700; letter-spacing: 0.5px; line-height: 1.4;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
    }
    #${ROOT_ID} .mua-pop {
      display: none; position: absolute; left: 44px; bottom: 0;
      min-width: 190px; padding: 10px 12px;
      background: #191a1a; border: 1px solid #2a2b2b; border-radius: 4px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
      text-align: left; line-height: 1.5;
    }
    #${ROOT_ID}:hover .mua-pop, #${ROOT_ID} .mua-pop:focus-within { display: block; }
    #${ROOT_ID} .mua-name { font-weight: 700; white-space: nowrap; }
    #${ROOT_ID} .mua-email { color: #606060; white-space: nowrap; }
    #${ROOT_ID} .mua-tier { color: #f2f2f2; }
    #${ROOT_ID} .mua-pop hr { border: 0; border-top: 1px solid #2a2b2b; margin: 8px 0; }
    #${ROOT_ID} .mua-signout {
      appearance: none; font: inherit; font-size: 11px; padding: 5px 10px;
      border: 1px solid #3a3b3b; border-radius: 3px;
      background: transparent; color: #f2f2f2; cursor: pointer;
    }
    #${ROOT_ID} .mua-signout:hover { background: #262727; }
    @media (prefers-reduced-motion: reduce) { #${ROOT_ID} .mua-orb { transition: none; } }
  `

  const orb = document.createElement('button')
  orb.className = 'mua-orb'
  orb.type = 'button'

  const badge = document.createElement('span')
  badge.className = 'mua-pro'
  badge.textContent = 'PRO'
  badge.style.display = 'none'

  const pop = document.createElement('div')
  pop.className = 'mua-pop'
  const nameEl = document.createElement('div')
  nameEl.className = 'mua-name'
  const emailEl = document.createElement('div')
  emailEl.className = 'mua-email'
  const tierEl = document.createElement('div')
  tierEl.className = 'mua-tier'
  const rule = document.createElement('hr')
  const signOut = document.createElement('button')
  signOut.className = 'mua-signout'
  signOut.type = 'button'
  signOut.textContent = 'Sign Out'
  pop.append(nameEl, emailEl, tierEl, rule, signOut)

  root.append(style, orb, pop)
  ;(document.body ?? document.documentElement).appendChild(root)

  let current: MuenUser | null = null

  const render = (user: MuenUser | null): void => {
    current = user
    const old = orb.querySelector('img')
    if (old !== null) old.remove()
    const initial = orb.querySelector('.mua-initial')
    if (initial !== null) initial.remove()

    if (user === null) {
      orb.setAttribute('aria-label', 'Sign in to Muen')
      orb.title = 'Sign in to Muen'
      const span = document.createElement('span')
      span.className = 'mua-initial'
      span.textContent = 'M'
      orb.appendChild(span)
      badge.style.display = 'none'
      pop.style.display = 'none'
      return
    }

    orb.setAttribute('aria-label', `${user.name} — Muen ${user.membership === 'pro' ? 'PRO ' : ''}member`)
    orb.title = `${user.name} (${user.email})`
    if (user.avatarUrl !== '') {
      const img = document.createElement('img')
      img.src = user.avatarUrl
      img.alt = ''
      // Avatar CDNs sometimes key on referrer; drop ours rather than 403.
      img.referrerPolicy = 'no-referrer'
      img.addEventListener('error', () => {
        // Picture failed (offline, URL gone): fall back to the initial.
        img.remove()
        if (orb.querySelector('.mua-initial') === null) {
          const span = document.createElement('span')
          span.className = 'mua-initial'
          span.textContent = (user.name.trim()[0] ?? 'M').toUpperCase()
          orb.appendChild(span)
        }
      })
      orb.appendChild(img)
    } else {
      const span = document.createElement('span')
      span.className = 'mua-initial'
      span.textContent = (user.name.trim()[0] ?? 'M').toUpperCase()
      orb.appendChild(span)
    }
    badge.style.display = user.membership === 'pro' ? 'block' : 'none'
    nameEl.textContent = user.name
    emailEl.textContent = user.email
    tierEl.textContent = user.membership === 'pro' ? 'PRO Member ✓' : 'Muen Member'
    pop.style.display = ''
  }

  orb.appendChild(badge)
  orb.addEventListener('click', () => {
    if (current === null) void bridge.signIn?.()
    // Signed in: hover (or focus-within) already shows the popover; a click is
    // a no-op — there is nothing to open that the popover does not show.
  })
  signOut.addEventListener('click', () => {
    void bridge.signOut?.()
  })

  bridge.onAuthChange(render)
  void bridge.user()?.then(render).catch(() => undefined)
}
