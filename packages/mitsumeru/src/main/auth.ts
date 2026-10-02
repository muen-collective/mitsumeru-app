import { app, ipcMain, safeStorage, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { AUTH_ORIGIN, AUTH_SCHEME } from '../shared/identity'
import type { AuthSession, MuenUser } from '../shared/auth'

/**
 * Muen sign-in (Epic 92). Shell-owned, same trust boundary as the updater:
 * `quitAndInstall` is an Electron API and so is this — the browser does the
 * identity proof, the shell only trades the resulting code for a session and
 * keeps it.
 *
 * Flow (entry per the 0.2.6 pivot call 5, 2026-09-30 — Clerk hosted on the Muen
 * site; the exchange contract below is unchanged, per decision 65):
 *   signIn()  → browser to <origin>/sign-in?client=mitsumeru
 *   the site  → after Clerk sign-in, mints a short code and redirects to
 *               mitsumeru://auth/callback?code=...  (deep link)
 *   handleDeepLink() → POST /api/auth/exchange { code, redirectUri } → { token, user }
 *   session   → encrypted on disk (safeStorage: macOS Keychain-backed),
 *               pushed to the window as mitsumeru:auth-changed
 *
 * Nothing here may take the app down: a server that is not deployed yet, an
 * offline machine, or a declined OAuth all land as a logged line and a signed-
 * out app. The harness boots whether or not anyone signs in.
 */

/** Where the session lives: <userData>/auth/session.enc (one file, encrypted). */
const storePath = (): string => join(app.getPath('userData'), 'auth', 'session.enc')

export interface AuthOptions {
  log: (message: string) => void
  /** Guard for IPC callers: only the window showing the harness may act. */
  isTrustedSender: (url: string) => boolean
  /** Session changed (signed in / signed out) — the shell pushes it onward. */
  onSessionChange: (session: AuthSession | null) => void
}

export interface AuthController {
  session: () => AuthSession | null
  /** Open the browser at the OAuth entry. */
  signIn: () => void
  /** Forget the session and delete the store file. */
  signOut: () => void
  /**
   * A mitsumeru://auth/callback URL arrived (macOS open-url / Windows argv).
   * Exchanges the code; an OAuth `error=` answer is only logged.
   */
  handleDeepLink: (url: string) => void
  stop: () => void
}

/** Defensive read of the server's exchange response — it is remote input. */
const readSession = (payload: unknown): AuthSession | null => {
  if (typeof payload !== 'object' || payload === null) return null
  const body = payload as Record<string, unknown>
  if (typeof body.token !== 'string' || body.token === '') return null
  if (typeof body.user !== 'object' || body.user === null) return null
  const raw = body.user as Record<string, unknown>
  if (typeof raw.id !== 'string' || typeof raw.email !== 'string') return null
  const user: MuenUser = {
    id: raw.id,
    email: raw.email,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : raw.email,
    avatarUrl: typeof raw.avatarUrl === 'string' ? raw.avatarUrl : '',
    membership: raw.membership === 'pro' ? 'pro' : 'free'
  }
  return { token: body.token, user }
}

export function startAuth(options: AuthOptions): AuthController {
  const { log, isTrustedSender, onSessionChange } = options
  const origin = process.env.MITSUMERU_AUTH_ORIGIN ?? AUTH_ORIGIN

  let session: AuthSession | null = null
  let stopped = false

  // ---- encrypted store ------------------------------------------------------

  const persist = (): void => {
    if (session === null) return
    if (!safeStorage.isEncryptionAvailable()) {
      // The keychain is unreachable (measured: never on macOS, possible on
      // Linux without a secret service). Signing in still works for this run —
      // the session just will not survive it, which beats plaintext on disk.
      log('auth-remember-skip encryption unavailable (session is this-run only)')
      return
    }
    try {
      const dir = join(app.getPath('userData'), 'auth')
      mkdirSync(dir, { recursive: true })
      writeFileSync(storePath(), safeStorage.encryptString(JSON.stringify(session)).toString('base64'))
      log('auth-remember ok')
    } catch (error) {
      log(`auth-remember-failed ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const restore = (): void => {
    try {
      if (!existsSync(storePath())) return
      if (!safeStorage.isEncryptionAvailable()) return
      const blob = Buffer.from(readFileSync(storePath(), 'utf8'), 'base64')
      const parsed = readSession(JSON.parse(safeStorage.decryptString(blob)))
      if (parsed === null) throw new Error('stored session failed validation')
      session = parsed
      log(`auth-restored email=${parsed.user.email} membership=${parsed.user.membership}`)
    } catch (error) {
      // A store we cannot read is a store we delete — a half-session that
      // always fails validation is worse than signing in again.
      log(`auth-restore-failed ${error instanceof Error ? error.message : String(error)}`)
      session = null
      try {
        rmSync(storePath(), { force: true })
      } catch {
        /* best effort */
      }
    }
  }

  // ---- exchange -------------------------------------------------------------

  const exchange = async (code: string): Promise<void> => {
    if (stopped) return
    try {
      const response = await fetch(`${origin}/api/auth/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, redirectUri: `${AUTH_SCHEME}://auth/callback` })
      })
      if (!response.ok) {
        log(`auth-exchange-failed status=${String(response.status)}`)
        return
      }
      const parsed = readSession(await response.json())
      if (parsed === null) {
        log('auth-exchange-failed malformed response')
        return
      }
      session = parsed
      persist()
      log(`auth-signed-in email=${parsed.user.email} membership=${parsed.user.membership}`)
      onSessionChange(session)
    } catch (error) {
      // Offline, DNS failure, a server that does not exist yet (Epic 92 Q2):
      // all just leave the user signed out.
      log(`auth-exchange-error ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ---- actions --------------------------------------------------------------

  const signIn = (): void => {
    // The sign-in route, not the homepage, and the client= marker tells the
    // site this sign-in must complete the app round-trip (mint + deep link).
    const url = `${origin}/sign-in?client=mitsumeru`
    log(`auth-open-browser ${url}`)
    void shell.openExternal(url)
  }

  const signOut = (): void => {
    if (session === null) return
    session = null
    try {
      rmSync(storePath(), { force: true })
    } catch (error) {
      log(`auth-store-remove-failed ${error instanceof Error ? error.message : String(error)}`)
    }
    log('auth-signed-out')
    onSessionChange(null)
  }

  const handleDeepLink = (url: string): void => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      log(`auth-deeplink-malformed ${url}`)
      return
    }
    if (parsed.protocol !== `${AUTH_SCHEME}:`) return
    if (parsed.host !== 'auth' || parsed.pathname !== '/callback') {
      log(`auth-deeplink-ignored ${url}`)
      return
    }
    const error = parsed.searchParams.get('error')
    if (error !== null) {
      // The person declined on the provider's page — expected, not a failure.
      log(`auth-declined ${error}`)
      return
    }
    const code = parsed.searchParams.get('code')
    if (code === null || code === '') {
      log('auth-deeplink-no-code')
      return
    }
    log('auth-deeplink code received, exchanging')
    void exchange(code)
  }

  // ---- boot -----------------------------------------------------------------

  restore()

  // ---- IPC ------------------------------------------------------------------

  ipcMain.handle('mitsumeru:auth-sign-in', (event) => {
    if (!isTrustedSender(event.senderFrame?.url ?? '')) {
      log(`[lockdown] deny auth-sign-in-sender ${event.senderFrame?.url ?? ''}`)
      return false
    }
    signIn()
    return true
  })

  ipcMain.handle('mitsumeru:auth-sign-out', (event) => {
    if (!isTrustedSender(event.senderFrame?.url ?? '')) {
      log(`[lockdown] deny auth-sign-out-sender ${event.senderFrame?.url ?? ''}`)
      return false
    }
    signOut()
    return true
  })

  ipcMain.handle('mitsumeru:auth-user', () => session?.user ?? null)

  ipcMain.handle('mitsumeru:auth-token', (event) => {
    const senderUrl = event.senderFrame?.url ?? ''
    if (!isTrustedSender(senderUrl)) {
      log(`[lockdown] deny auth-token-sender ${senderUrl}`)
      return null
    }
    return session?.token ?? null
  })

  const stop = (): void => {
    stopped = true
    for (const channel of ['mitsumeru:auth-sign-in', 'mitsumeru:auth-sign-out', 'mitsumeru:auth-user', 'mitsumeru:auth-token']) {
      ipcMain.removeHandler(channel)
    }
  }

  return { session: () => session, signIn, signOut, handleDeepLink, stop }
}
