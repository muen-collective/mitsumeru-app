/**
 * App identity — the one place the name lives.
 *
 * Epic 86 § Naming: the shell is codenamed `mitsumeru` until the wrap proof is
 * accepted, then renamed to `mitsumeru`. The rename must stay a one-file
 * change, so nothing else in the shell hardcodes the name — package name,
 * appId, productName and the update feed all read from here (+ package.json).
 */

export const APP_NAME = 'mitsumeru'
export const PRODUCT_NAME = 'Mitsumeru'
export const APP_ID = 'com.muen.mitsumeru'

/**
 * Where releases live (Epic 86 T12). Ours, and only ours — the wrap must never
 * inherit a `dshdesktop.com` feed, or a DSH release would overwrite this shell
 * and its signing identity with somebody else's build.
 *
 * GitHub Releases rather than a self-hosted feed (decided 2026-09-10): the shell
 * has no server to run, the org already has the account, and the provider needs
 * no `url` to point at. What that buys costs one naming rule, because the client
 * resolves its channel from the release tag:
 *
 *   - electron-updater reads `releases.atom`, keeps the entries whose tag's
 *     semver prerelease matches the channel this build asks for, and then
 *     downloads `<channel>-mac.yml` from that release's assets.
 *     `v0.1.0-dev` → channel `dev` → `dev-mac.yml`.
 *   - So **the tag carries the channel**. A `-dev` build published under a tag
 *     without the `dev` prerelease is invisible to every dev client, and a
 *     promoted `0.1.0` (channel `latest`) is served from the repository's
 *     latest non-prerelease release.
 *
 * `owner`/`repo` are duplicated in electron-builder.yml (the builder cannot
 * import TypeScript); `scripts/check-identity.sh` keeps the copies equal.
 */
export const UPDATE_OWNER = 'muen-collective'
// Renamed 2026-09-11 from `mitsumeru-shell`. Two names had to move for this to
// fit: the public website repo became `mitsumeru-site`, and the archived
// `mitsumeru-desktop` fork (dataelement/dsh-desktop) stays archived. This repo
// is the desktop app — our own Electron shell, not a fork of anyone's — so it
// now owns the plain product name, and this string is the feed path compiled
// into every build.
//
// GitHub redirects the old path, so builds already in the wild keep updating:
// `mitsumeru-shell/releases/...` still resolves, and their compiled
// app-update.yml keeps asking for that old path until they take an upgrade.
export const UPDATE_REPO = 'mitsumeru'

/** Human-facing page for the feed — logs and About, never client config. */
export const UPDATE_FEED_URL = `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases`

/** The harness package we wrap. Version is pinned in package.json. */
export const HARNESS_PACKAGE = '@deepseek-ai/dsh'

/**
 * Muen sign-in (Epic 92). Where the OAuth server lives and the deep-link
 * scheme it redirects back to. The default origin is the org's existing site —
 * Epic 92 Q2 (dedicated auth host vs mitsumeru.vercel.app) is still open, so a
 * run can point elsewhere with MITSUMERU_AUTH_ORIGIN without rebuilding.
 */
export const AUTH_ORIGIN = 'https://mitsumeru.vercel.app'
export const AUTH_SCHEME = 'mitsumeru'

/**
 * Release labeling (Epic 86 T11). Internal builds, download links, release
 * notes and CTAs all carry `-dev` until a build is promoted to production;
 * the same suffix is what tells the updater to track the dev channel.
 */
export const DEV_SUFFIX = '-dev'

export const isDevVersion = (version: string): boolean => version.endsWith(DEV_SUFFIX)

/**
 * The update channel a version belongs to. This reproduces electron-builder's
 * own rule (`appInfo.channel` = the version's first semver prerelease
 * component), which is what names the release manifest: `0.1.0-dev` is channel
 * `dev` → `dev-mac.yml`; `0.1.0` has no channel and electron-updater resolves
 * that to `latest` → `latest-mac.yml`.
 *
 * It is duplicated from the builder on purpose: the client needs the same
 * answer at runtime, and a mismatch here is not cosmetic — the app would ask
 * the feed for a file the release never uploaded (measured, see updater.ts).
 */
export const releaseChannel = (version: string): string | null => {
  const prerelease = version.split('-')[1]
  if (prerelease === undefined || prerelease === '') return null
  return prerelease.split('.')[0]
}

/**
 * Titles the harness UI may serve, used to tell the real app from the
 * browser-trust fence's fallback page. The published npm tarball ships
 * `DeepSeek Harness`; a frontend built from a checkout says `DSH Local Build`.
 */
export const HARNESS_TITLES = ['DeepSeek Harness', 'DSH Local Build']
