# @muen/dsh-changes-card

Kun's changed-files summary card, in white, at the end of a turn:

```
┌────────────────────────────────────────────────────┐
│ ▢  Edited 3 files                        +6  −1    │
├────────────────────────────────────────────────────┤
│ /Users/…/lib/llm/provider-contract.ts    +4  −0  › │
│ /Users/…/lib/llm/provider-catalog.ts     +1  −0  › │
│ /Users/…/settings/SettingsDialog.tsx     +1  −1  › │
└────────────────────────────────────────────────────┘
```

A separate bundle from `@muen/dsh-turn-summary` (the fold header) on purpose: one changes the fold,
the other adds a card, and either can be removed without touching the other.

## Why this exists next to the shipped card

`@deepseek-ai/dsh-client-ui-deliverables` already renders a changed-files card — localized, with
per-file rows, real line counts, and the `changes-review` right-Sidebar tab. That card is better
than this one wherever it appears. It appears only when the Host's change recorder announced a
`workspace/changes` summary for the turn, and that is not every turn:

| Session | What it changed | `workspace/changes` announced? |
|---|---|---|
| previous session | a **tracked** file (`skills/mitsumeru-release-loop/SKILL.md`) | yes — 1 event |
| this session | **new untracked** files (`plugins/dsh-turn-summary/*`) | no event at all |

So on a turn that only creates files, the shipped card has nothing to render. This card reads the
turn's own file tools instead, so it always can.

## It stands down when the Host card has something to show

```js
turn.data.get('deliverables')?.changes   // present → the shipped card owns this turn
```

Both cards register into `conversation.chat.turnTail`, so without that check they would stack. With
it, exactly one card renders per turn: the Host's when it has real diffs and a Review tab, this one
otherwise.

## Where the numbers come from

`useChat` → `locations.getTurn(turn)` → `nodes.get(key)`, keeping the `tool-call` roots whose name is
a file mutation, then reading the arguments the mutation actually applied:

| Call | Arguments read | Counts |
|---|---|---|
| `write` / `create_file` | `content` | lines added; deletions unknown |
| `edit` / `str_replace*` | `old_string` → `new_string` | **real line diff** |
| `apply_patch` | `patch` body | its `+` and `−` lines, headers excluded |

The edit diff is a genuine line diff: common prefix and suffix trimmed, then an LCS over the
remainder, bounded at 90,000 cells and degrading to whole-file replacement past that rather than
hanging. A whole-file `write` cannot know what it replaced, so it reports additions only — which is
exactly the case the Host card covers properly.

Rows are capped at 5 visible (with *Show all N files*) and 40 carried; the rest are counted.

## Verification

| Check | Result |
|---|---|
| JavaScript syntax (`node --check`) | ✅ both halves |
| Manifest + patch document | ✅ one YAML document, top-level array |
| Bundle install | ✅ `application: applied`, `enabled: true` |
| Client registration | ✅ `{ id: "muen-changes-card", order: -5, active: true }` in the live `turnTail` list, beside `deliverables` and `plan` |
| Rendered card | ⚠️ **unverified visually** — no browser control in the session that built it |
| Stand-down check | ⚠️ exercised only by inspection; needs a turn where the Host announced a summary |

## Configuration

None. Install or remove the bundle.
