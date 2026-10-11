/**
 * 批量转换服务
 * 支持：文件夹扫描、并行任务队列、并发控制、进度上报、取消任务
 */
import fs from 'fs'
import { join, extname, basename, dirname } from 'path'
import { convertImage } from './imageConverter'
import { performOcr, saveOcrResult } from './ocr'
import { spawn, ChildProcess } from 'child_process'

// ============================================================
// 类型定义
// ============================================================

export type BatchConversionType = 'img2png' | 'img2jpg' | 'img2webp' | 'heic2jpg' | 'ocr' | 'pdf2docx' | 'docx2pdf'

export interface BatchFileItem {
  inputPath: string
  outputPath: string
  filename: string
  ext: string
  status: 'pending' | 'processing' | 'success' | 'error' | 'skipped' | 'cancelled'
  message?: string
  size?: number
}

export interface BatchOptions {
  type: BatchConversionType
  outputDir?: string        // 自定义输出目录，不传则同源目录
  quality?: number          // 图片质量 1-100
  concurrency?: number      // 并发数，默认 3
  overwrite?: boolean       // 是否覆盖已存在文件，默认 false
  addWatermark?: boolean    // 是否在转换时集成水印（避免二次读写导致文件锁定）
}

export interface BatchProgress {
  taskId: string
  current: number
  total: number
  filename: string
  overallProgress: number   // 0-100
  itemStatus: BatchFileItem['status']
}

export interface BatchResult {
  taskId: string
  total: number
  success: number
  failed: number
  skipped: number
  items: BatchFileItem[]
  duration: number          // 毫秒
}

// ============================================================
// 支持的格式映射
// ============================================================

const FORMAT_EXTENSIONS: Record<BatchConversionType, string[]> = {
  'img2png': ['.jpg', '.jpeg', '.bmp', '.webp', '.tiff', '.gif'],
  'img2jpg': ['.png', '.bmp', '.webp', '.tiff', '.gif'],
  'img2webp': ['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.gif'],
  'heic2jpg': ['.heic', '.heif'],
  'ocr': ['.png', '.jpg', '.jpeg', '.bmp', '.webp'],
  'pdf2docx': ['.pdf'],
  'docx2pdf': ['.docx', '.doc'],
}

const OUTPUT_EXT: Record<BatchConversionType, string> = {
  'img2png': 'png',
  'img2jpg': 'jpg',
  'img2webp': 'webp',
  'heic2jpg': 'jpg',
  'ocr': 'txt',
  'pdf2docx': 'docx',
  'docx2pdf': 'pdf',
}

// ============================================================
// 文件夹扫描
// ============================================================

/**
 * 扫描文件夹中所有可转换的文件
 */
export function scanFolder(
  folderPath: string,
  type: BatchConversionType,
  recursive: boolean = true
): BatchFileItem[] {
  const results: BatchFileItem[] = []
  const validExts = FORMAT_EXTENSIONS[type].map(e => e.toLowerCase())

  function scan(dir: string) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)

      // 跳过隐藏文件和系统目录
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__MACOSX') {
        continue
      }

      if (entry.isDirectory() && recursive) {
        scan(fullPath)
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase()
        if (validExts.includes(ext)) {
          const outputExt = OUTPUT_EXT[type]
          const baseName = basename(entry.name, ext)
          const outputPath = join(dir, `${baseName}_易转.${outputExt}`)
          results.push({
            inputPath: fullPath,
            outputPath,
            filename: entry.name,
            ext: ext.substring(1),
            status: 'pending',
          })
        }
      }
    }
  }

  scan(folderPath)
  return results
}

/**
 * 从文件路径列表构建批量任务项
 */
export function buildBatchItems(
  filePaths: string[],
  type: BatchConversionType,
  outputDir?: string
): BatchFileItem[] {
  const outputExt = OUTPUT_EXT[type]
  const items: BatchFileItem[] = []

  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) {
      console.log(`[buildBatchItems] 跳过（文件不存在）: "${filePath}"`)
      continue
    }

    const ext = extname(filePath).toLowerCase()
    const validExts = FORMAT_EXTENSIONS[type].map(e => e.toLowerCase())
    if (!validExts.includes(ext)) {
      console.log(`[buildBatchItems] 跳过（格式不匹配）: "${filePath}" ext="${ext}" 需要=${validExts.join(',')}`)
      continue
    }

    const baseName = basename(filePath, ext)
    const dir = outputDir || dirname(filePath)
    const outputPath = join(dir, `${baseName}_易转.${outputExt}`)

    items.push({
      inputPath: filePath,
      outputPath,
      filename: basename(filePath),
      ext: ext.substring(1),
      status: 'pending',
    })
  }

  return items
}

/**
 * 构建批量任务项（带诊断信息）
 */
export function buildBatchItemsWithDiagnostics(
  filePaths: string[],
  type: BatchConversionType,
  outputDir?: string
): { items: BatchFileItem[], rejected: Array<{ path: string, reason: string }> } {
  const outputExt = OUTPUT_EXT[type]
  const items: BatchFileItem[] = []
  const rejected: Array<{ path: string, reason: string }> = []

  for (const filePath of filePaths) {
    if (!filePath) {
      rejected.push({ path: '(空路径)', reason: '路径为空' })
      continue
    }
    if (!fs.existsSync(filePath)) {
      rejected.push({ path: filePath, reason: '文件不存在' })
      continue
    }

    const ext = extname(filePath).toLowerCase()
    const validExts = FORMAT_EXTENSIONS[type].map(e => e.toLowerCase())
    if (!validExts.includes(ext)) {
      rejected.push({ path: filePath, reason: `格式 ${ext || '(无扩展名)'} 不匹配，需要: ${validExts.join(', ')}` })
      continue
    }

    const baseName = basename(filePath, ext)
    const dir = outputDir || dirname(filePath)
    const outputPath = join(dir, `${baseName}_易转.${outputExt}`)

    items.push({
      inputPath: filePath,
      outputPath,
      filename: basename(filePath),
      ext: ext.substring(1),
      status: 'pending',
    })
  }

  return { items, rejected }
}

// ============================================================
// 并发控制
// ============================================================

/**
 * 并发执行异步任务
 */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = []
  let index = 0

  async function worker() {
    while (index < tasks.length) {
      const currentIndex = index++
      results[currentIndex] = await tasks[currentIndex]()
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker())
  await Promise.all(workers)
  return results
}

// ============================================================
// 活跃任务管理（用于取消）
// ============================================================

const activeBatchTasks = new Map<string, { cancelled: boolean, processes: Set<ChildProcess> }>()

function registerBatchTask(taskId: string): { cancelled: boolean, processes: Set<ChildProcess> } {
  const tracker = { cancelled: false, processes: new Set<ChildProcess>() }
  activeBatchTasks.set(taskId, tracker)
  return tracker
}

function unregisterBatchTask(taskId: string) {
  activeBatchTasks.delete(taskId)
}

export function cancelBatchTask(taskId: string): boolean {
  const tracker = activeBatchTasks.get(taskId)
  if (tracker) {
    tracker.cancelled = true
    // 终止所有活跃子进程
    for (const proc of tracker.processes) {
      try { proc.kill('SIGTERM') } catch {}
    }
    return true
  }
  return false
}

// ============================================================
// Python 脚本路径获取（与 index.ts 中一致）
// ============================================================

function getPythonExe(): string {
  const bundledPython = join(__dirname, '../../python/python.exe')
  if (fs.existsSync(bundledPython)) return bundledPython
  return 'python'
}

function getPythonScript(scriptName: string): string {
  const bundledScript = join(process.resourcesPath || '', 'python', scriptName)
  if (fs.existsSync(bundledScript)) return bundledScript
  return join(__dirname, '../../python', scriptName)
}

// ============================================================
// 单文件转换执行
// ============================================================

async function convertSingleFile(
  item: BatchFileItem,
  type: BatchConversionType,
  options: BatchOptions,
  tracker: { cancelled: boolean, processes: Set<ChildProcess> }
): Promise<BatchFileItem> {
  if (tracker.cancelled) {
    item.status = 'cancelled'
    return item
  }

  // 检查输出文件是否已存在
  if (!options.overwrite && fs.existsSync(item.outputPath)) {
    item.status = 'skipped'
    item.message = '文件已存在，已跳过'
    return item
  }

  // 确保输出目录存在
  const outputDir = dirname(item.outputPath)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  item.status = 'processing'

  try {
    if (type === 'pdf2docx') {
      // PDF 转 Word — 调用 Python 子进程
      const result = await convertPdfSync(item.inputPath, item.outputPath, tracker)
      if (result.success) {
        item.status = 'success'
        item.size = result.size
        item.message = '转换成功'
      } else {
        item.status = 'error'
        item.message = result.message
      }
    } else if (type === 'docx2pdf') {
      // Word 转 PDF — 调用 Python + LibreOffice 子进程
      const result = await convertPdfSync(item.inputPath, item.outputPath, tracker, 'docx2pdf')
      if (result.success) {
        item.status = 'success'
        item.size = result.size
        item.message = '转换成功'
      } else {
        item.status = 'error'
        item.message = result.message
      }
    } else if (type === 'ocr') {
      // OCR 识别
      const ocrResult = await performOcr(item.inputPath, { lang: 'chi_sim+eng', psm: 3, taskId: `batch_ocr_${Date.now()}_${Math.random().toString(36).substring(2, 6)}` }, () => {})
      if (ocrResult.status === 'success' && ocrResult.text) {
        const saveResult = saveOcrResult(ocrResult.text, item.outputPath)
        if (saveResult.success) {
          item.status = 'success'
          item.size = Buffer.byteLength(ocrResult.text, 'utf-8')
          item.message = `识别到 ${ocrResult.text.length} 个字符`
        } else {
          item.status = 'error'
          item.message = saveResult.error || '保存失败'
        }
      } else {
        item.status = 'error'
        item.message = ocrResult.message || 'OCR 识别失败'
      }
    } else {
      // 图片格式转换
      const targetFormat = type === 'heic2jpg' ? 'jpg' : type.replace('img2', '') as 'png' | 'jpg' | 'webp'
      const result = await convertImage(item.inputPath, item.outputPath, targetFormat, {
        quality: options.quality,
        addWatermark: options.addWatermark,
      })
      if (result.status === 'success') {
        item.status = 'success'
        item.size = result.size
        item.message = '转换成功'
        // 标记水印是否已在管道中添加，供后置水印逻辑判断
        ;(item as any).watermarkApplied = result.watermarkApplied
      } else {
        item.status = 'error'
        item.message = result.message
      }
    }
  } catch (err: any) {
    item.status = 'error'
    item.message = err.message || '未知错误'
  }

  return item
}

/**
 * 同步执行 PDF/Word 转换（等待完成）
 */
function convertPdfSync(
  inputPath: string,
  outputPath: string,
  tracker: { cancelled: boolean, processes: Set<ChildProcess> },
  action: string = 'pdf2docx'
): Promise<{ success: boolean, size?: number, message?: string }> {
  return new Promise((resolve) => {
    if (tracker.cancelled) {
      resolve({ success: false, message: '已取消' })
      return
    }

    const pythonExe = getPythonExe()
    const scriptPath = getPythonScript('convert_pdf.py')
    const proc = spawn(pythonExe, [scriptPath, action, inputPath, outputPath], {
      shell: false,
    })

    tracker.processes.add(proc)

    let stderr = ''

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      tracker.processes.delete(proc)
      if (code === 0 && fs.existsSync(outputPath)) {
        const size = fs.statSync(outputPath).size
        resolve({ success: true, size })
      } else {
        resolve({ success: false, message: stderr || `进程退出码: ${code}` })
      }
    })

    proc.on('error', (err) => {
      tracker.processes.delete(proc)
      resolve({ success: false, message: err.message })
    })
  })
}

// ============================================================
// 批量转换主入口
// ============================================================

export async function executeBatchConversion(
  taskId: string,
  items: BatchFileItem[],
  options: BatchOptions,
  onProgress?: (progress: BatchProgress) => void
): Promise<BatchResult> {
  const startTime = Date.now()
  const tracker = registerBatchTask(taskId)
  const concurrency = options.concurrency || 3
  const total = items.length
  let current = 0

  // 构建任务函数
  const taskFns = items.map((item) => async () => {
    if (tracker.cancelled) {
      item.status = 'cancelled'
      current++
      return item
    }

    onProgress?.({
      taskId,
      current,
      total,
      filename: item.filename,
      overallProgress: Math.round((current / total) * 100),
      itemStatus: 'processing',
    })

    const result = await convertSingleFile(item, options.type, options, tracker)
    current++

    onProgress?.({
      taskId,
      current,
      total,
      filename: item.filename,
      overallProgress: Math.round((current / total) * 100),
      itemStatus: result.status,
    })

    return result
  })

  // 并发执行
  await runWithConcurrency(taskFns, concurrency)

  // 统计结果
  let success = 0
  let failed = 0
  let skipped = 0
  for (const item of items) {
    if (item.status === 'success') success++
    else if (item.status === 'error') failed++
    else if (item.status === 'skipped') skipped++
  }

  unregisterBatchTask(taskId)

  return {
    taskId,
    total,
    success,
    failed,
    skipped,
    items,
    duration: Date.now() - startTime,
  }
}
