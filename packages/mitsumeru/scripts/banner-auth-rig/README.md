# banner-auth-rig — the Epic 91 + 92 verification rig

Rescued from `/tmp/banner-test` (scratch) after it produced the `artifacts/`
evidence for **0.2.4-dev**. These drive the *packaged* app over CDP; nothing
here is part of the shipped build.

## Prerequisites

- A packaged build: `pnpm package:dir` or `pnpm package:mac:arm64` — the rig
  points at `release/mac-arm64/Mitsumeru.app`.
- Playwright: the scripts `require()` it from
  `/Users/thuypham/.kun/hand-me-up-os/node_modules/playwright` (machine-local;
  edit the require path on another machine).
- `check-pixels.cjs` / `auth-pixels.cjs` run under Electron:
  `./node_modules/.bin/electron check-pixels.cjs <png>` from `packages/mitsumeru`.

## Launch contract (env the app reads)

- `MITSUMERU_UPDATE_FEED=http://127.0.0.1:<port>` — point the updater at a
  stand-in feed instead of GitHub.
- `MITSUMERU_UPDATE_DISABLE=1` — kill the updater entirely (auth/menu runs).
- `MITSUMERU_UPDATE_RESTART=1` — test seam: on `update-downloaded` call the
  restart action directly (no offer dialog), so a run can prove the install
  path without a person clicking.
- `MITSUMERU_DSH_HOME=<dir>` / `MITSUMERU_LOG_DIR=<dir>` — throwaway harness
  state; `--remote-debugging-port=<port>` — CDP.

```sh
S=$(mktemp -d "${TMPDIR:-/tmp}/rig.XXXX"); mkdir -p "$S/dsh" "$S/logs"
MITSUMERU_DSH_HOME="$S/dsh" MITSUMERU_LOG_DIR="$S/logs" \
  ./release/mac-arm64/Mitsumeru.app/Contents/MacOS/Mitsumeru \
  --remote-debugging-port=9480 > "$S/app.log" 2>&1 &
```

## The flows

**Banner (Epic 91).** `feed-server.mjs --port 8917 --version <v> --mode same|404|real`
stands in for the feed (`real` serves a throttled ~25 MB zip with a matching
sha512). Then `shot.mjs <port> <outDir> <current|error|downloaded>` drives the
states; `check-pixels.cjs` asserts the 36 px strip in each frame (expects
full-viewport screenshots at 800 CSS px height — scale `H/800`).

**Auth (Epic 92).** `mock-auth.mjs --port 9110 --membership pro|free` provides
`/api/auth/github`, `/api/auth/exchange`, `/avatar.png`. Launch the app with
`MITSUMERU_AUTH_ORIGIN=http://127.0.0.1:9110`, then:

- `auth-shot.mjs <port> <outDir>` — signed-out → prints `READY_FOR_DEEPLINK`;
  deliver the link from the caller:
  `open -a release/mac-arm64/Mitsumeru.app "mitsumeru://auth/callback?code=mock-code-1"`
  → avatar + PRO → sign-out. Screenshots `auth-signedout/signedin/signedout-after`.
- `auth-verify.mjs <port> <outDir> <yes|no> [shotSuffix] [--no-signout]` —
  secondary checks (badge expectation, restore). `shotSuffix` replaces the PNG
  suffix (`restored` → `auth-restored.png`); `--no-signout` keeps the session.
- `auth-pixels.cjs <png> <avatar|badge|orb>` — pixel assertions on a frame.
- `menu-test.mjs <port> <outDir>` — needs a **signed-in** instance; drives the
  click-menu (row → Language submenu → 中文 live switch → back → sign out).

**Utilities.** `probe.mjs <port>` — one-shot banner state. `capture.mjs <port>
<outDir> <name> [waitText]` — one-shot capture; `waitText` waits for the banner
to contain a string first (used for `downloaded-install-failed`). `locale-probe.mjs`
pins the settings/update payload shape. `win.swift` lists the app's windows via
CGWindowList (works when CDP is blocked; no permissions needed).

## Gotchas (learned the hard way)

- **The offer dialog blocks everything.** When a download completes, the shell
  shows a modal "Restart Now / Later" alert; while it's up the main process is
  blocked and *all* CDP dies (connect and evaluate hang). Capture `downloaded`
  *before* the dialog, or capture the post-failure error state via
  `MITSUMERU_UPDATE_RESTART=1`. Answering "Later" with a real click (a person)
  unblocks and leaves the strip on `downloaded` — accessibility tooling could
  not reach the dialog while the app was modal.
- `screencapture` of a window needs Screen Recording permission —
  without it `screencapture -l` fails ("could not create image from window")
  and osascript sees no windows while the app is modal.
- A SIGKILL of the app leaves an **orphan harness** node process; find it via
  `ps ax | grep dsh/lib/bin.js` (match the release path) and kill it between runs.
- `auth-shot.mjs` / `auth-verify.mjs` were updated for the menu reshape
  (`.mua-row` / `.mua-avatar`; Sign out lives inside the menu).
- The evidence these produce lives in `../../artifacts/` (gitignored:
  `auth-*`, `menu-*`, `current-*`, `error-*`, `downloaded-*`).
