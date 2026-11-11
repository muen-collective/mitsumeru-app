# @muen/dsh-draw

Draw what you cannot say — and the agent reads it.

You sketch the thing that is too fiddly to describe; the agent reads it as
**element summaries** — shapes, labels, bboxes — not as pixels. No vision model, no OCR,
no screenshot round-trip. What you drew is already data.

## Why this exists

A person who can prompt a working demo still hits moments where the thing in their head
takes several attempts to say. In those moments a drawing is the cheaper encoding.

The failure this avoids: a design canvas that is a *second writable truth* beside the code.
The drawing here is a **message**, not a document. It is the only store, it holds no code,
and the agent never renders anything — so there is nothing to drift.

## The two seams

| Half | Seam | What it does |
|---|---|---|
| Host | `webServer` | serves the drawing page at `/plugins/draw/`, plus the JSON store |
| Host | `tools` | `draw_read` and `draw_apply` over that same file |
| Client | `slots` + `sidebarRightTabs` | the right-panel **Draw** tab; frames the host page |

Both halves read one file (`~/.dsh/muen-draw/draw.json`, or `MUEN_DRAW_DIR`), so the
page and the tool can never disagree.

**The Host half imports nothing from `@deepseek-ai/*`.** A workspace-linked bundle cannot
resolve those (the profile's `node_modules` carries none), and the row would mount *inert*
while `install_bundle` still reported success. Keep it that way.

## Tools

**`draw_read`** → `{ ok, revision, updatedAt, elements[], note }`

Each element is one of:

```json
{ "kind": "rect",     "bbox": [20,30,200,90], "label": "hero, full width" }
{ "kind": "text",     "text": "logo smaller", "at": [20,140] }
{ "kind": "scribble", "points": 128, "bbox": [40,40,100,30] }
{ "kind": "arrow",    "bbox": [300,120,60,-80] }
```

**`draw_apply`** → `{ ok, revision, applied, count }`

```json
{ "ops": [
  { "op": "add",    "element": { "kind": "rect", "x": 300, "y": 300, "w": 100, "h": 40, "label": "button" } },
  { "op": "update", "id": "eabc123", "props": { "label": "primary" } },
  { "op": "delete", "id": "eabc123" },
  { "op": "clear" }
] }
```

An empty `ops` list is refused rather than treated as a no-op — a tool that silently
succeeds at doing nothing is worse than one that says it did nothing.

## Drawing

Select/move · Scribble · Box · Arrow · Text · Undo · Delete · Clear.
Shortcuts: `V` `D` `R` `A` `T`, `⌘Z`, `Delete`.

Autosaves ~500 ms after you stop drawing; polls every 1.5 s so an agent's diagram appears
without a refresh. The dot in the toolbar is the save state.

## Verify

```bash
npm run verify           # host + client, no harness and no restart
```

**Host** (`verify/host.mjs`, 19 checks) mounts the real `apply()` against a fake
`webServer` + `tools`, serves it over real HTTP, and asserts both directions: what the page
writes the tool reads, and what the tool writes the page sees.

**Client** (`verify/client.mjs`, 24 checks) proves the bundle parses, mounts through a stub
loader, only requires react/primitives, registers through `ctx.effect`, exposes **thunks**
where the tab registry calls them (a bare string there crashes the start guide), consults
the host's `t` with both dictionaries covering every key, and renders an iframe pointing at
`/plugins/draw/` — including when the icon seam is empty, which is a crash rather than a
blank if the fallback is wrong.

Neither replaces the composed app: only a launch proves the plugin is not inert.

## Deliberately not in this version

- **Excalidraw** and **mermaid** rendering. Both are MIT and could be vendored into
  `assets/` (`@excalidraw/mermaid-to-excalidraw` is official and 1.5M downloads/week), but
  each is a large browser bundle. Shipping the board without them keeps the plugin
  dependency-free and installable today. Note the Obsidian Excalidraw plugin is **AGPL**,
  not MIT — do not fork it into this.
- **Vision.** The agent reads the element list, so it cannot be wrong about what a shape
  *is* — only about what it *means*. That is the intended division: structure from the
  store, intent from the model.
- **Persistence beyond one board.** A board is a message; keeping many invites it becoming
  a document, and documents drift from code.
- Any way to start an agent turn. A third-party plugin does not own the composer seam, so
  the pane says what to type rather than drawing a button that pretends to send.

## Install

```bash
cd ~/muen-plugins
pnpm harness        # or install the bundle into a profile
```

Then open the right panel → **Board**.
