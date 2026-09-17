// @muen/dsh-white-label — host half.
//
// WHAT THIS IS: the filesystem owner. The brand folder (<DSH_HOME>/brand/)
// contains an icon (SVG preferred, PNG/WebP accepted) and/or a logo (any
// accepted format). This host half reads those files, validates them, and
// exposes the result through a cordis service that the client half consumes —
// no shell bridge, no mitsumeru:* preload needed.
//
// WHY THE HOST OWNS THE FILES: a published plugin runs in a stock DSH with no
// shell bridge. The harness process has real filesystem access; the browser
// does not. So the host reads, the client renders.
//
// VALIDATION RULES (epic 88 R3; R1/R2 extended 2026-09-15 to admit raster
// icons — a brand folder is allowed to hold what a design tool exports):
//   R1. Extension: .svg, .png or .webp only
//   R2. Raster magic: PNG begins 89 50 4e 47 0d 0a 1a 0a; WebP is RIFF…WEBP
//   R3. SVG safety: no <script>, no on* attributes, no <style> block
//   R4. Size: ≤ 2 MB per file
//   R5. Something themes: at least one fill, stroke, stop-color, or color
//   R6. Expected filename in every refusal message
//
// The brand folder path is <DSH_HOME>/brand/. "DSH_HOME" is the profile's own
// home directory — for our app that is mitsu-dsh/, for any other profile its
// own home. Same folder as epic 88 R3.
//
// HOW THE HOME IS FOUND (measured 2026-09-14, and it is not obvious): the
// harness does NOT expose a `ctx.baseDir`. Grepping the whole shipped harness
// tree for `baseDir` finds only a cordis HMR option of the same name — nothing
// sets it on a plugin's context. `ctx.baseUrl` is a file:// URL set by cordis
// at boot, pointing at the PROFILE directory — NOT DSH_HOME. The brand folder
// is at DSH_HOME/brand/, which is one level up from the profile.
//
// DSH_HOME is the harness's own term for this directory, it is set for every
// harness process (the app sets it to its state dir; a stock `dsh web` run
// inherits it from the environment), and it is user data that no update
// touches.

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

const name = 'white-label'
const inject = []

const BRAND_DIR = 'brand'
const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2 MB
const ALLOWED_EXTENSIONS = new Set(['.svg', '.png', '.webp'])
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// A raster icon is a first-class mark, not a logo: a brand that ships a PNG or
// a WebP has no vector to hand, and requiring the file be named exactly
// `icon.svg` silently dropped that mark into the LOGO seat — the icon seat
// stayed empty and the fallback mark kept it (measured 2026-09-15).
//
// WebP is a RIFF container: "RIFF" <u32 size> "WEBP".
//
// When one seat has several candidates the winner is decided by EXT_RANK, never
// by readdir order: an SVG can follow the theme (see the README), so it beats a
// raster; PNG beats WebP because it is the format a design tool exports.
const EXT_RANK = { '.svg': 0, '.png': 1, '.webp': 2 }

// ── validation ─────────────────────────────────────────────────────────────

function validatePngMagic(buf) {
  if (buf.length < 8) return false
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_MAGIC[i]) return false
  }
  return true
}

function validateWebpMagic(buf) {
  if (buf.length < 12) return false
  return buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP'
}

function validateSvgSafety(text) {
  const errors = []
  // R3: no <script> tags (case-insensitive, with optional whitespace)
  if (/<script[\s>]/i.test(text)) {
    errors.push('contains <script> tag')
  }
  // R3: no on* event attributes (onclick, onload, onerror, etc.)
  if (/\bon\w+\s*=/i.test(text)) {
    errors.push('contains on* event attribute')
  }
  // R3: no <style> block
  if (/<style[\s>]/i.test(text)) {
    errors.push('contains <style> block')
  }
  return errors
}

function validateSvgThemes(text) {
  // R5: at least one of fill, stroke, stop-color, or color
  return /fill\s*=|stroke\s*=|stop-color|color\s*:/.test(text)
}

/**
 * Validate a single brand file.
 * @param {string} filename - the file's basename
 * @param {Buffer} content - raw file bytes
 * @returns {{ ok: boolean, error?: string, dataUrl?: string, mimeType?: string }}
 */
function validateBrandFile(filename, content) {
  const ext = extname(filename).toLowerCase()

  // R1: extension
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { ok: false, error: `${filename}: unsupported file type "${ext}" — use .png or .svg` }
  }

  // R4: size
  if (content.length > MAX_FILE_SIZE) {
    return { ok: false, error: `${filename}: file too large (${(content.length / 1024 / 1024).toFixed(1)} MB, max 2 MB)` }
  }

  if (ext === '.png' || ext === '.webp') {
    // R2: the bytes must be what the extension claims, so a renamed file is
    // refused rather than served as a broken data URL.
    const isPng = ext === '.png'
    if (isPng && !validatePngMagic(content)) {
      return { ok: false, error: `${filename}: not a valid PNG file (bad magic bytes)` }
    }
    if (!isPng && !validateWebpMagic(content)) {
      return { ok: false, error: `${filename}: not a valid WebP file (bad RIFF/WEBP header)` }
    }
    const mimeType = isPng ? 'image/png' : 'image/webp'
    const dataUrl = `data:${mimeType};base64,${content.toString('base64')}`
    return { ok: true, dataUrl, mimeType }
  }

  // SVG path
  const text = content.toString('utf-8')

  // R3: SVG safety
  const safetyErrors = validateSvgSafety(text)
  if (safetyErrors.length > 0) {
    return { ok: false, error: `${filename}: ${safetyErrors.join('; ')}` }
  }

  // R5: something themes
  if (!validateSvgThemes(text)) {
    return { ok: false, error: `${filename}: no fill, stroke, or colour found — nothing to theme` }
  }

  const mimeType = 'image/svg+xml'
  const dataUrl = `data:${mimeType};base64,${content.toString('base64')}`
  return { ok: true, dataUrl, mimeType }
}

// ── brand folder resolution ────────────────────────────────────────────────

/**
 * Resolve the brand folder path from the profile's home directory.
 * @param {string} profileHome - the DSH_HOME for this profile
 * @returns {string} absolute path to the brand folder
 */
function brandFolder(profileHome) {
  return join(profileHome, BRAND_DIR)
}

/**
 * Which seat a brand file occupies. The seats are separate render surfaces: the
 * icon is the mark (sidebar rail at 24 px, hero at 34 px, left of the blank-
 * session headline); the logo is the wordmark lockup in the sidebar name strip.
 *
 * A basename carrying `icon` as a whole word takes the icon seat — `icon.png`,
 * `icon-dark.webp`, `mitsu-icon.png`. That is what a real brand folder contains;
 * requiring the literal name `icon.svg` sent `mitsu-icon.png` to the LOGO seat
 * and left the mark seat to the fallback (measured 2026-09-15). Everything else
 * is a logo.
 *
 * @param {string} filename - the file's basename
 * @returns {'icon' | 'logo'}
 */
function seatFor(filename) {
  const base = filename.slice(0, filename.length - extname(filename).length).toLowerCase()
  return base.split(/[-_.]/).includes('icon') ? 'icon' : 'logo'
}

/**
 * Read and validate all brand files from the brand folder.
 * Returns the validated set, or an empty set if the folder doesn't exist.
 *
 * @param {string} profileHome - the DSH_HOME for this profile
 * @returns {Promise<{ icon: { dataUrl, error } | null, logo: { dataUrl, error } | null, folder: string, errors: string[] }>}
 */
async function readBrand(profileHome) {
  const folder = brandFolder(profileHome)
  const result = { icon: null, logo: null, folder, errors: [] }

  let files
  try {
    files = await readdir(folder)
  } catch {
    // Brand folder doesn't exist yet — that's fine, no brand configured
    return result
  }

  // Best accepted candidate per seat, compared by EXT_RANK (top of this file).
  // Starting at Infinity means "this seat is still empty".
  const seatRank = { icon: Number.POSITIVE_INFINITY, logo: Number.POSITIVE_INFINITY }

  for (const filename of files) {
    const ext = extname(filename).toLowerCase()
    if (!ALLOWED_EXTENSIONS.has(ext)) continue

    const filePath = join(folder, filename)
    try {
      const info = await stat(filePath)
      if (!info.isFile()) continue
      const content = await readFile(filePath)
      const validation = validateBrandFile(filename, content)

      if (!validation.ok) {
        result.errors.push(validation.error)
        continue
      }

      // Classify by NAME, not by exact filename: `icon.*` takes the icon seat,
      // anything else is a logo. `mitsu-icon.png` is a mark; `logo-dark.png` is
      // not. Within one seat an SVG beats a raster (it can follow the theme) and
      // PNG beats WebP, so the winner never depends on readdir order.
      const slot = seatFor(filename)
      if (EXT_RANK[ext] >= seatRank[slot]) continue
      seatRank[slot] = EXT_RANK[ext]
      result[slot] = { dataUrl: validation.dataUrl, mimeType: validation.mimeType }
    } catch {
      // File unreadable — skip silently
    }
  }

  return result
}

// ── durable uploads: the brand settings namespace ──────────────────────────
// The client half persists an uploaded brand through the settings scope, and
// that scope only resolves a namespace the HOST registers. Anything else
// reports `status: 'unavailable'` with an undefined `value` — see
// @deepseek-ai/dsh-client-ui-settings settings-contract.d.ts, "Settings
// namespace registered by the owning Host plugin". Without this registration
// the scope reads empty, `persistBrand` degrades to the browser-only
// localStorage mirror, and the upload is gone at the next launch: the harness
// serves a fresh random port each time and localStorage is origin-scoped.
// Same shape as @deepseek-ai/dsh-agent-default-model's own namespace.
// Measured 2026-09-16.
const BRAND_SETTINGS_NAMESPACE = 'white-label-brand'
// The brand document. Each seat owns its own mark and its own switch: the
// sidebar rail (24 px) and the hero seat (34 px) are separate surfaces, so one
// upload no longer feeds both. `icon` / `showIcon` are the pre-split single-mark
// fields — kept in the schema so an existing upload still resolves (the client
// half falls back to them) and so a document rewrite does not drop them.
const BRAND_SETTINGS_BASE = {
  logoLight: '',
  logoDark: '',
  sidebarIcon: '',
  heroIcon: '',
  showSidebarIcon: true,
  showHeroIcon: true,
  icon: '',
  showIcon: true,
}
const BRAND_SETTINGS_SCHEMA = z.object({
  logoLight: z.string().default(''),
  logoDark: z.string().default(''),
  sidebarIcon: z.string().default(''),
  heroIcon: z.string().default(''),
  showSidebarIcon: z.boolean().default(true),
  showHeroIcon: z.boolean().default(true),
  icon: z.string().default(''),
  showIcon: z.boolean().default(true),
})

// ── cordis apply ───────────────────────────────────────────────────────────

function apply(ctx) {
  // The brand folder lives at <DSH_HOME>/brand/. See the header for why
  // DSH_HOME — not ctx.baseUrl — is what actually resolves here.
  const profileHome = process.env.DSH_HOME
    || (ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : null)
    || process.cwd()

  // Provide the white-label service: the client half calls
  // ctx.get('white-label') to read brand files.
  try {
    ctx.provide('white-label', {
      readBrand: () => readBrand(profileHome),
      brandPath: () => brandFolder(profileHome),
      // revealBrandFolder: shell sugar — where the shell exposes it, the row
      // offers "Reveal brand folder"; elsewhere the row shows the path.
      // Not wired here — the shell binds it if available.
    })
  } catch {
    // provide is best-effort — if the service name is taken, keep going.
    // The client falls back to showing the path as selectable text.
  }

  // Register the brand namespace so the client's settings scope can read an
  // uploaded brand (and write a new one) durably. Optional by construction: a
  // composition with no settings provider keeps working exactly as composed.
  try {
    ctx.inject(['settings'], (settingsCtx) => {
      try {
        settingsCtx.settings.register(
          BRAND_SETTINGS_NAMESPACE,
          BRAND_SETTINGS_SCHEMA,
          { base: BRAND_SETTINGS_BASE },
        )
      } catch {
        // Provider present but the namespace is taken or rejected — keep going.
      }
    })
  } catch {
    // No settings service in this composition.
  }
}

export default { name, inject, apply }
