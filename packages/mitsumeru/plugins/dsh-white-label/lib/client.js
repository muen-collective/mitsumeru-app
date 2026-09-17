// @muen/dsh-white-label — browser half.
//
// WHAT THIS IS: an accent picker, a brand-file reader, and an upload surface.
//
// Three layers, each independent:
//   1. Accent picker — per-mode (light/dark) colour overrides applied as CSS
//      custom-property tokens. Stored in localStorage.
//   2. Brand-from-filesystem — the host half reads files from <DSH_HOME>/brand/
//      and exposes them through a cordis service. Shown in the brand row.
//   3. Brand upload — a Settings → Brand section where the user uploads logo
//      light/dark, plus an icon and a visibility switch for EACH seat. The
//      sidebar and the hero are separate surfaces, so they are configured
//      separately. Stored via the settings scope (durable across restarts) with
//      an localStorage mirror.
//
// Sidebar marks prefer uploaded values over filesystem values.
;(function () {
const WL_NS = "settings.white-label"
const WL_ROW_ID = "white-label-accent"
const KEY_LIGHT = "white-label:accent-light"
const KEY_DARK = "white-label:accent-dark"

const BRAND_NS = "settings.white-label-brand"
const BRAND_LS_KEY = "white-label:brand-uploaded"
const ACCEPT_IMAGE = "image/png,image/svg+xml"
const MAX_BYTES = 1024 * 1024 // 1 MB per image
const MAX_STORED = MAX_BYTES * 2 // base64 inflation buffer

/** Chip row, carried verbatim from dsh-dream-skin (12 colours, same order). */
const CHIPS = [
  "#4f83f2", "#2563eb", "#34d399", "#22d3ee", "#a78bfa", "#fb923c",
  "#f87171", "#fbbf24", "#e879f9", "#f472b6", "#2dd4bf", "#a3e635"
]

const HEX_RE = /^#[\da-f]{6}$/i

// ── colour maths ───────────────────────────────────────────────────────────

const toRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const toHex = (rgb) =>
  "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")
const tint = (hex, alpha) => {
  const [r, g, b] = toRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
const mix = (a, b, t) => {
  const [ar, ag, ab] = toRgb(a)
  const [br, bg, bb] = toRgb(b)
  return toHex([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t])
}

const rgbToHsl = (hex) => {
  const [ri, gi, bi] = toRgb(hex).map((v) => v / 255)
  const max = Math.max(ri, gi, bi)
  const min = Math.min(ri, gi, bi)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === ri ? (gi - bi) / d + (gi < bi ? 6 : 0) : max === gi ? (bi - ri) / d + 2 : (ri - gi) / d + 4
  return [h / 6, s, l]
}
const hslToRgb = (h, s, l) => {
  if (s === 0) return toHex([l * 255, l * 255, l * 255])
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  return toHex([channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255])
}

const srgb = (c) => {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}
const luminance = (hex) => {
  const [r, g, b] = toRgb(hex)
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b)
}
const contrast = (a, b) => {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const LABEL_INK = { light: "#ffffff", dark: "#0f1115" }
const MIN_CONTRAST = 4.5

const fitted = (hex, toward) => {
  if (toward === "light") {
    const [h, s, l] = rgbToHsl(hex)
    let out = hex
    for (let step = 1; step <= 80; step += 1) {
      if (contrast(out, LABEL_INK.light) >= MIN_CONTRAST) break
      out = hslToRgb(h, Math.min(1, s * (1 + step * 0.006)), Math.max(0, l * (1 - step * 0.03)))
    }
    return contrast(out, LABEL_INK.light) >= MIN_CONTRAST ? out : hex
  }
  let out = hex
  for (let step = 0; step < 80; step += 1) {
    if (contrast(out, LABEL_INK.dark) >= MIN_CONTRAST) break
    out = mix(out, "#ffffff", 0.05)
  }
  return contrast(out, LABEL_INK.dark) >= MIN_CONTRAST ? out : hex
}

const resolvedAccents = (accents) => {
  const { light, dark } = accents
  if (light === null && dark === null) return null
  if (light !== null && dark !== null) return { light, dark }
  if (light !== null) return { light, dark: fitted(light, "dark") }
  return { light: fitted(dark, "light"), dark }
}

const roleOverrides = (pair) => {
  const value = (fn) => ({ light: fn(pair.light), dark: fn(pair.dark) })
  return {
    "--dsw-alias-brand-primary": value((c) => c),
    "--dsw-alias-button-primary-hover": value((c) => mix(c, "#ffffff", 0.18)),
    "--dsw-alias-button-primary-dimmed": value((c) => mix(c, "#ffffff", 0.72)),
    "--dsw-alias-interactive-bg-hover": {
      light: tint(pair.light, 0.141),
      dark: tint(pair.dark, 0.239)
    },
    "--dsw-alias-interactive-bg-active": {
      light: tint(pair.light, 0.247),
      dark: tint(pair.dark, 0.418)
    }
  }
}

const accentStorage = {
  read() {
    const read = (key) => {
      try {
        const raw = window.localStorage.getItem(key)
        return typeof raw === "string" && HEX_RE.test(raw) ? raw.toLowerCase() : null
      } catch { return null }
    }
    return { light: read(KEY_LIGHT), dark: read(KEY_DARK) }
  },
  write(scheme, value) {
    const key = scheme === "light" ? KEY_LIGHT : KEY_DARK
    try {
      if (value === null) window.localStorage.removeItem(key)
      else window.localStorage.setItem(key, value)
    } catch {}
  }
}

let accentCurrent = { light: null, dark: null }
let overrideDispose = null

function applyAccent(ctx) {
  const pair = resolvedAccents(accentCurrent)
  if (pair === null) {
    overrideDispose?.()
    overrideDispose = null
    return
  }
  const tokens = roleOverrides(pair)
  const previous = overrideDispose
  overrideDispose = ctx.theme.overrideTokens("@muen/dsh-white-label:accent", tokens)
  previous?.()
}

const accentReport = () => {
  const pair = resolvedAccents(accentCurrent)
  if (pair === null) return null
  return {
    light: { value: pair.light, ratio: contrast(pair.light, LABEL_INK.light) },
    dark: { value: pair.dark, ratio: contrast(pair.dark, LABEL_INK.dark) }
  }
}

// ── brand upload persistence ───────────────────────────────────────────────

let BRAND_SCOPE = null
// The sidebar and the hero are separate surfaces — a 24 px rail mark and a
// 34 px seat beside the blank-session headline — so each owns its own upload and
// its own visibility switch. `icon` / `showIcon` are the PRE-SPLIT single-mark
// fields: one upload fed both seats and `showIcon` gated the hero only (the
// sidebar always rendered when a mark existed). They survive here purely as a
// read fallback for an existing upload; the first save on the Brand page
// materializes all four seat fields and clears them (see BrandUploadPage.save),
// so "Remove" on one seat can never be shadowed by the old shared mark.
const BRAND_SEAT_FIELDS = ["sidebarIcon", "heroIcon", "showSidebarIcon", "showHeroIcon"]
let brandValue = {
  logoLight: "", logoDark: "",
  sidebarIcon: "", heroIcon: "",
  showSidebarIcon: true, showHeroIcon: true,
}
let brandRev = 0
const brandListeners = new Set()
const BRAND_FIELDS = ["logoLight", "logoDark", ...BRAND_SEAT_FIELDS]

function isImageDataUrl(v) {
  return typeof v === "string" && v.startsWith("data:image/") && v.length <= MAX_STORED
}

// A boolean that may arrive as JSON true/false or as the settings doc's string
// form. null means "this source has nothing to say".
function readBool(src, key) {
  if (!src || typeof src !== "object") return null
  if (typeof src[key] === "boolean") return src[key]
  if (src[key] === "true" || src[key] === "false") return src[key] === "true"
  return null
}

function readBrandPersisted() {
  const out = {
    logoLight: "", logoDark: "",
    sidebarIcon: "", heroIcon: "",
    showSidebarIcon: true, showHeroIcon: true,
  }
  let legacyIcon = ""
  let legacyShowIcon = null
  // The localStorage mirror stores only what this page wrote, so a seat key
  // being present there — even as "" — is an explicit choice. The Host scope
  // cannot be read that way: schema defaults materialize empty strings into the
  // resolved value, so presence there proves nothing (see case 4 of the seat
  // check: a legacy-only brand resolves with sidebarIcon: "" in the scope).
  let mirrorSeatsExplicit = false
  const absorb = (src) => {
    if (!src || typeof src !== "object") return
    for (const k of ["logoLight", "logoDark", "sidebarIcon", "heroIcon"]) {
      if (isImageDataUrl(src[k])) out[k] = src[k]
    }
    const sidebar = readBool(src, "showSidebarIcon")
    if (sidebar !== null) out.showSidebarIcon = sidebar
    const hero = readBool(src, "showHeroIcon")
    if (hero !== null) out.showHeroIcon = hero
    if (isImageDataUrl(src.icon)) legacyIcon = src.icon
    const legacy = readBool(src, "showIcon")
    if (legacy !== null) legacyShowIcon = legacy
  }
  // Read settings scope (the durable Host document)…
  try {
    const snap = BRAND_SCOPE && typeof BRAND_SCOPE.getSnapshot === "function"
      ? BRAND_SCOPE.getSnapshot() : undefined
    const scopeVal = (snap && typeof snap === "object" && snap.value && typeof snap.value === "object")
      ? snap.value : snap
    absorb(scopeVal)
  } catch {}
  // …then the localStorage mirror (survives a partial Host scope).
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(BRAND_LS_KEY) : null
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object") {
        const pick = (a, b) => { if (!a) return b; if (!b) return a; return b.length > a.length ? b : a }
        if (typeof parsed.sidebarIcon === "string" || typeof parsed.heroIcon === "string") mirrorSeatsExplicit = true
        for (const k of ["logoLight", "logoDark", "sidebarIcon", "heroIcon"]) {
          out[k] = pick(out[k], isImageDataUrl(parsed[k]) ? parsed[k] : "")
        }
        const sidebar = readBool(parsed, "showSidebarIcon")
        if (sidebar !== null) out.showSidebarIcon = sidebar
        const hero = readBool(parsed, "showHeroIcon")
        if (hero !== null) out.showHeroIcon = hero
        if (isImageDataUrl(parsed.icon)) legacyIcon = pick(legacyIcon, parsed.icon)
        const legacy = readBool(parsed, "showIcon")
        if (legacy !== null) legacyShowIcon = legacy
      }
    }
  } catch {}
  // Pre-split fallback: the single mark held both seats. Skipped once the mirror
  // carries seat keys, so a "Remove" survives even when the Host write degraded
  // to localStorage-only and the scope still holds the legacy mark.
  if (!mirrorSeatsExplicit) {
    if (!out.sidebarIcon && legacyIcon) out.sidebarIcon = legacyIcon
    if (!out.heroIcon && legacyIcon) out.heroIcon = legacyIcon
  }
  // `showIcon: false` meant "no hero mark"; the sidebar had no switch at all.
  if (legacyShowIcon === false) out.showHeroIcon = false
  return out
}

function persistBrand(field, value) {
  brandValue = { ...brandValue, [field]: value }
  brandRev += 1
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(BRAND_LS_KEY, JSON.stringify(brandValue))
  } catch {}
  for (const fn of [...brandListeners]) fn()
  if (!BRAND_SCOPE || typeof BRAND_SCOPE.set !== "function") return Promise.resolve(false)
  let outcome
  try { outcome = BRAND_SCOPE.set(field, value) } catch { return Promise.resolve(false) }
  const confirm = async (settled) => {
    try { await settled } catch { return false }
    if (!BRAND_SCOPE || typeof BRAND_SCOPE.getSnapshot !== "function") return false
    try {
      const s = BRAND_SCOPE.getSnapshot() || {}
      return s.mode === "host" && s.status === "ready" && s.writable !== false
    } catch { return false }
  }
  if (outcome && typeof outcome.then === "function") return outcome.then(confirm)
  return Promise.resolve(false)
}

function subscribeBrand(fn) {
  brandListeners.add(fn)
  let disposed = false
  const unsub = BRAND_SCOPE && typeof BRAND_SCOPE.subscribe === "function"
    ? (() => { try { return BRAND_SCOPE.subscribe(() => { brandValue = readBrandPersisted(); for (const f of [...brandListeners]) f() }) } catch { return null } })()
    : null
  return () => {
    if (disposed) return
    disposed = true
    brandListeners.delete(fn)
    if (typeof unsub === "function") try { unsub() } catch {}
  }
}

function getBrandSnapshot() { return brandValue }

// The module factory below binds React (and react/jsx-runtime). This helper and
// the module-scope brand store sit ABOVE that factory, so a factory-local
// `var React` left the identifier unbound for them: every slot entry that reads
// the brand store crashed with `ReferenceError: React is not defined` —
// sidebar.brand.mark, sidebar.brand.name, conversation.hero.brand.mark and
// settings.section — which is why the sidebar/hero mark and the Brand upload
// page never rendered while the two Settings rows (react/jsx-runtime only) did.
// Measured 2026-09-16.
let React = null

function useSyncExternalStoreSafe(sub, get) {
  const R = React
  if (R === null) return get()
  return R.useSyncExternalStore
    ? R.useSyncExternalStore(sub, get, get)
    : (R.useState(get)[0])
}

// ── brand CSS ──────────────────────────────────────────────────────────────

const BRAND_CSS = [
  // Theme-switched logo for sidebar
  ".wl-logo{max-height:24px;width:auto;max-width:100%;object-fit:contain;vertical-align:middle;flex:none}",
  ".wl-logo--dark{display:none}",
  "body[data-ds-dark-theme] .wl-logo--light{display:none}",
  "body[data-ds-dark-theme] .wl-logo--dark{display:inline-block}",
  // Hero icon
  ".wl-hero{width:34px;height:34px;object-fit:contain;display:inline-block;vertical-align:middle}",
  // Settings page
  ".wl-brand-page{display:flex;flex-direction:column;gap:18px;max-width:620px}",
  ".wl-brand-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:10px}",
  ".wl-brand-card h3{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}",
  ".wl-brand-preview{min-height:64px;border:1px dashed rgba(255,255,255,.16);border-radius:8px;background:var(--dsw-static-neutral-bluish-900,#1b1b1c);display:flex;align-items:center;justify-content:center;padding:10px;overflow:hidden}",
  ".wl-brand-preview--light{background:#f4f3f0;border-color:rgba(18,18,24,.16)}",
  ".wl-brand-preview--light .wl-brand-preview--empty{color:#8a8a92}",
  ".wl-brand-preview img{max-height:44px;max-width:100%;object-fit:contain}",
  ".wl-brand-preview--empty{color:var(--dsw-alias-label-tertiary);font-size:12px}",
  ".wl-brand-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;margin:0}",
  ".wl-logo-cell-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
  ".wl-brand-btn{font:inherit;font-size:13px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:7px;padding:5px 12px;cursor:pointer}",
  ".wl-brand-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
  ".wl-brand-msg{font-size:13px;color:var(--dsw-alias-state-success-primary)}",
  ".wl-logo-row{display:flex;gap:12px}",
  ".wl-logo-cell{flex:1;display:flex;flex-direction:column;gap:10px;min-width:0}",
  ".wl-logo-cell-label{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}",
  // Toggle switch
  ".wl-switch{display:inline-flex;align-items:center;gap:10px;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer;user-select:none}",
  ".wl-switch input{position:absolute;opacity:0;width:0;height:0;margin:0}",
  ".wl-switch .wl-switch-track{position:relative;flex:none;width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-border-l2);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2);transition:background .15s ease}",
  ".wl-switch .wl-switch-track:after{content:\"\";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:transform .15s ease}",
  ".wl-switch input:checked + .wl-switch-track{background:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary)}",
  ".wl-switch input:checked + .wl-switch-track:after{transform:translateX(16px);background:#fff}",
  ".wl-switch input:focus-visible + .wl-switch-track{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:2px}",
  // Actions
  ".wl-brand-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
  ".wl-brand-btn--primary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff;font-weight:600}",
  ".wl-brand-btn--primary:hover:not(:disabled){background:var(--dsw-alias-state-business-primary);filter:brightness(1.12)}",
  ".wl-brand-btn:disabled{opacity:.45;cursor:default}",
  ".wl-brand-msg--warn{color:var(--dsw-alias-state-warn-primary)}",
  ".wl-brand-msg--ok{color:var(--dsw-alias-state-success-primary)}",
].join("\n")

// ── locale ─────────────────────────────────────────────────────────────────

const DICT = {
  en: {
    "accent.title": "Accent",
    "accent.pick": "Pick\u2026",
    "accent.reset": "Reset",
    "accent.set": "set",
    "accent.derived": "from the other mode",
    "accent.unset": "not set",
    "accent.hint": "Choose a colour for each mode. They are independent \u2014 a deep purple for dark and a pale blue for light is a normal pairing. Leaving one out derives it from the other.",
    "accent.contrastWarn": "Low contrast on this mode\u2019s buttons ({ratio}:1) \u2014 pick a darker shade.",
    "mode.light": "Light",
    "mode.dark": "Dark",
    "brand.title": "Brand",
    "brand.hint": "Place your icon (SVG, PNG or WebP) and logo files in the brand folder. The plugin reads them on launch.",
    "brand.path": "<DSH_HOME>/brand/",
    "brand.reveal": "Reveal folder",
    "upload.title": "Brand",
    "upload.intro": "Upload logos for light and dark themes. The sidebar mark and the hero mark are separate seats \u2014 each one has its own icon and its own switch.",
    "upload.lightLabel": "Logo \u2014 light theme",
    "upload.darkLabel": "Logo \u2014 dark theme",
    "upload.choose": "Choose image\u2026",
    "upload.replace": "Replace",
    "upload.remove": "Remove",
    "upload.preview": "Preview",
    "upload.sizeHint": "Transparent PNG or SVG, \u2264 1 MB. Lockups: artwork \u2265 48 px tall (2\u00d7 of the 24 px render). Square marks: \u2265 96 px.",
    "upload.sidebarIconLabel": "Sidebar icon",
    "upload.sidebarIconHint": "Square mark at the top of the sidebar rail, rendered at 24 px. Leave it empty to fall back to the brand folder\u2019s icon.",
    "upload.showSidebarIcon": "Show icon in sidebar",
    "upload.heroIconLabel": "Hero icon",
    "upload.heroIconHint": "Square mark beside the headline on a blank session, rendered at 34 px. Leave it empty to fall back to the brand folder\u2019s icon.",
    "upload.showHeroIcon": "Show icon in hero",
    "upload.saved": "Saved \u2014 your brand is live now.",
    "upload.saveBtn": "Save brand",
    "upload.revertBtn": "Revert",
    "upload.dirtyHint": "Changes apply when you click \u201cSave brand\u201d.",
    "upload.localOnly": "Warning: saved to this browser only \u2014 it will be lost when the app restarts.",
    "upload.invalidType": "Please choose a PNG or SVG file.",
    "upload.tooLarge": "That image is larger than 1 MB \u2014 please use a smaller export.",
    "upload.readError": "Could not read that file \u2014 please try again.",
  },
  zh: {
    "accent.title": "\u5f3a\u8c03\u8272",
    "accent.pick": "\u9009\u8272\u2026",
    "accent.reset": "\u6e05\u9664",
    "accent.set": "\u5df2\u8bbe\u7f6e",
    "accent.derived": "\u7531\u53e6\u4e00\u79cd\u6a21\u5f0f\u63a8\u5bfc",
    "accent.unset": "\u672a\u8bbe\u7f6e",
    "accent.hint": "\u5206\u522b\u4e3a\u4e24\u79cd\u6a21\u5f0f\u9009\u62e9\u989c\u8272\uff0c\u4e24\u8005\u4e92\u76f8\u72ec\u7acb\u2014\u2014\u6df1\u8272\u6a21\u5f0f\u7528\u6df1\u7d2b\u3001\u6d45\u8272\u6a21\u5f0f\u7528\u6d45\u84dd\u662f\u5e38\u89c1\u7684\u642d\u914d\u3002\u7559\u7a7a\u7684\u4e00\u4fa7\u4f1a\u7531\u53e6\u4e00\u4fa7\u63a8\u5bfc\u5f97\u51fa\u3002",
    "accent.contrastWarn": "\u5f53\u524d\u6a21\u5f0f\u6309\u94ae\u5bf9\u6bd4\u5ea6\u504f\u4f4e\uff08{ratio}:1\uff09\uff0c\u5efa\u8bae\u9009\u62e9\u66f4\u6df1\u7684\u989c\u8272\u3002",
    "mode.light": "\u6d45\u8272",
    "mode.dark": "\u6df1\u8272",
    "brand.title": "\u54c1\u724c",
    "brand.hint": "\u5c06\u56fe\u6807\uff08SVG/PNG/WebP\uff09\u548c logo \u6587\u4ef6\u653e\u5165\u54c1\u724c\u6587\u4ef6\u5939\uff0c\u63d2\u4ef6\u4f1a\u5728\u542f\u52a8\u65f6\u8bfb\u53d6\u3002",
    "brand.path": "<DSH_HOME>/brand/",
    "brand.reveal": "\u6253\u5f00\u6587\u4ef6\u5939",
    "upload.title": "\u54c1\u724c",
    "upload.intro": "\u4e0a\u4f20\u6d45\u8272/\u6df1\u8272\u4e3b\u9898\u7684\u6807\u5fd7\u3002\u8fb9\u680f\u56fe\u6807\u4e0e\u4e3b\u6807\u5fd7\u56fe\u6807\u662f\u4e24\u4e2a\u72ec\u7acb\u7684\u4f4d\u5e2d\uff0c\u5404\u81ea\u62e5\u6709\u56fe\u7247\u548c\u5f00\u5173\u3002",
    "upload.lightLabel": "\u6807\u5fd7 \u2014 \u6d45\u8272\u4e3b\u9898",
    "upload.darkLabel": "\u6807\u5fd7 \u2014 \u6df1\u8272\u4e3b\u9898",
    "upload.choose": "\u9009\u62e9\u56fe\u7247\u2026",
    "upload.replace": "\u66ff\u6362",
    "upload.remove": "\u79fb\u9664",
    "upload.preview": "\u9884\u89c8",
    "upload.sizeHint": "\u900f\u660e PNG \u6216 SVG\uff0c\u2264 1 MB\u3002\u6a2a\u5411\u7ec4\u5408\u6807\u5fd7\uff1a\u56fe\u6848\u9ad8\u5ea6 \u2265 48px\uff0c\u65b9\u5f62\u6807\u5fd7 \u2265 96px\u3002",
    "upload.sidebarIconLabel": "\u8fb9\u680f\u56fe\u6807",
    "upload.sidebarIconHint": "\u663e\u793a\u5728\u8fb9\u680f\u9876\u90e8\u7684\u65b9\u5f62\u56fe\u6807\uff0c\u6e32\u67d3\u4e3a 24px\u3002\u7559\u7a7a\u5219\u56de\u9000\u5230\u54c1\u724c\u6587\u4ef6\u5939\u4e2d\u7684\u56fe\u6807\u3002",
    "upload.showSidebarIcon": "\u5728\u8fb9\u680f\u663e\u793a\u56fe\u6807",
    "upload.heroIconLabel": "\u4e3b\u6807\u5fd7\u56fe\u6807",
    "upload.heroIconHint": "\u663e\u793a\u5728\u65b0\u4f1a\u8bdd\u6807\u9898\u65c1\u7684\u65b9\u5f62\u56fe\u6807\uff0c\u6e32\u67d3\u4e3a 34px\u3002\u7559\u7a7a\u5219\u56de\u9000\u5230\u54c1\u724c\u6587\u4ef6\u5939\u4e2d\u7684\u56fe\u6807\u3002",
    "upload.showHeroIcon": "\u5728\u4e3b\u6807\u5fd7\u533a\u663e\u793a\u56fe\u6807",
    "upload.saved": "\u5df2\u4fdd\u5b58\u2014\u2014\u54c1\u724c\u5df2\u751f\u6548\u3002",
    "upload.saveBtn": "\u4fdd\u5b58\u54c1\u724c",
    "upload.revertBtn": "\u8fd8\u539f",
    "upload.dirtyHint": "\u4fee\u6539\u9700\u70b9\u51fb\u201c\u4fdd\u5b58\u54c1\u724c\u201d\u540e\u624d\u4f1a\u751f\u6548\u3002",
    "upload.localOnly": "\u8b66\u544a\uff1a\u4ec5\u4fdd\u5b58\u5728\u5f53\u524d\u6d4f\u89c8\u5668\u4e2d\uff0c\u5e94\u7528\u91cd\u542f\u540e\u4f1a\u4e22\u5931\u3002",
    "upload.invalidType": "\u8bf7\u9009\u62e9 PNG \u6216 SVG \u6587\u4ef6\u3002",
    "upload.tooLarge": "\u8be5\u56fe\u7247\u8d85\u8fc7 1MB\uff0c\u8bf7\u7528\u66f4\u5c0f\u5c3a\u5bf8\u7684\u6587\u4ef6\u3002",
    "upload.readError": "\u65e0\u6cd5\u8bfb\u53d6\u8be5\u6587\u4ef6\uff0c\u8bf7\u91cd\u8bd5\u3002",
  },
}

function activeLang() {
  try {
    const l = (typeof document !== "undefined" && document.documentElement.lang) || "en"
    if (l.startsWith("zh")) return "zh"
    return "en"
  } catch { return "en" }
}

function translate(key) {
  const dict = DICT[activeLang()] || DICT.en
  return dict[key] || DICT.en[key] || key
}

// Written from inside apply(), never at module scope.
const MARKER = "__WHITE_LABEL__"

window.__ModuleLoader__.load({
  id: "@muen/dsh-white-label",
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    React = require("react") // module-scope binding declared above the factory
    var react_jsx_runtime = require("react/jsx-runtime")
    var store = require("@deepseek-ai/dsh-client-store")

    const styles = {
      group: { display: "flex", flexDirection: "column", gap: "12px", padding: "12px 0" },
      title: { color: "var(--dsw-alias-label-primary)", fontSize: "14px", fontWeight: 400, lineHeight: "22px" },
      sub: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", lineHeight: "18px", minWidth: "44px" },
      hint: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px" },
      warn: { color: "var(--dsw-alias-state-warn-primary)", fontSize: "12px", lineHeight: "18px" },
      row: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px" },
      dot: { width: "16px", height: "16px", borderRadius: "50%", flex: "none", boxShadow: "0 0 0 1px var(--dsw-alias-border-l2)" },
      hex: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
      button: {
        cursor: "pointer", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2)",
        background: "transparent", color: "var(--dsw-alias-label-primary)",
        font: "inherit", fontSize: "12px", lineHeight: "18px", padding: "4px 10px"
      },
      chip: { width: "18px", height: "18px", padding: 0, borderRadius: "50%", border: "none", cursor: "pointer" }
    }

    // ── SVG inlining ──────────────────────────────────────────────────────

    function dataUrlToString(dataUrl) {
      try {
        const parts = dataUrl.split(",")
        const meta = parts[0]
        const b64 = parts[1] || ""
        if (meta.includes(";base64")) return atob(b64)
        return decodeURIComponent(b64)
      } catch { return "" }
    }

    function InlineSvg(props) {
      const { src, className, style } = props
      const ref = React.useRef(null)
      React.useEffect(() => {
        if (!ref.current || !src) return
        const raw = src.startsWith("data:") ? dataUrlToString(src) : src
        if (!raw || !/<svg[\s>]/i.test(raw)) return
        const clean = raw.replace(/<\?xml[^?]*\?>\s*/gi, "")
        ref.current.innerHTML = clean
        const svg = ref.current.querySelector("svg")
        if (svg) {
          svg.style.width = "100%"
          svg.style.height = "100%"
          svg.removeAttribute("width")
          svg.removeAttribute("height")
        }
      }, [src])
      return React.createElement("span", {
        ref,
        className,
        style: { display: "inline-flex", alignItems: "center", maxWidth: "100%", overflow: "hidden", ...style },
        "data-ls-skip": ""
      })
    }

    // ── accent row ────────────────────────────────────────────────────────

    function AccentLine(props) {
      const { scheme, t } = props
      const authored = props.useStore((s) => s[scheme])
      const shown = authored !== null ? authored : props.derived[scheme]
      const failing = shown !== null && props.report !== null && props.report[scheme].ratio < 4.5
      return react_jsx_runtime.jsxs("div", {
        style: styles.group,
        children: [
          react_jsx_runtime.jsxs("div", {
            style: styles.row,
            children: [
              react_jsx_runtime.jsx("span", { style: styles.sub, children: t(scheme === "light" ? "mode.light" : "mode.dark") }),
              react_jsx_runtime.jsx("span", { style: { ...styles.dot, background: shown || "transparent" } }),
              react_jsx_runtime.jsx("span", { style: styles.hex, children: shown || t("accent.unset") }),
              react_jsx_runtime.jsx("span", {
                style: styles.sub,
                children: authored !== null ? t("accent.set") : shown !== null ? t("accent.derived") : ""
              }),
              react_jsx_runtime.jsxs("span", {
                style: { position: "relative", display: "inline-flex" },
                children: [
                  react_jsx_runtime.jsx("button", {
                    type: "button", style: styles.button, "aria-hidden": "true",
                    children: t("accent.pick")
                  }),
                  react_jsx_runtime.jsx("input", {
                    type: "color", "aria-label": t("accent.pick"), value: shown || "#4f83f2",
                    style: { position: "absolute", inset: 0, opacity: 0, cursor: "pointer" },
                    onChange: (event) => props.setAccent(scheme, String(event.target.value).toLowerCase())
                  })
                ]
              }),
              authored !== null
                ? react_jsx_runtime.jsx("button", {
                    type: "button", style: styles.button,
                    onClick: () => props.clearAccent(scheme),
                    children: t("accent.reset")
                  })
                : null
            ]
          }),
          react_jsx_runtime.jsx("div", {
            style: styles.row,
            children: CHIPS.map((hex) =>
              react_jsx_runtime.jsx("button", {
                type: "button", title: hex, "aria-label": hex, "aria-pressed": authored === hex,
                style: {
                  ...styles.chip, background: hex,
                  ...(authored === hex ? { outline: "2px solid var(--dsw-alias-label-primary)", outlineOffset: "1px" } : {})
                },
                onClick: () => props.setAccent(scheme, hex)
              }, hex)
            )
          }),
          failing
            ? react_jsx_runtime.jsx("div", {
                style: styles.warn,
                children: t("accent.contrastWarn", { ratio: props.report[scheme].ratio.toFixed(2) })
              })
            : null
        ]
      })
    }

    function AccentRow(props) {
      const light = props.useStore((s) => s.light)
      const dark = props.useStore((s) => s.dark)
      const pair = resolvedAccents({ light, dark })
      const reportPair = pair === null ? null : {
        light: { value: pair.light, ratio: contrast(pair.light, LABEL_INK.light) },
        dark: { value: pair.dark, ratio: contrast(pair.dark, LABEL_INK.dark) }
      }
      return react_jsx_runtime.jsxs("div", {
        style: styles.group,
        children: [
          react_jsx_runtime.jsx("div", { style: styles.title, children: props.t("accent.title") }),
          react_jsx_runtime.jsx(AccentLine, {
            scheme: "light", t: props.t, useStore: props.useStore,
            derived: pair === null ? { light: null } : { light: pair.light },
            report: reportPair, setAccent: props.setAccent, clearAccent: props.clearAccent
          }),
          react_jsx_runtime.jsx(AccentLine, {
            scheme: "dark", t: props.t, useStore: props.useStore,
            derived: pair === null ? { dark: null } : { dark: pair.dark },
            report: reportPair, setAccent: props.setAccent, clearAccent: props.clearAccent
          }),
          react_jsx_runtime.jsx("div", { style: styles.hint, children: props.t("accent.hint") })
        ]
      })
    }

    // ── brand-from-filesystem row (order 20) ──────────────────────────────

    function BrandSlot(props) {
      const { label, file } = props
      if (!file) {
        return react_jsx_runtime.jsxs("div", {
          className: "wl-brand-slot",
          children: [
            react_jsx_runtime.jsx("div", { className: "wl-brand-slot-label", children: label }),
            react_jsx_runtime.jsx("div", {
              className: "wl-brand-slot-preview",
              children: react_jsx_runtime.jsx("span", { className: "wl-brand-slot-empty", children: "not configured" })
            })
          ]
        })
      }
      return react_jsx_runtime.jsxs("div", {
        className: "wl-brand-slot",
        children: [
          react_jsx_runtime.jsx("div", { className: "wl-brand-slot-label", children: label }),
          react_jsx_runtime.jsx("div", {
            className: "wl-brand-slot-preview",
            children: react_jsx_runtime.jsx("img", { src: file.dataUrl, alt: label, draggable: false })
          })
        ]
      })
    }

    function BrandRow(props) {
      const brand = props.useStore((s) => s)
      const errors = brand.errors || []
      return react_jsx_runtime.jsxs("div", {
        style: styles.group,
        className: "wl-brand",
        children: [
          react_jsx_runtime.jsx("div", { style: styles.title, children: props.t("brand.title") }),
          react_jsx_runtime.jsx("div", { style: styles.hint, children: props.t("brand.hint") }),
          (brand.icon || brand.logo) && react_jsx_runtime.jsxs("div", {
            className: "wl-brand-previews",
            children: [
              react_jsx_runtime.jsx(BrandSlot, { label: "icon", file: brand.icon }),
              react_jsx_runtime.jsx(BrandSlot, { label: "logo", file: brand.logo })
            ]
          }),
          errors.length > 0 && react_jsx_runtime.jsx("div", {
            className: "wl-brand-errors",
            children: errors.map((e, i) =>
              react_jsx_runtime.jsx("div", { className: "wl-brand-error", children: e }, i)
            )
          }),
          react_jsx_runtime.jsxs("div", {
            style: { display: "flex", alignItems: "center", gap: "8px" },
            children: [
              react_jsx_runtime.jsx("div", {
                className: "wl-brand-path",
                children: brand.folder || props.t("brand.path")
              }),
              brand.revealFolder && react_jsx_runtime.jsx("button", {
                type: "button", className: "wl-brand-btn",
                onClick: () => brand.revealFolder(),
                children: props.t("brand.reveal")
              })
            ]
          })
        ]
      })
    }

    // ── upload settings section ───────────────────────────────────────────

    function LogoCell(props) {
      const { field, label, value, onChange } = props
      const [error, setError] = React.useState(null)
      const pick = (event) => {
        const file = event.target.files && event.target.files[0]
        event.target.value = ""
        if (!file) return
        if (!(file.type === "image/png" || file.type === "image/svg+xml" || /\.(png|svg)$/i.test(file.name))) {
          setError(translate("upload.invalidType")); return
        }
        if (file.size > MAX_BYTES) { setError(translate("upload.tooLarge")); return }
        setError(null)
        const reader = new FileReader()
        reader.onload = () => onChange(field, String(reader.result))
        reader.onerror = () => setError(translate("upload.readError"))
        reader.readAsDataURL(file)
      }
      const btnLabel = value ? translate("upload.replace") : translate("upload.choose")
      const previewClass = "wl-brand-preview" + (field === "logoLight" ? " wl-brand-preview--light" : "")
      return react_jsx_runtime.jsxs("div", { className: "wl-logo-cell", children: [
        react_jsx_runtime.jsx("div", { className: "wl-logo-cell-label", children: label }),
        react_jsx_runtime.jsx("div", { className: previewClass, children:
          value
            ? react_jsx_runtime.jsx("img", { src: value, alt: "", draggable: false })
            : react_jsx_runtime.jsx("span", { className: "wl-brand-preview--empty", children: translate("upload.preview") })
        }),
        react_jsx_runtime.jsxs("div", { className: "wl-logo-cell-actions", children: [
          react_jsx_runtime.jsx("label", { className: "wl-brand-btn", style: { display: "inline-block" }, children: [
            btnLabel,
            react_jsx_runtime.jsx("input", {
              type: "file", accept: ACCEPT_IMAGE,
              style: { display: "none" }, onChange: pick
            })
          ] }),
          value && react_jsx_runtime.jsx("button", {
            className: "wl-brand-btn",
            onClick: () => { onChange(field, ""); setError(null) },
            children: translate("upload.remove")
          })
        ] }),
        error && react_jsx_runtime.jsx("div", { className: "wl-brand-msg wl-brand-msg--warn", children: error })
      ] })
    }

    function BrandUploadPage() {
      const committed = useSyncExternalStoreSafe(subscribeBrand, getBrandSnapshot)
      const [draft, setDraft] = React.useState(() => ({ ...committed }))
      const [saving, setSaving] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const setField = (field, value) => { setDraft((d) => ({ ...d, [field]: value })); setNotice(null) }
      const dirty = BRAND_FIELDS.some((key) => draft[key] !== committed[key])
      const save = async () => {
        setSaving(true)
        const dirtyKeys = BRAND_FIELDS.filter((key) => draft[key] !== committed[key])
        const keys = new Set(dirtyKeys)
        // The first save that touches a seat materializes BOTH seats from the
        // resolved draft and clears the pre-split single-mark fields. Without
        // that, `icon` would keep shadowing an explicit "Remove" (""), because
        // the read fallback fills an empty seat from the legacy mark.
        const touchesSeats = dirtyKeys.some((key) => BRAND_SEAT_FIELDS.includes(key))
        if (touchesSeats) for (const key of BRAND_SEAT_FIELDS) keys.add(key)
        const pending = [...keys].map((key) => persistBrand(key, draft[key]))
        if (touchesSeats) {
          pending.push(persistBrand("icon", ""))
          pending.push(persistBrand("showIcon", true))
        }
        const results = await Promise.all(pending)
        setSaving(false)
        const hostOk = results.every(Boolean)
        setNotice({ kind: hostOk ? "ok" : "warn", text: translate(hostOk ? "upload.saved" : "upload.localOnly") })
      }
      const revert = () => { setDraft({ ...committed }); setNotice(null) }
      return react_jsx_runtime.jsxs("div", { className: "wl-brand-page", children: [
        react_jsx_runtime.jsx("p", {
          style: { color: "var(--dsw-alias-label-secondary)", fontSize: 13, lineHeight: 1.6, margin: 0 },
          children: translate("upload.intro")
        }),
        react_jsx_runtime.jsx("h3", { children: translate("upload.title") }),
        react_jsx_runtime.jsx("div", { className: "wl-brand-card", children:
          react_jsx_runtime.jsx("div", { className: "wl-logo-row", children: [
            react_jsx_runtime.jsx(LogoCell, { field: "logoLight", label: translate("upload.lightLabel"), value: draft.logoLight, onChange: setField }),
            react_jsx_runtime.jsx(LogoCell, { field: "logoDark", label: translate("upload.darkLabel"), value: draft.logoDark, onChange: setField })
          ] })
        }),
        react_jsx_runtime.jsx("p", { className: "wl-brand-hint", children: translate("upload.sizeHint") }),
        react_jsx_runtime.jsx("div", { className: "wl-brand-card", children: [
          react_jsx_runtime.jsx("label", { className: "wl-switch", children: [
            react_jsx_runtime.jsx("input", {
              type: "checkbox", checked: Boolean(draft.showSidebarIcon),
              onChange: (e) => setField("showSidebarIcon", e.target.checked)
            }),
            react_jsx_runtime.jsx("span", { className: "wl-switch-track", "aria-hidden": true }),
            react_jsx_runtime.jsx("span", { children: translate("upload.showSidebarIcon") })
          ] }),
          react_jsx_runtime.jsx(LogoCell, { field: "sidebarIcon", label: translate("upload.sidebarIconLabel"), value: draft.sidebarIcon, onChange: setField }),
          react_jsx_runtime.jsx("p", { className: "wl-brand-hint", children: translate("upload.sidebarIconHint") })
        ] }),
        react_jsx_runtime.jsx("div", { className: "wl-brand-card", children: [
          react_jsx_runtime.jsx("label", { className: "wl-switch", children: [
            react_jsx_runtime.jsx("input", {
              type: "checkbox", checked: Boolean(draft.showHeroIcon),
              onChange: (e) => setField("showHeroIcon", e.target.checked)
            }),
            react_jsx_runtime.jsx("span", { className: "wl-switch-track", "aria-hidden": true }),
            react_jsx_runtime.jsx("span", { children: translate("upload.showHeroIcon") })
          ] }),
          react_jsx_runtime.jsx(LogoCell, { field: "heroIcon", label: translate("upload.heroIconLabel"), value: draft.heroIcon, onChange: setField }),
          react_jsx_runtime.jsx("p", { className: "wl-brand-hint", children: translate("upload.heroIconHint") })
        ] }),
        react_jsx_runtime.jsx("div", { className: "wl-brand-actions", children: [
          react_jsx_runtime.jsx("button", {
            className: "wl-brand-btn wl-brand-btn--primary", disabled: !dirty || saving, onClick: save,
            children: translate("upload.saveBtn")
          }),
          react_jsx_runtime.jsx("button", {
            className: "wl-brand-btn", disabled: !dirty || saving, onClick: revert,
            children: translate("upload.revertBtn")
          })
        ] }),
        dirty && !saving && react_jsx_runtime.jsx("p", { className: "wl-brand-hint", style: { margin: 0 }, children: translate("upload.dirtyHint") }),
        notice && react_jsx_runtime.jsx("div", {
          className: notice.kind === "warn" ? "wl-brand-msg wl-brand-msg--warn" : "wl-brand-msg wl-brand-msg--ok",
          children: notice.text
        })
      ] })
    }

    // ── sidebar marks ─────────────────────────────────────────────────────

    // Module-level ref: filesystem brand data (loaded by host service).
    const fsBrand = { icon: null, logo: null }

    // The marks read the filesystem brand too, and the host read resolves AFTER
    // the first render. Reading the mutable object directly rendered the mark
    // once with nothing and never told it the icon had arrived — the icon seat
    // stayed empty until some unrelated re-render happened to redraw it. So the
    // filesystem brand gets its own subscription, mirroring the uploaded one.
    let fsBrandSnapshot = { icon: null, logo: null }
    const fsBrandListeners = new Set()
    function subscribeFsBrand(listener) {
      fsBrandListeners.add(listener)
      return () => { fsBrandListeners.delete(listener) }
    }
    function getFsBrandSnapshot() { return fsBrandSnapshot }
    function publishFsBrand() {
      fsBrandSnapshot = { icon: fsBrand.icon, logo: fsBrand.logo }
      for (const listener of [...fsBrandListeners]) listener()
    }
    // Upload brand data (from settings scope). Each seat has its own mark and
    // its own switch.
    const uploadedBrand = {
      logoLight: "", logoDark: "",
      sidebarIcon: "", heroIcon: "",
      showSidebarIcon: true, showHeroIcon: true,
    }

    // The sidebar mark: its own uploaded icon, its own visibility switch.
    function SidebarMark() {
      // Uploaded mark > filesystem icon.
      const uploaded = useSyncExternalStoreSafe(subscribeBrand, getBrandSnapshot)
      const fs = useSyncExternalStoreSafe(subscribeFsBrand, getFsBrandSnapshot)
      if (uploaded.showSidebarIcon === false) return null
      const own = uploaded.sidebarIcon
      const src = own || (fs.icon && fs.icon.dataUrl) || ""
      if (!src) return null
      const isSvg = own ? own.includes("image/svg+xml") : Boolean(fs.icon && fs.icon.mimeType === "image/svg+xml")
      if (isSvg) {
        return React.createElement(InlineSvg, { src, style: { height: "24px", width: "auto" } })
      }
      return React.createElement("img", {
        src, alt: "", draggable: false,
        style: { height: "24px", width: "auto", objectFit: "contain" },
        "data-ls-skip": ""
      })
    }

    function SidebarName() {
      const uploaded = useSyncExternalStoreSafe(subscribeBrand, getBrandSnapshot)
      const fs = useSyncExternalStoreSafe(subscribeFsBrand, getFsBrandSnapshot)
      // Prefer uploaded logos > filesystem logo.
      const light = uploaded.logoLight || (fs.logo && fs.logo.dataUrl) || ""
      const dark = uploaded.logoDark || (fs.logo && fs.logo.dataUrl) || ""
      if (!light && !dark) return null
      if (light && dark && light !== dark) {
        return React.createElement("span", {
          "data-ls-skip": "",
          style: { display: "inline-flex", alignItems: "center", maxWidth: "100%", minWidth: 0, overflow: "hidden" }
        },
          React.createElement("img", { key: "light", className: "wl-logo wl-logo--light", src: light, alt: "", draggable: false }),
          React.createElement("img", { key: "dark", className: "wl-logo wl-logo--dark", src: dark, alt: "", draggable: false })
        )
      }
      const src = light || dark
      if (src.includes("image/svg+xml")) {
        return React.createElement(InlineSvg, { src, style: { height: "24px", width: "auto", maxWidth: "100%" } })
      }
      return React.createElement("img", {
        src, alt: "", draggable: false,
        style: { height: "24px", width: "auto", maxWidth: "100%", objectFit: "contain" },
        "data-ls-skip": ""
      })
    }

    // The hero mark: the seat immediately left of the blank-session headline
    // ("Into the Unknown"). Separate upload and separate switch from the
    // sidebar. A filesystem icon is the brand operator's only statement of
    // intent, so it still holds the seat when no upload exists. Without that
    // fallback the hero seat could never be held by a filesystem brand — it
    // silently returned null and the previous occupant kept the seat
    // (measured 2026-09-15).
    function HeroMark() {
      const uploaded = useSyncExternalStoreSafe(subscribeBrand, getBrandSnapshot)
      const fs = useSyncExternalStoreSafe(subscribeFsBrand, getFsBrandSnapshot)
      if (uploaded.showHeroIcon === false) return null
      const own = uploaded.heroIcon
      const src = own || (fs.icon && fs.icon.dataUrl) || ""
      if (!src) return null
      const isSvg = own ? own.includes("image/svg+xml") : Boolean(fs.icon && fs.icon.mimeType === "image/svg+xml")
      const size = { height: "34px", width: "34px" }
      if (isSvg) {
        return React.createElement(InlineSvg, { src, style: size })
      }
      return React.createElement("img", {
        src, alt: "", draggable: false,
        style: { ...size, objectFit: "contain" },
        "data-ls-skip": ""
      })
    }

    // ── apply ─────────────────────────────────────────────────────────────

    // `settingsScope` is the settings transport (provided by
    // @deepseek-ai/dsh-client-ui-settings) and is what makes an uploaded brand
    // DURABLE. It must be DECLARED here: without it apply() can run before the
    // service exists, `ctx.get("settingsScope")` returns undefined, and every
    // upload silently degrades to the localStorage mirror — which a restart
    // wipes, because the harness serves a fresh random port each launch and
    // localStorage is origin-scoped. That is the whole "logo is gone when I
    // restart" report. dsh-client-ui-theme declares ["slots","locale","remote",
    // "settingsScope"] for exactly this reason; `remote` is not needed here
    // because SettingsScopeBinder binds the providing fiber for writes.
    // Measured 2026-09-16.
    const inject = ["slots", "locale", "theme", "settingsScope"]

    function apply(ctx) {
      // Inject brand CSS
      if (typeof document !== "undefined") {
        const tagId = "@muen/dsh-white-label/brand.css"
        if (!document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]")) {
          const tag = document.createElement("style")
          tag.dataset.plugin = "dsh-white-label"
          tag.dataset.pluginCss = tagId
          tag.textContent = BRAND_CSS
          document.head.appendChild(tag)
        }
      }

      // Register locale dictionaries (synchronous — must be available before slots render)
      try {
        const locale = typeof ctx.get === "function" ? ctx.get("locale") : undefined
        if (locale && typeof locale.register === "function") {
          locale.register(WL_NS, DICT)
        }
      } catch {}

      // Bind brand upload persistence
      try {
        const scopeService = typeof ctx.get === "function" ? ctx.get("settingsScope") : undefined
        BRAND_SCOPE = scopeService && typeof scopeService.bind === "function"
          ? scopeService.bind({ namespace: "white-label-brand" })
          : null
      } catch { BRAND_SCOPE = null }
      brandValue = readBrandPersisted()

      // ── accent row (order 10.5) ─────────────────────────────────────────
      const accentStore = store.defineStore({
        init: () => ({ light: null, dark: null, revision: -1 }),
        actions: {
          sync: (d, light, dark, revision) => {
            if (revision <= d.revision) return
            d.light = light; d.dark = dark; d.revision = revision
          }
        }
      })
      let bound
      let revision = 0
      const syncAccent = () => {
        accentCurrent = accentStorage.read()
        bound?.sync(accentCurrent.light, accentCurrent.dark, ++revision)
        applyAccent(ctx)
      }

      accentCurrent = accentStorage.read()
      applyAccent(ctx)

      // ── brand service + store (must be set up before the inject) ───────
      let brandService = null
      try { brandService = typeof ctx.get === "function" ? ctx.get("white-label") : null } catch { brandService = null }

      const fsBrandStore = store.defineStore({
        init: () => ({
          icon: null, logo: null,
          folder: "", errors: [],
          revealFolder: null, revision: 0
        }),
        actions: {
          sync: (d, icon, logo, folder, errors, revealFolder, revision) => {
            if (revision <= d.revision) return
            d.icon = icon; d.logo = logo; d.folder = folder
            d.errors = errors; d.revealFolder = revealFolder; d.revision = revision
          }
        }
      })

      let brandBound
      let brandRev2 = 0
      const loadBrand = async () => {
        if (!brandService || typeof brandService.readBrand !== "function") return
        try {
          const result = await brandService.readBrand()
          const reveal = typeof brandService.revealFolder === "function" ? brandService.revealFolder : null
          fsBrand.icon = result.icon
          fsBrand.logo = result.logo
          publishFsBrand()
          brandBound?.sync(result.icon, result.logo, result.folder, result.errors, reveal, ++brandRev2)
        } catch {}
      }

      let initialPath = ""
      if (brandService && typeof brandService.brandPath === "function") {
        try { initialPath = brandService.brandPath() } catch {}
      }

      // BOTH rows are registered in a single inject call using a generator,
      // because the slot system fires each inject ONCE. Two separate inject calls
      // would mean the second (brand) never fires — measured 2026-09-14.
      ctx.slots.inject("settings.general.item", function* () {
        // ── accent row (order 10.5) ──
        yield ctx.slots.register({
          name: "settings.general.item",
          id: WL_ROW_ID,
          order: 10.5,
          locale: WL_NS,
          store: accentStore,
          inject: (actions) => {
            bound = actions
            syncAccent()
            return {
              setAccent: (scheme, hex) => {
                if (!HEX_RE.test(hex)) return
                accentStorage.write(scheme === "light" ? "light" : "dark", hex.toLowerCase())
                syncAccent()
              },
              clearAccent: (scheme) => {
                accentStorage.write(scheme === "light" ? "light" : "dark", null)
                syncAccent()
              }
            }
          }
        }, AccentRow)

        // ── brand-from-filesystem row (order 20) ──
        yield ctx.slots.register({
          name: "settings.general.item",
          id: "white-label-brand",
          order: 20,
          // WL_NS, not BRAND_NS: the dictionary is registered once, under WL_NS
          // (see `locale.register(WL_NS, DICT)` above). BRAND_NS was never
          // registered, so this row rendered raw keys — "brand.title",
          // "brand.hint", "brand.path" — with no preview in the running app,
          // which reads as the plugin being absent. Measured 2026-09-16.
          locale: WL_NS,
          store: fsBrandStore,
          inject: (actions) => {
            brandBound = actions
            try {
              brandBound.sync(null, null, initialPath || "<DSH_HOME>/brand/", [], null, 0)
            } catch {}
            loadBrand()
            return {}
          }
        }, BrandRow)
      })

      // ── upload settings section ─────────────────────────────────────────
      try {
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register({
            name: "settings.section",
            id: "white-label-brand-upload",
            order: 15,
            label: () => translate("upload.title"),
          }, BrandUploadPage)
        )
      } catch {}

      // ── sidebar marks ───────────────────────────────────────────────────
      // Wrapped in try/catch: the stock dsh-web-app already registers an
      // occupant for sidebar.brand.mark. If our registration fails because the
      // slot is already taken, the brand row in Settings → General must still
      // work — the sidebar is a separate concern.
      try {
        ctx.slots.inject("sidebar.brand.mark", () =>
          ctx.slots.inject("sidebar.brand.name", () =>
            ctx.slots.inject("conversation.hero.brand.mark", function* () {
              yield ctx.slots.register({ name: "sidebar.brand.mark" }, SidebarMark)
              yield ctx.slots.register({ name: "sidebar.brand.name" }, SidebarName)
              yield ctx.slots.register({ name: "conversation.hero.brand.mark" }, HeroMark)
            })))
      } catch {}

      window[MARKER] = {
        mounted: true,
        accentRow: WL_ROW_ID,
        accentOrder: 10.5,
        brandOrder: 20,
        at: new Date().toISOString()
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.WL_ROW_ID = WL_ROW_ID
    exports.CHIPS = CHIPS
    return module.exports
  }
})
})()
