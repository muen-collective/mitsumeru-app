const { nativeImage } = require('electron')
// Usage: auth-pixels.cjs <png> <expect: avatar|badge|orb>
const img = nativeImage.createFromPath(process.argv[2])
const expect = process.argv[3]
const { width: W, height: H } = img.getSize()
const bmp = img.toBitmap()
const px = (x, y) => {
  const i = (y * W + x) * 4
  return [bmp[i + 2], bmp[i + 1], bmp[i]]
}
// Orb: CSS left 16..52, bottom-52..bottom-16 -> device px (2x)
const x0 = 32
const x1 = 104
const y0 = H - 104
const y1 = H - 32
let teal = 0
let red = 0
let total = 0
for (let y = y0; y < y1; y++) {
  for (let x = x0; x < x1; x++) {
    const [r, g, b] = px(x, y)
    total++
    // mock avatar: R ~0x1f, G/B pushed high -> teal/blue
    if (r < 90 && g > 90 && b > 100) teal++
    // PRO badge / Muen mark red
    if (r > 200 && g < 80 && b < 80) red++
  }
}
console.log(`${process.argv[2].split('/').pop()} region ${total}px teal=${teal} red=${red}`)
let pass = false
if (expect === 'avatar') pass = teal > 300
else if (expect === 'badge') pass = red > 20
else if (expect === 'orb') {
  // signed-out: dark orb + light M letter OR red Muen mark
  let light = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const [r, g, b] = px(x, y)
      if (r > 200 && g > 200 && b > 200) light++
    }
  }
  console.log(`  light(M/initial)=${light}`)
  pass = light > 40
}
console.log(pass ? 'PASS' : 'FAIL')
process.exit(pass ? 0 : 1)
