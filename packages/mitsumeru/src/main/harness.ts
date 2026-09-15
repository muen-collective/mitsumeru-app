import { spawn, type ChildProcess } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { HARNESS_PACKAGE } from '../shared/identity'

/**
 * The profile this app boots. Ours, not dsh's stock `web`: `web` composes no
 * plugin of ours, so the app would ship with every appearance surface silently
 * absent. A literal rather than a setting — which profile the app boots is a
 * property of this build, and a user-writable value here would be a way to make
 * the app boot something that is not the app.
 */
const PROFILE = 'mitsu'

/**
 * Plugins this app ships and composes into its profile. One literal list, so the
 * profile manifest and the bundle a build actually contains cannot drift apart.
 */
const SHIPPED_PLUGINS = ['@muen/dsh-brand-mitsumeru', '@muen/dsh-eva-theme', '@muen/dsh-white-label']

/**
 * Packages this app used to compose and no longer does. Removing one from
 * SHIPPED_PLUGINS is not enough to retract it, and assuming otherwise was wrong:
 * the reconciler keeps any bundle that is not shipped and not base, because that
 * is how a user's own plugin is preserved. A dropped package therefore looks
 * exactly like a user-added one and survives forever.
 *
 * Listed here so it is actively removed from a profile that has it.
 *
 * `@muen/dsh-mitsumeru-appearance` dropped 2026-09-12 on request, while its design
 * is reconsidered: it wrote the `--dsw-*` brand roles, and a theme plugin now
 * wants those same tokens, so shipping both means two layers competing per-token
 * with mount order deciding the winner. Its source stays in `plugins/`; it is
 * simply not vendered into a build.
 */
const RETIRED_PLUGINS = ['@muen/dsh-mitsumeru-appearance']

/**
 * Ensure our profile exists before booting it, because dsh does NOT create a
 * missing custom profile on request — measured: `dsh --profile mitsu` on a clean
 * DSH_HOME dies with `profile "mitsu" does not exist; create it with 'dsh plugin
 * --profile mitsu add <package>'`. That is a boot failure, not a missing plugin,
 * so it would take out the whole app on a fresh install.
 *
 * Package installs are NOT needed here: `resolveBundleDir` resolves each bundle
 * from the installation anchor FIRST and only then from the profile directory, so
 * harnes-internal names (`@deepseek-ai/dsh-base`, `dsh-web-app`) resolve from the
 * shipped install. That leaves a hand-written manifest for the plugins that ship
 * inside this app — but the ES module import does NOT resolve from the
 * installation. Measured: with the plugin only present in the harness tree, the
 * boot died with `Cannot find package '@muen/dsh-mitsumeru-appearance' imported
 * from <profileDir>`, because the loader imports each entry from the PROFILE
 * anchor. `dsh plugin add` solves this by symlinking into the profile's
 * node_modules, which is what the links below reproduce.
 *
 * The user's part of a profile is never overwritten: their other bundles, any
 * plugin they added, and every other key in the manifest are preserved. What IS
 * recomputed on each launch is the shipped plugin set — see the manifest comment
 * below for why leaving an existing file untouched turned out to be a bug rather
 * than a kindness.
 */
function ensureProfile(stateDir: string, pluginNames: string[], harnessRoot: string): string {
  const profileDir = join(stateDir, 'profiles', PROFILE)
  mkdirSync(profileDir, { recursive: true })

  // Every shipped plugin has to be linked AND composed, and the manifest's
  // `bundles` list is what composes it. A plugin present in the harness tree but
  // absent from that list is simply not mounted — which is the exact failure this
  // app shipped with: the sidebar brand seat kept its upstream occupant because
  // our brand bundle was never in the list. So the shipped set is recomputed from
  // SHIPPED_PLUGINS on every launch rather than written once on first run.
  //
  // This reverses the earlier "write it only when missing" rule, and the reason
  // is measured: 0.1.4-dev could not be fixed in place. The profile already
  // existed on every machine that had run the app, so a newly shipped plugin
  // could never reach an installed app, and the only way to get one in was to
  // delete the profile and lose the user's sessions with it.
  //
  // What the user owns survives: their own bundles keep their order and come
  // after ours, their added plugins are not dropped, and every other key in the
  // file is carried through untouched.
  const manifestPath = join(profileDir, 'package.json')
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>)
    : ({ name: `dsh-profile-${PROFILE}`, private: true, dependencies: {}, dsh: {} } as Record<string, unknown>)

  manifest.name ??= `dsh-profile-${PROFILE}`
  const dsh = (manifest.dsh ??= {}) as Record<string, unknown>
  const profile = (dsh.profile ??= {}) as Record<string, unknown>
  const base = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  const existing = Array.isArray(profile.bundles) ? (profile.bundles as string[]) : []
  profile.bundles = [
    ...base,
    ...pluginNames,
    ...existing.filter(
      (name) =>
        !base.includes(name) &&
        !pluginNames.includes(name) &&
        // A package we used to ship is removed here, not merely "not added":
        // without this it is indistinguishable from one the user added
        // themselves and would be kept forever. See RETIRED_PLUGINS.
        !RETIRED_PLUGINS.includes(name)
    )
  ]
  profile.patchReload ??= 'live'
  writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')

  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) {
    writeFileSync(patchPath, '# Your patch layer for this dsh profile, applied after every bundle layer.\n[]\n')
  }

  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) {
    writeFileSync(workspacePath, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  }

  // Link each shipped plugin into the profile's node_modules, from the harness
  // tree that shipped inside this app.
  //
  // The target is the harness ROOT's node_modules — where prepare-harness.sh
  // vendored the package — NOT the directory the dsh package happens to live in.
  // Measured 2026-09-11, and it cost a release: the spawn cwd
  // (`<Res>/harness/node_modules/@deepseek-ai/dsh`) was passed here, so every
  // lookup went to `<…>/@deepseek-ai/dsh/node_modules/@muen/…`, which does not
  // exist. Every link was skipped by the `continue` below, and dsh then died at
  // boot with `cannot resolve profile bundle "@muen/dsh-mitsumeru-appearance"` —
  // the bundle list named a package that was in the tree but linked nowhere.
  for (const name of pluginNames) {
    const target = join(harnessRoot, 'node_modules', name)
    if (!existsSync(target)) {
      // Reported, not silently skipped. The skip that used to live here is what
      // let a non-booting build reach a download: dsh fails the boot on its own,
      // but nothing said which package or where it had looked. The caller logs
      // this, and smoke / verify:surfaces turn it into a failure.
      console.log(`[harness] plugin-missing ${name} (looked in ${target})`)
      continue
    }
    const linkPath = join(profileDir, 'node_modules', name)
    try {
      const current = existsSync(linkPath) ? realpathSync(linkPath) : undefined
      if (current === realpathSync(target)) continue
      mkdirSync(dirname(linkPath), { recursive: true })
      rmSync(linkPath, { recursive: true, force: true })
      symlinkSync(target, linkPath, 'dir')
      console.log(`[harness] plugin-linked ${name}`)
    } catch (error) {
      // Loud, and named. A link that cannot be made is a package the boot will
      // not find, so it is the same class of failure as the missing target above
      // and must not read as a quiet success.
      console.log(`[harness] plugin-link-failed ${name}: ${String(error)}`)
    }
  }

  return profileDir
}

export interface HarnessConfig {
  /** Absolute path to the DSH CLI entry (apps/cli/lib/bin.js at the pinned ref). */
  entry: string
  /** The harness tree root: where this app's own plugin packages are vendored. */
  harnessRoot: string
  /** Working directory for the child (the dsh package root). */
  cwd: string
  /** Isolated DSH_HOME — all harness user data lands here, never ~/.dsh. */
  stateDir: string
  /** Absolute path for the harness log file (stdout+stderr tee). */
  logPath: string
  /** Milliseconds to wait for the readiness line before failing. */
  readyTimeoutMs?: number
  /** Optional callback for lifecycle events (logged by the shell). */
  onEvent?: (event: string) => void
}

export interface HarnessSession {
  child: ChildProcess
  /** Resolves with the tokenized readiness URL, rejects on timeout/exit. */
  readyUrl: Promise<string>
  /** Send SIGTERM, then SIGKILL after the grace period if still alive. */
  stop: (reason?: string) => void
}

/** Resolve the node binary Electron should spawn the harness with. */
export function resolveNodePath(): string {
  // npm sets npm_node_execpath when launched via npm scripts — best dev default.
  const fromNpm = process.env.npm_node_execpath
  if (fromNpm !== undefined && fromNpm !== '') return fromNpm
  const fromPath = (process.env.PATH ?? '')
    .split(':')
    .map((dir) => join(dir, 'node'))
    .find(existsSync)
  if (fromPath !== undefined) return fromPath
  // Packaged, launched from Finder: PATH is minimal and node is not on it.
  // Electron's own binary runs as plain node with ELECTRON_RUN_AS_NODE=1, so
  // the app carries no second runtime to ship or keep updated.
  return process.execPath
}

/** True when the harness child will run via Electron-as-node (see resolveNodePath). */
export function runsViaElectronNode(nodePath: string): boolean {
  return nodePath === process.execPath
}

// No reservePort(): we pass --port 0 and let the OS pick — the readiness URL
// on stdout carries the actual port, so there is no reserve/use race at all.

/**
 * The harness readiness signal is a stdout line, NOT an HTTP response:
 * GET / (no token) is 401 by design (browser-trust fence). Each boot prints a
 * fresh per-session token. See artifacts/entry.json (T0 contract).
 */
const READY_LINE = /dsh web: (https?:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/

/** Env for the child: isolate state, strip launcher pollution. */
function childEnv(stateDir: string, viaElectron: boolean): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value === undefined ||
      name === 'NODE_OPTIONS' ||
      name.startsWith('DSH_DESKTOP_') ||
      /^(?:npm|pnpm|corepack)_/u.test(name)
    ) {
      continue
    }
    clean[name] = value
  }
  clean.DSH_HOME = stateDir
  if (viaElectron) clean.ELECTRON_RUN_AS_NODE = '1'
  return clean
}

export function spawnHarness(config: HarnessConfig): HarnessSession {
  const { entry, harnessRoot, cwd, stateDir, logPath, readyTimeoutMs = 45_000, onEvent } = config

  mkdirSync(dirname(logPath), { recursive: true })
  mkdirSync(stateDir, { recursive: true })

  let resolveReady: (url: string) => void = () => {}
  let rejectReady: (error: Error) => void = () => {}
  const readyUrl = new Promise<string>((res, rej) => {
    resolveReady = res
    rejectReady = rej
  })

  let settled = false
  let stdoutBuf = ''
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true
      onEvent?.('ready-timeout')
      rejectReady(new Error(`harness not ready within ${readyTimeoutMs}ms (no 'dsh web:' line on stdout)`))
    }
  }, readyTimeoutMs)

  const nodePath = resolveNodePath()
  // `--expose-internals` is required, and only under Electron-as-node. The
  // profile runs `patchReload: live`, so dsh loads cordis-plugin-hmr for the
  // live patch layer, and HMR refuses to construct without the flag
  // (`--expose-internals is required for HMR service`). Measured 2026-09-11,
  // all four combinations: node boots with or without the flag, electron-as-node
  // **dies** without it and survives with it. The flag is inert where it is not
  // needed, so it is passed on both paths — the boot contract must not depend on
  // which node the shell happened to resolve.
  //
  // This is why 0.1.3-dev booted on a dev machine and died on a real install:
  // `pnpm smoke` launches the app as a child of the shell, so PATH has node and
  // resolveNodePath picks it; launched from Finder PATH is minimal, resolveNodePath
  // falls back to Electron-as-node, and the harness crashed before the UI came up.
  // The smoke run does not reproduce the Finder one — `pnpm smoke:finder` does.
  //
  // Create the profile before asking dsh to boot it — dsh does not initialize a
  // missing custom profile on request, it exits instead. See ensureProfile.
  const profileDir = ensureProfile(stateDir, SHIPPED_PLUGINS, harnessRoot)
  onEvent?.(`profile ready ${profileDir}`)
  const child = spawn(
    nodePath,
    [
      ...(runsViaElectronNode(nodePath) ? ['--expose-internals'] : []),
      entry,
      '--profile',
      PROFILE,
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      '0'
    ],
    {
      cwd,
      env: childEnv(stateDir, runsViaElectronNode(nodePath)),
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  onEvent?.(`spawned pid=${String(child.pid)} profile=${PROFILE}`)

  const logStream = createWriteStream(logPath, { flags: 'a' })
  const tee = (chunk: Buffer): void => {
    logStream.write(chunk)
    process.stdout.write(chunk)
    stdoutBuf += chunk.toString()
    const match = READY_LINE.exec(stdoutBuf)
    if (match !== null && !settled) {
      settled = true
      clearTimeout(timer)
      resolveReady(match[1])
    }
  }

  child.stdout?.on('data', tee)
  child.stderr?.on('data', tee)
  child.once('error', (error) => {
    onEvent?.(`spawn-error ${error.message}`)
    if (!settled) {
      settled = true
      clearTimeout(timer)
      rejectReady(error)
    }
  })
  child.once('exit', (code, signal) => {
    onEvent?.(`exited code=${String(code)} signal=${String(signal)}`)
    logStream.end()
    if (!settled) {
      settled = true
      clearTimeout(timer)
      rejectReady(new Error(`harness exited before ready (code=${String(code)} signal=${String(signal)})`))
    }
  })

  let stopped = false
  const stop = (reason = 'shutdown'): void => {
    if (stopped) return
    stopped = true
    if (child.exitCode !== null || child.signalCode !== null) {
      onEvent?.(`stop-skipped ${reason} (already exited)`)
      return
    }
    onEvent?.(`stop ${reason} sigterm pid=${String(child.pid)}`)
    child.kill('SIGTERM')
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        onEvent?.(`stop ${reason} sigkill pid=${String(child.pid)}`)
        child.kill('SIGKILL')
      }
    }, 4000)
    child.once('exit', () => clearTimeout(killTimer))
  }

  return { child, readyUrl, stop }
}

/**
 * Where the harness lives: inside our own install, as the published npm
 * closure — `node_modules/@deepseek-ai/dsh/lib/bin.js`. Epic 86 § Harness
 * artifact: no git checkout, no DSH workspace, no build step.
 *
 * `MITSUMERU_DSH_ENTRY` overrides the entry to wrap a different release (or a
 * built checkout) without touching code — the drill seam.
 */
export function harnessPaths(options: { stateDir: string; logDir: string; resourcesPath?: string }): {
  entry: string
  /** The harness tree root — the anchor this app's plugins are vendored under. */
  harnessRoot: string
  cwd: string
  stateDir: string
  logPath: string
} {
  // Where the ENTRY lives and where OUR PLUGINS live are two different anchors,
  // and conflating them is what made 0.1.5-dev unbootable. Measured 2026-09-11:
  //
  //            entry lives in                        plugins live in
  //   dev      <pkg>/node_modules/@deepseek-ai/dsh    <pkg>/build/harness/node_modules
  //   shipped  <Res>/harness/node_modules/@deepseek-ai/dsh   <Res>/harness/node_modules
  //
  // In a packaged app the two coincide (the tree IS the entry's parent), which is
  // why the earlier code — deriving the plugin anchor from the entry via
  // `resolve(entry, '..', '..')` — looked right and was wrong twice over: it
  // pointed one level too deep (`…/@deepseek-ai/dsh/node_modules/@muen`), and in
  // dev it did not name the staged tree at all. Both are stated separately now.
  const harnessRoot =
    options.resourcesPath === undefined
      ? resolve(__dirname, '..', '..', 'build', 'harness')
      : resolve(options.resourcesPath, 'harness')
  // The entry still resolves from `require` in dev, so `electron-vite dev` and
  // the smokes keep wrapping the workspace's own closure rather than whatever
  // happens to be staged. MITSUMERU_DSH_ENTRY is the documented override.
  const installed =
    options.resourcesPath === undefined
      ? resolve(__dirname, '..', '..', 'node_modules', HARNESS_PACKAGE, 'lib', 'bin.js')
      : resolve(harnessRoot, 'node_modules', HARNESS_PACKAGE, 'lib', 'bin.js')
  const entry = process.env.MITSUMERU_DSH_ENTRY ?? installed
  return {
    entry,
    harnessRoot,
    cwd: resolve(entry, '..', '..'), // the @deepseek-ai/dsh package root
    stateDir: options.stateDir,
    logPath: join(options.logDir, `harness-${String(Date.now())}.log`)
  }
}
