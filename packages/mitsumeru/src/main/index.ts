import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  type MenuItemConstructorOptions
} from 'electron'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { spawnHarness, harnessPaths, type HarnessSession } from './harness'
import { startUpdater, type UpdaterController } from './updater'
import {
  APP_ID,
  APP_NAME,
  HARNESS_PACKAGE,
  HARNESS_TITLES,
  PRODUCT_NAME,
  UPDATE_FEED_URL,
  isDevVersion
} from '../shared/identity'

/**
 * mitsumeru — our own Electron shell around a DSH release (Epic 86 Track B).
 * - spawn + poll + load (the harness is a child process; never imported here)
 * - single instance lock
 * - shutdown — SIGTERM with 4s grace → SIGKILL, tracked + logged
 * - window lockdown — sandbox, origin-restricted navigation, deny handlers
 */

const log = (message: string): void => {
  console.log(`[${APP_NAME}] ${message}`)
}

// Pin the profile directory by name. Two reasons (Epic 86 T8):
//   - our display name may change (mitsumeru → mitsumeru) and the path must not;
//   - the shipping Mitsumeru app already owns ~/Library/Application Support/
//     Mitsumeru, and two Electron apps must never share one profile.
app.setPath('userData', join(app.getPath('appData'), 'Mitsumeru'))

const smoke = process.env.MITSUMERU_SMOKE === '1'
// v5 lockdown scripted attempts: when set, the loaded UI fires intentional
// violations so the deny log can be asserted (expected denies == 1).
const lockdownProbe = process.env.MITSUMERU_LOCKDOWN_PROBE === '1'
// File-action probe: injects a real path (+ a backticked one and a missing one)
// and drives trusted clicks so reveal/miss can be asserted from the log.
// Click probe: drives a trusted click on an injected external link.
const clickProbe = process.env.MITSUMERU_CLICK_PROBE === '1'

let mainWindow: BrowserWindow | null = null
let updater: UpdaterController | null = null
let session_harness: HarnessSession | null = null
let harnessLogPath = ''
let harnessOrigin = '' // set once the readiness URL is known; navigation fence
let harnessUiLoaded = false
let gotSingleInstanceLock = false

// ---- T3: single instance lock ---------------------------------------------

gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  // A first instance already owns the lock. Never spawn a second harness:
  // quit before whenReady/startup runs.
  log('single-instance-denied quit')
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    log(`second-instance argv=${JSON.stringify(argv.slice(1))} cwd=${workingDirectory}`)
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
      log('second-instance-focused-existing-window')
    }
  })
}

// ---- window + lockdown (T5) ------------------------------------------------

function isHarnessNavigation(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    if (harnessOrigin === '') return true // before any harness URL is known
    return parsed.origin === harnessOrigin
  } catch {
    return false
  }
}

function createSplashWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    // The window title is user-visible, so it is the product name, not the
    // package codename.
    title: PRODUCT_NAME,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  win.once('ready-to-show', () => {
    win.show()
    log('window-shown')
  })

  // Both halves of this are guarded, and the guards are the fix for a crash,
  // not defensive habit. Measured 2026-09-11: when the harness dies during boot
  // — which is exactly what a bad profile bundle list causes — `did-finish-load`
  // fires for the *splash* window's teardown while the main window is being
  // destroyed, and `win.webContents.getTitle()` throws `TypeError: Object has
  // been destroyed`. That turned a clean "harness failed to start" into an
  // uncaught exception on the main process, which is a worse failure to debug
  // than the one that caused it.
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    const title = win.webContents.getTitle()
    log(`window-title ${title}`)
    if (HARNESS_TITLES.includes(title)) {
      harnessUiLoaded = true
      log('harness-ui-loaded')
    }
  })

  // The harness's page declares `<title>DeepSeek Harness</title>`, and without
  // this the window adopts it — so Mission Control, the Window menu and the Dock
  // tooltip all advertise upstream in an app that is not upstream's. Measured
  // 2026-09-10: `window-title DeepSeek Harness` was in the run log of every
  // launch. `page-title-updated` is the documented way to decline the change.
  win.on('page-title-updated', (event) => {
    event.preventDefault()
    if (!win.isDestroyed()) win.setTitle(PRODUCT_NAME)
  })

  // T5: navigation fence — renderer/user navigation may only stay on the
  // harness origin. (webContents.loadURL from main is not affected.)
  win.webContents.on('will-navigate', (event, url) => {
    if (!isHarnessNavigation(url)) {
      event.preventDefault()
      log(`[lockdown] deny navigate ${url}`)
    }
  })

  // T5 + external-link policy: window.open / target=_blank is denied outright.
  // A browser launch is only ever driven by a real click, which arrives through
  // the 'mitsumeru:open-external' IPC below. Scripted opens therefore open
  // nothing at all — no iframe, no stray browser tab.
  win.webContents.setWindowOpenHandler(({ url }) => {
    log(`[lockdown] deny window-open ${url}`)
    return { action: 'deny' }
  })

  // T5: no webviews attach to this window, ever.
  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
    log('[lockdown] deny webview-attach')
  })

  return win
}

// T5: permissions → deny by default, with a named allow-list.
//
// The ONE entry is `clipboard-sanitized-write`, and it is not a convenience:
// Chromium asks for it before the async Clipboard API will write, and every Copy
// button in the wrapped harness UI (code blocks, tool results, terminal output,
// diffs) writes through `navigator.clipboard.writeText`. Denying it does not
// merely block the write — the upstream helper in
// `@deepseek-ai/dsh-client-ui-primitives` catches the rejection and returns
// false, and its caller returns early on false, so the button neither wrote to
// the clipboard nor showed its "Copied" state. The only visible behaviour was a
// click that did nothing at all.
//
// Electron consults BOTH handlers — "most web APIs do a permission check and
// then make a permission request if the check is denied" — so the same set is
// applied on both paths. Anything not named here stays denied on both, which is
// the posture this app shipped with; widening it is still a deliberate edit.
//
// `clipboard-read` is deliberately NOT allowed. Nothing in the harness UI reads
// the clipboard through the async API (the terminal's paste path goes through
// DOM paste events, which need no permission), and allowing it would let any
// page in the harness origin read whatever the user last copied.
//
// Registered once the app is ready — session.defaultSession is unavailable
// before then.
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write'])

function installPermissionPolicy(): void {
  // Checks are consulted first and are silent by design: a denied check is how
  // Chromium reaches the request handler below, so logging every check would
  // turn routine probing into lockdown noise (scripts/smoke.sh fails a run that
  // logs `[lockdown] deny`).
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) =>
    ALLOWED_PERMISSIONS.has(permission)
  )

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission)
    log(`[lockdown] ${allowed ? 'allow' : 'deny'} permission ${permission}`)
    callback(allowed)
  })
}

// External-link policy: the preload forwards trusted link clicks here. This is
// the ONLY code path that opens a browser.
function installExternalLinkHandler(): void {
  ipcMain.on('mitsumeru:open-external', (event, url: unknown) => {
    if (typeof url !== 'string') return
    // Only the harness page may ask the shell to open something.
    const senderUrl = event.senderFrame?.url ?? ''
    if (!isHarnessNavigation(senderUrl)) {
      log(`[lockdown] deny open-external-sender ${senderUrl}`)
      return
    }
    if (isHarnessNavigation(url)) return // in-app links stay in-app
    if (!/^https?:\/\//u.test(url)) return
    log(`[lockdown] open-external (click) ${url}`)
    void shell.openExternal(url)
  })
}

// ---- splash + harness lifecycle -------------------------------------------

function loadSplash(): void {
  if (mainWindow === null) return
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function startHarnessAndLoad(): Promise<void> {
  // State lives under Electron's userData (Epic 86 T8: pick once, never rename).
  const stateDir = process.env.MITSUMERU_DSH_HOME ?? join(app.getPath('userData'), 'mitsu-dsh')
  const logDir = process.env.MITSUMERU_LOG_DIR ?? join(app.getPath('userData'), 'logs')
  const paths = harnessPaths({
    stateDir,
    logDir,
    // Packaged, the harness travels in Resources/harness, not node_modules.
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined
  })
  harnessLogPath = paths.logPath
  log(`harness entry=${paths.entry}`)
  log(`harness stateDir=${paths.stateDir}`)
  log(`harness log=${paths.logPath}`)

  session_harness = spawnHarness({
    ...paths,
    onEvent: (event) => log(`harness ${event}`)
  })

  try {
    const readyUrl = await session_harness.readyUrl
    harnessOrigin = new URL(readyUrl).origin
    log(`harness-ready ${readyUrl}`)
    // Every boot mints a fresh token, but harness cookies are keyed by HOST
    // (127.0.0.1), not by port. A cookie left over from a previous boot makes
    // the browser-trust fence answer with a fallback page — no <title>, ~27 DOM
    // nodes — instead of the app. Seen on the 4th consecutive launch of a
    // verification run. Clear them before every load; this shell uses the
    // default session for nothing else. (The harness's own state lives in
    // DSH_HOME, not in the browser profile, so nothing real is lost.)
    await session.defaultSession.clearStorageData({ storages: ['cookies'] })
    log('harness-cookies-cleared')
    if (mainWindow === null) throw new Error('window closed before harness ready')
    // Electron handles the 303 + session cookie natively; title flips to the
    // harness marker once the real UI finishes loading.
    await mainWindow.loadURL(readyUrl)

    if (lockdownProbe && !smoke) {
      // v5 scripted violation: force a window.open from the harness page.
      // Expected result: one [lockdown] deny window-open line, plus one
      // [lockdown] open-external line (the deliberate handoff to the system
      // browser). The URL path self-identifies so the browser tab is obviously
      // the probe, not a stray.
      await mainWindow.webContents.executeJavaScript(
        "window.open('https://example.com/mitsumeru-lockdown-probe','_blank'); 'probe-fired'"
      )
      setTimeout(() => {
        log('lockdown-probe-done')
        app.quit()
      }, 1500)
    }

    if (clickProbe && !smoke) {
      // v5b: prove the click path end to end with TRUSTED input. A synthetic
      // JS click would be filtered by event.isTrusted, so drive real mouse
      // events at the coordinates of an injected external anchor.
      const rectJson = (await mainWindow.webContents.executeJavaScript(`(() => {
        const a = document.createElement('a')
        a.id = 'wp-click-probe'
        a.href = 'https://example.com/mitsumeru-click-probe'
        a.textContent = 'mitsumeru click probe'
        a.style.cssText = 'position:fixed;top:12px;left:12px;z-index:2147483647;padding:8px;background:#fff;color:#000'
        document.body.appendChild(a)
        const r = a.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
      })()`)) as string
      const { x, y } = JSON.parse(rectJson) as { x: number; y: number }
      mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x, y })
      mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      setTimeout(() => {
        log('click-probe-done')
        app.quit()
      }, 1500)
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`harness-failed ${message}`)
    if (smoke) {
      app.exit(1)
      return
    }
    const choice = await dialog.showMessageBox({
      type: 'error',
      title: PRODUCT_NAME,
      message: 'The DSH harness failed to start.',
      detail: message,
      buttons: ['Retry', 'Show Log', 'Quit'],
      defaultId: 0,
      cancelId: 2
    })
    if (choice.response === 0) {
      session_harness?.stop('retry')
      void startHarnessAndLoad()
    } else if (choice.response === 1) {
      void shell.openPath(harnessLogPath)
    } else {
      app.quit()
    }
  }
}

// T6: screenshot evidence — capture the rendered DSH UI to artifacts/ after
// the SPA has had time to paint, and log the DOM size as a blank-page guard.
async function captureEvidence(dir: string): Promise<void> {
  if (mainWindow === null) return
  try {
    await new Promise((resolve) => setTimeout(resolve, 5000)) // SPA paint settle
    const domNodes = await mainWindow.webContents.executeJavaScript(
      "document.querySelectorAll('*').length"
    )
    log(`dom-nodes ${String(domNodes)}`)
    const image = await mainWindow.webContents.capturePage()
    if (image.isEmpty()) {
      log('screenshot-empty')
      return
    }
    if (process.env.MITSUMERU_DOM_DEBUG === '1') {
      // Diagnostic only: is the UI still booting at the 5s mark, and what is
      // actually on screen?
      await new Promise((resolve) => setTimeout(resolve, 10000))
      const late = await mainWindow.webContents.executeJavaScript("document.querySelectorAll('*').length")
      const text = await mainWindow.webContents.executeJavaScript(
        "(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300)"
      )
      log(`dom-nodes-late ${String(late)}`)
      log(`body-text ${String(text)}`)
    }
    mkdirSync(dir, { recursive: true })
    const stamp = Date.now()
    const file = join(dir, `screenshot-${stamp}.png`)
    writeFileSync(file, image.toPNG())
    log(`screenshot ${file}`)
  } catch (error) {
    log(`screenshot-failed ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ---- app info + menu (T11) --------------------------------------------------

/**
 * What an About panel or a support conversation needs, read at runtime from one
 * place. The version is Electron's own (`app.getVersion()` — the manifest's
 * version field), so whatever the artifact says is what the running app says.
 */
function appInfo(): Record<string, string | boolean> {
  return {
    name: APP_NAME,
    productName: PRODUCT_NAME,
    appId: APP_ID,
    version: app.getVersion(),
    dev: isDevVersion(app.getVersion()),
    harnessPackage: HARNESS_PACKAGE,
    updateFeed: UPDATE_FEED_URL,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    packaged: app.isPackaged
  }
}

function installMenu(): void {
  const version = app.getVersion()
  const dev = isDevVersion(version)
  // The panel renders these instead of the Info.plist defaults, so the label a
  // person sees always matches the version in the artifact filename — including
  // the `-dev` suffix that keeps an internal build from reading as released.
  app.setAboutPanelOptions({
    applicationName: PRODUCT_NAME,
    applicationVersion: version,
    version: '',
    credits: dev
      ? `Internal build — not for public distribution.\nWraps ${HARNESS_PACKAGE}.`
      : `Wraps ${HARNESS_PACKAGE}.`
  })

  const template: MenuItemConstructorOptions[] = [
    {
      role: 'appMenu',
      submenu: [
        {
          label: `About ${PRODUCT_NAME}`,
          click: () => {
            // Logged so the panel version can be asserted from a run, not only
            // eyeballed in a screenshot.
            log(`about-panel version=${version} dev=${String(dev)}`)
            app.showAboutPanel()
          }
        },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          click: () => {
            void updater?.checkNow('menu')
          }
        },
        {
          // The same action the ready-dialog's first button takes. Reachable
          // afterwards, because "Later" must not be the last word.
          label: 'Restart to Update…',
          click: () => {
            if (updater?.installNow() !== true) {
              log('update-install-skipped state=not-downloaded')
            }
          }
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---- app lifecycle ---------------------------------------------------------

/**
 * A version is downloaded and verified — offer the restart.
 *
 * Not a nicety: on macOS nothing installs without this call (see
 * `installNow` in updater.ts), so a download with no offer would sit in
 * Squirrel's cache forever while the app kept telling itself it was up to date.
 *
 * Plain wording on purpose: a person reads this.
 */
function offerRestart(version: string): void {
  log(`update-ready-offer version=${version}`)
  void dialog
    .showMessageBox({
      type: 'info',
      message: 'A new version is ready.',
      detail: `${version} has been downloaded and checked. Restarting takes a few seconds.`,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    .then(({ response }) => {
      if (response === 0) {
        updater?.installNow()
      } else {
        log(`update-install-deferred version=${version}`)
      }
    })
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return // denied instance: already quitting
  log('app-ready')
  log(
    `version ${app.getVersion()}${isDevVersion(app.getVersion()) ? ' dev-build' : ''} packaged=${String(app.isPackaged)}`
  )
  installPermissionPolicy()
  installExternalLinkHandler()
  installMenu()
  ipcMain.handle('mitsumeru:app-info', () => appInfo())
  // T12: a check 15 s after launch (+ jitter), every 6 h after that, again
  // after a sleep/wake, and on demand. Nothing here blocks the harness boot.
  const feedOverride = process.env.MITSUMERU_UPDATE_FEED ?? ''
  if (process.env.MITSUMERU_UPDATE_DISABLE === '1') {
    log('update-disabled (MITSUMERU_UPDATE_DISABLE=1)')
  } else {
    updater = startUpdater({
      log,
      isTrustedSender: isHarnessNavigation,
      feedUrl: feedOverride === '' ? undefined : feedOverride,
      onDownloaded: offerRestart
    })
  }
  mainWindow = createSplashWindow()
  loadSplash()
  void startHarnessAndLoad()

  if (smoke) {
    // Auto-quit once the harness UI reported loaded (or after a hard cap so a
    // hang fails the run instead of blocking forever).
    const deadline = setTimeout(() => {
      log('smoke-timeout')
      app.exit(1)
    }, 60_000)
    let captured = false
    const check = setInterval(() => {
      if (harnessUiLoaded) {
        if (process.env.MITSUMERU_SCREENSHOT === '1' && !captured) {
          // Evidence capture once, then quit via the same path.
          captured = true
          clearInterval(check)
          clearTimeout(deadline)
          // Always quit after capture (success or failure) so a capture hang
          // cannot block the smoke run forever.
          // out/main → ../../artifacts = packages/mitsumeru/artifacts in dev.
          void captureEvidence(join(__dirname, '../../artifacts')).finally(() => {
            log('smoke-quit')
            app.quit()
          })
          return
        }
        clearInterval(check)
        clearTimeout(deadline)
        log('smoke-quit')
        app.quit()
      }
    }, 250)
  }
})

app.on('window-all-closed', () => {
  log('window-all-closed')
  app.quit()
})

// T4: shutdown path. will-quit → SIGTERM to the harness child; harness.ts
// escalates to SIGKILL after a 4s grace. The child 'exited' event is logged
// by the onEvent callback so the timing can be asserted.
app.on('will-quit', () => {
  log('will-quit')
  updater?.stop()
  session_harness?.stop('quit')
})

process.on('exit', (code) => {
  log(`exit code=${String(code)}`)
})
