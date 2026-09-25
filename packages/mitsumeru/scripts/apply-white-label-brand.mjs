#!/usr/bin/env node
// Package the brand THIS BUILD ships, by writing it into the vendored
// @muen/dsh-white-label's own cordis.patch.yml.
//
// WHY HERE, AND WHY THIS SHAPE
//
// A plugin's durable settings namespace on dsh 0.1.7+ is its PROFILE ENTRY ID,
// and its values persist through the active profile's patch document. The patch
// layer order (bundle layers, then the profile's cordis.patch.yml, then
// $DSH_HOME/cordis.patch.yml — see dsh-app-boot's readProfilePatches) is what
// makes a shipped brand possible at all: a `config:` written into this BUNDLE
// layer is the product's default, while anything a person saves lands in the
// profile layer, outranks it, and survives an app update.
//
// So the brand is not copied into the user's state directory and it is not baked
// into a client bundle. It is config, in the layer that belongs to the build.
//
// The patch file gets ONE extra entry, targeted at the id the insert above it
// creates. Order inside a layer matters and is relied on: the insert mounts the
// entry, then the config sets it (applyEntryPatches walks the list in order).
//
// Input:  build/brand/white-label/{brand.json, *.png}
// Output: build/harness/node_modules/@muen/dsh-white-label/cordis.patch.yml
//
// Run by scripts/prepare-harness.sh AFTER the plugin is vendored. Idempotent: the
// target file is re-vendored from plugins/ on every build, so this always writes
// onto a clean copy rather than appending to its own output.
//
// With no brand folder, the plugin's neutral defaults ship — the standing rule
// that a build carries no identity it was not given.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? process.cwd()
const brandDir = join(root, 'build', 'brand', 'white-label')
const brandJson = join(brandDir, 'brand.json')
const target = join(root, 'build', 'harness', 'node_modules', '@muen', 'dsh-white-label', 'cordis.patch.yml')

// Fields the host half declares as volatile config. Kept as an allowlist rather
// than spread blindly: a typo in brand.json must not reach a boot patch, because
// the loader validates config against the plugin's schema and warns per unknown
// field — a warning is easy to miss in a log and the brand would simply not show.
const TEXT_FIELDS = ['brandTagline', 'statusLabel', 'accentLight', 'accentDark', 'icon', 'logoLight', 'logoDark', 'sidebarIcon', 'heroIcon']
const BOOL_FIELDS = ['showSidebarIcon', 'showHeroIcon', 'showIcon']
const FILE_FIELDS = ['icon', 'logoLight', 'logoDark', 'sidebarIcon', 'heroIcon']

const MIME = { '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' }

function fail(message) {
  console.error(`[brand] ${message}`)
  process.exit(1)
}

/** A JSON string is a valid YAML double-quoted scalar, so this is the whole escaper. */
const scalar = (value) => JSON.stringify(value)

if (!existsSync(target)) {
  fail(`no vendored plugin at ${target} — run scripts/prepare-harness.sh first`)
}

if (!existsSync(brandJson)) {
  console.log('[brand] no build/brand/white-label/brand.json — shipping the plugin defaults')
  process.exit(0)
}

const raw = JSON.parse(readFileSync(brandJson, 'utf8'))
const config = {}

for (const field of TEXT_FIELDS) {
  const value = raw[field]
  if (value === undefined || value === null || value === '') continue
  if (typeof value !== 'string') fail(`${field} must be a string`)
  config[field] = value
}
for (const field of BOOL_FIELDS) {
  if (typeof raw[field] === 'boolean') config[field] = raw[field]
}

// Files become data URLs, which is the shape the settings document stores and the
// only shape a patch can carry. The plugin's client half accepts an uploaded mark
// as a data URL and nothing else, so a path here would render nothing.
const files = raw.files ?? {}
for (const [field, name] of Object.entries(files)) {
  if (!FILE_FIELDS.includes(field)) fail(`files.${field} is not a brand mark field`)
  if (typeof name !== 'string' || name === '') fail(`files.${field} must be a filename`)
  const path = join(brandDir, name)
  if (!existsSync(path)) fail(`files.${field} names ${name}, which is not in ${brandDir}`)
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  const mime = MIME[ext]
  if (mime === undefined) fail(`files.${field}: ${ext} is not a supported mark (use .png, .svg or .webp)`)
  const bytes = readFileSync(path)
  if (bytes.length > 2 * 1024 * 1024) fail(`files.${field}: ${name} is over the 2 MB brand cap`)
  config[field] = `data:${mime};base64,${bytes.toString('base64')}`
}

const fields = Object.keys(config)
if (fields.length === 0) {
  console.log('[brand] brand.json sets nothing — shipping the plugin defaults')
  process.exit(0)
}

// Read the vendored patch, keep its insert, and append our config row. Appending
// rather than rewriting keeps this script correct if the plugin ever gains more
// rows of its own ahead of ours.
const existing = readFileSync(target, 'utf8')
if (existing.includes('\n# ── shipped brand')) {
  fail(`${target} already carries a shipped brand — it should be re-vendored before this runs`)
}

const lines = [existing.replace(/\s*$/, ''), '', '# ── shipped brand (generated by scripts/apply-white-label-brand.mjs) ──', '#',
  '# This bundle layer is the build\'s DEFAULT brand. The profile\'s own', '# cordis.patch.yml outranks it, so a brand a person saves in',
  '# Settings -> Brand persists across app updates and Reset restores these.', '- id: white-label', '  config:']
for (const field of TEXT_FIELDS) {
  if (config[field] !== undefined) lines.push(`    ${field}: ${scalar(config[field])}`)
}
for (const field of BOOL_FIELDS) {
  if (config[field] !== undefined) lines.push(`    ${field}: ${config[field]}`)
}
lines.push('')

writeFileSync(target, lines.join('\n'))
console.log(`[brand] packaged ${fields.join(', ')} into the white-label bundle patch`)
