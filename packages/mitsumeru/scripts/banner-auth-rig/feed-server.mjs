/**
 * Stand-in update feed for Epic 91 banner verification.
 *
 * Modes (argv):
 *   --port N          default 8899
 *   --version X       manifest version to advertise (default 9.9.9)
 *   --mode404         artifact path 404s  -> available -> error (download died)
 *   --mode real       serve a real throttled zip with matching sha512
 *                     -> downloading -> downloaded
 *   --mode same       manifest version = --version meaning "current" (no update)
 *
 * Everything here is the other end of the protocol, kept deliberately dumb —
 * nothing in this file is part of the shipped app.
 */
import { createServer } from 'node:http'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const port = Number(opt('port', '8899'))
const version = opt('version', '9.9.9')
const mode = opt('mode', '404') // 404 | real | same
const logFile = opt('log', '/tmp/banner-feed.log')

const ZIP_NAME = `Mitsumeru-${version}-arm64-mac.zip`
const work = join(tmpdir(), 'banner-feed')
mkdirSync(work, { recursive: true })

// --- the artifact: a real zip, ~24 MB of random bytes so it cannot compress
// away, served slowly enough that progress events fire. Built once, hashed once.
const zipPath = join(work, ZIP_NAME)
let sha512 = '0'.repeat(128)
if (mode === 'real') {
  if (!existsSync(zipPath)) {
    const raw = join(work, 'payload.bin')
    execSync(`head -c 25000000 /dev/urandom > ${raw}`)
    execSync(`cd ${work} && zip -q -0 ${ZIP_NAME} payload.bin`)
    console.log(`[feed] built artifact ${zipPath}`)
  }
  const bytes = readFileSync(zipPath)
  sha512 = createHash('sha512').update(bytes).digest('base64')
  console.log(`[feed] artifact ${bytes.length} bytes sha512=${sha512.slice(0, 16)}…`)
}

const yml = `version: ${version}
files:
  - url: ${ZIP_NAME}
    sha512: ${sha512}
    size: ${mode === 'real' ? 99999999999 : 1}
path: ${ZIP_NAME}
sha512: ${sha512}
releaseDate: '2026-09-29T00:00:00.000Z'
`

createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0]
  appendFileSync(logFile, `${req.method} ${req.url}\n`)
  if (path.endsWith('.yml')) {
    res.writeHead(200, { 'content-type': 'text/yaml' })
    res.end(yml)
    console.log(`[feed] manifest -> version ${version}`)
    return
  }
  if (path.endsWith('.zip')) {
    if (mode !== 'real') {
      res.writeHead(404)
      res.end()
      console.log('[feed] artifact -> 404')
      return
    }
    const bytes = readFileSync(zipPath)
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': String(bytes.length)
    })
    // ~5 MB/s so download-progress fires for several seconds.
    let offset = 0
    const step = () => {
      if (offset >= bytes.length) {
        res.end()
        console.log('[feed] artifact -> fully sent')
        return
      }
      res.write(bytes.subarray(offset, offset + 655360))
      offset += 655360
      setTimeout(step, 125)
    }
    step()
    return
  }
  res.writeHead(404)
  res.end()
}).listen(port, '127.0.0.1', () => console.log(`[feed] listening http://127.0.0.1:${port} mode=${mode} version=${version}`))
