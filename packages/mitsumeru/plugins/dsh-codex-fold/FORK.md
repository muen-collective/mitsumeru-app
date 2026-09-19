# FORK.md — @muen/dsh-codex-fold

## Upstream

| | |
|---|---|
| Package | `dsh-auto-collapse` **0.2.1** |
| Source | https://github.com/a179-sanae/dsh-auto-collapse |
| License | MIT — "Copyright (c) 2026 dsh-auto-collapse contributors" (`LICENSE` kept verbatim) |
| Fetched from | the installed profile: `…/profiles/mitsu/node_modules/dsh-auto-collapse` |

## Why a fork rather than a fresh plugin

The behaviour was already right — it is Codex-style agent-loop folding: keep the native turn row
(level 1), merge the thinking/tool/context rows *between prose* into one summary chip per run
(level 2), and expanding a chip shows the native rows again (level 3). Reimplementing that grouping
means reimplementing a DOM pass over the chat flow, with nothing to gain.

The defect was language. The shipped bundle contains **34 hardcoded Chinese strings** stored as
`\uXXXX` escapes (which is why a plain grep for Chinese text misses them) and **no locale lookup
anywhere**: no `locale`, `getLocale`, `i18n`, `navigator.language`, or `documentElement.lang`.

So this fork changes the copy and nothing else.

## What changed

1. **All 33 string sites → `tr("key")`**, backed by a 34-key dictionary registered for `en` and `zh`
   through `ctx.locale.register`, with `tr` rebound in `apply` via `ctx.locale.bind("muen-codex-fold")`.
   A built-in English table is the fallback if the locale service is unavailable, so the bundle can
   never render a raw key.
2. **`inject` gains `locale`** (`var inject = []` → `var inject = ["locale"]`), and
   `dsh.client.inject` in `package.json` adds `@deepseek-ai/dsh-client-locale`.
3. **Identity renamed**, in two distinct strings that are not interchangeable:
   the module id is the package name `@muen/dsh-codex-fold` (the client loader dispatches on it),
   while the settings namespace and plugin-card key are `muen-codex-fold`, because the settings
   service rejects a namespace that is not a lowercase hyphenated identifier.
4. Two template literals were restructured rather than swapped, because their Chinese was
   interpolated: the row `aria-label` and the settings-card `aria-label`.
5. **The Host half is now empty** — see below.
6. **Two runtime defects fixed on top of upstream** — see "Runtime defects we carry fixes for".

Untouched: the fold controller, storage semantics, and every behaviour.

## Runtime defects we carry fixes for

Both were found in the running app, not by reading code, and both are the kind that
only appear once the plugin is actually folding:

**1. The row icons could paint at the SVG default size — 300x150 px.** Upstream builds its
group icon and group chevron with `createElementNS` and sets only `viewBox`:

```js
const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
svg.setAttribute("viewBox", "0 0 16 16");        // no width, no height
```

Every dimension came from the injected stylesheet (`.dshcf-group-icon svg { width: 14px }`,
`.dshcf-group-chevron { width: 12px }`). A replaced element with a `viewBox` and no
intrinsic size falls back to 300x150 px, so with that stylesheet absent at paint time the
16x16 "three bars and three dots" icon renders as three large black bars with dots beside
them, and the chevron as a giant V — which is exactly what a reader saw mid-turn.

`localize.py` now writes the size on both elements, as attributes *and* inline styles, so
neither a missing stylesheet nor a host rule can inflate them.

**2. The disposer removed the stylesheet while styled rows were still mounted.**

```js
this.style.remove();   // on dispose — upstream
```

The rows the fork inserts outlive a controller restart (HMR, a fold toggle, a session
change), and they carry no other sizing. The removal is gone: the rules are static and
scoped to `.dshcf-*` classes, so one style element for the life of the page is the cheaper
end of the trade.

Neither fix changes behaviour; both are asserted by the generator, which aborts if the
anchors move.

**3. The chip rows fell back to the platform's button chrome.** Every visual property of a
group row — layout, colour, the absence of a border, left alignment, the chevron's rotation —
came from the injected stylesheet, on a `<button>`:

```
[ grey fill ][ 1px border ][ centred label ][ ☰ Thought ⌄ ]   ← with no stylesheet applied
```

That is what a reader saw: full-width boxed rows instead of quiet inline chips. The cause is
the same stylesheet dependency as (1) — the fix is the same medicine: the row's styling is now
written **inline** on the button, icon, label, detail and chevron, so it is correct whether or
not the CSS lands. Inline styles beat every non-`!important` rule, and need no stylesheet at
all. The chevron's open/closed rotation is driven from the update path that already maintains
`aria-expanded`, because the CSS selector that used to do it (`[aria-expanded="true"]
.dshcf-group-chevron`) has the same dependency.

The injected stylesheet still ships, and still carries what inline styles cannot: `:hover`,
`:focus-visible`, the running-status pulse, and the folded-row spacing rule.

## The failure that made the fork inert, and the fix

First install looked successful (`application: applied`, `enabled: true`) and did nothing at all. The
cause was upstream's Host half:

```js
import z from "@deepseek-ai/schemastery";   // ← unresolvable
ctx.inject(["settings"], (s) => s.settings.register(name, z.object({...}), {...}));
```

Node resolves a bare specifier by walking up from the package's **real** path. This bundle is
installed as a workspace link (`link:/Volumes/External SSD/mitsu/plugins/dsh-codex-fold`), so the
walk goes up the *workspace* tree — which contains no `@deepseek-ai/*` at all. The profile's
`node_modules` does not carry them either. The import threw, the plugin row failed to construct, and
because no row existed, no Client half was served: the plugin was inert rather than broken-looking.
This is the same wall already recorded for `@muen/dsh-white-label` in the release-loop skill.

**How it was caught** — and this is the check to repeat for any new bundle:

```bash
# the row must exist and be active; a missing row means the Host half failed to load
plugin_manager{ action: list_plugins }   # look for include:muen-codex-fold, fiberPhase: active
```

Before the fix the row was absent from the list entirely; after it, the row count went 174 → 175 and
the row reads `enabled: true, fiberPhase: active`.

**The fix** is to need nothing from the Host. `lib/index.js` is now an empty `apply`, and
`peerDependencies` on schemastery is gone. The Client half was already tolerant by construction:
`statusTextProvider(undefined)` falls back to the built-in `Deep sleeping...`, and the settings-card
setup returns early when the `settingsScope` service is absent — the fold observer is a separate
effect, so folding is unaffected.

Cost: the **Status text** setting is gone (the live row now always says `Deep sleeping...`). Restoring
it means vendoring schemastery into this package or installing the bundle as a tarball instead of a
link — not importing a peer the profile cannot resolve.

## Updating to a new upstream release

`lib/client.js` here is **generated, not hand-edited**:

```bash
npm pack dsh-auto-collapse@<new-version> && tar xzf dsh-auto-collapse-*.tgz
python3 localize.py package/lib/client.js lib/client.js
node --check lib/client.js
# lib/index.js stays empty on purpose — see "The failure that made the fork inert".
# Do NOT re-copy upstream's Host half: its schemastery import is what broke the mount.
```

`localize.py` asserts the exact shape it expects (counts per site, the two injection anchors) and
**aborts instead of half-applying**. A layout change upstream therefore shows up as a loud failure
rather than as a bundle that is half English and half Chinese.

Reproducibility is checked in this repo: running the script against upstream 0.2.1 produces
`lib/client.js` byte-for-byte.

## If the grouping stops working

The plugin reads the chat flow through `data-chat-flow`, `data-chat-flow-kind`, `data-tool`,
`data-state`, `data-subcalls` and friends, and upstream's own compatibility table lists only DSH
`0.1.2-rc.1` and `0.1.5-rc.2` as verified (this deployment runs `0.1.6-alpha.2`). Unknown DOM nodes
are left in their native display, so a layout change degrades to "no folding" rather than to a
broken transcript — the safe failure direction. If folding disappears after a harness upgrade,
re-check those attributes against the shipped `dsh-client-ui-chat` before touching anything else.
