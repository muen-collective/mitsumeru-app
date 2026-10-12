import { ipcMain, nativeTheme, type BrowserWindow } from 'electron'

/**
 * Mirror the app's own appearance into Electron's NATIVE appearance.
 *
 * WHY THIS EXISTS — the bug it fixes (founder, 2026-10-12: *"it works except the
 * color is off"*).
 *
 * The desktop mark buys the window a native material behind the page: on macOS,
 * `vibrancy: 'sidebar'` paints the sidebar's translucent gradient. That material
 * follows ELECTRON'S native appearance — and without this module nothing ever set
 * it, so it followed the OS. On a machine whose system appearance is Dark while
 * the app's theme is Light, the sidebar translated a dark grey material behind a
 * light UI: the washed-out, mismatched panel in that screenshot.
 *
 * The offical shell pairs the two, and the contract is small:
 *
 *   1. The harness's theme presenter writes `data-ds-theme-source` on `<html>`
 *      with `system` | `light` | `dark` (`ui-layout`, `THEME_SOURCE_ATTRIBUTE`).
 *      The PRELOAD watches that attribute and forwards each new value here.
 *   2. We set `nativeTheme.themeSource`, which fixes the native material, the
 *      window chrome, AND renderer `prefers-color-scheme` queries at once. The
 *      `system` value is passed through so that choice really does follow the OS.
 *
 * Fullscreen rides along for the same reason: the harness drops its 48px
 * title-band clearance in fullscreen (`html[data-fullscreen]`), and the native
 * traffic lights are hidden then too, so the two must agree or the layout leaves
 * a gap where nothing is drawn.
 */

const NATIVE_THEME_SET = 'dsh-desktop:native-theme-set'
const WINDOW_FULLSCREEN = 'dsh-desktop:window-fullscreen'

export interface NativeAppearance {
  dispose(): void
}

/**
 * Install the theme + fullscreen mirrors for one product window.
 *
 * Idempotent per call (each install owns its own listeners and removes them on
 * dispose), because sign-out/sign-in runs the boot path more than once.
 */
export function installNativeAppearance(
  win: BrowserWindow,
  log: (message: string) => void
): NativeAppearance {
  const contents = win.webContents

  const onTheme = (event: Electron.IpcMainEvent, source: unknown): void => {
    if (win.isDestroyed() || event.sender !== contents) return
    if (source !== 'light' && source !== 'dark' && source !== 'system') return
    if (nativeTheme.themeSource === source) return
    nativeTheme.themeSource = source
    log(`native-theme-source=${source}`)
  }
  ipcMain.on(NATIVE_THEME_SET, onTheme)

  // The harness drops its top clearance in fullscreen; the traffic lights go with
  // it. Both macOS and Windows hide the controls, so both get the signal.
  const sendFullscreen = (): void => {
    if (win.isDestroyed() || contents.isDestroyed()) return
    contents.send(WINDOW_FULLSCREEN, win.isFullScreen())
  }
  const scoped = process.platform === 'darwin' || process.platform === 'win32'
  if (scoped) {
    win.on('enter-full-screen', sendFullscreen)
    win.on('leave-full-screen', sendFullscreen)
    // Re-assert after every load: the page's own state starts clean.
    contents.on('did-finish-load', sendFullscreen)
  }

  return {
    dispose: (): void => {
      ipcMain.removeListener(NATIVE_THEME_SET, onTheme)
      if (scoped) {
        win.off('enter-full-screen', sendFullscreen)
        win.off('leave-full-screen', sendFullscreen)
        contents.off('did-finish-load', sendFullscreen)
      }
    }
  }
}
