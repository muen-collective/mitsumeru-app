import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import { APP_NAME } from '../shared/identity'
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

// The shell's own surface for the page it hosts: which build this is, and the
// update state. Read from the main process instead of baked in at build time,
// so a running app can never claim a version the artifact does not carry (T11)
// and the `-dev` label survives a rebuild.
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
  // button, the app menu's "Restart to Update…", and the update banner's
  // "Restart Now" — three surfaces, one action.
  restartToUpdate: () => ipcRenderer.invoke('mitsumeru:update-restart')
})
