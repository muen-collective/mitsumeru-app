/**
 * changes-card — Client half.
 *
 * The end-of-turn card Kun closes a turn with, in white:
 *
 *     ┌──────────────────────────────────────────────────────┐
 *     │ ▢  Edited 3 files                       +6  −1       │
 *     │    provider-contract.ts                 +4  −0    ›  │
 *     │    provider-catalog.ts                  +1  −0    ›  │
 *     │    SettingsDialog.tsx                   +1  −1    ›  │
 *     └──────────────────────────────────────────────────────┘
 *
 * ── where it renders ─────────────────────────────────────────────────────────
 * `conversation.chat.turnTail` (list, replaceRisk: none), the same additive seat
 * the shipped deliverables card uses. Order -5 puts it just above that card.
 *
 * ── why this exists next to the shipped card ─────────────────────────────────
 * `@deepseek-ai/dsh-client-ui-deliverables` already renders a changed-files card
 * with real diffs and a Review tab — but only when the Host's change recorder
 * announced a `workspace/changes` summary for the turn. That recorder can
 * legitimately announce nothing, and in this workspace it does: the session that
 * modified a *tracked* file got an announcement, while turns that only created
 * new *untracked* files got none, so no card appeared at all.
 *
 * So this card is the complement, not a second opinion. It reads the turn's own
 * file-tool nodes and can always answer; and it stands down the moment the Host
 * card has something to show:
 *
 *     turn.data.get('deliverables').changes   // present → the Host card owns it
 *
 * That check is why the two never render together.
 *
 * ── where the numbers come from ──────────────────────────────────────────────
 * `useChat` → `locations.getTurn(turn)` → `nodes.get(key)`, keeping the
 * `tool-call` roots whose name is a file mutation, then reading the arguments
 * the mutation actually applied:
 *
 *     write            content                  → added lines
 *     edit             old_string / new_string  → line diff (real LCS below)
 *     apply_patch      patch body               → its + and − lines
 *     str_replace_*    old_str / new_str        → line diff
 *
 * The diff is a real line diff: common prefix and suffix are trimmed, then an
 * LCS over the remainder. Work is bounded (see DIFF_CELL_BUDGET) and degrades to
 * "all lines added, all lines removed" rather than hanging on a huge edit.
 *
 * Counts are lines changed, not the Host's snapshot comparison: a whole-file
 * `write` cannot know what it replaced, so it reports additions only. The card
 * says so by deferring to the Host card whenever that one exists.
 *
 * The selector returns a JSON *string*, never a fresh object — a selector result
 * whose identity changes on every read would re-render forever.
 */
window.__ModuleLoader__.load({
  id: '@muen/dsh-changes-card',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'muen-changes-card';

    /** Collapsed row count before "Show all N files". */
    const VISIBLE_ROWS = 5;
    /** Most files one card carries; the rest are counted, not listed. */
    const MAX_FILES = 40;
    /** Lines² ceiling for the LCS; past it the diff degrades to whole-file. */
    const DIFF_CELL_BUDGET = 90000;

    const EN = {
      'label': 'Changed files',
      'title.one': 'Edited {count} file',
      'title.other': 'Edited {count} files',
      'showAll': 'Show all {count} files',
      'showLess': 'Collapse',
      'open': 'Open {name}',
      'more': '{count} more',
    };

    const ZH = {
      'label': '改动文件',
      'title.one': '编辑了 {count} 个文件',
      'title.other': '编辑了 {count} 个文件',
      'showAll': '展开全部 {count} 个文件',
      'showLess': '收起',
      'open': '打开 {name}',
      'more': '另有 {count} 个',
    };

    /** Replaced in apply() once the locale service is bound. */
    let translate = function (key, params) {
      const template = EN[key];
      if (template === undefined) return key;
      return interpolate(template, params);
    };

    function interpolate(template, params) {
      if (params === undefined || params === null) return template;
      return String(template).replace(/\{(\w+)\}/g, function (match, name) {
        const value = params[name];
        return value === undefined || value === null ? match : String(value);
      });
    }

    function plural(key, count) {
      return translate(key + (count === 1 ? '.one' : '.other'), { count: count });
    }

    /** First non-empty string among the candidate argument names. */
    function firstString(args, keys) {
      for (let i = 0; i < keys.length; i++) {
        const value = args[keys[i]];
        if (typeof value === 'string' && value.length > 0) return value;
      }
      return null;
    }

    /** Text → lines, treating one trailing newline as a terminator. */
    function toLines(text) {
      if (typeof text !== 'string' || text === '') return [];
      const lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return lines;
    }

    /** Longest common subsequence length over two line arrays, rolling rows. */
    function lcsLength(a, b) {
      const n = b.length;
      let prev = new Uint32Array(n + 1);
      let cur = new Uint32Array(n + 1);
      for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= n; j++) {
          cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : (prev[j] > cur[j - 1] ? prev[j] : cur[j - 1]);
        }
        const swap = prev;
        prev = cur;
        cur = swap;
        cur.fill(0);
      }
      return prev[n];
    }

    /** Added/deleted line counts between two texts. */
    function diffCounts(oldText, newText) {
      let a = toLines(oldText);
      let b = toLines(newText);
      let head = 0;
      while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
      let tail = 0;
      while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
      a = a.slice(head, a.length - tail);
      b = b.slice(head, b.length - tail);
      if (a.length === 0) return { added: b.length, deleted: 0 };
      if (b.length === 0) return { added: 0, deleted: a.length };
      if (a.length * b.length > DIFF_CELL_BUDGET) return { added: b.length, deleted: a.length };
      const common = lcsLength(a, b);
      return { added: b.length - common, deleted: a.length - common };
    }

    /** A unified-patch body's own `+`/`-` lines, file headers excluded. */
    function patchCounts(patch) {
      const lines = toLines(patch);
      let added = 0;
      let deleted = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('+++') || line.startsWith('---')) continue;
        if (line.startsWith('+')) added += 1;
        else if (line.startsWith('-')) deleted += 1;
      }
      return { added: added, deleted: deleted };
    }

    /** `*** Update File: path` / `+++ b/path` inside a patch body. */
    function patchPath(patch) {
      const match = /\*\*\* (?:Update|Add|Delete) File: (.+)|^\+\+\+ [ab]\/(.+)$/m.exec(patch);
      if (match === null) return null;
      const value = match[1] === undefined ? match[2] : match[1];
      return typeof value === 'string' && value !== '' ? value.trim() : null;
    }

    /**
     * One tool call's contribution, or null when it is not a file mutation.
     * Names are matched by prefix so unknown spellings degrade to "not a
     * mutation" rather than to a wrong count.
     */
    function contributionOf(name, argsRaw) {
      if (typeof argsRaw !== 'string' || argsRaw === '') return null;
      let args;
      try {
        args = JSON.parse(argsRaw);
      } catch (error) {
        return null;
      }
      if (args === null || typeof args !== 'object') return null;
      const n = String(name === undefined || name === null ? '' : name).toLowerCase();
      const path = firstString(args, ['file_path', 'filePath', 'path', 'notebook_path', 'target_file']);

      if (/^(write|create_file)$/.test(n)) {
        const content = firstString(args, ['content', 'file_text', 'text']);
        if (content === null) return null;
        return { path: path === null ? null : path, added: toLines(content).length, deleted: 0 };
      }
      if (/^apply_patch$/.test(n)) {
        const patch = firstString(args, ['patch', 'input', 'diff']);
        if (patch === null) return null;
        const counts = patchCounts(patch);
        return { path: path === null ? patchPath(patch) : path, added: counts.added, deleted: counts.deleted };
      }
      // str_replace_editor and every `edit`-family spelling share this shape.
      const oldText = firstString(args, ['old_string', 'old_str', 'old_text', 'oldText']);
      const newText = firstString(args, ['new_string', 'new_str', 'new_text', 'newText']);
      if (oldText !== null && newText !== null) {
        const counts = diffCounts(oldText, newText);
        return { path: path, added: counts.added, deleted: counts.deleted };
      }
      if (/^(str_replace|edit)/.test(n)) {
        const fileText = firstString(args, ['file_text']);
        if (fileText !== null) return { path: path, added: toLines(fileText).length, deleted: 0 };
      }
      return null;
    }

    /** Empty reading, and the shape `signature()` always returns. */
    function emptyReading() {
      return { files: [], added: 0, deleted: 0, extra: 0 };
    }

    /**
     * Fold one turn's file mutations into per-file counts.
     *
     * Pure, bounded, and safe on a partial window: a turn whose head was cut by
     * a compaction simply reports fewer files.
     */
    function signature(snapshot, turn) {
      const reading = emptyReading();
      try {
        if (snapshot === null || snapshot === undefined) return JSON.stringify(reading);
        const locations = snapshot.locations;
        const nodes = snapshot.nodes;
        if (locations === undefined || nodes === undefined) return JSON.stringify(reading);
        const keys = locations.getTurn(turn);
        if (!keys) return JSON.stringify(reading);

        const byPath = new Map();
        const order = [];
        let extra = 0;
        for (let i = 0; i < keys.length; i++) {
          const node = nodes.get(keys[i]);
          if (node === null || node === undefined || node.kind !== 'tool-call') continue;
          const root = node.data === undefined || node.data === null ? undefined : node.data.root;
          if (root === undefined || root === null) continue;
          const call = root.call === undefined || root.call === null ? null : root.call;
          const contribution = contributionOf(call === null ? root.name : call.name, call === null ? root.argsRaw : call.argsRaw);
          if (contribution === null) continue;
          const path = contribution.path === null || contribution.path === undefined ? '(unnamed)' : contribution.path;
          if (!byPath.has(path)) {
            if (order.length >= MAX_FILES) {
              extra += 1;
              continue;
            }
            byPath.set(path, { p: path, a: 0, d: 0 });
            order.push(path);
          }
          const entry = byPath.get(path);
          entry.a += contribution.added;
          entry.d += contribution.deleted;
          reading.added += contribution.added;
          reading.deleted += contribution.deleted;
        }
        for (let i = 0; i < order.length; i++) reading.files.push(byPath.get(order[i]));
        reading.extra = extra;
      } catch (error) {
        // A reshaping snapshot must not take the transcript down.
        return JSON.stringify(emptyReading());
      }
      return JSON.stringify(reading);
    }

    /** Does the Host's own card own this turn? Then this one stays away. */
    function hostOwnsCard(turn) {
      try {
        const data = turn === undefined || turn === null ? undefined : turn.data;
        if (data === undefined || data === null || typeof data.get !== 'function') return false;
        const deliverables = data.get('deliverables');
        return deliverables !== undefined && deliverables !== null && deliverables.changes !== undefined && deliverables.changes !== null;
      } catch (error) {
        return false;
      }
    }

    function FileIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        [
          h('path', { key: 'doc', d: 'M4.25 1.75h4.5L12 5v9.25H4.25z' }),
          h('path', { key: 'fold', d: 'M8.6 1.9V5.1H11.9' }),
        ],
      );
    }

    function Counts(props) {
      return h('span', { style: { display: 'inline-flex', gap: '8px', fontVariantNumeric: 'tabular-nums' } }, [
        h('span', { key: 'add', style: { color: 'var(--dsw-alias-state-success-primary)' } }, '+' + props.added),
        h('span', { key: 'del', style: { color: 'var(--dsw-alias-state-error-primary)' } }, '\u2212' + props.deleted),
      ]);
    }

    function ChangesCard(props) {
      if (props === undefined || props === null) return null;
      if (props.turn === undefined || props.turn === null) return null;
      if (typeof props.useChat !== 'function') return null;
      return h(ChangesCardInner, props);
    }

    function ChangesCardInner(props) {
      const turn = props.turn;
      const turnNumber = turn.turn;
      const state = React.useState(false);
      const expanded = state[0];
      const setExpanded = state[1];

      const encoded = props.useChat(function (snapshot) {
        return signature(snapshot, turnNumber);
      });

      let reading = emptyReading();
      try {
        if (typeof encoded === 'string') reading = JSON.parse(encoded);
      } catch (error) {
        reading = emptyReading();
      }

      const files = Array.isArray(reading.files) ? reading.files : [];
      if (turn.status === 'open') return null;
      if (files.length === 0) return null;
      // The shipped card has real diffs and a Review tab; never compete with it.
      if (hostOwnsCard(turn)) return null;

      const visible = expanded ? files : files.slice(0, VISIBLE_ROWS);
      const rows = [];
      for (let i = 0; i < visible.length; i++) {
        const file = visible[i];
        const name = String(file.p);
        const short = name.split('/').slice(-2).join('/');
        rows.push(
          h(
            'li',
            {
              key: 'file-' + i,
              style: { borderTop: '1px solid var(--dsw-alias-border-l1)', listStyle: 'none' },
            },
            h(
              'button',
              {
                type: 'button',
                'data-muen-changes-card': 'row',
                'data-path': name,
                title: name,
                'aria-label': translate('open', { name: short }),
                onClick: function () {
                  if (typeof props.openFile === 'function') props.openFile(name);
                },
                style: {
                  appearance: 'none',
                  border: 0,
                  background: 'transparent',
                  font: 'inherit',
                  color: 'var(--dsw-alias-label-secondary)',
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '10px 14px',
                  margin: 0,
                  cursor: 'pointer',
                  textAlign: 'left',
                },
              },
              [
                h(
                  'span',
                  {
                    key: 'path',
                    style: {
                      flex: '1 1 auto',
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: '0.95em',
                    },
                  },
                  name,
                ),
                h(Counts, { key: 'counts', added: file.a, deleted: file.d }),
                h('span', { key: 'chev', 'aria-hidden': 'true', style: { color: 'var(--dsw-alias-label-tertiary)' } }, '\u203a'),
              ],
            ),
          ),
        );
      }

      const headerChildren = [
        h(
          'span',
          {
            key: 'tile',
            'aria-hidden': 'true',
            style: {
              flex: '0 0 auto',
              width: '32px',
              height: '32px',
              borderRadius: '8px',
              background: 'var(--dsw-alias-interactive-bg-hover)',
              color: 'var(--dsw-alias-label-secondary)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            },
          },
          h(FileIcon, {}),
        ),
        h(
          'span',
          { key: 'titles', style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
          [
            h(
              'span',
              {
                key: 'title',
                style: { color: 'var(--dsw-alias-label-primary)', fontSize: '1.08em', fontWeight: 600, lineHeight: 1.35 },
              },
              plural('title', files.length + (reading.extra > 0 ? reading.extra : 0)),
            ),
            h(
              'span',
              { key: 'stat', style: { fontSize: '0.92em' } },
              h(Counts, { added: reading.added, deleted: reading.deleted }),
            ),
          ],
        ),
        h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
      ];

      if (files.length > VISIBLE_ROWS) {
        headerChildren.push(
          h(
            'button',
            {
              key: 'all',
              type: 'button',
              'data-muen-changes-card': 'toggle',
              onClick: function () {
                setExpanded(!expanded);
              },
              style: {
                appearance: 'none',
                border: 0,
                background: 'transparent',
                font: 'inherit',
                color: 'var(--dsw-alias-label-secondary)',
                cursor: 'pointer',
                padding: '4px 6px',
                borderRadius: '6px',
                whiteSpace: 'nowrap',
              },
            },
            expanded ? translate('showLess') : translate('showAll', { count: files.length }),
          ),
        );
      }

      return h(
        'div',
        {
          'data-muen-changes-card': 'root',
          'data-turn': String(turnNumber),
          style: {
            boxSizing: 'border-box',
            margin: '8px 0 2px',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '12px',
            background: 'var(--dsw-alias-bg-layer-1)',
            overflow: 'hidden',
            fontFamily: 'inherit',
            fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
            color: 'var(--dsw-alias-label-primary)',
          },
        },
        [
          h(
            'div',
            {
              key: 'header',
              style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px' },
            },
            headerChildren,
          ),
          h('ul', { key: 'list', style: { margin: 0, padding: 0, listStyle: 'none' } }, rows),
        ],
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(function () {
          const disposers = [];
          const pair = [['en', EN], ['zh', ZH]];
          for (let i = 0; i < pair.length; i++) {
            try {
              disposers.push(ctx.locale.register(NS, pair[i][0], pair[i][1]));
            } catch (error) {
              // already registered by an earlier generation of this plugin
            }
          }
          return function () {
            for (let i = 0; i < disposers.length; i++) {
              try {
                disposers[i]();
              } catch (error) {
                // disposal is best-effort
              }
            }
          };
        });
        translate = ctx.locale.bind(NS);

        ctx.slots.inject('conversation.chat.turnTail', function () {
          return ctx.slots.register(
            {
              name: 'conversation.chat.turnTail',
              id: 'muen-changes-card',
              order: -5,
              label: function () {
                return translate('label');
              },
            },
            ChangesCard,
          );
        });
      },
    };
  },
});
