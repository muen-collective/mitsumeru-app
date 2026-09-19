# @muen/dsh-turn-summary

Kun's turn fold, on DSH's own Turn-process disclosure.

```
▸ Processed 24m 0s
```

The shipped row says `Thought for a while · 12 tool calls · 3 messages` — no elapsed time. This
renders that row instead, in the app's language, with the turn's real duration.

The read/edited/ran breakdown deliberately stays **off** this label and lives one level down, on the
per-run chips that `@muen/dsh-codex-fold` contributes — that is where Kun keeps it, and repeating it
here would say everything twice. The breakdown is still one hover away, in the row's tooltip.

## Layer 1 of the agent-loop fold, and its gates

The folding itself is the **host's**, not this plugin's: DSH's `turn-process` disclosure hides the
Turn's process members (`data-turn-process-hidden`) while the final answer stays visible. What this
plugin changes is the row's wording. That matters because the fold is gated by host state, and none
of these gates can be moved by a Client plugin:

| Gate | Where it comes from |
|---|---|
| `compactTranscript` | the `ui-chat.transcriptView` setting — `normal` \| `compact`, **default `compact`** |
| the Turn is closed | `processPresentation.turnClosed` |
| an answer boundary exists | `spec.answerAnchorSeq !== null` / `spec.answerStep !== null` |
| the history window is complete | `historyIncomplete` — older history still to load disables the fold |

When any gate is shut, `foldable` is false: the host marks the control row's own wrapper
`data-turn-process-hidden` (its CSS collapses it) and the shipped renderer returns null. This plugin
now does the same — `if (!foldable) return null` — instead of painting into an invisible wrapper,
and it drives its auto-fold from `spec.answerStep` (the same precondition `setOpen` itself applies)
rather than from a snapshot guess.

The host already defaults to folded (`processOpen` is false unless the chat store has an entry), so
this plugin's auto-fold only re-closes a turn that something else opened — and never one the reader
opened by hand.

## What it is not

**The changed-files card is already in the product.** `@deepseek-ai/dsh-client-ui-deliverables`
registers "Edited {count} files", `+{count}` / `-{count}`, the per-file rows, and the
`changes-review` right-Sidebar tab (`Review · turn {turn}`, split/unified, line wrap) — English
and Chinese, with the diffs served by the Host's `workspaceChanges` service
(`/api/changes.summary`, `/api/changes.diff`). Rebuilding it here would put two cards on the same
turn, so this plugin deliberately does not. If the card is missing from a turn, the thing to check
is whether that turn changed files at all — not this plugin.

**It does not rewrite the DOM.** `dsh-auto-collapse` folds the shipped rows by observing and
patching the page, and its 27 summary strings are hardcoded Chinese
(`"\u5DF2\u601D\u8003"`, `"\u5DF2\u6CE8\u5165\u4E0A\u4E0B\u6587"`, `"\u8FD0\u884C\u4E86\u547D\u4EE4"`, …) with no locale lookup anywhere in its bundle.
This plugin takes a seat and asks the locale service for words instead. It was disabled when this
plugin was installed; re-enable it only if you want the DOM rewrite back.

## The seam it takes

| | |
|---|---|
| **Slot** | `conversation.chat.node`, key `turn-process` |
| **Kind** | keyed, session scope, `replaceRisk: shadows-shipped-ui` |
| **Effect** | the host's occupant for that key is replaced — "Registering an already-occupied key replaces that occupant" |
| **Not touched** | everything folded *under* the row. This plugin renders the control, never the work; expanding shows the host's real process rows |

This is the one shipped surface the plugin shadows, so it is the one thing to re-check after a
harness upgrade. The guard is deliberate: with no `node` prop, no `useChat`, or no `turnProcess`
state, the component renders nothing and the transcript is unaffected rather than blanked.

## Where the numbers come from

One `useChat` selector over `ChatSnapshot`, three documented maps, no DOM:

```js
legacy.turnTimings            // Map<turn, { startTime, endTime? }>  → duration
legacy.turnEnds               // Map<turn, seq>                      → is the turn closed
locations.getTurn(turn)       // → node keys; nodes.get(key) → nodes
```

* **Steps** — `assistant-step` nodes in the turn.
* **Actions** — `tool-call` nodes bucketed by name
  (`write|edit|str_replace|apply_patch|…` → edited, `read|glob|grep|…` → read, `bash|shell|…` →
  ran, `web_search|web_fetch` → searched, `*browser*|playwright|…` → browsed, `subagent*` →
  delegated). Unknown names land in `other` and still count.
* **Tokens** — the `turn-tail` node's `tokenUsage.totalTokens`.

The selector returns a JSON **string**, never a fresh object: a selector result whose identity
changes on every read would re-render forever.

## Folding

* A **closed** turn folds itself once, on first render.
* A turn the reader opened by hand is never folded again — remembered per
  `sessionId:turn` for the life of the page.
* A **live** turn is left alone and reads `Working · …` instead of `Processed …`.

## Configuration

There is none: no settings row, no thresholds, no storage. Install or remove the bundle. If a
collapse-by-default preference is ever wanted, the Host half (`index.js`) is the empty home for it.

## Verification

| Check | Result |
|---|---|
| JavaScript syntax (`node --check`) | ✅ both halves |
| Manifest (`dsh.bundle.patch`, exports, client platform) | ✅ |
| Patch document | ✅ one YAML document, top-level array |
| Bundle install | ✅ `application: applied`, `enabled: true` |
| Client registration | ✅ the old `turnTail` entry disappeared and only the shipped `deliverables` + `plan` entries remain, which is the observable proof that the reloaded half registers into `turn-process` instead |
| Replaced the host's row | ⚠️ **unverified visually** — the rendered row, the fold toggle, and the auto-fold have not been seen; the keyed occupant list cannot distinguish the host's registration from a replacement |

After an upgrade, the fast check is: does the header still read `Processed … · Read … files`, and
does clicking it reveal the process rows? If the header reverts to `Thought for a while`, the
`turn-process` key moved and the plugin is inert rather than broken.
