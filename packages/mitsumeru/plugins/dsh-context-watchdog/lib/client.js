/**
 * context-watchdog — Client half.
 *
 * Two surfaces, two jobs:
 *
 *   1. the alert  — `conversation.input.dock`: a full-width banner above the
 *      composer once this session's context passes the policy's threshold,
 *      offering the two things a reader can actually do about it.
 *   2. the policy — `settings.general.item`: the row that owns the threshold,
 *      under Settings → General, beside "Conversation display".
 *
 * The banner replaced an ambient chip in `conversation.composer.dock`. The host
 * already renders its own context meter beside the composer, so a second quiet
 * number was duplication; what was missing was an *actionable* surface. The
 * banner offers every choice plainly and lets the reader make it:
 *
 *     [ New session ]   [ Snooze ▾ ]   [ × ]
 *                          ├ Until 400K (next band)
 *                          └ For 20 minutes
 *
 * `uiWorkspace.startSession()` parks the current session in the sidebar — it is
 * not destroyed — so the choice is about cost, not about losing work.
 *
 * ── the threshold policy ─────────────────────────────────────────────────────
 * A fixed token count cannot serve models with different windows: 300K never
 * fires on a 128K model and is 30% of a 1M one. A percentage alone cannot serve
 * cost: 35% of a 32K window is 11K, which would nag far earlier than it saves.
 * So the default is a percentage that never fires *later* than a ceiling, and
 * never *earlier* than a floor:
 *
 *     auto  : max(FLOOR, min(percent% × contextWindow, CEILING))
 *     fixed : the count you type
 *
 * The percentage protects the window; the ceiling protects the wallet. On a 1M
 * window the ceiling binds (300K — the old default, unchanged); on a 200K window
 * the percentage binds (70K). `contextWindow` is the routed model's own capacity
 * ("newest recorded route capacity"), so switching model re-derives the
 * threshold with no per-model table to maintain.
 *
 * ── the snooze rule ──────────────────────────────────────────────────────────
 * Snoozing is banded by *tokens*, not by time, because tokens are the metric: a
 * time snooze can expire exactly as a long expensive stretch begins. One band is
 * 10% of the window past the trigger, and **never past 85%** — beyond that the
 * alert is about quality (compaction, drift, repeated work) rather than cost, so
 * it re-arms whether or not the reader snoozed. The time option exists because
 * some readers think in time; the token option is the one that cannot mislead.
 *
 * ── where the numbers come from ──────────────────────────────────────────────
 * The `contextPressure` projection — the same source the host's own ContextMeter
 * reads: `{ projectedTokens?: number, pressureTokens?: number, contextWindow: number }`.
 * `projectedTokens` wins when present (it accounts for what the NEXT request
 * would carry, including a compaction that just shadowed a span).
 *
 * ── why localStorage ────────────────────────────────────────────────────────
 * A Host settings namespace would need `@deepseek-ai/schemastery`, which a
 * workspace-linked bundle cannot resolve — the wall that made
 * `@muen/dsh-codex-fold` inert on its first install. So the row owns its own
 * value: a JSON document in localStorage, with a listener set so the row and the
 * banner stay in step. Moving to a real namespace later means shipping the bundle
 * as a tarball (or vendoring schemastery), nothing more.
 */
window.__ModuleLoader__.load({
  id: '@muen/dsh-context-watchdog',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'context-watchdog';
    const STORE_KEY = 'dsh-context-watchdog.settings';
    const LEGACY_KEY = 'dsh-context-watchdog.threshold';

    const DEFAULTS = { mode: 'auto', percent: 35, ceiling: 300000, floor: 25000, fixed: 300000 };
    const LIMITS = { percent: [1, 95], ceiling: [1000, 10000000], floor: [1000, 10000000], fixed: [1000, 10000000] };

    /** Past this share the alert is about quality, not cost, and cannot be snoozed. */
    const SNOOZE_CAP_SHARE = 0.85;
    /** One snooze band, as a share of the window. */
    const SNOOZE_BAND_SHARE = 0.1;
    /** The time-based option, for readers who think in time. */
    const SNOOZE_MINUTES = 20;

    const DICT = {
      title: 'Context {used} of {window} ({percent}%)',
      copyConsider: 'Starting a fresh session for the next task keeps this one fast and cheap.',
      copyRecommend: 'Recommended: start a fresh session for the next task.',
      copyStrong: 'Strongly recommended: every step now re-sends this whole context.',
      copyCritical: 'Compaction is likely. Starting a fresh session keeps you in control of what is carried forward.',
      newSession: 'New session',
      newSessionTitle: 'Starts an empty session; this one stays in the sidebar',
      snooze: 'Snooze',
      snoozeTitle: 'Hide this until one of these is true',
      snoozeBand: 'Until {tokens} (next band)',
      snoozeTime: 'For {minutes} minutes',
      snoozeBlocked: 'At {share}% this cannot be snoozed — start a fresh session or expect compaction.',
      dismiss: 'Dismiss',
      rowTitle: 'Context reminder',
      rowDescription: 'When to suggest starting a new session.',
      modeAuto: 'Auto (%)',
      modeFixed: 'Fixed tokens',
      percentLabel: 'Percent of window',
      ceilingLabel: 'Ceiling (tokens)',
      floorLabel: 'Floor (tokens)',
      fixedLabel: 'Tokens',
      ruleAuto: 'Fires at {percent}% of the model’s window, never above {ceiling} and never below {floor}.',
      ruleFixed: 'Fires at {fixed} tokens, whatever the model’s window.',
      preview: 'Last seen window {window} → fires at {threshold}',
      previewTooSmall: 'Last seen window {window} is too small for this policy — the reminder stays silent.',
      previewNone: 'Open a session to see the threshold for the model in use.',
    };

    const ZH = {
      title: '上下文 {used} / {window}（{percent}%）',
      copyConsider: '下一个任务开新会话，可以让当前会话保持快速且省钱。',
      copyRecommend: '建议：下一个任务开新会话。',
      copyStrong: '强烈建议：现在每一步都会重发整个上下文。',
      copyCritical: '很可能触发压缩。开新会话可以让你决定保留什么。',
      newSession: '新会话',
      newSessionTitle: '开启空白会话；当前会话仍保留在侧边栏',
      snooze: '稍后提醒',
      snoozeTitle: '满足以下任一条件前不再提示',
      snoozeBand: '到 {tokens} 再提醒（下一档）',
      snoozeTime: '{minutes} 分钟后提醒',
      snoozeBlocked: '已达 {share}%，无法再延后 — 请开新会话，否则将触发压缩。',
      dismiss: '关闭',
      rowTitle: '上下文提醒',
      rowDescription: '何时建议开启新会话。',
      modeAuto: '自动（百分比）',
      modeFixed: '固定 tokens',
      percentLabel: '窗口百分比',
      ceilingLabel: '上限（tokens）',
      floorLabel: '下限（tokens）',
      fixedLabel: 'Tokens',
      ruleAuto: '达到模型窗口的 {percent}% 时提醒，不超过 {ceiling}，不低于 {floor}。',
      ruleFixed: '无论模型窗口多大，达到 {fixed} tokens 时提醒。',
      preview: '最近窗口 {window} → 提醒于 {threshold}',
      previewTooSmall: '最近窗口 {window} 对当前策略太小 — 提醒将保持静默。',
      previewNone: '打开一个会话即可看到当前模型的提醒阈值。',
    };

    /** Replaced in apply() once the locale service is bound. */
    let translate = function (key, params) {
      const template = DICT[key];
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

    // ── the settings document ────────────────────────────────────────────────
    const listeners = new Set();
    let version = 0;
    let settings = read();

    function clampNumber(value, range, fallback) {
      const parsed = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(range[1], Math.max(range[0], Math.round(parsed)));
    }

    function normalize(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {};
      const mode = source.mode === 'fixed' ? 'fixed' : 'auto';
      return {
        mode: mode,
        percent: clampNumber(source.percent, LIMITS.percent, DEFAULTS.percent),
        ceiling: clampNumber(source.ceiling, LIMITS.ceiling, DEFAULTS.ceiling),
        floor: clampNumber(source.floor, LIMITS.floor, DEFAULTS.floor),
        fixed: clampNumber(source.fixed, LIMITS.fixed, DEFAULTS.fixed),
      };
    }

    /** Read the stored document, migrating the pre-policy single threshold. */
    function read() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY);
        if (raw !== null) return normalize(JSON.parse(raw));
      } catch (error) {
        // A blocked or corrupt read falls through to the legacy key.
      }
      try {
        const legacy = window.localStorage.getItem(LEGACY_KEY);
        if (legacy !== null) {
          const parsed = Number(legacy);
          if (Number.isFinite(parsed) && parsed > 0) {
            return normalize({ mode: 'fixed', fixed: parsed });
          }
        }
      } catch (error) {
        // Ignore and take the defaults.
      }
      return normalize(DEFAULTS);
    }

    /** Tell every mounted surface that shared state moved. */
    function notify() {
      version += 1;
      listeners.forEach(function (listener) {
        try {
          listener();
        } catch (error) {
          // one listener must not stop the others
        }
      });
    }

    function write(next) {
      settings = normalize(next);
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(settings));
      } catch (error) {
        // Persistence failing must not cost the reader their session.
      }
      notify();
    }

    function subscribe(listener) {
      listeners.add(listener);
      return function () {
        listeners.delete(listener);
      };
    }

    function getVersion() {
      return version;
    }

    /** Stable per page: the row and the banner read the same document. */
    function useSettings() {
      React.useSyncExternalStore(subscribe, getVersion, getVersion);
      return settings;
    }

    /**
     * The policy. `undefined` means "no alert for this window": a window too
     * small for the floor cannot be nudged usefully, and an alert that cannot be
     * computed must stay silent.
     */
    function thresholdFor(policy, windowSize) {
      if (policy.mode === 'fixed') {
        return windowSize !== undefined && windowSize > 0 && policy.fixed >= windowSize ? undefined : policy.fixed;
      }
      if (typeof windowSize !== 'number' || !Number.isFinite(windowSize) || windowSize <= 0) return undefined;
      const byPercent = (windowSize * policy.percent) / 100;
      const chosen = Math.max(policy.floor, Math.min(byPercent, policy.ceiling));
      if (chosen >= windowSize) return undefined;
      return Math.round(chosen);
    }

    /** 312000 -> "312K", 1000000 -> "1M", 800 -> "800". */
    function formatTokens(count) {
      if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null;
      if (count >= 1000000) {
        const millions = count / 1000000;
        return (Number.isInteger(millions) ? millions : millions.toFixed(1)) + 'M';
      }
      if (count >= 1000) return Math.round(count / 1000) + 'K';
      return String(count);
    }

    /** The window the banner last saw, so the root-scoped row can preview it. */
    let lastWindow;

    /** Dismissed alerts and snoozes, per session: the reader's own choices. */
    const dismissed = new Set();
    const snoozes = new Map();

    function snoozeOf(sessionId) {
      return snoozes.has(sessionId) ? snoozes.get(sessionId) : null;
    }

    /** Snooze until the context passes `untilTokens` — one band past the trigger. */
    function snoozeToBand(sessionId, untilTokens) {
      snoozes.set(sessionId, { untilTokens: untilTokens });
      notify();
    }

    /** Snooze for a fixed wall-clock stretch. */
    function snoozeForMinutes(sessionId, minutes) {
      snoozes.set(sessionId, { untilTime: Date.now() + minutes * 60000 });
      notify();
    }

    /**
     * The next re-arm point, never past the quality cap, and always far enough
     * ahead of where the reader already is to be worth respecting.
     */
    function nextBandFor(threshold, used, windowSize) {
      const step = Math.round(windowSize * SNOOZE_BAND_SHARE);
      const cap = Math.round(windowSize * SNOOZE_CAP_SHARE);
      const candidate = Math.max(Math.round(threshold) + step, Math.round(used) + step);
      return Math.min(candidate, cap);
    }

    // ── the glyphs ───────────────────────────────────────────────────────────
    /**
     * The app's own icon set, when it is reachable. `@deepseek-ai/dsh-client-ui-primitives`
     * is a client module the shipped chat/trajectory plugins already require, so a
     * plugin can too — and then the banner's glyphs match every other glyph in the
     * UI. Wrapped because a module that is not in the browser module table must
     * degrade to the inlined fallback, not break the banner.
     */
    let hostIcons = null;
    try {
      hostIcons = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (error) {
      hostIcons = null;
    }

    function hostIcon(name, size) {
      const component = hostIcons === null || hostIcons === undefined ? undefined : hostIcons[name];
      return typeof component === 'function' ? h(component, { size: size }) : null;
    }

    /**
     * Lucide `triangle-alert`, inlined — the fallback when the host set is not
     * reachable. Icon geometry from lucide-static 1.47.0 (ISC licence). Explicit
     * width/height: an SVG with a viewBox and no intrinsic size paints at the
     * 300x150 px default, which is a defect this project has already met once.
     */
    function InlineTriangleAlert(props) {
      const size = props !== undefined && props.size !== undefined ? props.size : 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { flex: 'none', display: 'block' },
        },
        [
          h('path', { key: 'body', d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }),
          h('path', { key: 'stem', d: 'M12 9v4' }),
          h('path', { key: 'dot', d: 'M12 17h.01' }),
        ],
      );
    }

    /** The alert's leading glyph: the app's, else the inline triangle. */
    function WarningGlyph(props) {
      const size = props !== undefined && props.size !== undefined ? props.size : 16;
      const native = hostIcon('IconWarningOutline16', size);
      return native === null ? h(InlineTriangleAlert, { size: size }) : native;
    }

    /** The dismiss control's glyph: the app's, else a text multiplication sign. */
    function CloseGlyph() {
      const native = hostIcon('IconCloseOutline16', 12);
      return native === null ? '\u00d7' : native;
    }

    // ── surface 1: the banner ────────────────────────────────────────────────
    const actionStyle = {
      appearance: 'none',
      font: 'inherit',
      fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
      lineHeight: 1.35,
      padding: '4px 10px',
      borderRadius: '7px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    };

    function primaryActionStyle() {
      return Object.assign({}, actionStyle, {
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-label-primary-inverted, #fff)',
      });
    }

    function ghostActionStyle() {
      return Object.assign({}, actionStyle, {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
      });
    }

    function menuItemStyle(disabled) {
      return {
        appearance: 'none',
        border: 0,
        background: 'transparent',
        font: 'inherit',
        fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
        lineHeight: 1.4,
        textAlign: 'left',
        width: '100%',
        padding: '6px 10px',
        borderRadius: '6px',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        color: 'var(--dsw-alias-label-secondary)',
      };
    }

    function ContextBanner(props) {
      if (typeof props.useProjection !== 'function') return null;
      return h(ContextBannerInner, props);
    }

    function ContextBannerInner(props) {
      const policy = useSettings();
      const menuState = React.useState(false);
      const menuOpen = menuState[0];
      const setMenuOpen = menuState[1];
      const pressure = props.useProjection('contextPressure');
      const sessionId = props.sessionId === undefined || props.sessionId === null ? '' : String(props.sessionId);

      const used =
        pressure === undefined || pressure === null
          ? undefined
          : pressure.projectedTokens !== undefined
            ? pressure.projectedTokens
            : pressure.pressureTokens;
      const windowSize = pressure === undefined || pressure === null ? undefined : pressure.contextWindow;
      if (typeof windowSize === 'number' && windowSize > 0) lastWindow = windowSize;

      const snooze = snoozeOf(sessionId);
      const timeSnoozed = snooze !== null && typeof snooze.untilTime === 'number' && Date.now() < snooze.untilTime;
      const untilTime = timeSnoozed ? snooze.untilTime : null;

      // A time snooze has to expire on its own; nothing else re-renders this.
      React.useEffect(
        function () {
          if (untilTime === null) return undefined;
          const handle = window.setTimeout(notify, Math.max(500, untilTime - Date.now() + 50));
          return function () {
            window.clearTimeout(handle);
          };
        },
        [untilTime],
      );

      const threshold = thresholdFor(policy, windowSize);
      const measurable = threshold !== undefined && typeof used === 'number' && Number.isFinite(used);
      const bandSnoozed = snooze !== null && typeof snooze.untilTokens === 'number';
      const suppressed =
        dismissed.has(sessionId) || timeSnoozed || (bandSnoozed && used < snooze.untilTokens);
      if (!measurable || used < threshold || suppressed) return null;

      const share = windowSize > 0 ? (used / windowSize) * 100 : 0;
      const percent = Math.round(share);
      const copyKey =
        share >= 85 ? 'copyCritical' : share >= 70 ? 'copyStrong' : share >= 50 ? 'copyRecommend' : 'copyConsider';

      const nextBand = nextBandFor(threshold, used, windowSize);
      const canBandSnooze = share < SNOOZE_CAP_SHARE * 100 && nextBand > used;
      const canStart = typeof props.startSession === 'function';

      const actions = [];
      if (canStart) {
        actions.push(
          h(
            'button',
            {
              key: 'new-session',
              type: 'button',
              'data-context-watchdog': 'new-session',
              title: translate('newSessionTitle'),
              onClick: function () {
                dismissed.add(sessionId);
                try {
                  props.startSession();
                } catch (error) {
                  // A refused start leaves the banner in place.
                }
                notify();
              },
              style: primaryActionStyle(),
            },
            translate('newSession'),
          ),
        );
      }

      if (canBandSnooze || !timeSnoozed) {
        actions.push(
          h(
            'button',
            {
              key: 'snooze',
              type: 'button',
              'data-context-watchdog': 'snooze',
              'aria-expanded': menuOpen ? 'true' : 'false',
              title: translate('snoozeTitle'),
              onClick: function () {
                setMenuOpen(!menuOpen);
              },
              style: ghostActionStyle(),
            },
            translate('snooze') + ' \u25be',
          ),
        );
      }

      actions.push(
        h(
          'button',
          {
            key: 'dismiss',
            type: 'button',
            'data-context-watchdog': 'dismiss',
            title: translate('dismiss'),
            'aria-label': translate('dismiss'),
            onClick: function () {
              dismissed.add(sessionId);
              notify();
            },
            style: Object.assign({}, ghostActionStyle(), { padding: '4px 7px', display: 'inline-flex', alignItems: 'center' }),
          },
          h(CloseGlyph, {}),
        ),
      );

      const children = [
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
              color: 'var(--dsw-alias-state-warn-primary)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            },
          },
          h(WarningGlyph, { size: 16 }),
        ),
        h('span', { key: 'titles', style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' } }, [
          h(
            'span',
            {
              key: 'title',
              style: {
                color: 'var(--dsw-alias-label-primary)',
                fontSize: 'var(--dsh-content-font-size, 14px)',
                fontWeight: 600,
                lineHeight: 1.35,
              },
            },
            translate('title', {
              used: formatTokens(used),
              window: formatTokens(windowSize),
              percent: percent,
            }),
          ),
          h(
            'span',
            {
              key: 'copy',
              style: {
                color: 'var(--dsw-alias-label-tertiary)',
                fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
                lineHeight: 1.4,
              },
            },
            translate(copyKey),
          ),
        ]),
        h(
          'span',
          { key: 'actions', style: { display: 'inline-flex', alignItems: 'center', gap: '6px', flex: '0 0 auto' } },
          actions,
        ),
      ];

      if (menuOpen) {
        const items = [];
        items.push(
          h(
            'button',
            {
              key: 'band',
              type: 'button',
              'data-context-watchdog': 'snooze-band',
              disabled: !canBandSnooze,
              onClick: function () {
                if (!canBandSnooze) return;
                snoozeToBand(sessionId, nextBand);
                setMenuOpen(false);
              },
              style: menuItemStyle(!canBandSnooze),
            },
            canBandSnooze
              ? translate('snoozeBand', { tokens: formatTokens(nextBand) })
              : translate('snoozeBlocked', { share: percent }),
          ),
        );
        items.push(
          h(
            'button',
            {
              key: 'time',
              type: 'button',
              'data-context-watchdog': 'snooze-time',
              onClick: function () {
                snoozeForMinutes(sessionId, SNOOZE_MINUTES);
                setMenuOpen(false);
              },
              style: menuItemStyle(false),
            },
            translate('snoozeTime', { minutes: SNOOZE_MINUTES }),
          ),
        );
        children.push(
          h(
            'div',
            {
              key: 'menu',
              'data-context-watchdog': 'snooze-menu',
              style: {
                position: 'absolute',
                zIndex: 20,
                right: '14px',
                top: '100%',
                marginTop: '4px',
                minWidth: '220px',
                padding: '4px',
                border: '1px solid var(--dsw-alias-border-l1)',
                borderRadius: '8px',
                background: 'var(--dsw-alias-bg-overlay)',
                boxShadow: '0 6px 20px rgba(0, 0, 0, 0.12)',
              },
            },
            items,
          ),
        );
      }

      return h(
        'div',
        {
          'data-context-watchdog': 'banner',
          role: 'status',
          style: {
            boxSizing: 'border-box',
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            // Match the composer card's box, not just its cap. Two things put a
            // dock entry off-centre if you get them wrong, and the harness's own
            // goal banner (`GoalBar.module.css`) is the reference for both:
            //
            //   * `margin: 0 auto` — a dock entry is a flex child of the stack
            //     (which stretches), so without an auto inline margin a capped
            //     entry sits at the stack's *start*, not under the centred card.
            //   * the side clearance — the card lives inside a wrapper that pads
            //     by `--dsh-composer-side-clearance`, so an entry that keeps the
            //     full width is that much wider than the card on a narrow window.
            //
            // Both the width and the cap are tokens, so the banner follows the
            // composer through any resize — window, sidebar, or panel — exactly
            // as the card does. (`--dsh-composer-height`, which the seat sets at
            // runtime, is the card's height and does not concern this row.)
            width: 'calc(100% - 2 * var(--dsh-composer-side-clearance))',
            maxWidth: 'var(--dsh-composer-card-max-width)',
            margin: '0 auto 8px',
            padding: '10px 14px',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '12px',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-primary)',
            fontFamily: 'inherit',
          },
        },
        children,
      );
    }

    // ── surface 2: the policy row ────────────────────────────────────────────
    const labelStyle = {
      display: 'block',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 'var(--dsh-content-font-size, 14px)',
      lineHeight: 1.4,
    };
    const descriptionStyle = {
      display: 'block',
      marginTop: '2px',
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
      lineHeight: 1.4,
    };
    const ruleStyle = {
      display: 'block',
      marginTop: '6px',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
      lineHeight: 1.4,
    };

    function segmentStyle(active) {
      return {
        appearance: 'none',
        font: 'inherit',
        fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
        padding: '4px 10px',
        borderRadius: '6px',
        cursor: 'pointer',
        border: '1px solid ' + (active ? 'var(--dsw-alias-border-l2)' : 'var(--dsw-alias-border-l1)'),
        background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
      };
    }

    function numberField(key, label) {
      const range = LIMITS[key];
      return h(
        'label',
        {
          key: key,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
          },
        },
        [
          h('span', { key: 'label' }, label),
          h('input', {
            key: 'input',
            type: 'number',
            inputMode: 'numeric',
            min: range[0],
            max: range[1],
            step: key === 'percent' ? 1 : 1000,
            value: String(settings[key]),
            'data-context-watchdog': 'input-' + key,
            onChange: function (event) {
              const next = {};
              next[key] = event.target.value === '' ? settings[key] : Number(event.target.value);
              write(Object.assign({}, settings, next));
            },
            style: {
              width: '96px',
              boxSizing: 'border-box',
              padding: '3px 6px',
              borderRadius: '6px',
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-1)',
              color: 'var(--dsw-alias-label-primary)',
              font: 'inherit',
              fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
            },
          }),
        ],
      );
    }

    function ThresholdRow() {
      useSettings();
      const auto = settings.mode === 'auto';
      const threshold = thresholdFor(settings, lastWindow);

      let preview = translate('previewNone');
      if (typeof lastWindow === 'number' && lastWindow > 0) {
        preview =
          threshold === undefined
            ? translate('previewTooSmall', { window: formatTokens(lastWindow) })
            : translate('preview', { window: formatTokens(lastWindow), threshold: formatTokens(threshold) });
      }

      const rule = auto
        ? translate('ruleAuto', {
            percent: settings.percent,
            ceiling: formatTokens(settings.ceiling),
            floor: formatTokens(settings.floor),
          })
        : translate('ruleFixed', { fixed: formatTokens(settings.fixed) });

      const fields = auto
        ? [
            numberField('percent', translate('percentLabel')),
            numberField('ceiling', translate('ceilingLabel')),
            numberField('floor', translate('floorLabel')),
          ]
        : [numberField('fixed', translate('fixedLabel'))];

      return h(
        'div',
        {
          'data-context-watchdog': 'settings-row',
          style: { boxSizing: 'border-box', display: 'block', padding: '2px 0' },
        },
        [
          h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, [
            h('span', { key: 'titles', style: { flex: '1 1 auto', minWidth: 0 } }, [
              h('span', { key: 'label', style: labelStyle }, translate('rowTitle')),
              h('span', { key: 'desc', style: descriptionStyle }, translate('rowDescription')),
            ]),
            h('span', { key: 'modes', style: { display: 'inline-flex', gap: '6px' } }, [
              h(
                'button',
                {
                  key: 'auto',
                  type: 'button',
                  'data-context-watchdog': 'mode-auto',
                  'aria-pressed': auto ? 'true' : 'false',
                  onClick: function () {
                    write(Object.assign({}, settings, { mode: 'auto' }));
                  },
                  style: segmentStyle(auto),
                },
                translate('modeAuto'),
              ),
              h(
                'button',
                {
                  key: 'fixed',
                  type: 'button',
                  'data-context-watchdog': 'mode-fixed',
                  'aria-pressed': auto ? 'false' : 'true',
                  onClick: function () {
                    write(Object.assign({}, settings, { mode: 'fixed' }));
                  },
                  style: segmentStyle(!auto),
                },
                translate('modeFixed'),
              ),
            ]),
          ]),
          h('div', { key: 'fields', style: { display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', marginTop: '8px' } }, fields),
          h('span', { key: 'rule', style: ruleStyle }, rule),
          h('span', { key: 'preview', style: Object.assign({}, ruleStyle, { color: 'var(--dsw-alias-label-tertiary)' }) }, preview),
        ],
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // The dictionaries are resources this plugin owns, so registration rides
        // ctx.effect and leaves with the plugin. A duplicate (ns, locale) throws
        // — which a hot reload can race — and losing a dictionary must not take
        // the surfaces down with it.
        ctx.effect(() => {
          const disposers = [];
          const pair = [['en', DICT], ['zh', ZH]];
          for (let i = 0; i < pair.length; i++) {
            try {
              disposers.push(ctx.locale.register(NS, pair[i][0], pair[i][1]));
            } catch (error) {
              // already registered by an earlier generation of this plugin
            }
          }
          return () => {
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

        // The banner's primary action is real: `startSession` parks this session
        // in the sidebar and opens an empty one. Captured through inject so a
        // host without the service simply renders the banner without that button.
        let startSession = null;
        ctx.inject(['uiWorkspace'], (serviceCtx) => {
          serviceCtx.effect(() => {
            const workspace = serviceCtx.uiWorkspace;
            startSession = typeof workspace?.startSession === 'function' ? () => workspace.startSession() : null;
            return () => {
              startSession = null;
            };
          }, 'context-watchdog: workspace service');
        });

        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'context-watchdog',
              order: 30,
              inject: () => ({
                startSession: () => {
                  if (typeof startSession === 'function') startSession();
                },
              }),
            },
            ContextBanner,
          ),
        );

        ctx.slots.inject('settings.general.item', () =>
          ctx.slots.register(
            {
              name: 'settings.general.item',
              id: 'context-watchdog',
              order: 13,
              label: () => translate('rowTitle'),
            },
            ThresholdRow,
          ),
        );
      },
    };
  },
});
