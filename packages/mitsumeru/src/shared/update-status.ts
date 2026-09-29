/**
 * The updater's state, as every consumer sees it — the main process produces
 * it, the preload forwards it, the injected update banner renders it.
 *
 * Moved out of `src/main/updater.ts` for Epic 91: the banner lives in the
 * page's main world, so its code is stringified from here at build time, and
 * one definition keeps producer and consumer from drifting on field names.
 */
export interface UpdateStatus {
  state:
    | 'disabled'
    | 'idle'
    | 'checking'
    | 'current'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'error'
  /**
   * Which check produced this state — 'manual' / 'menu' (a person asked) or
   * 'timer' / 'resume' (background). The banner only surfaces manual checks:
   * a cadence check finding the app current must not flash a strip at someone
   * who did not ask, and a background check failing while offline must not
   * either. Download progress and a downloaded update are shown regardless —
   * those happened because of the person's earlier manual trigger or because
   * an update is genuinely ready.
   */
  trigger?: string
  /** Version the updater is talking about (available/downloaded), if any. */
  version?: string
  percent?: number
  message?: string
  /** Where the downloaded version was archived, when it was. */
  archived?: string
  /** Epoch ms of the last state change. */
  at: number
}
