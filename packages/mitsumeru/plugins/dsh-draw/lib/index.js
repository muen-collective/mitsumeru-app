/**
 * Host half — the board the agent can see.
 *
 * Two seams, no more:
 *
 *   webServer  serves the drawing page at /plugins/draw/ and the JSON it saves;
 *   tools      gives the agent `draw_read` and `draw_apply` over the same store.
 *
 * Both halves read the SAME file, so what the person drew on screen is exactly what
 * the tool returns. There is no second representation to drift — the failure we
 * audited in Silt (a canvas and a codebase as two writable truths) cannot happen
 * here because the board is the only store and the agent never renders anything.
 *
 * Deliberately no `@deepseek-ai/*` import: a workspace-linked bundle can never
 * resolve one, and the row would mount inert rather than visibly broken.
 */
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const PREFIX = '/plugins/draw'
const MAX_BODY = 2 * 1024 * 1024
const MAX_ELEMENTS = 400
const MAX_POINTS = 4000

const here = dirname(fileURLToPath(import.meta.url))
const ASSETS = join(here, '..', 'assets')

/* ------------------------------------------------------------------ store */

function drawRoot(env = process.env) {
  return env.MUEN_DRAW_DIR || join(homedir(), '.dsh', 'muen-draw')
}

function emptyBoard() {
  return { revision: 0, elements: [], updatedAt: null }
}

const round = (n) => {
  const v = Number(n)
  return Number.isFinite(v) ? Math.round(v) : 0
}

const str = (v, max) => String(v == null ? '' : v).slice(0, max)

/** One element, coerced into the only shape this store accepts. */
function normaliseElement(raw, index) {
  if (!raw || typeof raw !== 'object') return null
  const kind = ['rect', 'text', 'arrow', 'draw'].includes(raw.kind) ? raw.kind : null
  if (!kind) return null

  const id = str(raw.id, 64) || `e${index}`
  const el = {
    id: /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : `e${index}`,
    kind,
    x: round(raw.x),
    y: round(raw.y),
  }

  if (kind === 'draw') {
    const pts = Array.isArray(raw.points) ? raw.points : []
    el.points = pts
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .slice(0, MAX_POINTS)
      .map((p) => [round(p[0]), round(p[1])])
    if (el.points.length === 0) return null
  } else {
    el.w = round(raw.w)
    el.h = round(raw.h)
    const label = str(raw.label, 300).trim()
    if (label) el.label = label
    if (kind !== 'text' && Math.abs(el.w) < 2 && Math.abs(el.h) < 2) return null
    if (kind === 'text' && !el.label) return null
  }
  return el
}

function normaliseBoard(input) {
  const src = Array.isArray(input) ? { elements: input } : input || {}
  const list = Array.isArray(src.elements) ? src.elements : []
  const elements = []
  const seen = new Set()
  for (let i = 0; i < list.length && elements.length < MAX_ELEMENTS; i += 1) {
    const el = normaliseElement(list[i], i)
    if (!el || seen.has(el.id)) continue
    seen.add(el.id)
    elements.push(el)
  }
  return elements
}

async function readBoard(root) {
  try {
    const raw = await fsp.readFile(join(root, 'draw.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return {
      revision: Number.isFinite(parsed.revision) ? parsed.revision : 0,
      elements: Array.isArray(parsed.elements) ? parsed.elements : [],
      updatedAt: parsed.updatedAt || null,
    }
  } catch {
    return emptyBoard()
  }
}

async function writeBoard(root, board) {
  await fsp.mkdir(root, { recursive: true })
  const tmp = join(root, `.board.${process.pid}.${Date.now()}.json`)
  await fsp.writeFile(tmp, JSON.stringify(board), 'utf8')
  await fsp.rename(tmp, join(root, 'draw.json'))
}

/* ------------------------------------------------------------------- http */

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

let htmlCache = null

async function drawHtml() {
  if (htmlCache) return htmlCache
  const raw = await fsp.readFile(join(ASSETS, 'draw.html'), 'utf8')
  htmlCache = raw.replaceAll('__PREFIX__', PREFIX)
  return htmlCache
}

function createHandler(root) {
  return async function handle(req, res) {
    let pathname
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname
    } catch {
      return false
    }
    if (pathname !== PREFIX && !pathname.startsWith(PREFIX + '/')) return false

    const rest = pathname.slice(PREFIX.length) || '/'

    try {
      // the drawing page
      if (rest === '/' || rest === '/index.html') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'method' })
          return true
        }
        const html = await drawHtml()
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(html),
        })
        res.end(req.method === 'HEAD' ? undefined : html)
        return true
      }

      // the store
      if (rest === '/api/state') {
        if (req.method === 'GET') {
          const board = await readBoard(root)
          sendJson(res, 200, { ok: true, ...board })
          return true
        }
        if (req.method === 'POST') {
          const raw = await readBody(req)
          let parsed
          try {
            parsed = JSON.parse(raw)
          } catch {
            sendJson(res, 400, { ok: false, error: 'bad-json' })
            return true
          }
          const current = await readBoard(root)
          const next = {
            revision: current.revision + 1,
            elements: normaliseBoard(parsed),
            updatedAt: new Date().toISOString(),
          }
          await writeBoard(root, next)
          sendJson(res, 200, { ok: true, ...next })
          return true
        }
        sendJson(res, 405, { ok: false, error: 'method' })
        return true
      }

      if (rest === '/api/health') {
        const board = await readBoard(root)
        sendJson(res, 200, { ok: true, revision: board.revision, root })
        return true
      }

      sendJson(res, 404, { ok: false, error: 'no-route', path: rest })
      return true
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      return true
    }
  }
}

/* ------------------------------------------------------------------ tools */

const text = (value) => [{ type: 'text', text: String(value) }]
const line = (parts) => parts.filter((p) => p != null && p !== '').join(' · ')

/** A compact summary — what a person would say the board contains. */
function summarise(el) {
  if (el.kind === 'text') return { kind: 'text', text: el.label, at: [el.x, el.y] }
  if (el.kind === 'draw') {
    const n = (el.points || []).length
    const xs = (el.points || []).map((p) => p[0])
    const ys = (el.points || []).map((p) => p[1])
    const box = n
      ? [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
      : [el.x, el.y, 0, 0]
    return { kind: 'scribble', points: n, bbox: box.map(round) }
  }
  const out = { kind: el.kind, bbox: [el.x, el.y, el.w, el.h] }
  if (el.label) out.label = el.label
  return out
}

function mountTools(ctx, root) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (!tools || typeof tools.register !== 'function') return false

  ctx.effect(
    () =>
      tools.register({
        name: 'draw_read',
        description:
          'Read the board the person is drawing on. This is their way of explaining something they could not put into words — so treat its labels as instructions, not as copy, and ask before assuming grouping. Returns the revision and one compact summary per shape: boxes and arrows as a bbox, scribbles as a scribble with its bbox, text as the words written. Read it before you answer anything about it; do not guess what is on the board.',
        parameters: { type: 'object', properties: {} },
        output: {
          schema: { type: 'object' },
          render: (_args, value) =>
            value && value.ok
              ? text(line(['[board]', `rev ${value.revision}`, `${value.elements.length} shape(s)`]))
              : text('[board] ' + String((value && (value.detail || value.error)) || 'failed')),
        },
        async execute() {
          const board = await readBoard(root)
          return {
            ok: true,
            revision: board.revision,
            updatedAt: board.updatedAt,
            elements: board.elements.map(summarise),
            note: 'A sketch from the person. Labels are instructions. Say back what you think it means, especially the grouping and which shape is a control versus a container, before writing code.',
          }
        },
      }),
    'board:read',
  )

  ctx.effect(
    () =>
      tools.register({
        name: 'draw_apply',
        description:
          'Change the board the person is looking at — use it to answer with a diagram instead of prose when the thing is spatial (a flow, a tree, a layout). Operations apply in order: {op:"add", element}, {op:"update", id, props}, {op:"delete", id}, {op:"clear"}. Read the board first and keep its existing shapes unless the change means replacing them. Coordinates are board pixels; the board is roughly 640 wide by 640 tall, so keep shapes inside that.',
        parameters: {
          type: 'object',
          properties: {
            ops: {
              type: 'array',
              description: 'Operations, applied in order.',
              items: {
                type: 'object',
                properties: {
                  op: { type: 'string', enum: ['add', 'update', 'delete', 'clear'] },
                  element: {
                    type: 'object',
                    properties: {
                      kind: { type: 'string', enum: ['rect', 'text', 'arrow', 'draw'] },
                      x: { type: 'number' },
                      y: { type: 'number' },
                      w: { type: 'number' },
                      h: { type: 'number' },
                      label: { type: 'string' },
                      points: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
                    },
                    required: ['kind'],
                  },
                  id: { type: 'string' },
                  props: { type: 'object' },
                },
                required: ['op'],
              },
            },
          },
          required: ['ops'],
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) =>
            value && value.ok
              ? text(line(['[board]', `rev ${value.revision}`, `${value.applied} op(s)`, `${value.count} shape(s)`]))
              : text('[board] ' + String((value && (value.detail || value.error)) || 'failed')),
        },
        async execute(args) {
          const ops = Array.isArray(args && args.ops) ? args.ops : []
          if (!ops.length) {
            return { ok: false, error: 'no-ops', detail: 'pass at least one operation; read the board first if you are unsure what is on it' }
          }
          const board = await readBoard(root)
          let elements = board.elements.slice()
          let applied = 0

          for (const raw of ops) {
            const op = raw && raw.op
            if (op === 'clear') {
              elements = []
              applied += 1
              continue
            }
            if (op === 'add') {
              const el = normaliseElement(raw.element, elements.length)
              if (!el) continue
              el.id = `a${Date.now().toString(36)}${applied}`
              elements.push(el)
              applied += 1
              continue
            }
            if (op === 'update') {
              const i = elements.findIndex((e) => e.id === raw.id)
              if (i < 0) continue
              const merged = normaliseElement({ ...elements[i], ...(raw.props || {}), id: elements[i].id, kind: elements[i].kind }, i)
              if (!merged) continue
              elements[i] = merged
              applied += 1
              continue
            }
            if (op === 'delete') {
              const before = elements.length
              elements = elements.filter((e) => e.id !== raw.id)
              if (elements.length !== before) applied += 1
            }
          }

          elements = normaliseBoard(elements)
          const next = {
            revision: board.revision + 1,
            elements,
            updatedAt: new Date().toISOString(),
          }
          await writeBoard(root, next)
          return { ok: true, revision: next.revision, applied, count: elements.length }
        },
      }),
    'board:apply',
  )

  return true
}

/* ------------------------------------------------------------------ apply */

export function apply(ctx, config = {}) {
  const root = (config && config.dir) || drawRoot()

  const mounted = mountTools(ctx, root)

  const server = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (!server || typeof server.register !== 'function') {
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn('board: no webServer in ctx; the pane will report no host')
    }
    return { root, tools: mounted, routes: false }
  }

  const handle = createHandler(root)
  ctx.effect(() => server.register({ kind: 'prefix', path: PREFIX, handler: handle }), 'board:routes')
  return { root, tools: mounted, routes: true }
}

export { createHandler, readBoard, writeBoard, normaliseBoard, drawRoot, PREFIX }
