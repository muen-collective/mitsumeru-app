# context-watchdog

A Client-only DSH plugin with two surfaces, two jobs:

| | |
|---|---|
| **the alert** | `conversation.input.dock` — a full-width banner above the composer, once the session passes the policy's threshold, offering the two things a reader can do about it: `[ New session ] [ Snooze ▾ ] [ × ]` |
| **the policy** | `settings.general.item` — the row that owns the threshold, under **Settings → General**, beside "Conversation display" |

Intent: token-cost savings. Every step of a long session re-sends the whole context, so the
banner is the human complement to the host's automatic compaction — a deliberate cut at a task
boundary instead of a lossy automatic one.

## Why a banner and not a chip

This replaced an ambient chip in `conversation.composer.dock`. The host **already** renders its own
context meter beside the composer, so a second quiet number was duplication; what was missing was
an **actionable** surface. Two rules follow from that:

1. **The alert can do the thing.** `New session` calls `uiWorkspace.startSession()`, which parks
   the current session in the sidebar and opens an empty one — nothing is destroyed, so the choice
   is about cost, not about losing work. The button is omitted, not disabled, when the service is
   absent.
2. **Every choice is spelled out.** `Snooze ▾` opens a menu whose items name their own effect —
   `Until 604K (next band)` or `For 20 minutes` — so the reader decides informed, rather than
   discovering later what a vague "later" meant.
3. **It *is* the composer's box, not merely the same width.** Two separate things put a dock entry
   out of line, and the harness's own goal banner (`GoalBar.module.css`) is the reference for both:

   ```css
   /* .nLMEza_dock */ width: calc(100% - 2*side-clearance - 4*dock-inset); margin: 0 auto;
   /* .nLMEza_bar  */ width: 100%; max-width: calc(card-max - 4*dock-inset); margin: 0 auto;
   ```

   - **Centring.** A dock entry is a flex child of the composer stack, which stretches. A capped
     entry without an auto inline margin therefore sits at the stack's **start** — under nothing.
     `margin: 0 auto` is the convention, and it is what this banner was missing.
   - **The side clearance.** The composer card lives inside a wrapper that pads by
     `--dsh-composer-side-clearance`; an entry that keeps the full width is that much wider than the
     card on a narrow window. The banner subtracts the same clearance.

   So: `width: calc(100% - 2 * var(--dsh-composer-side-clearance))`,
   `max-width: var(--dsh-composer-card-max-width)`, `margin: 0 auto 8px`. Both the width and the cap
   are tokens, so the banner **follows the composer through any resize** — window, sidebar, or panel
   — exactly as the card does. (`--dsh-composer-height`, which the seat sets at runtime, is the
   card's height and doesn't concern this row.)

   The one deliberate divergence: the goal banner caps at `card-max - 4*dock-inset` (the card's
   *content* box, 32px narrower). This banner is a bordered card that should stack flush with the
   composer card, so it uses the card's **outer** box. One line to switch if you prefer the other.
   `07-tests/unit/context-watchdog-banner.test.mjs` pins the cap, the clearance subtraction and the
   auto margins, so none of it can silently regress.

## The threshold policy

A **fixed token count cannot serve models with different windows**: 300K never fires on a 128K
model and is 30% of a 1M one. A **percentage alone cannot serve cost**: 35% of a 32K window is
11K, which would nag far earlier than it saves. So the default is a percentage that never fires
later than a ceiling, and never earlier than a floor:

```
auto  :  max(FLOOR, min(percent% × contextWindow, CEILING))
fixed :  the count you type
```

Defaults: `percent 35`, `CEILING 300000`, `FLOOR 25000`.

| Window | 35% × window | fired at | which bound |
|---|---|---|---|
| 1M (DeepSeek Flash) | 350K | **300K** | ceiling — the wallet |
| 200K | 70K | **70K** | percentage — the window |
| 128K | 45K | **45K** | percentage |
| 32K | 11K | **25K** | floor |

`contextWindow` comes from `contextPressure` — "the newest recorded route capacity" — so
**switching model re-derives the threshold with no per-model table to maintain**. A window too
small for the floor stays silent rather than nagging uselessly.

## Escalation: one surface, three voices

| Share | Copy | Snooze |
|---|---|---|
| < 50% | "Starting a fresh session for the next task keeps this one fast and cheap." | both options |
| 50–70% | "Recommended: start a fresh session for the next task." | both options |
| 70–85% | "Strongly recommended: every step now re-sends this whole context." | both options |
| ≥ 85% | "Compaction is likely. Starting a fresh session keeps you in control of what is carried forward." | **band refused** — the item turns into an explanation |

## Snooze: banded by tokens, not by time

Snoozing is one **band** — 10% of the window *past where the reader already is* — so a snooze can
never be void the moment it is taken:

```
next band = min( max(threshold + 10% × window, used + 10% × window), 85% × window )
```

On a 1M window with a 300K trigger, a reader at 504K is offered **Until 604K**, not 400K. The
time option (`For 20 minutes`) exists because some readers think in time; the token option is the
one that cannot mislead, because tokens are the metric. Past 85% the band option is refused
outright: there the alert is about *quality* — compaction, drift, repeated work — not cost, so it
re-arms whether or not the reader snoozed.

Dismissal (`×`) is per session for the life of the page, as is a snooze. A new session starts
clean because the numbers are new.

## How it works

| | |
|---|---|
| **Data** | the `contextPressure` projection — `{ projectedTokens?, pressureTokens?, contextWindow }`, the same source the host's own `ContextMeter` reads. `projectedTokens` wins when present (it accounts for what the next request would carry, including a span a compaction just shadowed). |
| **Alert seat** | `conversation.input.dock` (list, session scope, `replaceRisk: none`), order 30 — after the harness's own `todo` (0), `goal` (10) and `queue` (20) banners, closest to the composer. Root-scoped? no: session scope, which is what gives it `sessionId` and `useProjection`. |
| **Policy seat** | `settings.general.item` (list, root scope, `replaceRisk: none`), order 13. Root scope means **no `useProjection`**: the row renders the *rule*, the banner renders the *live* number, and the row previews the last window the banner saw. |
| **Glyphs** | the app's own `IconWarningOutline16` / `IconCloseOutline16` from `@deepseek-ai/dsh-client-ui-primitives`, with an inlined Lucide `triangle-alert` (ISC) as the fallback if that module is unreachable |
| **Host half** | none. `index.js` exports an empty `apply`; every number is already a Client projection. |
| **Silence rules** | nothing renders while the window or the used-token count is unavailable; a window too small for the floor stays quiet; dismissal and snooze are remembered per session. |

## Configuration

**Settings → General → "Context reminder."** Two modes (`Auto (%)` / `Fixed tokens`), the numbers
beside them, the rule in plain language, and a live preview (`Last seen window 200K → fires at
70K`) once a session has told the plugin which window the model has.

Storage is a JSON document in `localStorage`:

```js
localStorage.getItem('dsh-context-watchdog.settings')     // {"mode":"auto","percent":35,...}
localStorage.removeItem('dsh-context-watchdog.settings')  // back to the defaults
```

The pre-policy key — a bare number — is still honoured as `{"mode":"fixed"}` with that count.

**Why localStorage and not a Host settings namespace:** a namespace needs
`@deepseek-ai/schemastery`, which a workspace-`link:`ed bundle cannot resolve — the wall that made
`@muen/dsh-codex-fold` inert on its first install. Moving to a real namespace later means shipping
this bundle as a tarball (or vendoring schemastery), nothing more.

## Install / remove

```
plugin_manager install_bundle "/Volumes/External SSD/mitsu/plugins/dsh-context-watchdog"
plugin_manager remove_bundle  @muen/dsh-context-watchdog
```

It was promoted out of `10-scratch/` into `plugins/dsh-context-watchdog` on 2026-09-18, once the
banner was accepted. The profile's `link:` dependency follows the directory, so the move needed a
`remove_bundle` + `install_bundle` pair — a bare `mv` leaves the profile's symlink dangling.

## Verified / not verified

| Check | Result |
|---|---|
| Syntax (`node --check`) | ✅ |
| Threshold policy | ✅ 8/8 — bounds, silent cases, fixed mode, clamping, legacy-key migration |
| Banner behaviour | ✅ 9/9, rendered from the real bundle in a VM with a miniature React: seat (`input.dock` yes, `composer.dock` no), `Context 504K of 1M (50%)`, escalation copy, the three actions, host glyphs and the inline fallback, `New session` calling `startSession` and clearing the alert, the snooze band labelled `Until 604K` and hiding the banner, the band refused at 90%, silence in the three unmeasurable cases, both locales |
| Live registration | ✅ `input.dock` → `context-watchdog` order 30; `composer.dock` → only the host's `stats` remains |
| Promotion to `plugins/` (2026-09-18) | ✅ profile `link:` dependency and `node_modules/@muen/dsh-context-watchdog` symlink both point at `plugins/dsh-context-watchdog`; the bundle resolves; both test files re-run green from the new path |
| The banner's pixels | ⚠️ **still unverified visually** — a fresh browser session gets `dsh web authentication required` from `http://127.0.0.1:64661`, and the agent session is given no authenticated URL. Needs the founder's eyes (or an authenticated Agent Window). |

## Deliberately not done

- **Dollars.** The harness has no currency contract: `dsh-llm-deepseek/request-pricing` is image
  *token* pricing for accounting, and no projection carries a price or cost field — which is also
  why Kun prints "Price unavailable". Cost is expressed in tokens. A user-editable price table is
  the only route to money, and it belongs with the per-turn readout, not with the alert.
- **Cache share.** `tokenUsage` carries `uncachedInputTokens` / `cacheReadTokens` /
  `cacheWriteTokens`, so "91% cached" is computable — but that informs a *readout*, not an alert.
- **Dismissal that survives a reload.** Choices are remembered for the life of the page; a durable
  per-session record would need session-keyed storage.
