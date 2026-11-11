// @muen/dsh-draw — browser half.
//
// One `board` tab in the right panel. The pane is deliberately thin: it frames the
// host-served drawing page and says the one thing a person needs to know before
// they use it — the agent reads this board. Nothing here draws anything, so the
// client bundle needs no canvas library (and cannot have one: only react, react-dom
// and the client primitives may be required).
//
// Loader format: one self-contained script registered through window.__ModuleLoader__.
window.__ModuleLoader__.load({
  id: '@muen/dsh-draw',
  factory: (require) => {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    const icon = (current, legacy) => primitives[current] ?? primitives[legacy]
    const IconBoard = icon('IconEditOutlineRegular', 'IconEditOutline16') ?? icon('IconTextRegular', 'IconText16')
    const IconSparkle = icon('IconSparkleRegular', 'IconSparkle16')

    const PLUGIN_ID = '@muen/dsh-draw'
    const KIND = 'draw'
    const NS = 'draw'
    const BASE = '/plugins/draw/'

    const EN = {
      'type.label': 'Draw',
      'guide.title': 'Draw what you cannot say',
      'guide.description': 'Sketch it on the board — the agent reads it, and can draw back',
      'pane.reads': 'The agent reads what you draw',
      'pane.hint': 'Sketch the thing that is hard to describe. Words you write on it are treated as instructions.',
      'pane.open': 'Open',
      'pane.title': 'Draw',
      'pane.close': 'Close',
    }

    const ZH = {
      'type.label': '画',
      'guide.title': '画出来，别硬说',
      'guide.description': '在画板上勾一下 — 智能体会读它，也能画回给你',
      'pane.reads': '智能体会读取你画的内容',
      'pane.hint': '把说不清的地方画出来。画板上的文字会被当作指令。',
      'pane.open': '新窗口打开',
      'pane.title': '画',
      'pane.close': '关闭',
    }

    function BoardPane(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => EN[key] ?? key
      const [ready, setReady] = React.useState(false)

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
            gap: 6,
            padding: '8px 8px 0',
            boxSizing: 'border-box',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 6, flex: '0 0 auto' } },
          IconSparkle
            ? h(IconSparkle, { width: 13, height: 13, style: { flex: '0 0 auto', alignSelf: 'center', opacity: 0.7 } })
            : null,
          h(
            'span',
            { style: { fontSize: 11.5, fontWeight: 600, color: 'var(--dsw-alias-fg-l2, #6b6b6b)' } },
            t('pane.reads'),
          ),
          h('span', { style: { flex: 1 } }),
          h(
            'a',
            {
              href: BASE,
              target: '_blank',
              rel: 'noreferrer',
              style: {
                fontSize: 11,
                color: 'var(--dsw-alias-fg-l3, #8a8a8a)',
                textDecoration: 'none',
                borderBottom: '1px solid currentColor',
              },
            },
            t('pane.open'),
          ),
        ),
        h(
          'div',
          {
            style: {
              flex: '1 1 auto',
              minHeight: 0,
              borderRadius: 8,
              overflow: 'hidden',
              border: '1px solid var(--dsw-alias-border-l3, #dcd8d1)',
              background: '#fffefb',
              position: 'relative',
            },
          },
          h('iframe', {
            src: BASE,
            title: t('pane.title'),
            onLoad: () => setReady(true),
            style: { display: 'block', width: '100%', height: '100%', border: 0 },
          }),
          ready
            ? null
            : h(
                'div',
                {
                  style: {
                    position: 'absolute',
                    inset: 0,
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 11.5,
                    color: 'var(--dsw-alias-fg-l3, #8a8a8a)',
                    pointerEvents: 'none',
                  },
                },
                t('pane.hint'),
              ),
        ),
        h(
          'div',
          {
            style: {
              flex: '0 0 auto',
              padding: '2px 2px 8px',
              fontSize: 11,
              lineHeight: 1.45,
              color: 'var(--dsw-alias-fg-l3, #8a8a8a)',
            },
          },
          t('pane.hint'),
        ),
      )
    }

    function BoardTitle(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => EN[key] ?? key
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        IconBoard ? h(IconBoard, { width: 14, height: 14 }) : null,
        h('span', null, t('pane.title')),
      )
    }

    function boardDefinition(t) {
      return {
        kind: KIND,
        // The registry CALLS these, so they are thunks — a bare string crashes the
        // start guide with "entry.title is not a function".
        title: () => t('type.label'),
        icon: IconBoard ? () => h(IconBoard, { width: 16, height: 16 }) : undefined,
        guide: [
          {
            id: 'open',
            order: 40,
            title: () => t('guide.title'),
            description: () => t('guide.description'),
            icon: IconBoard ? () => h(IconBoard, { width: 16, height: 16 }) : undefined,
          },
        ],
      }
    }

    const inject = ['slots', 'locale', 'sidebarRightTabs']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-draw.copy')
      ctx.effect(() => ctx.sidebarRightTabs.register(boardDefinition(t)), 'dsh-draw.type')
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PLUGIN_ID, locale: NS }, BoardPane),
          ),
        'dsh-draw.body',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: PLUGIN_ID, locale: NS }, BoardTitle),
          ),
        'dsh-draw.title',
      )
    }

    return { inject, apply }
  },
})
