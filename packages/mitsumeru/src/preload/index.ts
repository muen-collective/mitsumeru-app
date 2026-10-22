import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import { APP_NAME } from '../shared/identity'
import type { MuenUser } from '../shared/auth'
import type { UpdateStatus } from '../shared/update-status'

/**
 * mitsumeru preload.
 *
 * External-link policy (decided 2026-09-09): a real click on a link opens the
 * reader's system browser. Nothing else ever opens a browser.
 *
 * Why the click (and not the main process) decides: the harness UI renders
 * external links as `target="_blank"` anchors, so a trusted click is the only
 * honest signal of intent. Scripted window.open() calls are denied in the main
 * process and never forwarded — `event.isTrusted` filters synthetic dispatches,
 * so injected content cannot drive the browser.
 */

function externalHrefFrom(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined
  const anchor = target.closest('a[href]')
  if (anchor === null) return undefined
  const href = anchor.getAttribute('href')
  if (href === null || href === '') return undefined
  try {
    const url = new URL(href, window.location.href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

document.addEventListener(
  'click',
  (event) => {
    // Trusted input only: a script dispatching click() cannot open a browser.
    if (!event.isTrusted) return
    const href = externalHrefFrom(event.target)
    if (href === undefined) return
    // The main process decides: harness-origin links stay in-app, external ones
    // go to the system browser.
    ipcRenderer.send('mitsumeru:open-external', href)
  },
  true
)

/**
 * Full DSH desktop parity (founder, 2026-10-12: *"i want full parity"*).
 *
 * The page is marked as the macOS desktop shell and given the desktop bridge, in
 * that order of importance — but they are ONE change, because either alone is
 * broken:
 *
 *   - The mark alone makes `dsh-client-shortcuts` expect a native bridge and
 *     hard-fail its constructor when there is none, which cascades into
 *     "web boot: N entries did not activate" and the frame never mounts.
 *     (Measured 2026-10-12; the mark was reverted for exactly this reason.)
 *   - The bridge alone is inert: nothing reads `window.dshDesktop` until the
 *     runtime resolves to `desktop`, which is the mark.
 *
 * WHAT THE MARK BUYS
 *
 * `ui-layout` computes the collapsed sidebar's width as
 * `darwin || data-windows-titlebar ? 0 : 56` — so the rail COLLAPSES ALL THE WAY
 * instead of leaving the 56px icon column (the founding ask). It also turns on
 * the desktop chrome: the `[data-window-drag]` regions the window needs once the
 * title bar is hidden, the translucent New-session button, the sidebar gradient.
 *
 * WHAT THE BRIDGE MUST PROVIDE
 *
 * Exactly the surface the client destructures, nothing more:
 *
 *   dshDesktop = {
 *     protocolVersion: 1,
 *     keyboard: { closeWindow(revision), subscribe(listener) },
 *     shortcuts: { get(definitions), edit(edit, revision), recording(active), subscribe(listener) }
 *   }
 *
 * `keyboard.subscribe` is the load-bearing half: in desktop runtime the registry
 * takes configurable bindings ONLY from those messages (the DOM path serves
 * fixed actions alone), so a stub would silently kill every keyboard shortcut.
 *
 * `deviceInfo` is deliberately absent: no bundle reads it, and the official
 * value describes a DeepSeek account this app does not have.
 */
const DESKTOP_IPC = {
  shortcutsInput: 'dsh-desktop:shortcuts-input',
  shortcutsCloseWindow: 'dsh-desktop:shortcuts-close-window',
  shortcutsGet: 'dsh-desktop:shortcuts-get',
  shortcutsEdit: 'dsh-desktop:shortcuts-edit',
  shortcutsChanged: 'dsh-desktop:shortcuts-changed',
  shortcutsRecording: 'dsh-desktop:shortcuts-recording',
  nativeThemeSet: 'dsh-desktop:native-theme-set',
  windowFullscreen: 'dsh-desktop:window-fullscreen'
} as const

interface ShortcutInputMessage {
  kind: string
  frameName?: string
}

function createDesktopBridge(): Record<string, unknown> {
  return {
    protocolVersion: 1,
    keyboard: {
      closeWindow: (revision: string): Promise<void> =>
        ipcRenderer.invoke(DESKTOP_IPC.shortcutsCloseWindow, revision),
      subscribe: (listener: (input: ShortcutInputMessage) => void): (() => void) => {
        const handle = (_event: IpcRendererEvent, input: ShortcutInputMessage): void => {
          // Embedded frames have to prove they own the focused element before
          // the message is trusted — the same check the official bridge makes.
          if (input.kind === 'iframe') {
            const element = document.activeElement
            if (
              !(element instanceof HTMLIFrameElement) ||
              !element.isConnected ||
              !element.matches('iframe[data-sidebar-browser-frame], iframe[data-html-preview]')
            ) {
              return
            }
            if (input.frameName === '' || input.frameName === undefined || element.name !== input.frameName) return
          }
          if (input.kind === 'webview') {
            const element = document.activeElement
            if (element?.matches('webview[data-sidebar-browser-frame]') !== true || !element.isConnected) return
            if (input.frameName === '' || input.frameName === undefined) return
            if (element.getAttribute('name') !== input.frameName) return
          }
          listener(input)
        }
        ipcRenderer.on(DESKTOP_IPC.shortcutsInput, handle)
        return () => {
          ipcRenderer.removeListener(DESKTOP_IPC.shortcutsInput, handle)
        }
      }
    },
    shortcuts: {
      get: (definitions: unknown): Promise<unknown> =>
        ipcRenderer.invoke(DESKTOP_IPC.shortcutsGet, definitions),
      edit: (edit: unknown, revision: string): Promise<unknown> =>
        ipcRenderer.invoke(DESKTOP_IPC.shortcutsEdit, edit, revision),
      recording: (active: boolean): Promise<void> =>
        ipcRenderer.invoke(DESKTOP_IPC.shortcutsRecording, active),
      subscribe: (listener: (snapshot: unknown) => void): (() => void) => {
        const handle = (_event: IpcRendererEvent, snapshot: unknown): void => listener(snapshot)
        ipcRenderer.on(DESKTOP_IPC.shortcutsChanged, handle)
        return () => {
          ipcRenderer.removeListener(DESKTOP_IPC.shortcutsChanged, handle)
        }
      }
    }
  }
}

/**
 * Mark `<html data-platform>` and install the bridge — the official shell's
 * `markDocumentPlatform()`, scoped to this app.
 *
 * TWO MECHANISMS, on purpose:
 *
 *   - The attribute is a plain DOM assignment. The DOM is shared between the
 *     preload's isolated world and the page, so the mark is visible to the page
 *     directly — that is exactly how the official shell does it.
 *   - The bridge goes through `contextBridge.exposeInMainWorld`. A bare
 *     `window.dshDesktop = …` would land on the ISOLATED world's `window` and the
 *     page would never see it; objects and functions do not cross worlds on
 *     their own the way the DOM does.
 *
 * THE GUARD IS THE POINT. Everything below is conditional on the main process
 * confirming that the keyboard bridge is live (`desktop-parity:ask`). The mark
 * without the bridge is worse than neither: `dsh-client-shortcuts` resolves its
 * runtime from this one attribute and throws when the bridge is missing, which
 * cascades into "web boot: N entries did not activate" and the frame never
 * mounts. So an unavailable bridge degrades to today's behaviour — the 56px icon
 * rail, a working app — instead of a broken one.
 *
 * The ask is synchronous because the decision has to be made in this tick, before
 * the page's own bundle reads the attribute at import time.
 */
/**
 * Mirror the app's appearance into Electron's native appearance.
 *
 * Without this the window's native material (`vibrancy: 'sidebar'`) follows the
 * OS appearance instead of the app's theme, so a light app on a dark system gets
 * a dark grey sidebar — the founder's *"the color is off"* (2026-10-12).
 *
 * The source of truth is `html[data-ds-theme-source]`, which the harness's theme
 * presenter writes (`system` | `light` | `dark`); the main process turns it into
 * `nativeTheme.themeSource`. Observed with an observer rather than polled, and
 * seeded once at startup so the material is right before the user changes
 * anything.
 */
function syncNativeTheme(): void {
  const send = (): void => {
    const value = document.documentElement.getAttribute('data-ds-theme-source')
    if (value === null) return
    ipcRenderer.send(DESKTOP_IPC.nativeThemeSet, value)
  }
  const observe = (): void => {
    new MutationObserver(send).observe(document.documentElement, {
      attributeFilter: ['data-ds-theme-source']
    })
    send()
  }
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', observe, { once: true })
  } else {
    observe()
  }
}

/**
 * Mirror fullscreen onto `<html data-fullscreen>`.
 *
 * The harness drops its 48px title-band clearance in fullscreen
 * (`html[data-platform=darwin][data-fullscreen]`), where the native traffic
 * lights are hidden too. Both halves must agree or the title row leaves a gap.
 */
function syncWindowFullscreen(): void {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return
  ipcRenderer.on(DESKTOP_IPC.windowFullscreen, (_event, fullscreen: unknown) => {
    const root = document.documentElement
    if (root === null) return
    if (fullscreen === true) root.dataset.fullscreen = 'true'
    else delete root.dataset.fullscreen
  })
}

function installDesktopParity(): void {
  const install = (): void => {
    let available = false
    try {
      available = ipcRenderer.sendSync('mitsumeru:desktop-parity') === true
    } catch {
      available = false
    }
    if (!available) return
    document.documentElement.dataset.platform = process.platform
    contextBridge.exposeInMainWorld('dshDesktop', createDesktopBridge())
  }
  if (document.documentElement === null) window.addEventListener('DOMContentLoaded', install)
  else install()
}

installDesktopParity()
// Both mirrors are unconditional: they are harmless without the mark (nothing
// sends on the theme channel until the harness writes the attribute), and they
// are required WITH it.
syncNativeTheme()
syncWindowFullscreen()

// The shell's own surface for the page it hosts: which build this is, and the
// update state. Read from the main process instead of baked in at build time,
// so a running app can never claim a version the artifact does not carry (T11)
// and the `-dev` label survives a rebuild.
//
// The workspace folder chooser rides the SAME name DSH's own desktop exposes
// (`__DSH_DIRECTORY_PICKER__`), because the harness's directory-picker client
// looks for exactly this global first and only falls back to the host's
// osascript panel when it is absent (`dsh-client-ui-directory-picker-native`,
// `apply()`). The fallback's panel is an accessory process's window, so a new
// folder cannot be named in it on macOS; this bridge gives the client an
// Electron sheet attached to this window instead. Same contract as upstream:
// `pick()` resolves to an absolute path, or `null` when the person cancels.
contextBridge.exposeInMainWorld('__DSH_DIRECTORY_PICKER__', {
  pick: () => ipcRenderer.invoke('mitsumeru:pick-directory')
})

contextBridge.exposeInMainWorld(APP_NAME, {
  getAppInfo: () => ipcRenderer.invoke('mitsumeru:app-info'),
  checkForUpdates: () => ipcRenderer.invoke('mitsumeru:update-check'),
  updateStatus: () => ipcRenderer.invoke('mitsumeru:update-status'),
  archivedVersions: () => ipcRenderer.invoke('mitsumeru:update-archive'),
  // Push subscription for the injected update banner (Epic 91): the updater's
  // state changes are forwarded to this window as `mitsumeru:update-changed`,
  // so the banner reacts the moment an update is ready instead of polling.
  // The channel is separate from the `update-status` invoke above — one asks,
  // the other is told. Returns an unsubscribe.
  onUpdateStatus: (cb: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, status: UpdateStatus): void => cb(status)
    ipcRenderer.on('mitsumeru:update-changed', listener)
    return () => {
      ipcRenderer.removeListener('mitsumeru:update-changed', listener)
    }
  },
  // Restart into a downloaded version. Called by the ready-dialog's first
  // button, the app menu's "Restart to Update…", and the update indicator's
  // Restart action — three surfaces, one action.
  restartToUpdate: () => ipcRenderer.invoke('mitsumeru:update-restart'),
  // Muen sign-in (Epic 92). The token deliberately has no getter for the
  // overlay — only the main process and the gated plugin flow (which asks
  // through the trusted IPC) ever see it; the overlay deals in MuenUser.
  auth: {
    signIn: (): Promise<void> => ipcRenderer.invoke('mitsumeru:auth-sign-in'),
    signOut: (): Promise<void> => ipcRenderer.invoke('mitsumeru:auth-sign-out'),
    user: (): Promise<MuenUser | null> => ipcRenderer.invoke('mitsumeru:auth-user'),
    token: (): Promise<string | null> => ipcRenderer.invoke('mitsumeru:auth-token'),
    // Push subscription: sign-in and sign-out both arrive as
    // `mitsumeru:auth-changed` (same ask/tell split as the update channels).
    onAuthChange: (cb: (user: MuenUser | null) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, user: MuenUser | null): void => cb(user)
      ipcRenderer.on('mitsumeru:auth-changed', listener)
      return () => {
        ipcRenderer.removeListener('mitsumeru:auth-changed', listener)
      }
    }
  }
})
