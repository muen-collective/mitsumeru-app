# @muen/dsh-white-label

A **filesystem-based white-label brand plugin** for DeepSeek Harness. Reads brand files (an `icon.*` mark and a `logo.*` lockup) from `<DSH_HOME>/brand/` and exposes them through a cordis service — no shell bridge, no `mitsumeru:*` preload needed. It also owns the Settings → Brand page and the durable `white-label-brand` settings namespace behind it: the two seat marks, the hero tagline, the accent colour, and the run-status label.

## How it works

The host half reads and validates brand files from the profile's brand folder, and owns the durable settings namespace (the uploaded logos, the two seat marks with their switches, the hero tagline, and the run-status label). The browser half consumes both to render brand marks in the sidebar and hero — two separate seats, each configured on its own — to render the hero tagline, and to replace the conversation's run-status line.

## Settings → Brand

The **sidebar** (a 24 px rail mark) and the **hero** (a 34 px mark beside the blank-session headline) are different surfaces, so they are configured independently:

| Setting | What it does |
|---|---|
| Sidebar logo — light / dark | the wordmark lockup in the sidebar name strip (height-capped at 24 px) |
| Show icon in sidebar + Sidebar icon | the rail mark and its own visibility switch (24 px) |
| Show icon in hero + Hero icon | the hero-seat mark and its own visibility switch (34 px) |
| Accent — light / dark | the brand accent colour for each mode |
| Hero tagline | the copy on a blank session, above the composer (see below) |
| Status label | the line the conversation shows while a turn runs (see below) |

Each seat falls back to the brand folder's `icon.*` when no upload is set, so a filesystem-only brand keeps working with no settings at all. Before the split, one uploaded icon fed both seats under a single switch; that legacy mark is still read, and the first save on the Brand page materializes both seats and clears it.

### Validation rules (epic 88 R3)

| Rule | Description |
|---|---|
| R1 | Extension: `.svg`, `.png` or `.webp` only |
| R2 | Raster magic: PNG begins `89 50 4e 47 0d 0a 1a 0a`; WebP is a RIFF container (`RIFF`…`WEBP`) |
| R3 | SVG safety: no `<script>`, no `on*` attributes, no `<style>` block |
| R4 | Size: ≤ 2 MB per file |
| R5 | An SVG must theme: at least one `fill`, `stroke`, `stop-color`, or `color` |
| R6 | Expected filename in every refusal message |

### Brand folder

Place files in `<DSH_HOME>/brand/`. The **filename decides the seat** — a basename carrying `icon` as a whole word (`icon.png`, `icon-dark.webp`, `mitsu-icon.png`) takes the icon seat; everything else is a logo:

- `icon.svg` / `icon.png` / `icon.webp` — the mark: sidebar rail (24 px) and the hero seat (34 px, immediately left of the blank-session headline), unless the per-seat upload in Settings → Brand overrides either one
- `logo.png` / `logo.svg` / `logo.webp` — the brand lockup in the sidebar name strip (height-capped at 24 px)

Within one seat an **SVG wins over a raster** (it is rendered inline, so it can follow the theme through `currentColor`, which is why an SVG must satisfy R5), and **PNG wins over WebP** — never readdir order.

A raster icon renders as an image: it is drawn exactly as exported and does **not** invert with the theme, so a dark-on-transparent mark disappears in dark mode. Ship an `icon.svg` plus a raster, or a vector only, when the mark must work in both themes.

If the folder doesn't exist, the plugin is a no-op.

## Hero tagline

One text field — **Settings → Brand → Hero tagline** — replaces the blank-session headline ("Into the Unknown" / 探索未至之境) above the composer. It is persisted as `brandTagline` in the durable `white-label-brand` settings namespace (mirrored to `localStorage` for first paint), capped at 200 characters, and **empty keeps the shipped headline**: the occupant re-renders the copy the harness hands it as `fallbackText`, so the words never disappear while a brand is being edited.

The headline has no slot of its own, and a plugin cannot declare one — slot names live in the compiled render tree, and a parent factory must declare a child before any renderer may call it. So the seat comes from a narrow, additive patch to the vendored client bundle, `patches/patch-hero-brand-tagline.mjs`, which the app build applies to the staged harness **before** electron-builder signs the app (`prepare-harness.sh`), keeping the edit inside the code signature. Mitsumeru 0.2.0 and later ship it. On a stock DSH install the seat does not exist, the occupant is inert, and a save says so rather than looking broken.

The seam is two edits, not one: the `renderSlot("conversation.hero.tagline", …)` call in `HeroShell` **and** the seat's declaration in the `conversation.content` factory's `children` table. A call without the declaration throws `SlotOwnershipError` during render and unmounts the whole blank-session view — hero and composer. `scripts/verify-hero-tagline.mjs` fails on that shape, and `prepare-harness.sh` runs it as a build gate.

## Run-status label

One text field — **Settings → Brand → Status label** — replaces the line the conversation shows while a turn runs. DSH ships that line as `chat.deepDiving`: **"Deep diving..."** in English, **"深度求索中..."** in Chinese. The label is persisted as `statusLabel` in the same durable `white-label-brand` namespace, capped at 40 characters, and **empty keeps the shipped copy**.

Unlike the tagline, this one has no seam to use and none to add. The copy is a dictionary entry inside `@deepseek-ai/dsh-client-ui-chat`, and the Client locale service keeps one dictionary per `(namespace, locale)` pair: a second `locale.register("chat", "en", …)` throws `locale namespace "chat" already has locale "en"`, and registering *first* is worse — it makes ui-chat's own registration throw and takes the chat view down with it. So the plugin rewrites the one text node the status row renders, under a deliberately narrow matcher: an element carrying **both** `role="status"` and `aria-live="polite"` whose first child still holds the shipped copy. Another plugin's status row, a row holding text we did not write, and a brand with no label set are left exactly as they render — and while no label is set, no observer runs at all.

This is the same route the community plugin `alingalingling/ui-status-label` takes, and it retires the moment DSH exposes a status extension point of its own. `tests/white-label-status-label.test.mjs` pins the three behaviours that matter: the shipped copy is replaced in both languages, a foreign row is untouched, and clearing the label restores the shipped copy and stands the observer down.

## Install

```bash
dsh plugin add <github-release-tarball-url>
```

Or locally:

```bash
dsh plugin --profile mitsu add ./plugins/dsh-white-label
```

## Contrast with `@muen/dsh-brand-swap`

| | `dsh-white-label` | `dsh-brand-swap` |
|---|---|---|
| Shipped in | the Mitsumeru app (bundled) | the public market |
| Brand source | `<DSH_HOME>/brand/` **and** uploads in Settings → Brand | uploads in Settings → Brand |
| Storage | `white-label-brand` settings namespace + the filesystem | its own cordis settings doc |
| Hero tagline | yes | yes |
| Status label | yes | no |
| Accent picker | Yes (per-mode light/dark) | No |
| Use case | the brand a Mitsumeru deployment ships | per-profile identity on a stock harness |

Both register into the same DSH brand slots. **Do not co-install.**
