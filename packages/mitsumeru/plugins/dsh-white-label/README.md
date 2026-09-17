# @muen/dsh-white-label

A **filesystem-based white-label brand plugin** for DeepSeek Harness. Reads brand files (an `icon.*` mark and a `logo.*` lockup) from `<DSH_HOME>/brand/` and exposes them through a cordis service — no shell bridge, no `mitsumeru:*` preload needed.

## How it works

The host half reads and validates brand files from the profile's brand folder. The browser half consumes the service to render brand marks in the sidebar and hero — two separate seats, each configured on its own.

## The two mark seats

The **sidebar** (a 24 px rail mark) and the **hero** (a 34 px mark beside the blank-session headline) are different surfaces, so Settings → Brand configures them independently:

| Setting | What it does |
|---|---|
| Sidebar logo — light / dark | the wordmark lockup in the sidebar name strip (height-capped at 24 px) |
| Show icon in sidebar + Sidebar icon | the rail mark and its own visibility switch (24 px) |
| Show icon in hero + Hero icon | the hero-seat mark and its own visibility switch (34 px) |

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
| Storage | Filesystem (`<DSH_HOME>/brand/`) | Cordis settings doc |
| Logo source | Pre-placed files | Upload via Settings → Brand |
| Accent picker | Yes (per-mode light/dark) | No |
| Use case | Static brand deployment | Interactive brand configuration |

Both register into the same DSH brand slots. **Do not co-install.**
