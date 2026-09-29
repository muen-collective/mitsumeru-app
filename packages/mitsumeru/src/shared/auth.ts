/**
 * Muen identity (Epic 92) — the shape the shell, the preload bridge and the
 * injected avatar overlay all agree on. Produced by the auth server, carried
 * by the JWT's claims, stored encrypted on disk.
 */
export interface MuenUser {
  /** Stable server-side id. */
  id: string
  email: string
  name: string
  /** Avatar URL (GitHub profile picture for the v1 sign-in). */
  avatarUrl: string
  /** 'pro' shows the PRO badge and unlocks private plugins (Epic 92 §3). */
  membership: 'free' | 'pro'
}

/**
 * The signed-in session: the user plus the bearer token the server accepts.
 * The token never leaves the main process except through the explicit
 * `mitsumeru:auth-token` IPC — the overlay only ever sees the user.
 */
export interface AuthSession {
  user: MuenUser
  /** JWT from POST /auth/exchange. */
  token: string
}
