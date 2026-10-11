/**
 * 生成"易转"水印 PNG 图片（预生成方式，避免运行时字体问题）
 *
 * 关键改进：文字在 SVG 中已旋转 -45 度，PNG 输出后无需运行时旋转
 * 这样避免了矩形 PNG 旋转后边缘产生黑色竖线的问题
 *
 * 两种水印：
 * 1. watermark-image.png — 图片用：双色"易转"文字（已旋转）
 * 2. watermark-pdf.png   — PDF用：单色"易转"文字（已旋转）
 */
const sharp = require('sharp')
const fs = require('fs')
const path = require('path')
const os = require('os')

if (process.platform === 'win32') {
  process.env.TMPDIR = os.tmpdir()
}

const OUT_DIR = path.join(__dirname, 'build', 'watermark')
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })

const FONT_FAMILY = 'Microsoft YaHei, SimHei, SimSun, sans-serif'

/**
 * 验证 PNG 中是否有深色像素（文字是否渲染成功）
 */
async function verifyTextRendered(pngPath, label) {
  const buf = await sharp(pngPath).raw().toBuffer()
  let darkPx = 0
  for (let i = 0; i < buf.length; i += 4) {
    const alpha = buf[i + 3]
    if (alpha > 20 && buf[i] < 150 && buf[i + 1] < 150 && buf[i + 2] < 150) {
      darkPx++
    }
  }
  console.log(`  [${label}] 深色像素=${darkPx} ${darkPx > 100 ? '文字可见 ✓' : '文字不可见! ✗'}`)
  return darkPx > 100
}

/**
 * 验证 PNG 背景是否透明（检查边缘像素的 alpha 值）
 * 如果边缘有不透明像素，旋转后会产生黑色竖线
 */
async function verifyTransparentBackground(pngPath, label) {
  const meta = await sharp(pngPath).metadata()
  const buf = await sharp(pngPath).raw().toBuffer()
  const w = meta.width
  const h = meta.height
  let opaqueEdgePx = 0

  // 检查四条边的像素
  for (let x = 0; x < w; x++) {
    // 顶边
    const idxTop = (0 * w + x) * 4
    if (buf[idxTop + 3] > 10) opaqueEdgePx++
    // 底边
    const idxBot = ((h - 1) * w + x) * 4
    if (buf[idxBot + 3] > 10) opaqueEdgePx++
  }
  for (let y = 0; y < h; y++) {
    // 左边
    const idxLeft = (y * w + 0) * 4
    if (buf[idxLeft + 3] > 10) opaqueEdgePx++
    // 右边
    const idxRight = (y * w + (w - 1)) * 4
    if (buf[idxRight + 3] > 10) opaqueEdgePx++
  }

  console.log(`  [${label}] 边缘不透明像素=${opaqueEdgePx} ${opaqueEdgePx === 0 ? '背景透明 ✓' : '边缘有不透明像素! ✗'}`)
  return opaqueEdgePx === 0
}

/**
 * 生成图片水印：双色"易转"文字，已旋转 -45 度
 * 深色文字层（浅色背景可见）+ 白色文字层（深色背景可见）
 * 文字在 SVG 中预旋转，避免运行时旋转矩形 PNG 产生边缘竖线
 */
async function generateImageWatermark() {
  console.log('生成图片水印 (watermark-image.png)...')

  const fontSize = 120
  // 使用正方形画布，确保旋转后文字不会被裁剪
  // 对角线长度 = textW * sqrt(2) ≈ textW * 1.42，加足够边距
  const textW = Math.ceil(fontSize * 2.2)
  const canvasSize = Math.ceil(textW * 1.6) + 80

  // 双色文字，在 SVG 中预旋转 -45 度
  const svg = `<svg width="${canvasSize}" height="${canvasSize}" xmlns="http://www.w3.org/2000/svg">
  <text x="50%" y="50%" font-size="${fontSize}" fill="#000000" fill-opacity="0.55" font-family="${FONT_FAMILY}" font-weight="bold" text-anchor="middle" dominant-baseline="central" transform="rotate(-45 ${canvasSize / 2} ${canvasSize / 2})">易转</text>
  <text x="50%" y="50%" font-size="${fontSize}" fill="#ffffff" fill-opacity="0.35" font-family="${FONT_FAMILY}" font-weight="bold" text-anchor="middle" dominant-baseline="central" transform="rotate(-45 ${canvasSize / 2} ${canvasSize / 2})">易转</text>
</svg>`

  const outPath = path.join(OUT_DIR, 'watermark-image.png')
  await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toFile(outPath)
  console.log(`  尺寸: ${canvasSize}x${canvasSize} (正方形，预旋转)`)
  await verifyTextRendered(outPath, 'image')
  await verifyTransparentBackground(outPath, 'image')

  // 同时生成 medium 版本（兼容旧代码引用）
  fs.copyFileSync(outPath, path.join(OUT_DIR, 'watermark-medium.png'))
  fs.copyFileSync(outPath, path.join(OUT_DIR, 'watermark-large.png'))
  fs.copyFileSync(outPath, path.join(OUT_DIR, 'watermark-small.png'))
  console.log('  已同步到 watermark-medium/large/small.png')
}

/**
 * 生成 PDF 水印：纯透明"易转"文字，已旋转 -45 度
 */
async function generatePdfWatermark() {
  console.log('生成PDF水印 (watermark-pdf.png)...')

  const fontSize = 90
  const textW = Math.ceil(fontSize * 2.2)
  const canvasSize = Math.ceil(textW * 1.6) + 60

  const svg = `<svg width="${canvasSize}" height="${canvasSize}" xmlns="http://www.w3.org/2000/svg">
  <text x="50%" y="50%" font-size="${fontSize}" fill="#333333" fill-opacity="0.38" font-family="${FONT_FAMILY}" font-weight="bold" text-anchor="middle" dominant-baseline="central" transform="rotate(-45 ${canvasSize / 2} ${canvasSize / 2})">易转</text>
</svg>`

  const outPath = path.join(OUT_DIR, 'watermark-pdf.png')
  await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toFile(outPath)
  console.log(`  尺寸: ${canvasSize}x${canvasSize} (正方形，预旋转)`)
  await verifyTextRendered(outPath, 'pdf')
  await verifyTransparentBackground(outPath, 'pdf')
}

async function main() {
  console.log('=== 开始生成水印 PNG ===\n')
  await generateImageWatermark()
  console.log()
  await generatePdfWatermark()
  console.log('\n=== 水印生成完成 ===')
  console.log('输出目录:', OUT_DIR)
  const files = fs.readdirSync(OUT_DIR)
  for (const f of files) {
    const stat = fs.statSync(path.join(OUT_DIR, f))
    console.log(`  ${f} (${(stat.size / 1024).toFixed(1)} KB)`)
  }
}

main().catch(err => {
  console.error('ERROR:', err)
  process.exit(1)
})
