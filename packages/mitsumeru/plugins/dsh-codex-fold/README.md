# @muen/dsh-codex-fold

Codex-style agent-loop folding for the DSH conversation, **localized**.

The goal it serves: declutter the agent loop panel. A finished turn keeps its native summary row,
and the runs of thinking / tool / context rows that sit *between* prose paragraphs collapse into one
chip per run —

```
🤖 Ran 6 commands ⌄
```

— which expands back to the individual rows the host rendered, unchanged.

This is a localized fork of `dsh-auto-collapse` 0.2.1 (MIT). See [FORK.md](FORK.md) for what changed
and how to re-apply it to a new upstream release; [LICENSE](LICENSE) is upstream's, verbatim.

## Why it exists

The upstream bundle renders 34 hardcoded Chinese strings and never consults the locale, so an
English UI showed `已注入上下文 · 已思考` and a Chinese settings card. Vendoring it was cheaper and
safer than reimplementing its DOM grouping, and it keeps the attribution the licence requires.

## How it composes with our other plugins

| Plugin | Surface | Relationship |
|---|---|---|
| `@muen/dsh-turn-summary` | `conversation.chat.node` → `turn-process` | Rewrites the **level-1** row ("Processed 24m 0s · Read 9 files · …") and auto-folds closed turns |
| `@muen/dsh-codex-fold` (this) | DOM pass over the chat flow | Adds the **level-2** chips per run and leaves level 1 native |
| `@muen/dsh-changes-card` | `conversation.chat.turnTail` | The white end-of-turn changed-files card |

Level 1 is the host's row wrapper; replacing the node *renderer* changes the row's contents, not the
wrapper the fold controller reads, so the two are meant to run together. If folding disappears while
the summary row still renders, that assumption is what to re-check first.

## Settings — currently none

Upstream's settings card (**Status text**) is **not carried over**: it needed a Host settings
namespace, and the Host half's `@deepseek-ai/schemastery` import cannot resolve from a workspace-linked
bundle — that import is what made the first install inert. The live row therefore always shows the
built-in `Deep sleeping...`. [FORK.md](FORK.md) records the failure, the check that catches it, and
the two honest ways to get the setting back (vendor schemastery, or install as a tarball).

## Row styling (fixed)

Two symptoms, one cause: the fork's group rows depended on its injected stylesheet, and where
that stylesheet does not land the browser falls back to its own button chrome.

| Symptom | What was happening |
|---|---|
| **Oversized black icons** — a big dot beside a long bar per row, and a huge chevron | The 16x16 icon carried only a `viewBox`, so with no CSS to size it, it painted at the SVG default 300x150 px |
| **Boxed rows** — grey fill, 1px border, centred label, no left alignment, chevron never rotating | Every layout/colour property came from the same stylesheet, on a `<button>` |

Both are fixed by writing the values **on the elements**: intrinsic `width`/`height` on the two
runtime-built SVGs, and the row's layout/colour inline on the button, icon, label, detail and
chevron — so the chip is correct whether or not the CSS lands. The chevron's open/closed
rotation is driven from the update path that already maintains `aria-expanded`. See
[FORK.md](FORK.md) → "Runtime defects we carry fixes for".

The stylesheet still ships for what inline styles cannot express: `:hover`, `:focus-visible`,
the running-status pulse, and folded-row spacing.

## Verification

| Check | Result |
|---|---|
| Syntax (`node --check`, both halves) | ✅ |
| Script reproducibility | ✅ `localize.py` against upstream 0.2.1 reproduces `lib/client.js` byte-for-byte |
| No Chinese left in code paths | ✅ 0 surviving CJK escapes |
| Bundle loads and wires locale | ✅ executed in a VM sandbox: id `@muen/dsh-codex-fold`, `inject: ["locale"]`, `apply` registers `muen-codex-fold` × {en: 34 keys, zh: 34 keys} and returns a disposer |
| Host half needs nothing | ✅ no imports; `require.resolve("@deepseek-ai/schemastery")` fails from this package and nothing depends on it |
| Icon sizing | ✅ both runtime-built SVGs carry `width`/`height` attributes **and** inline styles; the unconditional `this.style.remove()` is gone |
| Row styling | ✅ the chip's layout, colour, alignment and border are written inline on the button/icon/label/detail/chevron (45 inline assignments), and the chevron rotates from the `aria-expanded` update path |
| **Row mounted** | ✅ `include:muen-codex-fold` → `enabled: true, fiberPhase: active` once the Host half stopped importing schemastery; **absent from the list** before that (plugin total 174 → 175) |
| Bundle install | ✅ `application: applied`, `enabled: true` |
| The folding itself | ⚠️ **unverified visually** — a DOM pass cannot be confirmed without eyes on the page |

Upstream's verified-host table lists DSH `0.1.2-rc.1` and `0.1.5-rc.2`; this deployment runs
`0.1.6-alpha.2`, which is why the visual check matters here more than usual.
