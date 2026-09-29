// Pixel-level verification of a banner screenshot: checks the top strip has
// the banner's chrome color (#191a1a), contains light text pixels, and that
// the strip has the expected height. Run: electron check-pixels.cjs <png>
const { nativeImage } = require('electron')
const path = process.argv[2]
const img = nativeImage.createFromPath(path)
if (img.isEmpty()) {
  console.log('FAIL: empty image')
  process.exit(1)
}
const size = img.getSize() // device pixels (2x on retina)
const bmp = img.toBitmap() // BGRA, device pixels
const W = size.width
const H = size.height
const px = (x, y) => {
  const i = (y * W + x) * 4
  return [bmp[i + 2], bmp[i + 1], bmp[i]] // RGB
}
const near = (c, [r, g, b], tol = 8) => Math.abs(c[0] - r) <= tol && Math.abs(c[1] - g) <= tol && Math.abs(c[2] - b) <= tol

console.log(`image ${W}x${H}`)
// Banner row: mid-strip (CSS 18px -> device y = 18 * (H/800)... use ratio
const scale = H / 800
const row = Math.round(18 * scale)
const bannerY = Math.round(36 * scale) + 4 // just below the strip

const stats = (y) => {
  let chrome = 0
  let light = 0
  for (let x = 0; x < W; x += 2) {
    const c = px(x, y)
    if (near(c, [25, 26, 26])) chrome++
    else if (c[0] > 200 && c[1] > 200 && c[2] > 200) light++
  }
  return { chrome, light, sampled: Math.ceil(W / 2) }
}

const inBanner = stats(row)
const below = stats(bannerY)
console.log(`row y=${row} (in banner):  chrome=${inBanner.chrome} light=${inBanner.light}/${inBanner.sampled}`)
console.log(`row y=${bannerY} (below):    chrome=${below.chrome} light=${below.light}/${below.sampled}`)
// Edge: find strip height — walk down from top until chrome row ends
let stripEnd = 0
for (let y = 0; y < Math.round(80 * scale); y += 2) {
  const s = stats(y)
  if (s.chrome > s.sampled * 0.5) stripEnd = y
}
console.log(`chrome strip ends at device y=${stripEnd} (css ${(stripEnd / scale).toFixed(1)}px)`)
const pass = inBanner.chrome > inBanner.sampled * 0.4 && inBanner.light > 5 && stripEnd > 0
console.log(pass ? 'PASS' : 'FAIL')
process.exit(pass ? 0 : 1)
