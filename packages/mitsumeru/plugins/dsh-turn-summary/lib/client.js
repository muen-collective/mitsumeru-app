/**
 * turn-summary — Client half.
 *
 * Kun's turn fold, on DSH's own Turn-process disclosure:
 *
 *     ▸ Processed 24m 0s · 12 steps · Read 9 files · Edited 5 files · Ran 2 commands
 *
 * The shipped row says "Thought for a while · 12 tool calls · 3 messages" — no
 * duration, and no read/edited/ran breakdown. This renders that row instead:
 * real elapsed time from the turn's own timing map, plus the action breakdown
 * counted off the turn's tool nodes. Closed turns fold themselves; clicking
 * opens the real process rows, which stay the host's (this plugin renders the
 * control, never the work).
 *
 * ── where it renders ─────────────────────────────────────────────────────────
 * `conversation.chat.node`, key `turn-process` (keyed, session scope). The
 * catalog's own words: "Reusing a key replaces that node renderer." The host's
 * occupant is replaced, which is the documented meaning of this seat and the
 * only way to change the wording of the fold header. Everything folded *under*
 * the header is untouched.
 *
 * This is the one shipped surface the plugin shadows, so it is the one thing to
 * re-check after a harness upgrade: if the key `turn-process` leaves the key
 * table, or `turnProcess` stops arriving on props, the guard below renders the
 * static summary and the plugin stays harmless rather than blanking the turn.
 *
 * ── where the numbers come from ──────────────────────────────────────────────
 * `useChat` (a selector over `ChatSnapshot`), two documented maps:
 *
 *     legacy.turnTimings : Map<turn, { startTime, endTime? }>   → duration
 *     locations.getTurn(turn) / nodes.get(key)                  → steps, tools
 *
 * "Finished" is not read from the snapshot but from the host's own verdict:
 * `turnProcess.foldable`, which already requires a closed Turn, a finalized
 * answer boundary, a complete history window and the compact transcript mode.
 *
 * Tool rows carry `data.root: ToolCallBlock`; the settled form names the call at
 * `root.call.name`/`root.call.argsRaw`, the running form at `root.name`/
 * `root.argsRaw`. The `turn-tail` node carries the turn's exact
 * `tokenUsage.totalTokens`.
 *
 * The selector returns a JSON *string*, never a fresh object — a selector result
 * whose identity changes on every read would re-render forever.
 *
 * ── deliberate non-goals ─────────────────────────────────────────────────────
 * The changed-files card ("Edited 3 files +6 −1" with Review) already ships,
 * localized, in `@deepseek-ai/dsh-client-ui-deliverables` — it registers into
 * the turn tail and owns the `changes-review` right-Sidebar tab. Rebuilding it
 * here would put two cards on the same turn, so this plugin does not.
 */
window.__ModuleLoader__.load({
  id: '@muen/dsh-turn-summary',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'muen-turn-summary';

    /** Action buckets, in display order, with their dictionary key. */
    const BUCKETS = ['edited', 'read', 'ran', 'searched', 'browsed', 'subagent', 'asked', 'planned', 'other'];

    /**
     * Turns the reader expanded by hand, `sessionId:turn`. Auto-fold must never
     * fight a person: a turn in here is left alone.
     */
    const expandedByHand = new Set();

    const EN = {
      'processed': 'Processed {duration}',
      'processedPlain': 'Processed',
      'working': 'Working',
      'steps.one': '{count} step',
      'steps.other': '{count} steps',
      'tokens': '{count} tokens',
      'edited.one': 'Edited {count} file',
      'edited.other': 'Edited {count} files',
      'read.one': 'Read {count} file',
      'read.other': 'Read {count} files',
      'ran.one': 'Ran {count} command',
      'ran.other': 'Ran {count} commands',
      'searched.one': 'Searched the web {count} time',
      'searched.other': 'Searched the web {count} times',
      'browsed.one': 'Used the browser {count} time',
      'browsed.other': 'Used the browser {count} times',
      'subagent.one': 'Delegated {count} subagent',
      'subagent.other': 'Delegated {count} subagents',
      'asked.one': 'Asked {count} question',
      'asked.other': 'Asked {count} questions',
      'planned.one': 'Updated the plan {count} time',
      'planned.other': 'Updated the plan {count} times',
      'other.one': 'Used {count} other tool',
      'other.other': 'Used {count} other tools',
      'expand': 'Show what happened',
      'collapse': 'Hide what happened',
      'durationSeconds': '{value}s',
      'durationMinutes': '{minutes}m {seconds}s',
      'durationHours': '{hours}h {minutes}m',
    };

    const ZH = {
      'processed': '已处理 {duration}',
      'processedPlain': '已处理',
      'working': '处理中',
      'steps.one': '{count} 步',
      'steps.other': '{count} 步',
      'tokens': '{count} tokens',
      'edited.one': '编辑了 {count} 个文件',
      'edited.other': '编辑了 {count} 个文件',
      'read.one': '读取了 {count} 个文件',
      'read.other': '读取了 {count} 个文件',
      'ran.one': '运行了 {count} 条命令',
      'ran.other': '运行了 {count} 条命令',
      'searched.one': '联网搜索 {count} 次',
      'searched.other': '联网搜索 {count} 次',
      'browsed.one': '使用浏览器 {count} 次',
      'browsed.other': '使用浏览器 {count} 次',
      'subagent.one': '委派了 {count} 个子代理',
      'subagent.other': '委派了 {count} 个子代理',
      'asked.one': '提问 {count} 次',
      'asked.other': '提问 {count} 次',
      'planned.one': '更新计划 {count} 次',
      'planned.other': '更新计划 {count} 次',
      'other.one': '使用了 {count} 个其他工具',
      'other.other': '使用了 {count} 个其他工具',
      'expand': '展开工作过程',
      'collapse': '收起工作过程',
      'durationSeconds': '{value}秒',
      'durationMinutes': '{minutes}分{seconds}秒',
      'durationHours': '{hours}小时{minutes}分',
    };

    /**
     * Replaced in apply() once the locale service is bound. The fallback keeps a
     * render that somehow precedes apply() from throwing on a missing key.
     */
    let translate = function (key, params) {
      const template = EN[key];
      if (template === undefined) return key;
      return interpolate(template, params);
    };

    /** `{name}` substitution; a missing param stays literal so a bug is visible. */
    function interpolate(template, params) {
      if (params === undefined || params === null) return template;
      return String(template).replace(/\{(\w+)\}/g, function (match, name) {
        const value = params[name];
        return value === undefined || value === null ? match : String(value);
      });
    }

    /** Localized count phrase: `steps.one` / `steps.other`. */
    function plural(bucket, count) {
      return translate(bucket + (count === 1 ? '.one' : '.other'), { count: count });
    }

    /**
     * Which summary bucket one durable tool name belongs to. Prefix rules, not
     * an exhaustive table: an unknown name falls into `other` and still counts.
     */
    function bucketOf(name) {
      const n = String(name === undefined || name === null ? '' : name).toLowerCase();
      if (n === '') return 'other';
      if (/^(write|edit|str_replace|apply_patch|multi_edit|notebook_edit|create_file|delete_file|move_file)/.test(n)) return 'edited';
      if (/^(read|read_image|glob|grep|list_directory|file_search|search_files|ls)/.test(n)) return 'read';
      if (/^(bash|shell|run_command|exec|terminal|process)/.test(n)) return 'ran';
      if (/^(web_search|web_fetch|search_web|fetch)/.test(n)) return 'searched';
      if (/(browser|browse|playwright|puppeteer|chrome|screenshot)/.test(n)) return 'browsed';
      if (/^(subagent|subagent_fork|delegate|task)/.test(n)) return 'subagent';
      if (/^(ask_user_question|ask_user)/.test(n)) return 'asked';
      if (/^(todo_write|update_plan|plan)/.test(n)) return 'planned';
      return 'other';
    }

    /** Milliseconds → `9.4s` / `48s` / `1m 26s` / `1h 04m`. */
    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
      const seconds = ms / 1000;
      if (seconds < 10) return translate('durationSeconds', { value: seconds.toFixed(1) });
      if (seconds < 60) return translate('durationSeconds', { value: Math.round(seconds) });
      const totalMinutes = Math.floor(seconds / 60);
      if (totalMinutes < 60) {
        return translate('durationMinutes', {
          minutes: totalMinutes,
          seconds: Math.round(seconds - totalMinutes * 60),
        });
      }
      const hours = Math.floor(totalMinutes / 60);
      return translate('durationHours', { hours: hours, minutes: totalMinutes - hours * 60 });
    }

    /** 24500 → `24.5K`, 1000000 → `1M`, 812 → `812`. */
    function formatTokens(count) {
      if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null;
      if (count >= 1000000) {
        const millions = count / 1000000;
        return (Number.isInteger(millions) ? millions : millions.toFixed(1)) + 'M';
      }
      if (count >= 1000) return (count / 1000).toFixed(count < 100000 ? 1 : 0) + 'K';
      return String(count);
    }

    /** The empty reading, and the shape `signature()` always returns. */
    function emptyReading() {
      return { d: null, steps: 0, counts: {}, tok: null };
    }

    /**
     * Fold one turn's Chat nodes into a plain reading.
     *
     * Pure and cheap: it runs inside a selector, so it must not mutate anything
     * and must stay safe while the window is partial (loading, fork, a
     * compaction that cut the turn's head off).
     */
    function signature(snapshot, turn) {
      const reading = emptyReading();
      try {
        if (snapshot === null || snapshot === undefined) return JSON.stringify(reading);
        const legacy = snapshot.legacy;
        const locations = snapshot.locations;
        const nodes = snapshot.nodes;
        if (legacy === undefined || locations === undefined || nodes === undefined) return JSON.stringify(reading);

        if (legacy.turnTimings !== undefined) {
          const timing = legacy.turnTimings.get(turn);
          if (timing !== undefined && timing !== null && typeof timing.startTime === 'number' && typeof timing.endTime === 'number') {
            const ms = timing.endTime - timing.startTime;
            if (ms >= 0) reading.d = ms;
          }
        }

        const keys = locations.getTurn(turn);
        if (!keys) return JSON.stringify(reading);
        for (let i = 0; i < keys.length; i++) {
          const node = nodes.get(keys[i]);
          if (node === null || node === undefined) continue;
          if (node.kind === 'tool-call') {
            const root = node.data === undefined || node.data === null ? undefined : node.data.root;
            if (root === undefined || root === null) continue;
            const call = root.call === undefined || root.call === null ? null : root.call;
            const bucket = bucketOf(call === null ? root.name : call.name);
            reading.counts[bucket] = (reading.counts[bucket] || 0) + 1;
          } else if (node.kind === 'assistant-step') {
            reading.steps += 1;
          } else if (node.kind === 'turn-tail') {
            const data = node.data === undefined || node.data === null ? undefined : node.data;
            const usage = data === undefined ? undefined : data.tokenUsage;
            if (usage !== undefined && usage !== null && typeof usage.totalTokens === 'number') {
              reading.tok = usage.totalTokens;
            }
          }
        }
      } catch (error) {
        // A partial or reshaping snapshot must never take the transcript down.
        return JSON.stringify(emptyReading());
      }
      return JSON.stringify(reading);
    }

    /** Guard: no node or no hooks means no row, never a throw inside the flow. */
    function TurnProcessHeader(props) {
      if (props === undefined || props === null) return null;
      if (props.node === undefined || props.node === null) return null;
      if (typeof props.useChat !== 'function') return null;
      return h(TurnProcessHeaderInner, props);
    }

    function TurnProcessHeaderInner(props) {
      const data = props.node.data === undefined || props.node.data === null ? {} : props.node.data;
      const turnNumber = typeof data.turn === 'number' ? data.turn : null;
      const process = props.turnProcess;

      const encoded = props.useChat(function (snapshot) {
        return turnNumber === null ? JSON.stringify(emptyReading()) : signature(snapshot, turnNumber);
      });

      let reading = emptyReading();
      try {
        if (typeof encoded === 'string') reading = JSON.parse(encoded);
      } catch (error) {
        reading = emptyReading();
      }

      const foldKey = String(props.sessionId === undefined ? '' : props.sessionId) + ':' + String(turnNumber);
      const canFold = process !== undefined && process !== null && typeof process.setOpen === 'function';

      /**
       * The host hides this row's whole wrapper when the disclosure is not
       * foldable — `controllerInactive` -> `data-turn-process-hidden`, which its
       * CSS collapses — and the shipped renderer returns null for the same case.
       * Painting into that wrapper is invisible work, so `foldable` is the gate.
       * It is the host's own verdict and already requires a closed Turn, a
       * finalized answer boundary, a complete history window and the compact
       * transcript mode (default `compact`).
       */
      const foldable = canFold && process.foldable === true;
      const open = foldable && process.open === true;
      const spec = canFold ? process.spec : undefined;
      /** `setOpen` itself no-ops until a finalized answer step exists. */
      const answered = spec !== undefined && spec !== null && spec.answerStep !== null;

      // Fold a finished turn, and never re-fold one the reader opened by hand.
      React.useEffect(
        function () {
          if (!foldable || !answered) return;
          if (expandedByHand.has(foldKey)) return;
          if (process.open === true) {
            try {
              process.setOpen(false);
            } catch (error) {
              // A refused toggle is not worth a broken row.
            }
          }
        },
        [foldable, answered, foldKey, open],
      );

      if (!foldable) return null;

      const counts = reading.counts === undefined || reading.counts === null ? {} : reading.counts;
      const duration = formatDuration(reading.d);
      // Kun's turn row is the duration and nothing else: the read/edited/ran
      // breakdown belongs to the per-run chips one level down, which the fold
      // plugin contributes. Repeating it here would say everything twice.
      const text = answered
        ? duration === null
          ? translate('processedPlain')
          : translate('processed', { duration: duration })
        : translate('working');

      const details = [];
      if (reading.steps > 0) details.push(plural('steps', reading.steps));
      for (let i = 0; i < BUCKETS.length; i++) {
        const count = counts[BUCKETS[i]];
        if (typeof count === 'number' && count > 0) details.push(plural(BUCKETS[i], count));
      }
      const tokens = formatTokens(reading.tok);
      if (tokens !== null) details.push(translate('tokens', { count: tokens }));
      const tooltip = details.length === 0 ? text : text + ' \u00b7 ' + details.join(' \u00b7 ');
      const label = open ? translate('collapse') : translate('expand');
      const content = [
        h(
          'span',
          {
            key: 'chevron',
            'aria-hidden': 'true',
            style: {
              display: 'inline-block',
              width: '0.85em',
              opacity: 0.7,
              fontSize: '0.9em',
              transform: open ? 'none' : 'none',
            },
          },
          open ? '\u25be' : '\u25b8',
        ),
        h('span', { key: 'text', style: { minWidth: 0 } }, text),
      ];

      const rowStyle = {
        appearance: 'none',
        border: 0,
        background: 'transparent',
        font: 'inherit',
        color: 'inherit',
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: '5px',
        maxWidth: '100%',
        padding: '2px 6px 2px 2px',
        margin: 0,
        borderRadius: '6px',
        textAlign: 'left',
        lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
        cursor: 'pointer',
      };

      return h(
        'div',
        {
          'data-muen-turn-summary': 'fold',
          'data-turn': turnNumber === null ? '' : String(turnNumber),
          style: {
            boxSizing: 'border-box',
            display: 'block',
            fontFamily: 'inherit',
            fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
            color: 'var(--dsw-alias-label-tertiary)',
          },
        },
        h(
          'button',
          {
            type: 'button',
            'aria-expanded': open ? 'true' : 'false',
            title: tooltip,
            'aria-label': label + ' \u2014 ' + tooltip,
            onClick: function () {
              try {
                if (open) {
                  expandedByHand.delete(foldKey);
                  process.setOpen(false);
                } else {
                  expandedByHand.add(foldKey);
                  process.setOpen(true);
                }
              } catch (error) {
                // Toggling is the host's; a refusal leaves the fold as it was.
              }
            },
            style: rowStyle,
          },
          content,
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // The dictionaries are resources this plugin owns, so registration rides
        // ctx.effect and leaves with the plugin. A duplicate (ns, locale) throws
        // — which a hot reload can race — and losing a dictionary must not take
        // the row down with it.
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

        ctx.slots.inject('conversation.chat.node', function () {
          // The harness ships its own `turn-process` renderer at priority 0, and a
          // keyed slot REFUSES a same-priority duplicate rather than replacing it:
          //
          //   keyed slot "conversation.chat.node" already has an entry for key
          //   "turn-process" at priority 0 — register at a different priority to
          //   shadow it (lowest renders)
          //
          // Without a priority this plugin mounted nothing at all, silently — the
          // throw is one console line and the host's row renders in its place, so
          // the surface looked merely unimproved rather than broken. Measured
          // 2026-09-18 by a fresh-profile mount probe; the occupant list of the
          // running app had every native key and no muen entry.
          return ctx.slots.register(
            {
              name: 'conversation.chat.node',
              key: 'turn-process',
              priority: -1,
            },
            TurnProcessHeader,
          );
        });
      },
    };
  },
});
