import type { BrowserWindow } from 'electron'

import type { MuenUser } from '../shared/auth'

/**
 * The Muen account row + menu (Epic 92) — bottom-left of the harness window,
 * the slot DeepSeek Desktop uses: avatar + label row that opens a click menu
 * (their reference: Settings / Feedback / Sign out). Ours, v1:
 *
 *   signed out  -> [M] "Sign in to Muen"   click starts sign-in (browser)
 *   signed in   -> [avatar] "Signed in to Muen"
 *                    click -> menu:  Language > the harness's catalog
 *                                    ─────────
 *                                    Sign out
 *
 * The Language item lives here on the founder's call ("move the language
 * switcher into the menu") and writes the harness's own locale preference
 * over the settings wire it uses — `POST /api/settings/update`,
 * `{args: {ns: 'locale', patch: {preference: id}}}` — which the harness applies
 * live (measured: html lang flips in ~2.5 s, no reload). The preference is the
 * Host user-settings document's `locale.preference`, so the harness's
 * Settings → General row and this menu always agree.
 *
 * The LANGUAGES are not ours to list either. The harness ships two
 * (dsh-client-locale: LOCALE_IDS = zh, en) and every other arrives from a plugin
 * through `addLanguage` — ours come from `@muen/dsh-localize` (ko, ja, fr, de,
 * es). This menu draws the catalog the harness itself lists, read at open time
 * from `<html data-muen-languages>` (the mirror that plugin publishes; see its
 * README), and falls back to the built-in pair when nothing published one — a
 * stock DSH, or a profile without the plugin. A hardcoded pair here was the bug:
 * it showed `zh`/`en` to everyone, including the readers of the five languages we
 * had already added.
 *
 * Shell-owned, same reasoning as the update banner (Epic 91): sign-in state is
 * the shell's keychain session and a DSH plugin cannot reach it. Injected after
 * harness load; the page script is self-contained — it is stringified into
 * `executeJavaScript` and must not reference anything outside its body.
 *
 * Two load-bearing details below keep this row's DESIGN attached, and both were
 * earned by the same incident (measured 2026-10-03, founder's report: the
 * account row "lost its UI design — plain text + large image thumbnail" after
 * uninstalling a plugin; only an app restart brought it back):
 *
 *   1. The stylesheet carries an ownership tag. The harness's client module
 *      system claims every untagged `<style>` in the document for the plugin
 *      bundle materializing at that moment, then deletes that style when the
 *      plugin is removed. Untagged, this stylesheet was stolen by whichever
 *      plugin bundle materialized after injection — and died with it.
 *   2. The stylesheet and the root re-attach themselves if anything detaches
 *      them. Injection happens once per harness page load, so any DOM cleanup
 *      that removed either used to be permanent until the app restarted.
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
 * Runs IN the harness page's main world. Auth state comes from one
 * `auth.user()` pull plus `auth.onAuthChange` pushes; the language switch is
 * the harness's own settings API, called exactly the way its Language row
 * calls it (generated typert remote: `settings/update`, args-wrapped, measured
 * 2026-09-29 against 0.1.7-rc.1).
 */
function avatarPageScript(): void {
  const ROOT_ID = 'mitsumeru-avatar-overlay'
  /** The harness's own settings rail — the slot this overlay replaces. */
  const SETTINGS_SLOT = 'sidebar.settings'
  if (document.getElementById(ROOT_ID) !== null) return

  interface AuthBridge {
    signIn?: () => Promise<void>
    signOut?: () => Promise<void>
    user?: () => Promise<MuenUser | null>
    onAuthChange?: (cb: (user: MuenUser | null) => void) => (() => void) | undefined
  }
  const auth = (window as unknown as { mitsumeru?: { auth?: AuthBridge } }).mitsumeru?.auth
  if (auth === undefined || auth.user === undefined || auth.onAuthChange === undefined) return

  // The languages, read off the page at open time.
  //
  // `data-muen-languages` is the harness's catalog as `@muen/dsh-localize`
  // mirrors it: `[{id,label}]`, in the runtime's own order, the same list the
  // harness's Settings → General row draws. Absent (a stock DSH, or a profile
  // without that plugin) the built-in pair is the honest answer, because the
  // harness ships exactly those two.
  const BUILT_IN_LOCALES: Array<{ id: string; label: string }> = [
    { id: 'en', label: 'English' },
    { id: 'zh', label: '中文' }
  ]
  const locales = (): Array<{ id: string; label: string }> => {
    try {
      const raw = document.documentElement.dataset.muenLanguages
      if (raw === undefined || raw === '') return BUILT_IN_LOCALES
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return BUILT_IN_LOCALES
      const rows = parsed.filter(
        (row): row is { id: string; label: string } =>
          typeof row === 'object' &&
          row !== null &&
          typeof (row as { id?: unknown }).id === 'string' &&
          (row as { id: string }).id !== '' &&
          typeof (row as { label?: unknown }).label === 'string'
      )
      return rows.length > 0 ? rows : BUILT_IN_LOCALES
    } catch {
      // Malformed JSON is a mirror we cannot read, never a menu we do not show.
      return BUILT_IN_LOCALES
    }
  }
  // The overlay speaks both languages too — after a switch its own labels
  // follow, so the menu demonstrates the very thing it switches.
  const STRINGS: Record<string, Record<string, string>> = {
    en: {
      signIn: 'Sign in to Muen',
      signedIn: 'Signed in to Muen',
      settings: 'Settings',
      language: 'Language',
      signOut: 'Sign out',
      switchFailed: 'Could not switch language — try again'
    },
    zh: {
      signIn: '登录 Muen',
      signedIn: '已登录 Muen',
      settings: '设置',
      language: '语言',
      signOut: '退出登录',
      switchFailed: '语言切换失败 — 请重试'
    }
  }
  const currentLang = (): string => {
    // A successful switch sets langOverride immediately: the harness flips its
    // own html lang ~2.5 s later (measured), and our labels must not lag it.
    if (langOverride !== null) return langOverride
    const base = (document.documentElement.lang || 'en').split('-')[0]
    return base in STRINGS ? base : 'en'
  }
  const strings = (): Record<string, string> => STRINGS[currentLang()]

  const uuid = (): string =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`

  /** The harness's locale write — same wire its own Language row uses. */
  const switchLocale = async (id: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/settings/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: uuid(),
          method: 'settings/update',
          payload: { args: { ns: 'locale', patch: { preference: id } } }
        })
      })
      if (!res.ok) return false
      const data = (await res.json()) as { result?: { ok?: boolean } }
      return data.result?.ok === true
    } catch {
      return false
    }
  }

  // ---- DOM -----------------------------------------------------------------

  const root = document.createElement('div')
  root.id = ROOT_ID
  root.setAttribute('role', 'group')
  root.setAttribute('aria-label', 'Muen account')
  root.style.position = 'fixed'
  root.style.left = '16px'
  root.style.bottom = '16px'
  root.style.zIndex = '2147483647'

  const style = document.createElement('style')
  // OWNERSHIP TAG (see the module doc). The harness's client module system
  // claims style:not([data-plugin]) for whichever plugin bundle is materializing
  // — dsh-client-modules claimStyles(), "any untagged tag is claimed for the
  // materializing plugin (HMR bookkeeping)" — and removeOwnedStyles() then
  // deletes style[data-plugin=<that plugin>] when the plugin is removed,
  // replaced or pruned. Owning the tag ourselves is the hook the module system
  // leaves for exactly this: it never claims a tagged tag, and it only deletes a
  // tag equal to a plugin's own id. `mitsumeru-shell` is ours, so no plugin id
  // can equal it.
  style.setAttribute('data-plugin', 'mitsumeru-shell')
  style.setAttribute('data-plugin-css', 'mitsumeru-avatar-overlay')
  style.textContent = `
    #${ROOT_ID} {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px; color: var(--dsw-alias-label-primary, #f2f2f2);
    }
    #${ROOT_ID} .mua-row {
      display: flex; align-items: center; gap: 10px;
      height: 40px; padding: 0 10px 0 4px;
      border: 0; border-radius: 20px;
      background: transparent; color: var(--dsw-alias-label-primary, #f2f2f2);
      font: inherit; cursor: pointer;
    }
    #${ROOT_ID} .mua-row:hover { background: rgba(255, 255, 255, 0.06); }
    #${ROOT_ID} .mua-avatar {
      position: relative; width: 32px; height: 32px; flex: none;
      border-radius: 50%; background: #191a1a; overflow: visible;
      font-size: 14px; font-weight: 700; line-height: 30px;
      text-align: center; color: #f2f2f2;
    }
    #${ROOT_ID} .mua-avatar img {
      position: absolute; inset: 0; width: 32px; height: 32px;
      border-radius: 50%; object-fit: cover;
    }
    #${ROOT_ID} .mua-pro {
      position: absolute; right: -6px; top: -6px; z-index: 2;
      padding: 1px 4px; border-radius: 3px;
      background: #ff0000; color: #ffffff;
      font-size: 8px; font-weight: 700; letter-spacing: 0.5px; line-height: 1.4;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
    }
    #${ROOT_ID} .mua-label { white-space: nowrap; }
    #${ROOT_ID} .mua-menu {
      display: none; position: absolute; left: 0; bottom: calc(100% + 6px);
      min-width: 210px; padding: 6px;
      background: #1c1c1e; border: 1px solid #2a2b2b; border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
    }
    #${ROOT_ID} .mua-menu[data-open='1'] { display: block; }
    #${ROOT_ID} .mua-item {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      width: 100%; padding: 8px 10px;
      border: 0; border-radius: 6px;
      background: transparent; color: #f2f2f2;
      font: inherit; text-align: left; cursor: pointer;
    }
    #${ROOT_ID} .mua-item:hover, #${ROOT_ID} .mua-opt:hover { background: #262727; }
    #${ROOT_ID} .mua-chev { color: #606060; font-size: 14px; }
    #${ROOT_ID} .mua-sub { display: none; padding: 2px 0 4px; }
    #${ROOT_ID} .mua-sub[data-open='1'] { display: block; }
    #${ROOT_ID} .mua-opt {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      width: 100%; padding: 7px 10px 7px 22px;
      border: 0; border-radius: 6px;
      background: transparent; color: #cfcfcf;
      font: inherit; text-align: left; cursor: pointer;
    }
    #${ROOT_ID} .mua-opt[aria-checked='true'] { color: #ffffff; }
    #${ROOT_ID} .mua-check { color: #ff0000; visibility: hidden; }
    #${ROOT_ID} .mua-opt[aria-checked='true'] .mua-check { visibility: visible; }
    #${ROOT_ID} .mua-sep { border: 0; border-top: 1px solid #2a2b2b; margin: 6px 4px; }
    #${ROOT_ID} .mua-error {
      display: none; padding: 6px 10px; color: #ff6b6b; font-size: 12px;
    }
    #${ROOT_ID} .mua-error[data-on='1'] { display: block; }
    #${ROOT_ID} .mua-key { color: #606060; font-size: 12px; }
    /* The stock settings rail is the "settings slot" the founder removed
       (2026-10-02): hidden by its stable slot name, never the hashed class.
       The BUTTON stays in the DOM and keeps its live rect, which is what our menu
       opens Settings through — it is only drawn out of the rail (module doc:
       Settings rides the account menu). */
    div:has(> [data-slot="sidebar.settings"]) { display: none !important; }
  `

  const row = document.createElement('button')
  row.className = 'mua-row'
  row.type = 'button'
  row.setAttribute('aria-haspopup', 'menu')
  row.setAttribute('aria-expanded', 'false')

  const avatar = document.createElement('span')
  avatar.className = 'mua-avatar'

  const badge = document.createElement('span')
  badge.className = 'mua-pro'
  badge.textContent = 'PRO'
  badge.style.display = 'none'
  avatar.appendChild(badge)

  const label = document.createElement('span')
  label.className = 'mua-label'
  row.append(avatar, label)

  const menu = document.createElement('div')
  menu.className = 'mua-menu'
  menu.setAttribute('role', 'menu')

  const langItem = document.createElement('button')
  langItem.className = 'mua-item'
  langItem.type = 'button'
  langItem.setAttribute('role', 'menuitem')
  const langText = document.createElement('span')
  const langChev = document.createElement('span')
  langChev.className = 'mua-chev'
  langChev.textContent = '›'
  langItem.append(langText, langChev)

  const sub = document.createElement('div')
  sub.className = 'mua-sub'

  // The rows are built from the live catalog when the submenu opens — not once
  // at inject time. This script runs as the app boots, before the locale plugin
  // has offered its languages, so a list captured here would be the two the
  // harness ships and nothing else.
  let options: Array<{ id: string; opt: HTMLButtonElement }> = []
  let rendered = ''
  const renderOptions = (): void => {
    const next = locales()
    const signature = next.map((locale) => locale.id + ':' + locale.label).join('|')
    if (signature === rendered) return
    rendered = signature
    options = []
    sub.replaceChildren()
    for (const locale of next) {
      const opt = document.createElement('button')
      opt.className = 'mua-opt'
      opt.type = 'button'
      opt.setAttribute('role', 'menuitemradio')
      opt.dataset.locale = locale.id
      const text = document.createElement('span')
      text.textContent = locale.label
      const check = document.createElement('span')
      check.className = 'mua-check'
      check.textContent = '✓'
      opt.append(text, check)
      opt.addEventListener('click', () => {
        void pickLocale(locale.id)
      })
      sub.appendChild(opt)
      options.push({ id: locale.id, opt })
    }
  }

  const errorLine = document.createElement('div')
  errorLine.className = 'mua-error'

  const sep = document.createElement('hr')
  sep.className = 'mua-sep'

  const signOut = document.createElement('button')
  signOut.className = 'mua-item mua-signout'
  signOut.type = 'button'
  signOut.setAttribute('role', 'menuitem')
  const signOutText = document.createElement('span')
  signOut.appendChild(signOutText)

  const sepTop = document.createElement('hr')
  sepTop.className = 'mua-sep'

  const settingsItem = document.createElement('button')
  settingsItem.className = 'mua-item'
  settingsItem.type = 'button'
  settingsItem.setAttribute('role', 'menuitem')
  const settingsText = document.createElement('span')
  settingsText.textContent = 'Settings'
  const settingsKey = document.createElement('span')
  settingsKey.className = 'mua-key'
  settingsKey.textContent = '⌘,'
  settingsItem.append(settingsText, settingsKey)
  settingsItem.addEventListener('click', () => {
    setMenu(false)
    // Open Settings by driving the harness's OWN account menu.
    //
    // Three routes were tried in the running app (2026-10-12); only the last works:
    //
    //   1. Clicking the settings launcher directly. Our stylesheet hides its
    //      container, and a hidden element measures 0x0 — and that launcher IS the
    //      account menu's anchor, so the menu opened clamped at the window's
    //      top-left. This was the founder's *"another menu pops up top left"*.
    //      Measured `{x:0, y:0, w:0, h:0}` in both rail states.
    //   2. Driving the harness command `settings.open` over the native bridge. The
    //      command IS registered (inside the `sidebar.settings` slot injection) and
    //      the input arrives with a matching revision, yet nothing opens — slots
    //      are isolated, so it never lands in the registry the keyboard path
    //      dispatches against. Verified: `invokeCommand` true, `modalCount` 0.
    //   3. THIS: reveal the slot's OUTER wrapper (never the launcher alone, so no
    //      hidden ancestor can pinch the rect), let the harness open its own menu,
    //      then click the Settings row IT renders — which is exactly what a person
    //      clicking that row does. Verified in the live app: the dialog opens
    //      centred (`{x:672, y:203, w:800, h:800}`, `data-shortcut-modal="settings"`).
    //
    // The second click must wait for the harness menu to render, and the wait cannot
    // be a fixed number of frames: it is React work scheduled off the first click.
    // Poll for the row instead, with a bounded give-up so a harness that changes
    // its markup leaves nothing hidden behind.
    // A temporary veil hides that intermediate menu so the two-step hop is
    // invisible. It hides, it does not disable: `.click()` still fires on a
    // `visibility: hidden` element, which is why the veil is safe.
    const slot = document.querySelector('[data-slot="' + SETTINGS_SLOT + '"]')
    const outer = slot instanceof HTMLElement ? slot.parentElement : null
    if (!(slot instanceof HTMLElement) || outer === null) return
    const savedOuter = outer.getAttribute('style')
    const veil = document.createElement('style')
    veil.textContent =
      '[role="menu"]:not(#' + ROOT_ID + ' [role="menu"]) { visibility: hidden !important; }'
    document.head.append(veil)
    outer.style.setProperty('display', 'contents', 'important')
    // The style attribute has to read back so React's layout listener sees the
    // change and the fresh rect exists before the click.
    void slot.offsetHeight
    const launcher = slot.querySelector('button')
    if (launcher === null) {
      veil.remove()
      outer.style.setProperty('display', 'none', 'important')
      return
    }
    launcher.click()
    let tries = 0
    const hop = (): void => {
      const row = [...document.querySelectorAll('button')].find(
        (b) => (b.textContent ?? '').trim().toLowerCase().startsWith('settings') && !b.closest('#' + ROOT_ID)
      )
      if (row !== undefined) {
        row.click()
        veil.remove()
        if (savedOuter === null) outer.removeAttribute('style')
        else outer.setAttribute('style', savedOuter)
        return
      }
      // ~1s at 60fps, then give up and put the rail back.
      if (tries++ < 60) {
        requestAnimationFrame(hop)
        return
      }
      veil.remove()
      if (savedOuter === null) outer.removeAttribute('style')
      else outer.setAttribute('style', savedOuter)
    }
    requestAnimationFrame(hop)
  })

  // Settings rides the account menu (founder, 2026-10-02: "remove more... and
  // put settings inside the avatar's menu") — first item, above Language;
  // the stock gear rail stays hidden.
  menu.append(settingsItem, sepTop, langItem, sub, errorLine, sep, signOut)
  root.append(style, row, menu)
  const host = document.body ?? document.documentElement
  host.appendChild(root)

  // SELF-HEALING (see the module doc). Injection runs once per harness page
  // load, so without this, any DOM cleanup that detaches the root or the
  // stylesheet leaves the row unstyled until the app restarts. Two narrow
  // observers — the body's direct children, the root's direct children — keep
  // this off the SPA's own mutation traffic.
  const ensureAttached = (): void => {
    const container = document.body ?? document.documentElement
    if (root.parentNode !== container) container.appendChild(root)
    if (style.parentNode !== root) root.prepend(style)
  }
  new MutationObserver(ensureAttached).observe(host, { childList: true })
  new MutationObserver(ensureAttached).observe(root, { childList: true })

  // ---- state + behaviour ---------------------------------------------------

  let current: MuenUser | null = null
  let menuOpen = false
  let subOpen = false
  /** The id this session's successful switch claimed; see currentLang(). */
  let langOverride: string | null = null

  const applyStrings = (): void => {
    const s = strings()
    // The signed-in row shows the ACCOUNT, not a constant (founder, 2026-10-02:
    // *"it always says signed in w Muen even though I sign in with different
    // accounts"*). Name first (the founder's follow-up: *"it shows my gmail
    // addr instead of name"*), then email, then the constant as last resort.
    label.textContent = current === null
      ? s.signIn
      : current.name !== ''
        ? current.name
        : current.email !== ''
          ? current.email
          : s.signedIn
    settingsText.textContent = s.settings
    langText.textContent = s.language
    signOutText.textContent = s.signOut
    errorLine.textContent = s.switchFailed
  }

  const markChecked = (): void => {
    const active = currentLang()
    for (const { id, opt } of options) {
      opt.setAttribute('aria-checked', String(id === active))
    }
  }

  const setMenu = (open: boolean): void => {
    menuOpen = open
    if (!open) subOpen = false
    menu.dataset.open = open ? '1' : '0'
    sub.dataset.open = subOpen ? '1' : '0'
    errorLine.dataset.on = '0'
    row.setAttribute('aria-expanded', String(open))
  }

  const pickLocale = async (id: string): Promise<void> => {
    markCheckedTo(id)
    const ok = await switchLocale(id)
    if (ok) {
      // The harness flips its own html lang live (measured ~2.5 s); claim the
      // id now so labels and the check mark switch with the click instead of
      // trailing the html attribute.
      langOverride = id
      setMenu(false)
      applyStrings()
      markChecked()
    } else {
      errorLine.dataset.on = '1'
      subOpen = false
      sub.dataset.open = '0'
    }
  }

  const markCheckedTo = (id: string): void => {
    for (const { id: optionId, opt } of options) {
      opt.setAttribute('aria-checked', String(optionId === id))
    }
  }

  langItem.addEventListener('click', () => {
    renderOptions()
    subOpen = !subOpen
    sub.dataset.open = subOpen ? '1' : '0'
    errorLine.dataset.on = '0'
    markChecked()
  })

  signOut.addEventListener('click', () => {
    setMenu(false)
    void auth.signOut?.()
  })

  row.addEventListener('click', () => {
    if (current === null) {
      void auth.signIn?.()
      return
    }
    setMenu(!menuOpen)
    if (menuOpen) markChecked()
  })

  // Outside click and Esc close the menu (a menu that cannot be dismissed is
  // worse than no menu).
  document.addEventListener(
    'click',
    (event) => {
      if (!menuOpen) return
      if (event.target instanceof Node && !root.contains(event.target)) setMenu(false)
    },
    true
  )
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menuOpen) setMenu(false)
  })

  // ---- auth state ----------------------------------------------------------

  const render = (user: MuenUser | null): void => {
    current = user
    setMenu(false)
    for (const child of Array.from(avatar.querySelectorAll('img, .mua-initial'))) child.remove()

    applyStrings()
    if (user === null) {
      row.setAttribute('aria-label', strings().signIn)
      row.title = strings().signIn
      badge.style.display = 'none'
      const span = document.createElement('span')
      span.className = 'mua-initial'
      span.textContent = 'M'
      avatar.appendChild(span)
      return
    }

    row.setAttribute('aria-label', `${user.name} — Muen ${user.membership === 'pro' ? 'PRO ' : ''}member`)
    row.title = `${user.name} (${user.email})`
    if (user.avatarUrl !== '') {
      const img = document.createElement('img')
      img.src = user.avatarUrl
      img.alt = ''
      img.referrerPolicy = 'no-referrer'
      img.addEventListener('error', () => {
        // Picture failed (offline, URL gone): fall back to the initial.
        img.remove()
        if (avatar.querySelector('.mua-initial') === null) {
          const span = document.createElement('span')
          span.className = 'mua-initial'
          span.textContent = (user.name.trim()[0] ?? 'M').toUpperCase()
          avatar.appendChild(span)
        }
      })
      avatar.appendChild(img)
    } else {
      const span = document.createElement('span')
      span.className = 'mua-initial'
      span.textContent = (user.name.trim()[0] ?? 'M').toUpperCase()
      avatar.appendChild(span)
    }
    badge.style.display = user.membership === 'pro' ? 'block' : 'none'
    markChecked()
  }

  auth.onAuthChange(render)
  void auth.user()?.then(render).catch(() => undefined)
}
