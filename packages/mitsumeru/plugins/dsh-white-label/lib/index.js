// @muen/dsh-white-label — host half.
//
// WHAT THIS IS: the filesystem owner. The brand folder (<DSH_HOME>/brand/)
// contains icon.svg and/or logo (PNG or SVG). This host half reads those files,
// validates them, and exposes the result through a cordis service that the
// client half consumes — no shell bridge, no mitsumeru:* preload needed.
//
// WHY THE HOST OWNS THE FILES: a published plugin runs in a stock DSH with no
// shell bridge. The harness process has real filesystem access; the browser
// does not. So the host reads, the client renders.
//
// VALIDATION RULES (epic 88 R3, carried verbatim):
//   R1. Extension: .png or .svg only
//   R2. PNG magic: first 8 bytes must be 89 50 4e 47 0d 0a 1a 0a
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

const name = 'white-label'
const inject = []

const BRAND_DIR = 'brand'
const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2 MB
const ALLOWED_EXTENSIONS = new Set(['.png', '.svg'])
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// ── validation ─────────────────────────────────────────────────────────────

function validatePngMagic(buf) {
  if (buf.length < 8) return false
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_MAGIC[i]) return false
  }
  return true
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

  if (ext === '.png') {
    // R2: PNG magic bytes
    if (!validatePngMagic(content)) {
      return { ok: false, error: `${filename}: not a valid PNG file (bad magic bytes)` }
    }
    const mimeType = 'image/png'
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

      // Classify: icon.svg → icon, anything else → logo
      const isIcon = filename === 'icon.svg'
      const slot = isIcon ? 'icon' : 'logo'
      if (result[slot] === null) {
        result[slot] = { dataUrl: validation.dataUrl, mimeType: validation.mimeType }
      }
      // If multiple files match the same slot, first one wins (folder scan order)
    } catch {
      // File unreadable — skip silently
    }
  }

  return result
}

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
}

export default { name, inject, apply }
