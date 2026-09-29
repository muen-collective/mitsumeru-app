/**
 * Mock Muen auth server (Epic 92 test harness — NOT part of the shipped app).
 *
 * Stands in for the real 5-endpoint server so the shell-side deep-link flow
 * can be exercised end to end on this rig:
 *
 *   GET  /api/auth/github     -> 302 to mitsumeru://auth/callback?code=...
 *   POST /api/auth/exchange   -> { token, user } (membership from --membership)
 *   GET  /avatar.png          -> a tiny PNG for the orb
 *
 * Usage: node mock-auth.mjs --port 9100 [--membership pro|free]
 */
import { createServer } from 'node:http'
import { deflateSync } from 'node:zlib'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const port = Number(opt('port', '9100'))
const membership = opt('membership', 'pro')

// 1x1-ish red PNG is too small to read in a 36 px circle — a 64x64 solid
// color PNG built here with no dependencies (raw IHDR/IDAT/IEND chunks).
const crcTable = (() => {
  const t = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
const deflateRawSync = (input) => deflateSync(input)
const buildPng = () => {
  const W = 64
  const H = 64
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  // rows: filter byte 0 + RGB pixels (a deep teal so it reads as "photo-ish")
  const raw = Buffer.alloc(H * (1 + W * 3))
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 3)
    raw[row] = 0
    for (let x = 0; x < W; x++) {
      const p = row + 1 + x * 3
      raw[p] = 0x1f
      raw[p + 1] = 0x7a + ((x * 2) & 0x3f)
      raw[p + 2] = 0x8a + ((y * 2) & 0x3f)
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateRawSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
const png = buildPng()

const user = {
  id: 'dev-user-1',
  email: 'thuy@muen.dev',
  name: 'Thuy Pham',
  avatarUrl: `http://127.0.0.1:${port}/avatar.png`,
  membership
}

createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0]
  console.log(`[mock-auth] ${req.method} ${req.url}`)
  if (path === '/api/auth/github') {
    // The real server does GitHub OAuth here; the mock jumps straight to the
    // deep link — exactly what GitHub's redirect_uri eventually produces.
    res.writeHead(302, { location: 'mitsumeru://auth/callback?code=mock-code-1' })
    res.end()
    return
  }
  if (path === '/api/auth/exchange') {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      console.log(`[mock-auth] exchange body=${body}`)
      const token = `mock-jwt-${Date.now()}`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ token, user }))
    })
    return
  }
  if (path === '/avatar.png') {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(png)
    return
  }
  res.writeHead(404)
  res.end()
}).listen(port, '127.0.0.1', () => {
  console.log(`[mock-auth] listening http://127.0.0.1:${port} membership=${membership}`)
})
