import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The desktop keyboard bridge (full DSH parity, founder 2026-10-12: *"i want full
 * parity"*).
 *
 * WHY THIS IS NEEDED AT ALL
 *
 * `@deepseek-ai/dsh-client-shortcuts` picks its input path from one attribute:
 *
 *   const desktop = document.documentElement.dataset.platform
 *   runtime: desktop === undefined ? 'web' : 'desktop'
 *
 * On `web` the registry listens to DOM `keydown` and persists preferences to
 * localStorage. On `desktop` it (a) routes configurable bindings through a NATIVE
 * bridge instead of the DOM, and (b) hard-fails at construction when that bridge
 * is missing:
 *
 *   const keyboard = environment.runtime === 'desktop' ? window.dshDesktop?.keyboard : undefined
 *   if (environment.runtime === 'desktop' && keyboard === undefined) throw new Error('Desktop keyboard bridge unavailable')
 *
 * Because almost every UI bundle waits on the `shortcuts` service, that throw
 * cascades: measured 2026-10-12, marking the page without this bridge produced
 * "web boot: 25 entries did not activate … dsh-client-shortcuts: failed" and the
 * frame never mounted at all. So the mark and this bridge ship together or not
 * at all.
 *
 * WHAT IT BUYS (the reason the mark is wanted)
 *
 * `@deepseek-ai/dsh-client-ui-layout` reads the same mark for the collapsed
 * sidebar's width: `darwin || data-windows-titlebar ? 0 : 56`. Zero hides the rail
 * entirely instead of leaving the 56px icon column — the founder's ask. The mark
 * also turns on the desktop chrome (the `[data-window-drag]` regions, the
 * translucent New-session button, the sidebar gradient).
 *
 * THE DIVISION OF LABOUR (ported from the official shell, not reimplemented)
 *
 * The MAIN process owns the binding TABLE; the RENDERER owns the registry. The
 * main half keeps a key->binding index and, for each physical key event, decides
 * whether the event is a registered chord. When it is, the event is consumed
 * (preventDefault) and an input message goes to the page; gestures that already
 * reach the page are ignored. That ordering is what makes native bindings win
 * over the DOM without double-dispatching.
 *
 * The pure domain — parsing the stored document, resolving overrides against
 * defaults, validation, conflict detection, and the single-writer persistence
 * coordinator — is IMPORTED from the harness's own published entry point
 * (`@deepseek-ai/dsh-client-shortcuts/protocol`, a declared package export), so
 * there is no vendored copy to drift from the client it must agree with.
 */

/** The subset of the protocol surface this bridge uses. */
interface ShortcutBinding {
  code: string
  modifiers: string[]
  secondCode?: string
}
interface ShortcutDefinitions {
  id: string
  defaults: Record<string, ShortcutBinding | null | undefined>
  fixed?: ShortcutBinding[]
}
interface ShortcutRow {
  id: string
  binding: ShortcutBinding | null
  issue: string | null
  conflicts: string[]
}
interface ShortcutDocument {
  schemaVersion: number
  profiles: Record<string, Record<string, ShortcutBinding | null>>
}
interface ShortcutSnapshot {
  revision: string
  sequence: number
  document: ShortcutDocument
  status: string
  error: string | null
  usingDefaults: boolean
}
interface ShortcutEdit {
  type: 'set' | 'reset' | 'reset-all'
  id?: string
  binding?: ShortcutBinding | null
}

/** The IPC channel the page listens on; the page's own protocol, not ours. */
const SHORTCUTS_INPUT = 'dsh-desktop:shortcuts-input'
const SHORTCUTS_CHANGED = 'dsh-desktop:shortcuts-changed'
const SHORTCUTS_GET = 'dsh-desktop:shortcuts-get'
const SHORTCUTS_EDIT = 'dsh-desktop:shortcuts-edit'
const SHORTCUTS_RECORDING = 'dsh-desktop:shortcuts-recording'
const SHORTCUTS_CLOSE_WINDOW = 'dsh-desktop:shortcuts-close-window'

/** Local device platform in the vocabulary the protocol uses. */
function localPlatform(): 'macos' | 'windows' | 'linux' {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  return 'linux'
}

/**
 * Load the protocol module out of the harness tree the app actually runs.
 *
 * It is imported by absolute file URL rather than by package name because the
 * shell's own dependency tree holds only `@deepseek-ai/dsh`; the rest of the
 * closure lives in the staged/packaged harness root. That is the same anchor
 * `harnessPaths()` reports.
 */
async function loadProtocol(harnessRoot: string): Promise<{
  effectiveShortcuts: (
    definitions: ShortcutDefinitions[],
    document: ShortcutDocument,
    runtime: string,
    platform: string
  ) => ShortcutRow[]
  bindingKey: (binding: ShortcutBinding) => string
  parseShortcutDefinitions: (input: unknown) => ShortcutDefinitions[]
  parseShortcutEdit: (input: unknown) => ShortcutEdit
  parseShortcutDocument: (raw: string | null) => ShortcutDocument | string
  editShortcutDocument: (
    document: ShortcutDocument,
    edit: ShortcutEdit,
    runtime: string,
    platform: string
  ) => ShortcutDocument
  initialShortcutConfig: () => ShortcutSnapshot
}> {
  const entry = join(
    harnessRoot,
    'node_modules',
    '@deepseek-ai',
    'dsh-client-shortcuts',
    'lib',
    'protocol.js'
  )
  const module = (await import(pathToFileURL(entry).href)) as Record<string, unknown>
  for (const name of [
    'effectiveShortcuts',
    'bindingKey',
    'parseShortcutDefinitions',
    'parseShortcutEdit',
    'parseShortcutDocument',
    'editShortcutDocument',
    'initialShortcutConfig'
  ]) {
    if (typeof module[name] !== 'function') {
      throw new Error(`shortcuts protocol: missing ${name}`)
    }
  }
  return module as never
}

/**
 * The stored preference document, at `<stateDir>/keybindings.json` — the same
 * file name and location the official shell uses, so a profile that moves
 * between the two apps keeps its keybindings.
 *
 * Writes are atomic (temp + rename) with mode 0600, matching the official
 * store's `writeFileAtomic(path, raw, { mode: 0o600, dirMode: 0o700 })`.
 */
class KeybindingStore {
  #path: string
  #raw: string | null = null
  #snapshot: ShortcutSnapshot
  #definitions: ShortcutDefinitions[] = []
  #revision: string | undefined

  constructor(
    stateDir: string,
    private readonly protocol: Awaited<ReturnType<typeof loadProtocol>>,
    private readonly onPublish: (snapshot: ShortcutSnapshot) => void
  ) {
    this.#path = join(stateDir, 'keybindings.json')
    this.#snapshot = { ...protocol.initialShortcutConfig(), status: 'ready', usingDefaults: true }
  }

  /** The revision the page is currently configured against, if the table is live. */
  get revision(): string | undefined {
    return this.#revision
  }

  async read(): Promise<ShortcutSnapshot> {
    let raw: string | null = null
    try {
      raw = await readFile(this.#path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return this.#accept({ ...this.#snapshot, status: 'unreadable', error: 'read' })
      }
    }
    if (raw !== this.#raw) {
      this.#raw = raw
      const parsed = this.protocol.parseShortcutDocument(raw)
      if (typeof parsed === 'string') {
        return this.#accept({ ...this.#snapshot, status: 'unreadable', error: parsed })
      }
      return this.#accept({
        ...this.#snapshot,
        document: parsed,
        status: 'ready',
        error: null,
        usingDefaults: raw === null
      })
    }
    return this.#snapshot
  }

  setDefinitions(definitions: ShortcutDefinitions[]): void {
    this.#definitions = definitions
    this.#refresh()
  }

  async edit(edit: ShortcutEdit): Promise<{ status: string; snapshot: ShortcutSnapshot }> {
    const next = this.protocol.editShortcutDocument(this.#snapshot.document, edit, 'desktop', localPlatform())
    const raw = `${JSON.stringify(next, null, 2)}\n`
    try {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
      const temp = `${this.#path}.${String(process.pid)}.tmp`
      await writeFile(temp, raw, { mode: 0o600 })
      await rename(temp, this.#path)
    } catch {
      return { status: 'write-failed', snapshot: this.#snapshot }
    }
    this.#raw = raw
    return {
      status: 'saved',
      snapshot: this.#accept({ ...this.#snapshot, document: next, status: 'ready', error: null, usingDefaults: false })
    }
  }

  #accept(snapshot: ShortcutSnapshot): ShortcutSnapshot {
    this.#snapshot = {
      ...snapshot,
      sequence: this.#snapshot.sequence + 1,
      revision: crypto.randomUUID()
    }
    this.#refresh()
    return this.#snapshot
  }

  /** Rebuild the key index from the live table and publish it to the page. */
  #refresh(): void {
    const rows =
      this.#definitions.length === 0 || this.#snapshot.status === 'loading'
        ? []
        : this.protocol.effectiveShortcuts(this.#definitions, this.#snapshot.document, 'desktop', localPlatform())
    this.#keys = new Set(
      rows.flatMap((row) =>
        row.binding !== null && row.issue === null && row.conflicts.length === 0
          ? [this.protocol.bindingKey(row.binding)]
          : []
      )
    )
    this.#revision = this.#definitions.length === 0 || this.#snapshot.status === 'loading'
      ? undefined
      : this.#snapshot.revision
    this.onPublish(this.#snapshot)
  }

  #keys = new Set<string>()

  /** Is this exact gesture a registered, conflict-free binding? */
  matches(input: ShortcutBinding): { binding: ShortcutBinding; priority: boolean } | undefined {
    if (input.secondCode === undefined) {
      const key = this.protocol.bindingKey({ code: input.code, modifiers: input.modifiers })
      if (!this.#keys.has(key)) return undefined
      return { binding: input, priority: false }
    }
    // A chord: both keys must be in the table, and it outranks a plain binding.
    const pair = { code: input.code, secondCode: input.secondCode, modifiers: input.modifiers }
    if (!this.#keys.has(this.protocol.bindingKey(pair))) return undefined
    return { binding: pair, priority: true }
  }
}

export interface ShortcutBridge {
  /** The state directory the preferences are stored under (tests). */
  readonly path: string
  dispose(): void
}

/**
 * Probe the protocol module without installing anything.
 *
 * Called BEFORE the window exists, because the answer has to reach the preload
 * through `additionalArguments`, and those are fixed at window creation. The
 * invariant it protects is absolute (see the module doc): the page must never be
 * marked `desktop` unless a real bridge is waiting for it, or the boot dies.
 */
export async function desktopShortcutsAvailable(harnessRoot: string): Promise<boolean> {
  try {
    await loadProtocol(harnessRoot)
    return true
  } catch {
    return false
  }
}

/** The synchronous channel the preload asks before marking the document. */
const PARITY_ASK = 'mitsumeru:desktop-parity'

/** Set once the bridge is live; read by the preload's synchronous ask. */
let parityAvailable = false

/**
 * Answer the preload's one synchronous question: may the page be marked
 * `desktop`?
 *
 * Registered at module load so the answer is never "not ready" — a missing
 * handler would make `sendSync` return `undefined`, which is falsy, and the mark
 * would simply stay off (the safe direction).
 */
ipcMain.on(PARITY_ASK, (event) => {
  event.returnValue = parityAvailable
})

/** The live bridge, if any. At most one exists per process. */
let activeBridge: ShortcutBridge | undefined

/**
 * Install the shortcuts IPC + per-window key interception.
 *
 * `stateDir` is the harness state directory (the same one `harnessPaths()`
 * reports) so keybindings live beside the rest of the app's user data.
 *
 * IDEMPOTENT ON PURPOSE. Sign-out tears the harness down and sign-in starts it
 * again, so this runs more than once in one app session — and `ipcMain.handle`
 * THROWS on a duplicate channel ("Attempted to register a second handler"). The
 * previous bridge is therefore disposed before a new one is installed, rather
 * than assuming a single install per process.
 */
export async function installDesktopShortcuts(
  win: BrowserWindow,
  harnessRoot: string,
  stateDir: string,
  log: (message: string) => void
): Promise<ShortcutBridge | undefined> {
  activeBridge?.dispose()
  activeBridge = undefined

  let protocol: Awaited<ReturnType<typeof loadProtocol>>
  try {
    protocol = await loadProtocol(harnessRoot)
  } catch (error) {
    // Without the bridge the desktop mark must NOT be set (see the module doc):
    // the caller decides, and we report the reason.
    log(`shortcuts-protocol-unavailable ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }

  const contents = win.webContents
  const store = new KeybindingStore(stateDir, protocol, (snapshot) => {
    if (win.isDestroyed() || contents.isDestroyed()) return
    contents.send(SHORTCUTS_CHANGED, snapshot)
  })

  const isOwner = (event: IpcMainInvokeEvent): boolean =>
    !win.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame

  ipcMain.handle(SHORTCUTS_GET, async (event, input: unknown) => {
    if (!isOwner(event)) throw new Error('desktop shortcuts: rejected sender')
    store.setDefinitions(protocol.parseShortcutDefinitions(input))
    return await store.read()
  })
  ipcMain.handle(SHORTCUTS_EDIT, async (event, input: unknown) => {
    if (!isOwner(event)) throw new Error('desktop shortcuts: rejected sender')
    return await store.edit(protocol.parseShortcutEdit(input))
  })
  ipcMain.handle(SHORTCUTS_RECORDING, (event, active: unknown) => {
    if (!isOwner(event)) throw new Error('desktop shortcuts: rejected sender')
    if (typeof active !== 'boolean') throw new Error('desktop shortcuts: invalid recording state')
    contents.setIgnoreMenuShortcuts(active)
  })
  ipcMain.handle(SHORTCUTS_CLOSE_WINDOW, (event, expected: unknown) => {
    if (!isOwner(event)) throw new Error('desktop shortcuts: rejected sender')
    if (expected !== store.revision || store.revision === undefined) return
    if (!win.isFocused() || !win.isEnabled()) return
    win.close()
  })

  // The interception point. `before-input-event` fires for physical keys before
  // the page sees them, which is where a native binding must claim the gesture.
  const onInput = (event: { preventDefault: () => void }, input: Electron.Input): void => {
    const revision = store.revision
    if (revision === undefined || input.type !== 'keyDown') return
    const code = input.code
    const binding = store.matches({
      code,
      modifiers: [
        ...(input.control ? ['control'] : []),
        ...(input.alt ? ['alt'] : []),
        ...(input.shift ? ['shift'] : []),
        ...(input.meta ? ['meta'] : [])
      ]
    })
    if (binding === undefined) return
    event.preventDefault()
    if (input.isAutoRepeat) return
    contents.send(SHORTCUTS_INPUT, {
      kind: 'keyboard',
      revision,
      frameName: '',
      code: binding.binding.code,
      ...(binding.binding.secondCode === undefined ? {} : { secondCode: binding.binding.secondCode }),
      repeat: input.isAutoRepeat,
      control: input.control,
      alt: input.alt,
      shift: input.shift,
      meta: input.meta
    })
  }
  contents.on('before-input-event', onInput)

  // A navigation clears the table, exactly as the official shell does: the page
  // that owned these definitions is gone.
  const onNavigate = (): void => store.setDefinitions([])
  contents.on('did-start-navigation', onNavigate)

  // Publish the initial (defaults-only) configuration so the page's first
  // `get` has a live document to read.
  await store.read()

  parityAvailable = true
  log('shortcuts-bridge-installed')
  const bridge: ShortcutBridge = {
    path: join(stateDir, 'keybindings.json'),
    dispose: (): void => {
      parityAvailable = false
      if (activeBridge === bridge) activeBridge = undefined
      contents.off('before-input-event', onInput)
      contents.off('did-start-navigation', onNavigate)
      ipcMain.removeHandler(SHORTCUTS_GET)
      ipcMain.removeHandler(SHORTCUTS_EDIT)
      ipcMain.removeHandler(SHORTCUTS_RECORDING)
      ipcMain.removeHandler(SHORTCUTS_CLOSE_WINDOW)
    }
  }
  activeBridge = bridge
  return bridge
}
