# @muen/dsh-white-label

A **filesystem-based white-label brand plugin** for DeepSeek Harness. Reads brand files (`icon.svg`, `logo.png`/`logo.svg`) from `<DSH_HOME>/brand/` and exposes them through a cordis service — no shell bridge, no `mitsumeru:*` preload needed.

## How it works

The host half reads and validates brand files from the profile's brand folder. The browser half consumes the service to render brand marks in the sidebar and hero.

### Validation rules (epic 88 R3)

| Rule | Description |
|---|---|
| R1 | Extension: `.png` or `.svg` only |
| R2 | PNG magic: first 8 bytes must be `89 50 4e 47 0d 0a 1a 0a` |
| R3 | SVG safety: no `<script>`, no `on*` attributes, no `<style>` block |
| R4 | Size: ≤ 2 MB per file |
| R5 | Something themes: at least one `fill`, `stroke`, `stop-color`, or `color` |
| R6 | Expected filename in every refusal message |

### Brand folder

Place files in `<DSH_HOME>/brand/`:

- `icon.svg` — sidebar icon (rendered as inline SVG to preserve `currentColor`)
- `logo.png` or `logo.svg` — brand logo

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
