/**
 * 图片转换服务
 * 支持: PNG, JPG, WEBP, BMP 互转 + HEIC 转 JPG
 */
import { PDFDocument } from 'pdf-lib'
import fs from 'fs'
import os from 'os'
import { join, extname, dirname } from 'path'

// 修复 sharp/libvips 在 Windows 上使用 /tmp 路径的问题
// libvips 内部会使用 TMPDIR 环境变量作为临时目录，Windows 上 /tmp 不存在
if (process.platform === 'win32') {
  if (!process.env.TMPDIR || process.env.TMPDIR === '/tmp') {
    process.env.TMPDIR = os.tmpdir()
  }
}

/**
 * Sharp 懒加载（避免 sharp 原生模块加载失败时整个模块无法导入）
 * 这样即使 sharp 加载失败，pdf-lib 的 PDF 水印功能仍然可用
 */
let _sharp: any = null
let _sharpLoadError: string | null = null

/**
 * 将 sharp 原生 DLL 目录添加到 PATH，解决打包后 DLL 找不到的问题
 * 
 * 背景：
 * - sharp 的原生模块 .node 文件依赖 libvips-42.dll 等 DLL
 * - 打包后 sharp 会把 .node 复制到临时目录再加载（因为 asar 内无法直接 dlopen）
 * - 但临时目录里没有 libvips DLL，导致 ERR_DLOPEN_FAILED
 * - 解决方案：加载 sharp 前将 @img/sharp-win32-x64/lib 加入 PATH
 */
function setupSharpDllPath(): void {
  if (process.platform !== 'win32') return
  try {
    // 尝试多种路径定位 sharp 的原生 DLL 目录
    const candidates: string[] = []

    // 方式1：通过 require.resolve 找到 sharp 包位置（开发环境 + 打包后 asarUnpack 均适用）
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sharpPkgPath = require.resolve('sharp/package.json')
      const sharpDir = dirname(sharpPkgPath)
      candidates.push(join(sharpDir, '..', '@img', 'sharp-win32-x64', 'lib'))
    } catch { /* ignore */ }

    // 方式2：打包后 app.asar.unpacked 中的路径
    if (process.resourcesPath) {
      candidates.push(join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@img', 'sharp-win32-x64', 'lib'))
    }

    // 方式3：开发环境 node_modules
    candidates.push(join(__dirname, '..', '..', 'node_modules', '@img', 'sharp-win32-x64', 'lib'))

    for (const dllDir of candidates) {
      if (fs.existsSync(dllDir)) {
        const currentPath = process.env.PATH || ''
        if (!currentPath.includes(dllDir)) {
          process.env.PATH = dllDir + ';' + currentPath
          watermarkLog(`Sharp DLL 路径已添加到 PATH: ${dllDir}`)
        }
        return
      }
    }
    watermarkLog('WARNING: 未找到 sharp 原生 DLL 目录，可能导致加载失败')
  } catch (err: any) {
    watermarkLog(`WARNING: 设置 sharp DLL 路径失败: ${err?.message || err}`)
  }
}

async function getSharp(): Promise<any> {
  if (_sharpLoadError) {
    throw new Error(`Sharp 加载失败: ${_sharpLoadError}`)
  }
  if (!_sharp) {
    try {
      watermarkLog('正在动态加载 sharp...')
      // 加载前确保 DLL 路径在 PATH 中
      setupSharpDllPath()
      const mod = await import('sharp')
      _sharp = mod.default || mod
      watermarkLog('Sharp 加载成功')
    } catch (err: any) {
      _sharpLoadError = err?.message || String(err)
      watermarkLog(`ERROR: Sharp 动态加载失败: ${_sharpLoadError}`)
      throw err
    }
  }
  return _sharp
}

/**
 * 水印调试日志（写入临时文件，方便排查打包环境中的问题）
 */
function watermarkLog(message: string): void {
  try {
    const logPath = join(os.tmpdir(), 'yizhuan-watermark.log')
    const timestamp = new Date().toISOString()
    fs.appendFileSync(logPath, `[${timestamp}] ${message}\n`, 'utf-8')
  } catch {
    // 日志写入失败不影响主流程
  }
}

/**
 * 安全写入文件：优先使用 writeFileSync 原地覆盖（保持 File ID 不变）
 * 仅在原地写入失败（文件被锁定）时，回退到临时文件 + rename 策略
 *
 * 关键：renameSync 会改变文件的 File ID，导致 Windows Explorer
 * 缓存失效后无法显示文件。writeFileSync 原地覆盖保持 File ID 不变，
 * Explorer 可以正常跟踪文件变更。
 */
async function atomicWriteFile(filePath: string, data: Buffer): Promise<void> {
  // 优先尝试原地覆盖（保持 File ID）
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, 300))
      }
      fs.writeFileSync(filePath, data)
      return // 成功，直接返回
    } catch (err) {
      watermarkLog(`WARNING: 原地写入失败 (尝试 ${attempt + 1}/3): ${(err as Error).message}`)
    }
  }

  // 回退方案：临时文件 + rename（会改变 File ID，但至少能写入）
  watermarkLog(`WARNING: 原地写入失败，回退到临时文件策略: ${filePath}`)
  const tmpPath = filePath + '.wm_tmp_' + Date.now()
  try {
    fs.writeFileSync(tmpPath, data)

    let replaced = false
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, 300))
        }
        fs.renameSync(tmpPath, filePath)
        replaced = true
        break
      } catch {
        try {
          fs.copyFileSync(tmpPath, filePath)
          // copyFileSync 成功后删除临时文件
          try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
          replaced = true
          break
        } catch {
          watermarkLog(`WARNING: 临时文件替换失败 (尝试 ${attempt + 1}/3): ${filePath}`)
        }
      }
    }
    if (!replaced) {
      throw new Error('文件写入失败（原地和临时文件策略均失败）')
    }
  } finally {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  }
}

type TargetFormat = 'png' | 'jpg' | 'webp' | 'bmp' | 'heic'

interface ConvertOptions {
  quality?: number  // 1-100, 仅对 jpg/webp 有效
  width?: number    // 可选：缩放宽度
  height?: number   // 可选：缩放高度
  addWatermark?: boolean  // 是否在转换时集成水印（避免二次读写导致文件锁定）
}

interface ConvertResult {
  status: 'success' | 'error'
  output?: string
  size?: number
  message?: string
  watermarkApplied?: boolean  // 标记水印是否已在转换管道中添加
}

/**
 * 获取 sharp 支持的输入格式
 */
const SUPPORTED_INPUT_FORMATS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'gif']

/**
 * 检测文件是否为 HEIC 格式
 */
function isHeic(filePath: string): boolean {
  const ext = filePath.toLowerCase().split('.').pop()
  return ext === 'heic' || ext === 'heif'
}

/**
 * HEIC 转 JPG（通过 heic-convert）
 */
async function heicToJpg(inputPath: string, outputPath: string, options: ConvertOptions = {}): Promise<ConvertResult> {
  try {
    // heic-convert 是外部依赖，使用动态 import 兼容 ESM
    const heicConvertModule = await import('heic-convert')
    const heicConvert = heicConvertModule.default || heicConvertModule
    const inputBuffer = fs.readFileSync(inputPath)

    // heic-convert 返回 { data: Uint8Array, format: string }
    const result = await heicConvert({
      buffer: inputBuffer,
      format: 'JPEG',
      quality: (options.quality || 85) / 100
    })

    let outputBuffer = Buffer.from(result.data)
    let watermarkApplied = false

    // 如果需要水印，用 sharp 合成水印后再写入
    if (options.addWatermark) {
      try {
        const sharp = await getSharp()
        const metadata = await sharp(outputBuffer).metadata()
        const imgW = metadata.width || 800
        const imgH = metadata.height || 600
        const watermarkBuffer = await getWatermarkOverlayBuffer(imgW, imgH, 0.35)
        if (watermarkBuffer) {
          outputBuffer = await sharp(outputBuffer)
            .composite([{ input: watermarkBuffer, blend: 'over' as any }])
            .jpeg({ quality: options.quality || 85 })
            .toBuffer()
          watermarkApplied = true
          watermarkLog(`heicToJpg 水印集成成功: ${imgW}x${imgH}`)
        }
      } catch (err) {
        watermarkLog(`WARNING: heicToJpg 水印集成失败: ${err}`)
      }
    }

    fs.writeFileSync(outputPath, outputBuffer)

    return {
      status: 'success',
      output: outputPath,
      size: outputBuffer.length,
      message: `HEIC 转 JPG 成功，文件大小: ${(outputBuffer.length / 1024).toFixed(1)} KB`,
      watermarkApplied
    }
  } catch (err: any) {
    return {
      status: 'error',
      message: `HEIC 转换失败: ${err.message}`
    }
  }
}

/**
 * 通用图片格式转换（基于 sharp）
 */
export async function convertImage(
  inputPath: string,
  outputPath: string,
  targetFormat: TargetFormat,
  options: ConvertOptions = {}
): Promise<ConvertResult> {
  try {
    // 验证输入文件
    if (!fs.existsSync(inputPath)) {
      return { status: 'error', message: `输入文件不存在: ${inputPath}` }
    }

    // 确保输出目录存在
    const outputDir = dirname(outputPath)
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    // HEIC 特殊处理
    if (isHeic(inputPath)) {
      if (targetFormat === 'jpg') {
        return await heicToJpg(inputPath, outputPath, options)
      } else {
        // HEIC -> 目标格式，先转 JPG 再转目标格式
        const tmpJpg = outputPath.replace(/\.\w+$/, '.tmp.jpg')
        // 第一步不加水印，避免第二步重复加水印
        const heicResult = await heicToJpg(inputPath, tmpJpg, { ...options, addWatermark: false })
        if (heicResult.status !== 'success') return heicResult

        // 再用 sharp 转换（在此步骤集成水印）
        const result = await convertWithSharp(tmpJpg, outputPath, targetFormat, options)
        // 清理临时文件
        try { fs.unlinkSync(tmpJpg) } catch {}
        return result
      }
    }

    // 通用 sharp 转换
    return await convertWithSharp(inputPath, outputPath, targetFormat, options)
  } catch (err: any) {
    return {
      status: 'error',
      message: `图片转换失败: ${err.message}`
    }
  }
}

/**
 * 使用 sharp 执行转换
 */
async function convertWithSharp(
  inputPath: string,
  outputPath: string,
  targetFormat: TargetFormat,
  options: ConvertOptions = {}
): Promise<ConvertResult> {
  const sharp = await getSharp()

  // 读取元数据（用于水印尺寸计算）
  const metadata = await sharp(inputPath).metadata()
  let pipeline = sharp(inputPath)

  // 缩放
  if (options.width || options.height) {
    pipeline = pipeline.resize({
      width: options.width,
      height: options.height,
      fit: 'inside',
      withoutEnlargement: true
    })
  }

  // 在编码前集成水印（避免转换后二次读写导致文件锁定）
  let watermarkApplied = false
  if (options.addWatermark) {
    const imgW = metadata.width || 800
    const imgH = metadata.height || 600
    const watermarkBuffer = await getWatermarkOverlayBuffer(imgW, imgH, 0.35)
    if (watermarkBuffer) {
      pipeline = pipeline.composite([{ input: watermarkBuffer, blend: 'over' as any }])
      watermarkApplied = true
      watermarkLog(`convertWithSharp 水印集成成功: ${imgW}x${imgH} -> ${targetFormat}`)
    } else {
      watermarkLog(`WARNING: convertWithSharp 水印 overlay 生成失败，跳过水印`)
    }
  }

  // 格式转换
  switch (targetFormat) {
    case 'jpg':
      pipeline = pipeline.jpeg({
        quality: options.quality || 85,
        mozjpeg: true
      })
      break
    case 'png':
      pipeline = pipeline.png({
        compressionLevel: 9,
        palette: true
      })
      break
    case 'webp':
      pipeline = pipeline.webp({
        quality: options.quality || 85
      })
      break
    case 'bmp':
      // sharp 不直接支持 BMP 输出，转 PNG 后用 Jimp 或提示
      // 这里先转 PNG，后续可扩展
      pipeline = pipeline.png()
      break
    case 'heic':
      // HEIC/HEIF 编码
      // sharp 0.35.3 预编译二进制包含 libheif 但不含 x265 编码器，
      // 无法使用 compression: 'hevc' 编码标准 HEIC
      // 改用 AVIF（AV1 编码），它是 HEIF 容器家族中 sharp 完整支持的格式
      // AVIF 同样具有极高压缩比，是现代图片格式
      pipeline = pipeline.avif({
        quality: options.quality || 80,
        effort: 4, // 编码效率（0-9，值越大编码越慢但压缩率越高）
      } as any)
      break
    default:
      return { status: 'error', message: `不支持的目标格式: ${targetFormat}` }
  }

  // 使用 toBuffer + fs.writeFileSync 替代 toFile
  // sharp 的 toFile() 在 Windows 上处理中文路径时会报 "Invalid argument"
  const outputBuffer = await pipeline.toBuffer()
  fs.writeFileSync(outputPath, outputBuffer)

  const size = fs.statSync(outputPath).size
  return {
    status: 'success',
    output: outputPath,
    size,
    message: `转换成功，文件大小: ${(size / 1024).toFixed(1)} KB`,
    watermarkApplied
  }
}

/**
 * 批量转换图片
 */
export async function batchConvertImages(
  items: Array<{ inputPath: string, outputPath: string, targetFormat: TargetFormat }>,
  options: ConvertOptions = {},
  onProgress?: (current: number, total: number, filename: string) => void
): Promise<ConvertResult[]> {
  const results: ConvertResult[] = []
  const total = items.length

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const filename = item.inputPath.split(/[/\\]/).pop() || 'unknown'
    onProgress?.(i + 1, total, filename)
    const result = await convertImage(item.inputPath, item.outputPath, item.targetFormat, options)
    results.push(result)
  }

  return results
}

// ======================== 图片压缩功能 ========================

type CompressLevel = 'light' | 'standard' | 'aggressive' | 'custom'
type CompressFormatOption = 'keep' | 'png' | 'jpg' | 'webp'

interface CompressOptions {
  level: CompressLevel
  format?: CompressFormatOption
  // 自定义压缩选项（会员专享）
  customMaxWidth?: number     // 最大宽度（px），等比缩放
  customMaxHeight?: number    // 最大高度（px），等比缩放
  customQuality?: number      // 自定义质量（1-100）
  maintainAspectRatio?: boolean  // 固定长宽比（默认 true：保持比例；false：强制拉伸到指定宽高）
  customMaxSizeKb?: number    // 自定义最大文件大小（KB），通过二分法调整 quality 逼近目标
  addWatermark?: boolean      // 是否在压缩时同时添加水印（避免压缩后加水印导致 PNG 变大）
}

interface CompressResult {
  status: 'success' | 'error'
  output?: string
  originalSize?: number
  compressedSize?: number
  savedPercent?: number
  message?: string
}

/** level 对应的质量参数映射 */
const COMPRESS_LEVEL_CONFIG: Record<CompressLevel, { quality: number; maxResize?: number }> = {
  light:      { quality: 85 },
  standard:   { quality: 65 },
  aggressive: { quality: 35, maxResize: 2048 },
  custom:     { quality: 60 },  // 自定义模式的默认值，实际使用 customQuality 覆盖
}

/**
 * 压缩单张图片
 * @param inputPath  输入图片路径
 * @param outputPath 输出图片路径
 * @param taskId     任务 ID（可用于日志追踪）
 * @param options    压缩选项（level + 可选 format）
 */
export async function compressImage(
  inputPath: string,
  outputPath: string,
  taskId: string,
  options: CompressOptions
): Promise<CompressResult> {
  try {
    // 验证输入文件
    if (!fs.existsSync(inputPath)) {
      return { status: 'error', message: `输入文件不存在: ${inputPath}` }
    }

    // 确保输出目录存在
    const outputDir = dirname(outputPath)
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    // 读取原始文件大小
    const originalSize = fs.statSync(inputPath).size

    // 获取当前 level 配置
    const config = COMPRESS_LEVEL_CONFIG[options.level]

    // 自定义质量参数（1-100），会员专享覆盖 level 默认值
    const baseQuality = options.customQuality !== undefined
      ? Math.max(1, Math.min(100, options.customQuality))
      : config.quality

    // ===== 尺寸缩放选项（像素单位模式） =====
    // maintainAspectRatio 默认 true（保持比例）
    const maintainAspect = options.maintainAspectRatio !== false
    const hasCustomWidth = options.customMaxWidth !== undefined && options.customMaxWidth > 0
    const hasCustomHeight = options.customMaxHeight !== undefined && options.customMaxHeight > 0
    const hasCustomResize = hasCustomWidth || hasCustomHeight
    // level 默认缩放（aggressive 模式）
    const levelMaxResize = config.maxResize

    /**
     * 构建 sharp resize 选项
     * - 固定长宽比(true)且同时设宽高：fit='inside'（保持比例缩放到指定范围内）
     * - 固定长宽比(true)且只设一边：只设该维度，另一边由 sharp 按比例自动计算
     * - 不固定长宽比(false)且宽高都设：fit='fill'（强制拉伸到指定宽高）
     * - 不固定长宽比(false)且只设一边：退化为 fit='inside'（仅缩放该维度）
     */
    function buildResizeOptions():
      | { width?: number; height?: number; fit: 'inside' | 'fill'; withoutEnlargement: boolean }
      | undefined {
      // 自定义尺寸优先
      if (hasCustomResize) {
        const width = hasCustomWidth ? options.customMaxWidth : undefined
        const height = hasCustomHeight ? options.customMaxHeight : undefined
        if (maintainAspect) {
          // 固定长宽比：等比缩放到指定范围内（只设一个维度时另一个自动）
          return { width, height, fit: 'inside', withoutEnlargement: true }
        }
        // 不固定长宽比：宽高都设置时强制拉伸，否则退化为等比缩放
        if (hasCustomWidth && hasCustomHeight) {
          return { width, height, fit: 'fill', withoutEnlargement: true }
        }
        return { width, height, fit: 'inside', withoutEnlargement: true }
      }
      // level 默认缩放
      if (levelMaxResize) {
        return { width: levelMaxResize, height: levelMaxResize, fit: 'inside', withoutEnlargement: true }
      }
      return undefined
    }

    // 确定输出格式
    let outputFormat: CompressFormatOption = options.format || 'keep'
    if (outputFormat === 'keep') {
      const ext = inputPath.toLowerCase().split('.').pop() || ''
      if (['jpg', 'jpeg'].includes(ext)) outputFormat = 'jpg'
      else if (ext === 'png') outputFormat = 'png'
      else if (ext === 'webp') outputFormat = 'webp'
      else outputFormat = 'jpg' // 默认回退到 jpg
    }

    // ===== 生成水印 overlay（如果需要在压缩时同时添加水印）=====
    // 使用预渲染 PNG 生成水印 overlay，避免 SVG 嵌套渲染失败
    // 将水印集成到压缩管道中，避免压缩后再加水印导致 PNG 文件变大
    let watermarkSvgBuffer: Buffer | null = null
    if (options.addWatermark) {
      try {
        const sharp = await getSharp()
        const metadata = await sharp(inputPath).metadata()
        const imgW = metadata.width || 800
        const imgH = metadata.height || 600
        // 使用预渲染 PNG 生成水印 overlay（比 SVG 嵌套渲染更可靠）
        watermarkSvgBuffer = await getWatermarkOverlayBuffer(imgW, imgH, 0.35)
        watermarkLog(`压缩集成水印生成: ${imgW}x${imgH}, buffer=${watermarkSvgBuffer ? watermarkSvgBuffer.length : 'null'}`)
      } catch (err) {
        watermarkLog(`压缩集成水印生成失败: ${err}`)
      }
    }

    /**
     * 内部压缩函数：按指定 quality 执行一次压缩到 outputPath，返回输出文件大小
     * 如果 watermarkSvgBuffer 存在，在编码前合成水印（避免压缩后加水印导致文件变大）
     */
    async function runCompress(quality: number): Promise<number> {
      const sharp = await getSharp()
      let pipeline = sharp(inputPath)
      const resizeOpts = buildResizeOptions()
      if (resizeOpts) {
        pipeline = pipeline.resize(resizeOpts as any)
      }
      // 在编码前合成水印，这样编码器可以优化包含水印的图像数据
      if (watermarkSvgBuffer) {
        pipeline = pipeline.composite([{ input: watermarkSvgBuffer, blend: 'over' as any }])
      }
      switch (outputFormat) {
        case 'jpg':
          pipeline = pipeline.jpeg({ quality, mozjpeg: true })
          break
        case 'png':
          // PNG 使用调色板量化和最大压缩级别，减少水印带来的文件大小增长
          // 有水印时使用更少的颜色（64色）和更低的质量，因为水印会增加颜色数量
          pipeline = pipeline.png({
            compressionLevel: 9,
            palette: true,
            colours: watermarkSvgBuffer ? 64 : 128,
            quality: watermarkSvgBuffer ? 50 : 80,
            effort: 10,
          } as any)
          break
        case 'webp':
          pipeline = pipeline.webp({ quality })
          break
      }
      // 使用 toBuffer + fs.writeFileSync 替代 toFile（避免中文路径问题）
      const outBuf = await pipeline.toBuffer()
      fs.writeFileSync(outputPath, outBuf)
      return fs.statSync(outputPath).size
    }

    // ===== 执行压缩 =====
    let compressedSize: number

    if (options.customMaxSizeKb !== undefined && options.customMaxSizeKb > 0) {
      // 体积单位模式：二分法调整 quality 逼近目标文件大小
      const targetBytes = options.customMaxSizeKb * 1024

      // 先用基础 quality 压缩一次
      let quality = baseQuality
      let size = await runCompress(quality)

      // 仅对有损格式（jpg/webp）进行二分法（PNG 无损，quality 不影响文件大小）
      if (size > targetBytes && (outputFormat === 'jpg' || outputFormat === 'webp')) {
        // 文件过大，二分法寻找满足目标的最大 quality（质量尽可能高且不超标）
        let low = 5        // 最低质量
        let high = quality // 已知超标的 quality
        // 最多重试 5 次，最低不低于 5
        for (let attempt = 0; attempt < 5 && high - low > 1; attempt++) {
          const mid = Math.floor((low + high) / 2)
          const midSize = await runCompress(mid)
          if (midSize <= targetBytes) {
            low = mid       // mid 达标，记录并尝试更高
            size = midSize
          } else {
            high = mid      // mid 未达标，降低上界
          }
        }
        // 最终采用 low（满足目标且质量最高），若 low 未单独测试则补压缩一次
        if (quality !== low) {
          quality = low
          size = await runCompress(quality)
        }
      }

      compressedSize = size
    } else {
      // 像素单位 / 普通模式：直接以 baseQuality 压缩一次
      compressedSize = await runCompress(baseQuality)
    }

    // 计算节省百分比
    let savedPercent = parseFloat(
      ((originalSize - compressedSize) / originalSize * 100).toFixed(1)
    )

    // 如果有水印的 PNG 压缩后仍然比原文件大，尝试转为 JPG 格式（有损格式能更好地压缩含水印的图片）
    if (watermarkSvgBuffer && outputFormat === 'png' && compressedSize >= originalSize) {
      watermarkLog(`PNG 有水印压缩后仍然更大 (${compressedSize} >= ${originalSize})，尝试转为 JPG 格式`)
      try {
        const jpgOutputPath = outputPath.replace(/\.png$/i, '.jpg')
        const sharp = await getSharp()
        let jpgPipeline = sharp(inputPath)
        const resizeOpts = buildResizeOptions()
        if (resizeOpts) {
          jpgPipeline = jpgPipeline.resize(resizeOpts as any)
        }
        // 添加水印（使用白色背景，因为 JPG 不支持透明度）
        if (watermarkSvgBuffer) {
          // 先添加白色背景（处理透明 PNG），再添加水印
          jpgPipeline = jpgPipeline.flatten({ background: '#ffffff' })
            .composite([{ input: watermarkSvgBuffer, blend: 'over' as any }])
        }
        // 使用 toBuffer + writeFileSync 避免中文路径问题
        const jpgBuf = await jpgPipeline
          .jpeg({ quality: 75, mozjpeg: true })
          .toBuffer()
        fs.writeFileSync(jpgOutputPath, jpgBuf)

        const jpgSize = fs.statSync(jpgOutputPath).size
        if (jpgSize < originalSize) {
          // JPG 格式更小，使用 JPG 结果
          // 删除原来的 PNG 输出文件
          try { fs.unlinkSync(outputPath) } catch {}
          // 更新输出路径和大小
          outputPath = jpgOutputPath
          compressedSize = jpgSize
          savedPercent = parseFloat(
            ((originalSize - compressedSize) / originalSize * 100).toFixed(1)
          )
          watermarkLog(`PNG 转 JPG 成功: ${jpgSize} bytes, 节省 ${savedPercent}%`)
        } else {
          // JPG 也更大，删除 JPG 文件，保留 PNG
          try { fs.unlinkSync(jpgOutputPath) } catch {}
          watermarkLog(`JPG 也更大 (${jpgSize} >= ${originalSize})，保留 PNG 结果`)
        }
      } catch (err) {
        watermarkLog(`PNG 转 JPG 失败: ${err}`)
      }
    }

    return {
      status: 'success',
      output: outputPath,
      originalSize,
      compressedSize,
      savedPercent,
      message: `压缩成功，原始: ${(originalSize / 1024).toFixed(1)} KB，压缩后: ${(compressedSize / 1024).toFixed(1)} KB，节省 ${savedPercent}%`,
    }
  } catch (err: any) {
    return {
      status: 'error',
      message: `图片压缩失败: ${err.message}`,
    }
  }
}

/**
 * 批量压缩图片
 * @param items     待压缩的图片列表
 * @param taskId    任务 ID
 * @param options   压缩选项（level + 可选 format）
 * @param onProgress 可选进度回调 (current, total)
 */
export async function batchCompressImages(
  items: Array<{ inputPath: string, outputPath: string }>,
  taskId: string,
  options: CompressOptions,
  onProgress?: (current: number, total: number) => void
): Promise<CompressResult[]> {
  const results: CompressResult[] = []
  const total = items.length

  for (let i = 0; i < items.length; i++) {
    const result = await compressImage(items[i].inputPath, items[i].outputPath, taskId, options)
    results.push(result)
    onProgress?.(i + 1, total)
  }

  return results
}

// ======================== 图片水印功能 ========================

/** 水印位置到 sharp gravity 的映射 */
const WATERMARK_GRAVITY_MAP: Record<string, string> = {
  'top-left': 'northwest',
  'top-center': 'north',
  'top-right': 'northeast',
  'middle-left': 'west',
  'center': 'center',
  'middle-right': 'east',
  'bottom-left': 'southwest',
  'bottom-center': 'south',
  'bottom-right': 'southeast',
}

/**
 * 给图片添加文字水印
 * 使用 sharp 的 composite 功能叠加 SVG 文本水印
 * @param inputPath  输入图片路径
 * @param outputPath 输出图片路径
 * @param taskId     任务 ID
 * @param options    水印选项（text 必填，其余可选）
 */
export async function watermarkImage(
  inputPath: string,
  outputPath: string,
  taskId: string,
  options: {
    text: string
    fontSize?: number      // default 48
    opacity?: number       // 0-1, default 0.3
    color?: string         // default '#ffffff'
    position?: string      // 'top-left'|'top-center'|'top-right'|'middle-left'|'center'|'middle-right'|'bottom-left'|'bottom-center'|'bottom-right', default 'center'
    rotation?: number      // degrees, default -45
  }
): Promise<{ status: 'success' | 'error', output?: string, message?: string }> {
  try {
    // 验证输入文件
    if (!fs.existsSync(inputPath)) {
      return { status: 'error', message: `输入文件不存在: ${inputPath}` }
    }

    // 确保输出目录存在
    const outputDir = dirname(outputPath)
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    const fontSize = options.fontSize ?? 48
    const opacity = options.opacity ?? 0.3
    const color = options.color ?? '#ffffff'
    const position = options.position ?? 'center'
    const rotation = options.rotation ?? -45

    // 获取图片尺寸
    const sharp = await getSharp()
    const metadata = await sharp(inputPath).metadata()
    const imgWidth = metadata.width || 800
    const imgHeight = metadata.height || 600

    // 估算文本所需宽度（粗略：每个字符约 0.6 * fontSize）
    const textWidth = Math.ceil(options.text.length * fontSize * 0.6)
    // SVG 覆盖层尺寸，不超过图片边界，避免水印溢出
    const svgWidth = Math.min(Math.max(textWidth + fontSize * 2, fontSize * 2), imgWidth)
    const svgHeight = Math.min(fontSize * 3, imgHeight)

    // 位置映射到 sharp gravity
    const gravityStr = WATERMARK_GRAVITY_MAP[position] || 'center'

    // 转义 SVG 文本中的特殊字符
    const escapedText = options.text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')

    // 生成 SVG 水印（透明背景，旋转文本）
    const svgString = `<svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">
  <text x="50%" y="50%" font-size="${fontSize}" fill="${color}" fill-opacity="${opacity}" font-family="sans-serif" text-anchor="middle" dominant-baseline="middle" transform="rotate(${rotation} ${svgWidth / 2} ${svgHeight / 2})">${escapedText}</text>
</svg>`

    const svgBuffer = Buffer.from(svgString)

    // 使用 sharp composite 叠加水印
    const sharpFn = await getSharp()
    await sharpFn(inputPath)
      .composite([{ input: svgBuffer, gravity: gravityStr as any }])
      .toFile(outputPath)

    const size = fs.statSync(outputPath).size
    return {
      status: 'success',
      output: outputPath,
      message: `水印添加成功，文件大小: ${(size / 1024).toFixed(1)} KB`
    }
  } catch (err: any) {
    return {
      status: 'error',
      message: `水印添加失败: ${err.message}`
    }
  }
}

// ======================== 品牌水印功能（非会员输出自动添加） ========================

/**
 * 检测图片平均亮度，用于自适应水印颜色
 * @returns 0-255 的平均亮度值
 */
async function getImageBrightness(filePath: string): Promise<number> {
  try {
    const sharp = await getSharp()
    const stats = await sharp(filePath).stats()
    const r = stats.channels[0]?.mean || 0
    const g = stats.channels[1]?.mean || 0
    const b = stats.channels[2]?.mean || 0
    return (r * 0.299 + g * 0.587 + b * 0.114)
  } catch {
    return 128
  }
}

/**
 * 根据亮度自适应选择水印颜色
 * 暗色背景用白色文字，亮色背景用深灰文字
 */
function getAdaptiveColor(brightness: number): { color: string; opacity: number } {
  if (brightness < 128) {
    // 深色背景：使用白色文字，提高透明度确保可见
    return { color: '#ffffff', opacity: 0.4 }
  } else {
    // 浅色背景：使用深灰文字
    return { color: '#333333', opacity: 0.25 }
  }
}

/**
 * 预渲染水印 PNG 的 base64 缓存
 * 使用打包的水印 PNG 图片避免 SVG 文字渲染中文字符失败的问题
 */
let _watermarkPngBase64: string | null = null

function getWatermarkPngBase64(): string {
  if (_watermarkPngBase64) return _watermarkPngBase64

  // 使用已导入的 fs 和 join（ESM 环境下 require 可能不可用）
  // 尝试多个路径查找预渲染水印 PNG
  const candidates = [
    // 打包后
    join(process.resourcesPath || '', 'watermark', 'watermark-image.png'),
    // 开发环境
    join(globalThis.__dirname || __dirname || '.', '..', '..', 'build', 'watermark', 'watermark-image.png'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const buffer = fs.readFileSync(p)
      const base64 = buffer.toString('base64')
      _watermarkPngBase64 = base64
      watermarkLog(`水印 PNG 加载成功: ${p}, 大小: ${buffer.length} bytes`)
      return base64
    }
  }
  watermarkLog('WARNING: 未找到预渲染水印 PNG，回退到 SVG 文字模式')
  return ''
}

/**
 * 获取预渲染水印 PNG 的文件路径
 */
function getWatermarkPngPath(): string | null {
  const candidates = [
    join(process.resourcesPath || '', 'watermark', 'watermark-image.png'),
    join(globalThis.__dirname || __dirname || '.', '..', '..', 'build', 'watermark', 'watermark-image.png'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

/**
 * 生成适配目标尺寸的水印 PNG Buffer
 * 完全使用 sharp 原生操作（create + composite），不依赖 SVG 渲染
 * 预渲染 PNG 中的文字已旋转 -45 度，无需运行时旋转
 * 这样避免了矩形 PNG 旋转后边缘产生黑色竖线的问题
 *
 * @param targetWidth 目标图片宽度
 * @param targetHeight 目标图片高度
 * @param opacity 水印透明度 (0-1)，仅用于日志记录，实际透明度由预渲染 PNG 决定
 * @returns 水印 PNG Buffer（与目标图片同尺寸，可直接用于 composite）
 */
async function getWatermarkOverlayBuffer(
  targetWidth: number,
  targetHeight: number,
  opacity: number = 0.35
): Promise<Buffer | null> {
  try {
    const sharp = await getSharp()
    const wmPngPath = getWatermarkPngPath()

    if (!wmPngPath) {
      watermarkLog(`ERROR: 未找到预渲染水印 PNG，无法生成水印 overlay`)
      return null
    }

    // 预渲染 PNG 是正方形，文字已旋转 -45 度
    // 根据目标尺寸计算水印大小：取较小边的 60%
    const minDim = Math.min(targetWidth, targetHeight)
    const wmSize = Math.round(minDim * 0.6)

    // 步骤1：读取预渲染 PNG 并 resize 到合适尺寸（正方形，保持比例）
    const wmResized = await sharp(wmPngPath)
      .resize(wmSize, wmSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .toBuffer()

    // 步骤2：创建目标尺寸的透明画布，将水印居中合成（无需旋转，PNG 已预旋转）
    const overlayBuffer = await sharp({
      create: {
        width: targetWidth,
        height: targetHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite([{
        input: wmResized,
        gravity: 'center',
        blend: 'over'
      }])
      .png()
      .toBuffer()

    watermarkLog(`水印 overlay 生成成功 (预旋转PNG模式): ${targetWidth}x${targetHeight}, wmSize=${wmSize}x${wmSize}, opacity=${opacity}`)
    return overlayBuffer
  } catch (err) {
    watermarkLog(`ERROR: 水印 overlay 生成失败: ${err}`)
    return null
  }
}

/**
 * 生成水印 SVG Buffer
 * 45度倾斜，居中，半透明，自适应深浅背景色
 *
 * 实现方式（不使用 SVG feColorMatrix 滤镜，因为 sharp 的 librsvg 不支持）：
 * 1. 预渲染 PNG 水印：深色文字 + 半透明白色椭圆背景，在深浅背景上都可见
 * 2. SVG 双色文字层：黑色文字（浅色背景可见）+ 白色文字（深色背景可见）
 * 两者叠加确保水印在任何背景下都清晰可见
 *
 * @param width 画布宽度
 * @param height 画布高度
 * @param color 主颜色（当 dualColor=false 时使用）
 * @param opacity 透明度（当 dualColor=false 时使用）
 * @param text 水印文字
 * @param dualColor 是否使用双色模式（默认 true）
 */
function generateWatermarkSvg(
  width: number,
  height: number,
  color: string = '#333333',
  opacity: number = 0.35,
  text: string = '易转',
  dualColor: boolean = true
): Buffer {
  // 字体大小：画布较小边的 22%
  const fontSize = Math.round(Math.min(width, height) * 0.22)
  const rotateTransform = `rotate(-45 ${width / 2} ${height / 2})`
  const fontFamily = 'Microsoft YaHei, SimHei, SimSun, sans-serif'
  const pngBase64 = getWatermarkPngBase64()

  // 构建水印 SVG 内容
  let svgContent = ''

  // 层1：预渲染 PNG 水印（如果可用）
  // PNG 已包含深色文字 + 半透明白色椭圆背景，在深浅背景上都可见
  // PNG 透明度基于传入的 opacity 参数缩放，上限 0.55
  if (pngBase64) {
    const minDim = Math.min(width, height)
    const wmWidth = Math.round(minDim * 0.6)
    const wmHeight = Math.round(wmWidth * 0.55) // PNG 宽高比约 1.83:1
    const wmX = Math.round((width - wmWidth) / 2)
    const wmY = Math.round((height - wmHeight) / 2)
    const pngOpacity = Math.min(0.55, opacity * 2.2).toFixed(2)
    svgContent += `  <image href="data:image/png;base64,${pngBase64}" xlink:href="data:image/png;base64,${pngBase64}" x="${wmX}" y="${wmY}" width="${wmWidth}" height="${wmHeight}" transform="${rotateTransform}" opacity="${pngOpacity}"/>\n`
  }

  // 层2：SVG 双色文字（作为补充，确保即使 PNG 不可见也有水印）
  // 透明度基于传入的 opacity 参数动态缩放
  if (dualColor) {
    // 黑色文字层：浅色背景可见
    const darkOpacity = Math.max(0.08, opacity * 0.85).toFixed(2)
    svgContent += `  <text x="50%" y="50%" font-size="${fontSize}" fill="#000000" fill-opacity="${darkOpacity}" font-family="${fontFamily}" font-weight="bold" text-anchor="middle" dominant-baseline="central" transform="${rotateTransform}">${text}</text>\n`
    // 白色文字层：深色背景可见
    const lightOpacity = Math.max(0.10, opacity * 1.0).toFixed(2)
    svgContent += `  <text x="50%" y="50%" font-size="${fontSize}" fill="#ffffff" fill-opacity="${lightOpacity}" font-family="${fontFamily}" font-weight="bold" text-anchor="middle" dominant-baseline="central" transform="${rotateTransform}">${text}</text>\n`
  } else {
    svgContent += `  <text x="50%" y="50%" font-size="${fontSize}" fill="${color}" fill-opacity="${opacity}" font-family="${fontFamily}" font-weight="bold" text-anchor="middle" dominant-baseline="central" transform="${rotateTransform}">${text}</text>\n`
  }

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
${svgContent}</svg>`
  return Buffer.from(svg)
}

/**
 * 给图片添加"易转"品牌水印（非会员自动添加）
 * 水印作为背景：45度倾斜、居中、半透明、自适应颜色
 * @param filePath 图片文件路径（原地覆盖）
 */
export async function applyBrandWatermark(filePath: string): Promise<void> {
  try {
    watermarkLog(`开始添加图片水印: ${filePath}`)
    if (!fs.existsSync(filePath)) {
      watermarkLog(`ERROR: 文件不存在: ${filePath}`)
      return
    }

    const sharp = await getSharp()

    // 先读取文件到 buffer，释放文件句柄，避免后续写入时文件被锁定
    const fileBuffer = fs.readFileSync(filePath)
    const metadata = await sharp(fileBuffer).metadata()
    const imgWidth = metadata.width || 800
    const imgHeight = metadata.height || 600

    watermarkLog(`水印参数: imgWidth=${imgWidth}, imgHeight=${imgHeight}`)

    // 使用预渲染 PNG 生成水印 overlay（比 SVG 嵌套渲染更可靠）
    const watermarkPngBuffer = await getWatermarkOverlayBuffer(imgWidth, imgHeight, 0.35)
    if (!watermarkPngBuffer) {
      watermarkLog(`WARNING: 水印 overlay 生成失败，跳过水印`)
      return
    }
    watermarkLog(`水印 PNG buffer 生成成功, 大小: ${watermarkPngBuffer.length} bytes`)

    // 读取原始格式，保持输出格式一致
    const format = metadata.format || 'png'

    // 使用 buffer 作为输入（而非文件路径），避免文件句柄锁定
    const outputBuffer = await sharp(fileBuffer)
      .composite([{ input: watermarkPngBuffer, blend: 'over' as any }])
      .toFormat(format as any)
      .toBuffer()

    // 验证 buffer 有效
    if (!outputBuffer || outputBuffer.length === 0) {
      throw new Error('水印 buffer 生成失败或为空')
    }

    // 使用原子写入（临时文件 + rename），避免文件锁定导致 Explorer 不可见
    await atomicWriteFile(filePath, outputBuffer)
    watermarkLog(`SUCCESS: 图片水印添加成功: ${filePath}`)
  } catch (err) {
    watermarkLog(`ERROR: 图片水印添加失败: ${filePath} - ${err}`)
    console.error('[watermark] 图片水印添加失败:', filePath, err)
  }
}

/**
 * 给 PDF 添加水印（非会员自动添加）
 * 每页居中45度倾斜半透明水印，嵌入背景
 * 使用 SVG 生成水印图片再嵌入 PDF，避免 pdf-lib 不支持中文字符的问题
 * @param filePath PDF 文件路径（原地覆盖）
 */
async function applyPdfWatermark(filePath: string): Promise<void> {
  try {
    watermarkLog(`开始添加PDF水印: ${filePath}`)
    if (!fs.existsSync(filePath)) {
      watermarkLog(`ERROR: PDF文件不存在: ${filePath}`)
      return
    }

    const bytes = fs.readFileSync(filePath)
    const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true })
    const pages = pdfDoc.getPages()

    for (const page of pages) {
      const { width, height } = page.getSize()
      const w = Math.round(width)
      const h = Math.round(height)

      // 使用预渲染 PNG 生成水印 overlay（比 SVG 嵌套渲染更可靠）
      // opacity=0.35: PDF水印透明度
      const pngBuffer = await getWatermarkOverlayBuffer(w, h, 0.35)
      if (!pngBuffer) {
        watermarkLog(`WARNING: PDF 第 ${pages.indexOf(page) + 1} 页水印 overlay 生成失败，跳过该页`)
        continue
      }

      // 嵌入 PNG 到 PDF，覆盖整页
      const pngImage = await pdfDoc.embedPng(pngBuffer)
      page.drawImage(pngImage, {
        x: 0,
        y: 0,
        width: width,
        height: height,
        opacity: 1.0,
      })
    }

    const pdfBytes = await pdfDoc.save()
    await atomicWriteFile(filePath, Buffer.from(pdfBytes))
    watermarkLog(`SUCCESS: PDF水印添加成功: ${filePath}, 页数: ${pages.length}`)
  } catch (err) {
    watermarkLog(`ERROR: PDF水印添加失败: ${filePath} - ${err}`)
    console.error('[watermark] PDF 水印添加失败:', filePath, err)
  }
}

/**
 * 给 DOCX 文件添加水印（非会员自动添加）
 * 使用 DrawingML 锚定图片：45度倾斜、居中、半透明，衬于文字下方
 * DrawingML <wp:anchor> + behindDoc="1" 是 Word 2016+ 标准水印方式
 * @param filePath DOCX 文件路径（原地覆盖）
 */
async function applyDocxWatermark(filePath: string): Promise<void> {
  try {
    watermarkLog(`开始添加DOCX水印: ${filePath}`)
    if (!fs.existsSync(filePath)) {
      watermarkLog(`ERROR: DOCX文件不存在: ${filePath}`)
      return
    }

    const AdmZipModule = await import('adm-zip')
    const AdmZip = AdmZipModule.default || AdmZipModule
    // 先读取文件到 Buffer，避免 AdmZip 持有文件句柄导致写入时文件锁定
    const fileBuffer = fs.readFileSync(filePath)
    const zip = new AdmZip(fileBuffer)

    // 生成正方形水印 PNG（文字已预旋转 -45 度）
    const wmSize = 600
    const watermarkPngBuffer = await getWatermarkOverlayBuffer(wmSize, wmSize, 0.4)
    if (!watermarkPngBuffer) {
      watermarkLog(`ERROR: DOCX水印图片生成失败`)
      return
    }

    // 将水印图片添加到 word/media/ 目录
    const mediaPath = 'word/media/watermark.png'
    zip.addFile(mediaPath, watermarkPngBuffer)

    // 使用 DrawingML 锚定图片（Word 2016+ 标准水印方式）
    // <wp:anchor> behindDoc="1" 实现衬于文字下方
    // <wp:positionH/V> relativeFrom="margin" + center 实现居中定位
    // 图片尺寸 400pt x 400pt = 5080000 EMU (1pt = 12700 EMU)
    const relId = 'rIdYiZhuanWm'
    const imgExtent = 5080000 // 400pt in EMU
    const wmDrawingXml = `<w:p><w:r><w:rPr><w:noProof/></w:rPr><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251655168" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="margin"><wp:align>center</wp:align></wp:positionH><wp:positionV relativeFrom="margin"><wp:align>center</wp:align></wp:positionV><wp:extent cx="${imgExtent}" cy="${imgExtent}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="100" name="Watermark"/><wp:cNvGraphicFramePr/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="100" name="watermark"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${imgExtent}" cy="${imgExtent}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>`

    // DrawingML 命名空间（必须声明在 header 根元素上）
    const drawingNamespaces = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

    // 查找 header 文件
    const headerEntries = zip.getEntries().filter((e: any) => /header\d*\.xml$/.test(e.entryName))

    if (headerEntries.length > 0) {
      for (const entry of headerEntries) {
        let content = entry.getData().toString('utf-8')
        // 确保 DrawingML 命名空间存在
        if (!content.includes('xmlns:wp=')) {
          content = content.replace(/<w:hdr /, `<w:hdr ${drawingNamespaces} `)
          // 如果没有 <w:hdr 标签（可能是自闭合或其他格式），尝试在第一个标签上添加
          if (!content.includes('xmlns:wp=')) {
            content = content.replace(/(<\w+:\w+\s)/, `$1${drawingNamespaces} `)
          }
        }
        // 在 </w:hdr> 前插入水印
        if (content.includes('</w:hdr>')) {
          content = content.replace(/<\/w:hdr>/, `${wmDrawingXml}</w:hdr>`)
        } else {
          // 尝试匹配其他 header 结束标签
          content = content.replace(/(<\/[\w:]+header[\w]*>)/, `${wmDrawingXml}$1`)
        }
        zip.updateFile(entry.entryName, Buffer.from(content, 'utf-8'))
        watermarkLog(`DOCX: 水印已添加到 header: ${entry.entryName}`)
      }
      // 更新每个 header 的 rels 文件添加图片关系
      for (const entry of headerEntries) {
        const headerName = entry.entryName.split('/').pop() // e.g. header1.xml
        const relsPath = `word/_rels/${headerName}.rels`
        const relsEntry = zip.getEntry(relsPath)
        if (relsEntry) {
          let relsContent = relsEntry.getData().toString('utf-8')
          if (!relsContent.includes(relId)) {
            const relXml = `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/watermark.png"/>`
            relsContent = relsContent.replace(/<\/Relationships>/, `${relXml}</Relationships>`)
            zip.updateFile(relsPath, Buffer.from(relsContent, 'utf-8'))
          }
        } else {
          // 创建 rels 文件
          const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/watermark.png"/>\n</Relationships>`
          zip.addFile(relsPath, Buffer.from(relsXml, 'utf-8'))
        }
      }
    } else {
      // 没有 header，创建一个包含水印的 header
      const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ${drawingNamespaces}>\n${wmDrawingXml}\n</w:hdr>`
      zip.addFile('word/header1.xml', Buffer.from(headerXml, 'utf-8'))

      // 创建 header 的 rels 文件
      const headerRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/watermark.png"/>\n</Relationships>`
      zip.addFile('word/_rels/header1.xml.rels', Buffer.from(headerRelsXml, 'utf-8'))

      // 修改 document.xml.rels 添加 header 关系
      const docRelsEntry = zip.getEntry('word/_rels/document.xml.rels')
      if (docRelsEntry) {
        let relsContent = docRelsEntry.getData().toString('utf-8')
        const headerRelId = 'rIdHeaderWm1'
        if (!relsContent.includes(headerRelId)) {
          const relXml = `<Relationship Id="${headerRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>`
          relsContent = relsContent.replace(/<\/Relationships>/, `${relXml}</Relationships>`)
          zip.updateFile('word/_rels/document.xml.rels', Buffer.from(relsContent, 'utf-8'))

          // 修改 document.xml 添加 header 引用
          const docEntry = zip.getEntry('word/document.xml')
          if (docEntry) {
            let docContent = docEntry.getData().toString('utf-8')
            // 确保 document.xml 有 r 命名空间
            if (!docContent.includes('xmlns:r=')) {
              docContent = docContent.replace(/<w:document /, `<w:document xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" `)
            }
            const headerRef = `<w:headerReference w:type="default" r:id="${headerRelId}"/>`
            if (docContent.includes('<w:sectPr')) {
              // 在 sectPr 开标签后插入
              docContent = docContent.replace(/<w:sectPr[^>]*>/, match => `${match}${headerRef}`)
            } else {
              // 没有 sectPr，在 </w:body> 前创建一个
              docContent = docContent.replace(/<\/w:body>/, `<w:sectPr>${headerRef}</w:sectPr></w:body>`)
            }
            zip.updateFile('word/document.xml', Buffer.from(docContent, 'utf-8'))
            watermarkLog(`DOCX: 已创建 header1.xml 并添加 headerReference`)
          }
        }
      }
    }

    // 确保 [Content_Types].xml 包含 png 扩展名声明和 header override
    const ctEntry = zip.getEntry('[Content_Types].xml')
    if (ctEntry) {
      let ctContent = ctEntry.getData().toString('utf-8')
      // 添加 png 扩展名
      if (!ctContent.includes('Extension="png"')) {
        ctContent = ctContent.replace(/<\/Types>/, '<Default Extension="png" ContentType="image/png"/></Types>')
        watermarkLog(`DOCX: 已添加 png Content_Type 声明`)
      }
      // 确保 header1.xml 的 Override 存在（如果新建了 header）
      if (headerEntries.length === 0 && !ctContent.includes('header1.xml')) {
        ctContent = ctContent.replace(/<\/Types>/, '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>')
        watermarkLog(`DOCX: 已添加 header1.xml Content_Type Override`)
      }
      zip.updateFile('[Content_Types].xml', Buffer.from(ctContent, 'utf-8'))
    }

    // 保存修改后的 DOCX（使用原子写入，避免文件锁定导致 Explorer 不可见）
    const zipBuffer = zip.toBuffer()
    await atomicWriteFile(filePath, zipBuffer)
    watermarkLog(`SUCCESS: DOCX水印添加成功 (DrawingML): ${filePath}`)
  } catch (err) {
    watermarkLog(`ERROR: DOCX水印添加失败: ${filePath} - ${err}`)
    console.error('[watermark] DOCX 水印添加失败:', filePath, err)
  }
}

/**
 * 生成视频水印 PNG 图片到临时文件
 * 生成 960x540 的半透明水印图片供 ffmpeg overlay 使用
 * @returns 临时水印图片路径，失败返回 null
 */
export async function generateVideoWatermarkPng(): Promise<string | null> {
  try {
    // 画布尺寸 960x540，水印约占画面 1/2 宽度
    const width = 960
    const height = 540
    // 视频水印透明度 0.22，比图片水印(0.35)更低，不影响观看
    // 使用预渲染 PNG 生成水印 overlay（比 SVG 嵌套渲染更可靠）
    const overlayBuffer = await getWatermarkOverlayBuffer(width, height, 0.22)
    if (!overlayBuffer) {
      watermarkLog(`ERROR: 视频水印 overlay 生成失败`)
      return null
    }

    const tmpPath = join(os.tmpdir(), `yizhuan-video-wm-${Date.now()}.png`)
    fs.writeFileSync(tmpPath, overlayBuffer)

    watermarkLog(`视频水印PNG生成成功: ${tmpPath}`)
    return tmpPath
  } catch (err) {
    watermarkLog(`ERROR: 视频水印PNG生成失败: ${err}`)
    return null
  }
}

/**
 * 给 PPTX 文件添加水印（非会员自动添加）
 * 在每张幻灯片上添加 45 度倾斜、居中、半透明文字水印
 * @param filePath PPTX 文件路径（原地覆盖）
 */
async function applyPptxWatermark(filePath: string): Promise<void> {
  try {
    watermarkLog(`开始添加PPTX水印: ${filePath}`)
    if (!fs.existsSync(filePath)) {
      watermarkLog(`ERROR: PPTX文件不存在: ${filePath}`)
      return
    }

    const AdmZipModule = await import('adm-zip')
    const AdmZip = AdmZipModule.default || AdmZipModule
    // 先读取文件到 Buffer，避免 AdmZip 持有文件句柄导致写入时文件锁定
    const fileBuffer = fs.readFileSync(filePath)
    const zip = new AdmZip(fileBuffer)

    // 读取幻灯片尺寸（从 presentation.xml 中获取）
    // 标准尺寸：16:9 = 12192000 x 6858000 EMU，4:3 = 9144000 x 6858000 EMU
    let slideWidth = 12192000 // 默认 16:9
    let slideHeight = 6858000
    const presEntry = zip.getEntry('ppt/presentation.xml')
    if (presEntry) {
      const presContent = presEntry.getData().toString('utf-8')
      const sizeMatch = presContent.match(/<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/)
      if (sizeMatch) {
        slideWidth = parseInt(sizeMatch[1])
        slideHeight = parseInt(sizeMatch[2])
      }
    }
    watermarkLog(`PPTX 幻灯片尺寸: ${slideWidth} x ${slideHeight} EMU`)

    // 计算水印形状的居中位置
    // 形状尺寸：宽 = 幻灯片宽度的 50%，高 = 幻灯片高度的 30%
    const shapeW = Math.round(slideWidth * 0.5)
    const shapeH = Math.round(slideHeight * 0.3)
    const shapeX = Math.round((slideWidth - shapeW) / 2)
    const shapeY = Math.round((slideHeight - shapeH) / 2)

    // PPTX 水印形状 XML - 双层水印（深色 + 白色），确保深色和浅色背景都可见
    // rot: -2700000 = -45度（PPTX 角度单位为 1/60000 度）
    // 形状1：深色文字（浅色背景可见），形状2：白色文字（深色背景可见）
    // sz: 8000 = 80pt（增大字体提高可见性）
    const watermarkShapeXml = `<p:sp>
  <p:nvSpPr>
    <p:cNvPr id="9998" name="WatermarkDark"/>
    <p:cNvSpPr><a:spLocks noTextEdit="1"/></p:cNvSpPr>
    <p:nvPr/>
  </p:nvSpPr>
  <p:spPr>
    <a:xfrm rot="-2700000">
      <a:off x="${shapeX}" y="${shapeY}"/>
      <a:ext cx="${shapeW}" cy="${shapeH}"/>
    </a:xfrm>
    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
    <a:noFill/>
  </p:spPr>
  <p:txBody>
    <a:bodyPr wrap="none" rtlCol="0" anchor="ctr"/>
    <a:lstStyle/>
    <a:p>
      <a:pPr algn="ctr"/>
      <a:r>
        <a:rPr lang="zh-CN" sz="8000" b="1" spc="-1">
          <a:solidFill><a:srgbClr val="333333"><a:alpha val="35000"/></a:srgbClr></a:solidFill>
          <a:latin typeface="Microsoft YaHei"/>
          <a:ea typeface="Microsoft YaHei"/>
        </a:rPr>
        <a:t>易转</a:t>
      </a:r>
    </a:p>
  </p:txBody>
</p:sp>
<p:sp>
  <p:nvSpPr>
    <p:cNvPr id="9999" name="WatermarkLight"/>
    <p:cNvSpPr><a:spLocks noTextEdit="1"/></p:cNvSpPr>
    <p:nvPr/>
  </p:nvSpPr>
  <p:spPr>
    <a:xfrm rot="-2700000">
      <a:off x="${shapeX}" y="${shapeY}"/>
      <a:ext cx="${shapeW}" cy="${shapeH}"/>
    </a:xfrm>
    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
    <a:noFill/>
  </p:spPr>
  <p:txBody>
    <a:bodyPr wrap="none" rtlCol="0" anchor="ctr"/>
    <a:lstStyle/>
    <a:p>
      <a:pPr algn="ctr"/>
      <a:r>
        <a:rPr lang="zh-CN" sz="8000" b="1" spc="-1">
          <a:solidFill><a:srgbClr val="ffffff"><a:alpha val="40000"/></a:srgbClr></a:solidFill>
          <a:latin typeface="Microsoft YaHei"/>
          <a:ea typeface="Microsoft YaHei"/>
        </a:rPr>
        <a:t>易转</a:t>
      </a:r>
    </a:p>
  </p:txBody>
</p:sp>`

    // 查找所有幻灯片文件（slide1.xml, slide2.xml, ...）
    const slideEntries = zip.getEntries().filter((e: any) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))

    for (const entry of slideEntries) {
      let content = entry.getData().toString('utf-8')

      // 在 </p:spTree> 前插入水印形状
      if (content.includes('</p:spTree>')) {
        content = content.replace(/<\/p:spTree>/, `${watermarkShapeXml}</p:spTree>`)
        zip.updateFile(entry.entryName, Buffer.from(content, 'utf-8'))
        watermarkLog(`PPTX水印已添加到: ${entry.entryName}`)
      }
    }

    const zipBuffer = zip.toBuffer()
    await atomicWriteFile(filePath, zipBuffer)
    watermarkLog(`SUCCESS: PPTX水印添加成功: ${filePath}, 处理了 ${slideEntries.length} 张幻灯片`)
  } catch (err) {
    watermarkLog(`ERROR: PPTX水印添加失败: ${filePath} - ${err}`)
    console.error('[watermark] PPTX 水印添加失败:', filePath, err)
  }
}

/**
 * 给 XLSX 文件添加水印（非会员自动添加）
 * 在每个工作表中添加背景图片水印
 * @param filePath XLSX 文件路径（原地覆盖）
 */
async function applyXlsxWatermark(filePath: string): Promise<void> {
  try {
    watermarkLog(`开始添加XLSX水印: ${filePath}`)
    if (!fs.existsSync(filePath)) {
      watermarkLog(`ERROR: XLSX文件不存在: ${filePath}`)
      return
    }

    const AdmZipModule = await import('adm-zip')
    const AdmZip = AdmZipModule.default || AdmZipModule
    const fileBuffer = fs.readFileSync(filePath)
    const sourceZip = new AdmZip(fileBuffer)

    // 生成正方形水印 PNG（文字已预旋转 -45 度）
    const wmSize = 500
    const watermarkBuffer = await getWatermarkOverlayBuffer(wmSize, wmSize, 0.4)
    if (!watermarkBuffer) {
      watermarkLog('ERROR: 无法生成XLSX水印图片')
      return
    }

    // ===== 步骤1：提取所有文件到 Map，规范化路径为正斜杠 =====
    const fileMap = new Map<string, Buffer>()
    sourceZip.getEntries().forEach((entry: any) => {
      const normalizedName = entry.entryName.replace(/\\/g, '/')
      fileMap.set(normalizedName, entry.getData())
    })

    // ===== 步骤2：收集 Content_Types 中的 Default 和 Override =====
    const ctDefaults = new Map<string, string>()
    const ctOverrides = new Map<string, string>()
    const ctContent = (fileMap.get('[Content_Types].xml') || Buffer.from('')).toString('utf-8')
    for (const m of ctContent.matchAll(/<Default\s+Extension="([^"]+)"\s+ContentType="([^"]+)"\s*\/>/g)) {
      ctDefaults.set(m[1], m[2])
    }
    for (const m of ctContent.matchAll(/<Override\s+PartName="([^"]+)"\s+ContentType="([^"]+)"\s*\/>/g)) {
      ctOverrides.set(m[1], m[2])
    }

    // 添加必要的声明
    ctDefaults.set('png', 'image/png')

    // ===== 步骤3：处理每个工作表 =====
    const sheetEntries = Array.from(fileMap.keys()).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    watermarkLog(`XLSX: 找到 ${sheetEntries.length} 个工作表`)

    let drawingCounter = 0

    for (const sheetPath of sheetEntries) {
      drawingCounter++
      const sheetName = sheetPath.split('/').pop()!
      const sheetRelsPath = `xl/worksheets/_rels/${sheetName}.rels`
      const drawingFileName = `drawing${drawingCounter}.xml`
      const drawingPath = `xl/drawings/${drawingFileName}`
      const drawingRelsPath = `xl/drawings/_rels/${drawingFileName}.rels`

      let content = (fileMap.get(sheetPath) || Buffer.from('')).toString('utf-8')

      // 确保 worksheet 根元素有 r 命名空间
      if (!content.includes('xmlns:r=')) {
        content = content.replace(/<worksheet /, '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ')
      }

      // 移除旧版 <picture> 元素
      content = content.replace(/<picture\s+r:id="[^"]*"\s*\/>/g, '')
      content = content.replace(/<picture\s*\/>/g, '')

      // 移除已有 <drawing> 元素（避免重复）
      content = content.replace(/<drawing\s+r:id="[^"]*"\s*\/>/g, '')

      // 创建 drawing XML — oneCellAnchor（浮动在单元格上方）
      const newDrawingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:oneCellAnchor>
    <xdr:from>
      <xdr:col>2</xdr:col>
      <xdr:colOff>457200</xdr:colOff>
      <xdr:row>2</xdr:row>
      <xdr:rowOff>114300</xdr:rowOff>
    </xdr:from>
    <xdr:ext cx="5486400" cy="4114800"/>
    <xdr:pic>
      <xdr:nvPicPr>
        <xdr:cNvPr id="1" name="Watermark"/>
        <xdr:cNvPicPr/>
      </xdr:nvPicPr>
      <xdr:blipFill>
        <a:blip r:embed="rId1"/>
        <a:stretch><a:fillRect/></a:stretch>
      </xdr:blipFill>
      <xdr:spPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="5486400" cy="4114800"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      </xdr:spPr>
    </xdr:pic>
    <xdr:clientData/>
  </xdr:oneCellAnchor>
</xdr:wsDr>`
      fileMap.set(drawingPath, Buffer.from(newDrawingXml, 'utf-8'))

      // 创建 drawing rels — 引用水印图片
      const newDrawingRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/watermark.png"/>
</Relationships>`
      fileMap.set(drawingRelsPath, Buffer.from(newDrawingRelsXml, 'utf-8'))

      // 注册 drawing Override
      ctOverrides.set(`/xl/drawings/${drawingFileName}`, 'application/vnd.openxmlformats-officedocument.drawing+xml')

      // 重建工作表 rels — 收集现有关系（排除旧水印），添加 drawing 引用
      const sheetRelsMap = new Map<string, { type: string, target: string }>()
      const existingRels = (fileMap.get(sheetRelsPath) || Buffer.from('')).toString('utf-8')
      for (const m of existingRels.matchAll(/<Relationship\s+Id="([^"]+)"\s+Type="([^"]+)"\s+Target="([^"]+)"\s*\/>/g)) {
        // 排除旧版水印图片关系
        if (m[1] === 'rIdWm100') continue
        sheetRelsMap.set(m[1], { type: m[2], target: m[3] })
      }

      // 找到最大 rId 编号
      const existingRIds = Array.from(sheetRelsMap.keys())
        .filter(k => k.startsWith('rId'))
        .map(k => parseInt(k.slice(3)))
      const maxRId = existingRIds.length > 0 ? Math.max(...existingRIds) : 0
      const drawingRelId = `rId${maxRId + 1}`

      sheetRelsMap.set(drawingRelId, {
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing',
        target: `../drawings/${drawingFileName}`
      })

      // 重建 sheet rels XML
      let newSheetRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      newSheetRels += '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
      for (const [id, rel] of sheetRelsMap) {
        newSheetRels += `  <Relationship Id="${id}" Type="${rel.type}" Target="${rel.target}"/>\n`
      }
      newSheetRels += '</Relationships>'
      fileMap.set(sheetRelsPath, Buffer.from(newSheetRels, 'utf-8'))

      // 在工作表 XML 中插入 <drawing> 元素
      const drawingRefXml = `<drawing r:id="${drawingRelId}"/>`
      const afterDrawingMatch = content.match(/<(oleObjects|controls|webPublishItems|tableParts|extLst)\b/)
      if (afterDrawingMatch) {
        const insertPos = afterDrawingMatch.index!
        content = content.slice(0, insertPos) + drawingRefXml + content.slice(insertPos)
      } else if (content.includes('</worksheet>')) {
        content = content.replace(/<\/worksheet>/, `${drawingRefXml}</worksheet>`)
      } else {
        content += drawingRefXml
      }
      fileMap.set(sheetPath, Buffer.from(content, 'utf-8'))
      watermarkLog(`XLSX: drawing 已创建: ${drawingPath}, relId=${drawingRelId}, 工作表: ${sheetPath}`)
    }

    // ===== 步骤4：添加水印图片 =====
    fileMap.set('xl/media/watermark.png', watermarkBuffer)

    // ===== 步骤5：重建 [Content_Types].xml — Default 在 Override 之前 =====
    let newCt = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    newCt += '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
    for (const [ext, ct] of ctDefaults) {
      newCt += `  <Default Extension="${ext}" ContentType="${ct}"/>\n`
    }
    for (const [part, ct] of ctOverrides) {
      newCt += `  <Override PartName="${part}" ContentType="${ct}"/>\n`
    }
    newCt += '</Types>'
    fileMap.set('[Content_Types].xml', Buffer.from(newCt, 'utf-8'))

    // ===== 步骤6：创建全新 ZIP，按标准顺序添加文件 =====
    const newZip = new AdmZip()

    // 定义添加顺序（OOXML 标准）
    const orderedNames = [
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/app.xml',
      'docProps/core.xml',
    ]

    // 先添加有序文件
    for (const name of orderedNames) {
      const data = fileMap.get(name)
      if (data) {
        newZip.addFile(name, data)
        fileMap.delete(name)
      }
    }

    // 添加 xl/ 目录下的文件（按字母顺序）
    const remainingNames = Array.from(fileMap.keys()).sort()
    for (const name of remainingNames) {
      const data = fileMap.get(name)!
      newZip.addFile(name, data)
    }

    // ===== 步骤7：保存 =====
    const zipBuffer = newZip.toBuffer()
    await atomicWriteFile(filePath, zipBuffer)
    watermarkLog(`SUCCESS: XLSX水印添加成功 (oneCellAnchor/重建ZIP): ${filePath}, 处理了 ${sheetEntries.length} 个工作表, 创建了 ${drawingCounter} 个 drawing`)
  } catch (err) {
    watermarkLog(`ERROR: XLSX水印添加失败: ${filePath} - ${err}`)
    console.error('[watermark] XLSX 水印添加失败:', filePath, err)
  }
}

/**
 * 给文件添加水印（根据文件类型自动选择处理方式）
 * 支持：图片（sharp SVG）、PDF（pdf-lib + SVG）、DOCX（DrawingML）、PPTX（形状）、XLSX（背景图）、视频（需 ffmpeg overlay）
 * @param filePath 文件路径（原地覆盖）
 */
export async function applyWatermarkToFile(filePath: string): Promise<void> {
  const ext = extname(filePath).toLowerCase()
  watermarkLog(`applyWatermarkToFile 被调用: ${filePath}, 扩展名: ${ext}`)
  if (ext === '.pdf') {
    await applyPdfWatermark(filePath)
  } else if (['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tiff', '.heic', '.heif', '.avif'].includes(ext)) {
    await applyBrandWatermark(filePath)
  } else if (ext === '.docx') {
    await applyDocxWatermark(filePath)
  } else if (ext === '.pptx') {
    await applyPptxWatermark(filePath)
  } else if (ext === '.xlsx') {
    await applyXlsxWatermark(filePath)
  } else if (['.mp4', '.avi', '.mkv', '.mov', '.webm', '.flv', '.wmv', '.m4v', '.mpg', '.mpeg', '.ts'].includes(ext)) {
    // 视频水印通过 ffmpeg overlay 在 index.ts 中处理，这里不原地覆盖
    watermarkLog(`SKIP: 视频水印请在转换时通过 ffmpeg overlay 添加: ${ext}`)
  } else if (ext === '.txt') {
    // TXT 文件：在末尾追加文字水印
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const watermark = `\n\n--- 由易转转换 ---\n`
      if (!content.includes('由易转转换')) {
        fs.writeFileSync(filePath, content + watermark, 'utf-8')
        watermarkLog(`SUCCESS: TXT 水印添加成功: ${filePath}`)
      }
    } catch (err) {
      watermarkLog(`ERROR: TXT 水印添加失败: ${filePath} - ${err}`)
    }
  } else if (ext === '.html' || ext === '.htm') {
    // HTML 文件：注入 CSS 水印
    try {
      let content = fs.readFileSync(filePath, 'utf-8')
      if (!content.includes('yizhuan-watermark')) {
        const wmCss = `<style id="yizhuan-watermark">
  .yizhuan-wm{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-45deg);font-size:48px;font-weight:bold;color:rgba(128,128,128,0.3);pointer-events:none;z-index:9999;white-space:nowrap;}
</style>
<div class="yizhuan-wm">易转</div>`
        if (content.includes('</body>')) {
          content = content.replace('</body>', `${wmCss}</body>`)
        } else {
          content += wmCss
        }
        fs.writeFileSync(filePath, content, 'utf-8')
        watermarkLog(`SUCCESS: HTML 水印添加成功: ${filePath}`)
      }
    } catch (err) {
      watermarkLog(`ERROR: HTML 水印添加失败: ${filePath} - ${err}`)
    }
  } else if (ext === '.md') {
    // Markdown 文件：在末尾追加水印文字
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      if (!content.includes('由易转转换')) {
        const watermark = `\n\n---\n*由易转转换*`
        fs.writeFileSync(filePath, content + watermark, 'utf-8')
        watermarkLog(`SUCCESS: MD 水印添加成功: ${filePath}`)
      }
    } catch (err) {
      watermarkLog(`ERROR: MD 水印添加失败: ${filePath} - ${err}`)
    }
  } else {
    watermarkLog(`SKIP: 不支持的水印文件类型: ${ext}`)
  }
}

// ======================== 图片转 HTML/MD 功能 ========================

/** 图片扩展名到 MIME 类型的映射 */
const IMAGE_MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
}

/**
 * 将图片转换为 HTML 或 Markdown 文件（图片以 base64 data URI 内嵌）
 * @param inputPath  输入图片路径
 * @param outputPath 输出文件路径
 * @param taskId     任务 ID
 * @param options    转换选项（format 必填，title 可选）
 */
export async function imageToHtml(
  inputPath: string,
  outputPath: string,
  taskId: string,
  options: {
    format: 'html' | 'md'
    title?: string
  }
): Promise<{ status: 'success' | 'error', output?: string, message?: string }> {
  try {
    // 验证输入文件
    if (!fs.existsSync(inputPath)) {
      return { status: 'error', message: `输入文件不存在: ${inputPath}` }
    }

    // 确保输出目录存在
    const outputDir = dirname(outputPath)
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    // 读取图片并转为 base64 data URI
    const imageBuffer = fs.readFileSync(inputPath)
    const base64 = imageBuffer.toString('base64')
    const ext = inputPath.toLowerCase().split('.').pop() || 'png'
    const mimeType = IMAGE_MIME_MAP[ext] || 'image/png'
    const dataUri = `data:${mimeType};base64,${base64}`

    const title = options.title || '图片'

    if (options.format === 'html') {
      // 生成完整的 HTML 文档，图片以 base64 内嵌，附带样式
      const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      background: #f0f2f5;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    h1 { font-size: 24px; color: #333; margin-bottom: 20px; }
    .image-container {
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.1);
      padding: 20px;
      max-width: 90%;
    }
    img { max-width: 100%; height: auto; display: block; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <div class="image-container">
    <img src="${dataUri}" alt="${title}" />
  </div>
</body>
</html>`
      fs.writeFileSync(outputPath, html, 'utf-8')
    } else {
      // Markdown：图片以 base64 data URI 引用
      const md = `# ${title}\n\n![${title}](${dataUri})\n`
      fs.writeFileSync(outputPath, md, 'utf-8')
    }

    const size = fs.statSync(outputPath).size
    return {
      status: 'success',
      output: outputPath,
      message: `图片转 ${options.format.toUpperCase()} 成功，文件大小: ${(size / 1024).toFixed(1)} KB`
    }
  } catch (err: any) {
    return {
      status: 'error',
      message: `图片转 HTML/MD 失败: ${err.message}`
    }
  }
}
