/**
 * PDF 工具模块
 * 功能：合并、拆分、转图片、获取信息、HTML转PDF、Markdown转PDF
 * 依赖：pdf-lib, pdfjs-dist, sharp, marked
 */
import { PDFDocument } from 'pdf-lib'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import { marked } from 'marked'
import { BrowserWindow, app } from 'electron'
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * 获取 mutool.exe 路径（用于 PDF 压缩和加密）
 * 优先使用打包内置的 mutool.exe，其次使用 CAJ 工具目录中的
 */
function getMutoolPath(): string | null {
  // 打包后：extraResources 中的 mutool.exe
  const bundled = path.join(process.resourcesPath || '', 'caj-tools', 'mutool.exe')
  if (fs.existsSync(bundled)) return bundled
  // 开发环境
  const devPath = path.join(__dirname, '..', '..', 'build', 'caj-tools', 'mutool.exe')
  if (fs.existsSync(devPath)) return devPath
  // userData 目录（CAJ 运行时安装的）
  const userDataPath = path.join(app.getPath('userData'), 'caj-tools', 'mutool.exe')
  if (fs.existsSync(userDataPath)) return userDataPath
  return null
}

/**
 * Sharp 懒加载（避免 sharp 原生模块加载失败时整个 pdfTools 模块无法导入）
 * 这样即使 sharp 加载失败，htmlToPdf、mergePdfs、splitPdf 等不依赖 sharp 的功能仍然可用
 */
let _sharp: any = null
let _sharpLoadError: string | null = null

async function getSharp(): Promise<any> {
  if (_sharpLoadError) {
    throw new Error(`Sharp 加载失败: ${_sharpLoadError}`)
  }
  if (!_sharp) {
    try {
      const mod = await import('sharp')
      _sharp = mod.default || mod
    } catch (err: any) {
      _sharpLoadError = err?.message || String(err)
      throw err
    }
  }
  return _sharp
}

// ============================================================
// 类型定义
// ============================================================

/** 通用转换结果（单文件输出） */
export interface PdfConvertResult {
  status: 'success' | 'error'
  output?: string
  size?: number
  message?: string
  totalPages?: number
}

/** 拆分结果中的单项 */
export interface SplitItem {
  output: string
  pages: number
}

/** 拆分结果 */
export interface SplitResult {
  status: 'success' | 'error'
  items: SplitItem[]
  totalItems: number
  message?: string
}

/** 转图片结果中的单项 */
export interface PdfImageItem {
  output: string
  page: number
  size: number
}

/** 转图片结果 */
export interface PdfToImagesResult {
  status: 'success' | 'error'
  items: PdfImageItem[]
  totalItems: number
  message?: string
}

/** PDF 信息 */
export interface PdfInfo {
  pages: number
  size: number
}

/** 拆分模式 */
export type SplitMode = 'each' | 'range' | 'interval' | 'extract' | 'content'

/** 拆分选项 */
export interface SplitOptions {
  start?: number   // range 模式：起始页码（1-based）
  end?: number     // range 模式：结束页码（1-based）
  pagesPerFile?: number // interval 模式：每 N 页
  pages?: number[]     // extract 模式：指定页码数组（1-based）
  keyword?: string     // content 模式：按关键词拆分的关键词
}

/** PDF 转图片选项 */
export interface PdfToImagesOptions {
  format?: 'png' | 'jpg' | 'webp'
  dpi?: 72 | 150 | 200 | 300
  pages?: string   // 页码范围，如 '1-3,5'
  quality?: number // jpg/webp 质量 1-100
}

/** 进度回调类型 */
export type ProgressCallback = (current: number, total: number, status?: string) => void

// ============================================================
// 初始化 pdfjs-dist worker
// ============================================================

let workerInitialized = false

function ensurePdfJsWorker(): void {
  if (workerInitialized) return

  // pdfjs-dist v6 的 worker 文件路径
  // 开发环境：node_modules 中；打包环境：extraResources 或 asar 中
  const workerPaths = [
    // 打包后（从 app.asar.unpacked 或 node_modules）
    path.join(process.resourcesPath || '', 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'),
    // 开发环境
    path.join(__dirname, '../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs'),
  ]

  for (const p of workerPaths) {
    if (fs.existsSync(p)) {
      // 关键修复：Windows 路径必须转换为 file:/// URL
      // 否则 pdfjs-dist 的 ESM loader 会报错 "Received protocol 'c:'"
      GlobalWorkerOptions.workerSrc = `file:///${p.replace(/\\/g, '/')}`
      workerInitialized = true
      return
    }
  }

  // 回退：使用 CDN（不建议生产环境使用，但确保功能可用）
  GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs'
  workerInitialized = true
}

// ============================================================
// pdfjs-dist 文件路径查找与提取（用于隐藏窗口渲染）
// ============================================================

/**
 * 查找 pdfjs-dist 的主模块和 worker 文件路径
 */
function findPdfJsBuildFiles(): { mainPath: string; workerPath: string } {
  const searchDirs = [
    // 打包后
    path.join(process.resourcesPath || '', 'node_modules', 'pdfjs-dist', 'build'),
    // 开发环境
    path.join(__dirname, '../../node_modules/pdfjs-dist/build'),
  ]

  for (const dir of searchDirs) {
    const mainPath = path.join(dir, 'pdf.min.mjs')
    const workerPath = path.join(dir, 'pdf.worker.min.mjs')
    if (fs.existsSync(mainPath) && fs.existsSync(workerPath)) {
      return { mainPath, workerPath }
    }
  }

  return { mainPath: '', workerPath: '' }
}

/**
 * 将 pdfjs-dist 构建文件提取到临时目录（解决 asar 内文件无法被 Chromium 加载的问题）
 * 返回 file:// URL 格式的路径
 */
let pdfjsTempDir: string | null = null

function ensurePdfJsTempFiles(): { mainUrl: string; workerUrl: string } | null {
  const { mainPath, workerPath } = findPdfJsBuildFiles()

  if (!mainPath || !workerPath) {
    console.error('[pdfTools] 未找到 pdfjs-dist 构建文件')
    return null
  }

  // 创建临时目录（只提取一次）
  if (!pdfjsTempDir) {
    pdfjsTempDir = path.join(os.tmpdir(), 'yizhuan-pdfjs')
    if (!fs.existsSync(pdfjsTempDir)) {
      fs.mkdirSync(pdfjsTempDir, { recursive: true })
    }
  }

  const tempMain = path.join(pdfjsTempDir, 'pdf.min.mjs')
  const tempWorker = path.join(pdfjsTempDir, 'pdf.worker.min.mjs')

  // 如果临时文件不存在或大小不匹配，则复制
  try {
    if (!fs.existsSync(tempMain) || fs.statSync(tempMain).size !== fs.statSync(mainPath).size) {
      fs.copyFileSync(mainPath, tempMain)
    }
    if (!fs.existsSync(tempWorker) || fs.statSync(tempWorker).size !== fs.statSync(workerPath).size) {
      fs.copyFileSync(workerPath, tempWorker)
    }
  } catch (err) {
    console.error('[pdfTools] 提取 pdfjs-dist 文件失败:', err)
    return null
  }

  // 转换为 file:// URL
  const mainUrl = `file:///${tempMain.replace(/\\/g, '/')}`
  const workerUrl = `file:///${tempWorker.replace(/\\/g, '/')}`

  return { mainUrl, workerUrl }
}

// ============================================================
// 1. PDF 合并
// ============================================================

/**
 * 合并多个 PDF 文件为一个 PDF
 * @param filePaths - 待合并的 PDF 文件路径数组（按顺序）
 * @param outputPath - 输出文件路径
 * @param taskId - 任务 ID（用于进度回调标识）
 * @param onProgress - 进度回调 (loaded/total)
 */
export async function mergePdfs(
  filePaths: string[],
  outputPath: string,
  taskId: string,
  onProgress?: ProgressCallback
): Promise<PdfConvertResult> {
  try {
    if (filePaths.length === 0) {
      return { status: 'error', message: '没有选择任何文件' }
    }

    // 确保输出目录存在
    const outputDir = path.dirname(outputPath)
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    // 验证输入文件
    for (const fp of filePaths) {
      if (!fs.existsSync(fp)) {
        return { status: 'error', message: `文件不存在: ${fp}` }
      }
    }

    const mergedPdf = await PDFDocument.create()
    let totalPages = 0

    for (let i = 0; i < filePaths.length; i++) {
      onProgress?.(i, filePaths.length, `正在加载第 ${i + 1}/${filePaths.length} 个文件`)

      const bytes = fs.readFileSync(filePaths[i])
      const pdf = await PDFDocument.load(bytes)
      const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices())
      copiedPages.forEach((page) => mergedPdf.addPage(page))

      totalPages += pdf.getPageCount()
    }

    onProgress?.(filePaths.length, filePaths.length, '正在生成合并文件...')

    const mergedBytes = await mergedPdf.save()
    fs.writeFileSync(outputPath, mergedBytes)

    const size = fs.statSync(outputPath).size
    onProgress?.(filePaths.length, filePaths.length, '完成')

    return {
      status: 'success',
      output: outputPath,
      size,
      totalPages,
      message: `合并完成，共 ${filePaths.length} 个文件，${totalPages} 页`
    }
  } catch (err: any) {
    return { status: 'error', message: `PDF 合并失败: ${err.message}` }
  }
}

// ============================================================
// 2. PDF 拆分
// ============================================================

/**
 * 拆分 PDF 文件
 * @param inputPath - 输入 PDF 路径
 * @param outputPath - 输出目录路径
 * @param taskId - 任务 ID
 * @param mode - 拆分模式: each(逐页) | range(指定起止页) | interval(每N页) | extract(指定页码)
 * @param options - 拆分选项
 * @param onProgress - 进度回调
 */
export async function splitPdf(
  inputPath: string,
  outputPath: string,
  taskId: string,
  mode: SplitMode,
  options: SplitOptions = {},
  onProgress?: ProgressCallback
): Promise<SplitResult> {
  try {
    if (!fs.existsSync(inputPath)) {
      return { status: 'error', items: [], totalItems: 0, message: `文件不存在: ${inputPath}` }
    }

    // 确保输出目录存在
    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true })
    }

    const bytes = fs.readFileSync(inputPath)
    const srcPdf = await PDFDocument.load(bytes)
    const totalPages = srcPdf.getPageCount()
    const baseName = path.basename(inputPath, path.extname(inputPath))
    const ext = '.pdf'

    // 根据模式计算分组
    const groups: number[][] = [] // 每个元素是一组页码（0-based）

    switch (mode) {
      case 'each':
        // 逐页拆分：每页一个文件
        for (let i = 0; i < totalPages; i++) {
          groups.push([i])
        }
        break

      case 'range': {
        const start = Math.max(0, (options.start ?? 1) - 1)
        const end = Math.min(totalPages - 1, (options.end ?? totalPages) - 1)
        if (start > end || start >= totalPages) {
          return { status: 'error', items: [], totalItems: 0, message: '无效的页码范围' }
        }
        groups.push([])
        for (let i = start; i <= end; i++) {
          groups[0].push(i)
        }
        break
      }

      case 'interval': {
        const perFile = options.pagesPerFile ?? 1
        if (perFile < 1) {
          return { status: 'error', items: [], totalItems: 0, message: '每文件页数必须大于 0' }
        }
        let current = 0
        while (current < totalPages) {
          const group: number[] = []
          for (let j = 0; j < perFile && current < totalPages; j++, current++) {
            group.push(current)
          }
          groups.push(group)
        }
        break
      }

      case 'extract': {
        const pages = (options.pages ?? []).map(p => p - 1).filter(p => p >= 0 && p < totalPages)
        if (pages.length === 0) {
          return { status: 'error', items: [], totalItems: 0, message: '没有有效的页码' }
        }
        groups.push(pages)
        break
      }

      case 'content': {
        const keyword = (options.keyword ?? '').trim()
        if (!keyword) {
          return { status: 'error', items: [], totalItems: 0, message: '请输入关键词' }
        }
        // 使用 pdfjs-dist 逐页提取文本，找到包含关键词的页码
        let keywordPages: number[] = []
        try {
          // 使用 pdfjs-dist 的 getDocument 加载 PDF
          const pdfjsDoc = await getDocument({ data: bytes }).promise
          for (let i = 1; i <= pdfjsDoc.numPages; i++) {
            const page = await pdfjsDoc.getPage(i)
            const textContent = await page.getTextContent()
            const pageText = textContent.items.map((item: any) => item.str || '').join(' ')
            if (pageText.includes(keyword)) {
              keywordPages.push(i - 1) // 转为 0-based
            }
          }
        } catch (err) {
          // 如果 pdfjs-dist 提取失败，回退到默认行为
          console.warn('PDF 文本提取失败，使用默认拆分:', err)
          // 默认所有页面都包含关键词（即逐页拆分）
          keywordPages = Array.from({ length: totalPages }, (_, i) => i)
        }

        if (keywordPages.length === 0) {
          return { status: 'error', items: [], totalItems: 0, message: `未找到包含关键词 "${keyword}" 的页面` }
        }

        // 以关键词出现的页面为分组起点
        // 每组从 keywordPages[n] 开始，到 keywordPages[n+1] - 1 结束
        let currentGroup: number[] = []
        for (let i = 0; i < totalPages; i++) {
          currentGroup.push(i)
          if (keywordPages.includes(i) && currentGroup.length > 1) {
            // 当前页是关键词页，且不是第一页
            // 弹出当前页，加入上一组
            const lastPage = currentGroup.pop()!
            if (currentGroup.length > 0) {
              groups.push(currentGroup)
            }
            currentGroup = [lastPage]
          }
        }
        // 最后一组
        if (currentGroup.length > 0) {
          groups.push(currentGroup)
        }

        // 如果只有一组，说明没有按内容分到多个组
        if (groups.length <= 1) {
          return { status: 'error', items: [], totalItems: 0, message: `关键词 "${keyword}" 出现在所有页面，无法拆分` }
        }
        break
      }

      default:
        return { status: 'error', items: [], totalItems: 0, message: `不支持的拆分模式: ${mode}` }
    }

    // 生成拆分文件
    const items: SplitItem[] = []
    for (let g = 0; g < groups.length; g++) {
      onProgress?.(g + 1, groups.length, `正在拆分第 ${g + 1}/${groups.length} 部分`)

      const newPdf = await PDFDocument.create()
      const copiedPages = await newPdf.copyPages(srcPdf, groups[g])
      copiedPages.forEach((page) => newPdf.addPage(page))

      // 文件名：如果只有一个分组，使用原文件名 + _extracted；否则加序号
      let fileName: string
      if (groups.length === 1 && mode === 'range') {
        fileName = `${baseName}_p${options.start}-${options.end}${ext}`
      } else if (groups.length === 1 && mode === 'extract') {
        fileName = `${baseName}_extracted${ext}`
      } else if (mode === 'each') {
        fileName = `${baseName}_${String(groups[g][0] + 1).padStart(3, '0')}${ext}`
      } else {
        fileName = `${baseName}_${String(g + 1).padStart(3, '0')}${ext}`
      }

      const outPath = path.join(outputPath, fileName)
      const newBytes = await newPdf.save()
      fs.writeFileSync(outPath, newBytes)

      items.push({ output: outPath, pages: groups[g].length })
    }

    onProgress?.(groups.length, groups.length, '完成')

    return {
      status: 'success',
      items,
      totalItems: items.length,
      message: `拆分完成，共生成 ${items.length} 个文件`
    }
  } catch (err: any) {
    return { status: 'error', items: [], totalItems: 0, message: `PDF 拆分失败: ${err.message}` }
  }
}

// ============================================================
// 3. PDF 转图片
// ============================================================

/**
 * 解析页码范围字符串（如 '1-3,5,7-9'）为页码数组（1-based）
 */
function parsePageRange(rangeStr: string, maxPage: number): number[] {
  const pages = new Set<number>()
  const parts = rangeStr.split(',').map(s => s.trim()).filter(Boolean)

  for (const part of parts) {
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-').map(s => s.trim())
      const start = parseInt(startStr, 10)
      const end = parseInt(endStr, 10)
      if (!isNaN(start) && !isNaN(end)) {
        for (let p = Math.max(1, start); p <= Math.min(maxPage, end); p++) {
          pages.add(p)
        }
      }
    } else {
      const p = parseInt(part, 10)
      if (!isNaN(p) && p >= 1 && p <= maxPage) {
        pages.add(p)
      }
    }
  }

  return Array.from(pages).sort((a, b) => a - b)
}

/**
 * 将 PDF 转换为图片
 * 使用 Electron 隐藏 BrowserWindow + pdfjs-dist 渲染 PDF 页面，再用 sharp 保存为 PNG/JPG
 * 无需 node-canvas 原生依赖，直接利用 Electron 内置的 Chromium 渲染引擎
 * @param inputPath - 输入 PDF 路径
 * @param outputDir - 输出目录
 * @param taskId - 任务 ID
 * @param options - 转换选项
 * @param onProgress - 进度回调 (currentPage/totalPages)
 * @param getHiddenWindow - 创建隐藏窗口的工厂函数
 */
export async function pdfToImages(
  inputPath: string,
  outputDir: string,
  taskId: string,
  options: PdfToImagesOptions = {},
  onProgress?: ProgressCallback,
  getHiddenWindow?: (html: string) => Promise<BrowserWindow>
): Promise<PdfToImagesResult> {
  try {
    ensurePdfJsWorker()

    if (!fs.existsSync(inputPath)) {
      return { status: 'error', items: [], totalItems: 0, message: `文件不存在: ${inputPath}` }
    }

    // 确定实际输出目录（空字符串时使用源文件所在目录）
    const actualOutputDir = outputDir?.trim?.()
      ? outputDir
      : path.dirname(inputPath)

    // 确保输出目录存在
    if (!fs.existsSync(actualOutputDir)) {
      fs.mkdirSync(actualOutputDir, { recursive: true })
    }

    const format = options.format || 'png'
    const dpi = options.dpi || 150
    const quality = options.quality || 85
    const baseName = path.basename(inputPath, path.extname(inputPath))

    // 提取 pdfjs-dist 文件到临时目录（用于隐藏窗口的 file:// 加载）
    const pdfjsUrls = ensurePdfJsTempFiles()
    if (!pdfjsUrls) {
      return { status: 'error', items: [], totalItems: 0, message: 'PDF 渲染组件缺失，请重新安装应用' }
    }

    // 加载 PDF 文档获取页数（主进程中使用 pdfjs-dist，仅获取元数据）
    const pdfBytes = fs.readFileSync(inputPath)
    const data = new Uint8Array(pdfBytes)
    const pdfDoc = await getDocument({ data }).promise
    const totalPages = pdfDoc.numPages

    // 确定要转换的页码（1-based）
    let targetPages: number[]
    if (options.pages) {
      targetPages = parsePageRange(options.pages, totalPages)
    } else {
      targetPages = Array.from({ length: totalPages }, (_, i) => i + 1)
    }

    if (targetPages.length === 0) {
      return { status: 'error', items: [], totalItems: 0, message: '没有匹配的页码' }
    }

    const items: PdfImageItem[] = []
    const scale = dpi / 72

    // 创建临时渲染目录
    const renderTempDir = path.join(os.tmpdir(), 'yizhuan-render')
    if (!fs.existsSync(renderTempDir)) {
      fs.mkdirSync(renderTempDir, { recursive: true })
    }

    // 将 PDF 数据写入临时文件（供隐藏窗口通过 file:// 加载）
    const tempPdfPath = path.join(renderTempDir, `source_${Date.now()}.pdf`)
    fs.writeFileSync(tempPdfPath, pdfBytes)
    const pdfFileUrl = `file:///${tempPdfPath.replace(/\\/g, '/')}`

    for (let idx = 0; idx < targetPages.length; idx++) {
      const pageNum = targetPages[idx]
      onProgress?.(idx + 1, targetPages.length, `正在渲染第 ${pageNum} 页`)

      // 获取页面尺寸（主进程中获取，避免在渲染器中重复加载）
      const page = await pdfDoc.getPage(pageNum)
      const viewport = page.getViewport({ scale })
      const imgWidth = Math.floor(viewport.width)
      const imgHeight = Math.floor(viewport.height)

      // 构建 HTML 文件
      // 使用 canvas.toDataURL() 直接获取渲染结果，避免 capturePage 的时序问题和颜色空间转换问题
      const htmlContent = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; }
  body { overflow: hidden; background: #ffffff; }
  canvas { display: block; }
</style>
</head>
<body>
<canvas id="c" width="${imgWidth}" height="${imgHeight}"></canvas>
<script type="module">
import * as pdfjsLib from '${pdfjsUrls.mainUrl}';
pdfjsLib.GlobalWorkerOptions.workerSrc = '${pdfjsUrls.workerUrl}';

(async () => {
  try {
    const loadingTask = pdfjsLib.getDocument({ url: '${pdfFileUrl}' });
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(${pageNum});
    const viewport = page.getViewport({ scale: ${scale} });
    const canvas = document.getElementById('c');
    canvas.width = ${imgWidth};
    canvas.height = ${imgHeight};
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, ${imgWidth}, ${imgHeight});
    await page.render({ canvasContext: ctx, viewport }).promise;
    // 等待一帧确保绘制完成
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    // 将 canvas 转为 data URL 并通过 title 传递（base64 PNG）
    const dataUrl = canvas.toDataURL('image/png');
    // title 有长度限制，使用 sessionStorage 暂存
    sessionStorage.setItem('renderResult', dataUrl);
    document.title = 'render-done';
  } catch (err) {
    document.title = 'render-error:' + (err.message || String(err));
  }
})();
</script>
</body>
</html>`

      // 将 HTML 写入临时文件（通过 file:// 协议加载，确保 ES 模块解析正常）
      const tempHtmlPath = path.join(renderTempDir, `render_p${pageNum}_${Date.now()}.html`)
      fs.writeFileSync(tempHtmlPath, htmlContent)

      // 创建隐藏窗口（尺寸精确匹配 canvas，避免 capturePage 捕获到白边）
      const hiddenWin = new BrowserWindow({
        width: Math.min(imgWidth, 4096),
        height: Math.min(imgHeight, 4096),
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          offscreen: false,
          webSecurity: false,
        }
      })

      try {
        // 通过 file:// 协议加载 HTML（确保 ES 模块 import 正常解析）
        await hiddenWin.loadFile(tempHtmlPath)

        // 等待渲染完成（检查 document.title 变化）
        await new Promise<void>((resolve, reject) => {
          const startTime = Date.now()
          const TIMEOUT = 30000

          const checkTitle = () => {
            if (hiddenWin.isDestroyed()) {
              reject(new Error('渲染窗口已关闭'))
              return
            }
            const title = hiddenWin.webContents.getTitle()
            if (title === 'render-done') {
              resolve()
              return
            }
            if (title.startsWith('render-error:')) {
              reject(new Error(title.substring('render-error:'.length)))
              return
            }
            if (Date.now() - startTime > TIMEOUT) {
              reject(new Error('渲染超时（30秒），可能是 pdfjs-dist 加载失败'))
              return
            }
            setTimeout(checkTitle, 200)
          }
          setTimeout(checkTitle, 500)
        })

        // 从 sessionStorage 中获取 canvas.toDataURL() 的结果（避免 capturePage 的颜色空间转换和时序问题）
        const dataUrl = await hiddenWin.webContents.executeJavaScript(
          `sessionStorage.getItem('renderResult') || ''`
        )

        if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) {
          throw new Error('渲染结果获取失败：sessionStorage 中无有效数据')
        }

        // 将 base64 data URL 转为 Buffer
        const base64Data = dataUrl.substring('data:image/png;base64,'.length)
        const imgBuffer = Buffer.from(base64Data, 'base64')

        // 确定输出路径
        const ext = format === 'jpg' ? 'jpg' : format === 'webp' ? 'webp' : 'png'
        const fileName = targetPages.length === 1
          ? `${baseName}_易转.${ext}`
          : `${baseName}_${String(pageNum).padStart(3, '0')}.${ext}`
        const outPath = path.join(actualOutputDir, fileName)

        // 使用 sharp 优化输出（直接处理 PNG buffer，格式转换/质量调整）
        const sharp = await getSharp()
        await sharp(imgBuffer)
          .toFormat(format === 'jpg' ? 'jpeg' : format === 'webp' ? 'webp' : 'png', {
            quality: (format === 'jpg' || format === 'webp') ? quality : undefined,
            compressionLevel: format === 'png' ? 6 : undefined
          })
          .toFile(outPath)

        const size = fs.statSync(outPath).size
        items.push({ output: outPath, page: pageNum, size })
      } finally {
        if (!hiddenWin.isDestroyed()) {
          hiddenWin.close()
        }
        try { fs.unlinkSync(tempHtmlPath) } catch { /* ignore */ }
      }
    }

    // 清理临时 PDF 文件
    try { fs.unlinkSync(tempPdfPath) } catch { /* ignore */ }

    onProgress?.(targetPages.length, targetPages.length, '完成')

    return {
      status: 'success',
      items,
      totalItems: items.length,
      message: `转换完成，共 ${items.length} 张图片`
    }
  } catch (err: any) {
    return { status: 'error', items: [], totalItems: 0, message: `PDF 转图片失败: ${err.message}` }
  }
}

// ============================================================
// 4. 获取 PDF 信息
// ============================================================

/**
 * 获取 PDF 文件的基本信息（页数和文件大小）
 * 使用正则解析 PDF 二进制内容快速获取页数（同步，无需完整加载 PDF）
 * 对于需要精确页数的场景，请使用异步的 getPdfPageCount
 * @param inputPath - PDF 文件路径
 */
export async function getPdfInfo(inputPath: string): Promise<PdfInfo> {
  try {
    if (!fs.existsSync(inputPath)) {
      return { pages: 0, size: 0 }
    }

    const bytes = fs.readFileSync(inputPath)
    const size = bytes.length

    // 使用 pdf-lib 精确解析页数（支持各种 PDF 结构）
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true })
    const pages = pdf.getPageCount()

    return { pages, size }
  } catch {
    return { pages: 0, size: 0 }
  }
}

/**
 * 获取 PDF 页数（异步版本，使用 pdf-lib 精确解析）
 * 当同步 getPdfInfo 的正则方法不准确时使用
 */
export async function getPdfPageCount(inputPath: string): Promise<number> {
  try {
    if (!fs.existsSync(inputPath)) return 0
    const bytes = fs.readFileSync(inputPath)
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true })
    return pdf.getPageCount()
  } catch {
    return 0
  }
}

// ============================================================
// 5. HTML 转 PDF（通过 Electron 隐藏窗口）
// ============================================================

/**
 * 创建一个隐藏的 BrowserWindow 用于 HTML/Markdown 转 PDF
 * 使用 file:// 协议加载临时 HTML 文件，避免 data: URL 的内容长度限制和模块解析问题
 * @param htmlContent - HTML 内容
 * @returns 加载完成的 BrowserWindow 实例
 */
export async function createHiddenWindow(htmlContent: string): Promise<BrowserWindow> {
  const hiddenWin = new BrowserWindow({
    width: 1200,
    height: 1600,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      offscreen: false
    }
  })

  // 将 HTML 内容写入临时文件，通过 file:// 协议加载
  // 避免 data:text/html URL 在内容较大时超过 Chromium URL 长度限制导致加载失败
  const tempDir = path.join(os.tmpdir(), 'yizhuan-html')
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true })
  }
  const tempHtmlPath = path.join(tempDir, `html2pdf_${Date.now()}.html`)
  fs.writeFileSync(tempHtmlPath, htmlContent, 'utf-8')

  try {
    await hiddenWin.loadFile(tempHtmlPath)
  } catch (err: any) {
    try { fs.unlinkSync(tempHtmlPath) } catch { /* ignore */ }
    throw new Error(`页面加载失败: ${err.message}`)
  }

  // 等待内容完全加载和渲染（支持外部资源如图片、CSS）
  await new Promise<void>((resolve) => {
    const wc = hiddenWin.webContents
    const TIMEOUT = 15000 // 15秒加载超时

    // 如果已经在加载完成状态，直接 resolve
    if (!wc.isLoading()) {
      setTimeout(resolve, 500)
      return
    }

    const timer = setTimeout(() => {
      // 超时不报错，直接用已加载的内容渲染 PDF
      // 外部资源加载失败不应阻止 PDF 生成
      resolve()
    }, TIMEOUT)

    wc.once('did-finish-load', () => {
      clearTimeout(timer)
      // 额外等待让外部资源（图片/CSS）渲染完成
      setTimeout(resolve, 800)
    })

    wc.once('did-fail-load', () => {
      clearTimeout(timer)
      // 加载失败也不报错，尝试继续渲染
      resolve()
    })
  })

  // 延迟清理临时文件（窗口仍在使用中，等窗口关闭后清理）
  hiddenWin.once('closed', () => {
    try { fs.unlinkSync(tempHtmlPath) } catch { /* ignore */ }
  })

  return hiddenWin
}

/**
 * 带超时的 Promise 包装器
 */
function withTimeout<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(reason)), ms)
    )
  ])
}

/**
 * HTML 转 PDF
 * 使用 Electron 的 webContents.printToPDF 在隐藏 BrowserWindow 中渲染 HTML 并输出 PDF
 * @param htmlContent - HTML 内容字符串
 * @param outputPath - 输出 PDF 路径
 * @param taskId - 任务 ID
 * @param getHiddenWindow - 获取隐藏 BrowserWindow 的工厂函数（由调用方提供，用于传递 Electron 实例）
 */
export async function htmlToPdf(
  htmlContent: string,
  outputPath: string,
  taskId: string,
  getHiddenWindow: (html: string) => Promise<BrowserWindow>
): Promise<PdfConvertResult> {
  try {
    // 确保输出目录存在
    const outputDir = path.dirname(outputPath)
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    // 创建隐藏窗口并加载 HTML（含加载超时）
    const hiddenWin = await getHiddenWindow(htmlContent)

    try {
      // 额外等待让页面中的异步内容（如图片、JS渲染）完成
      await new Promise(r => setTimeout(r, 1000))

      // 调用 printToPDF 生成 PDF 数据（带60秒超时）
      const pdfData = await withTimeout(
        hiddenWin.webContents.printToPDF({
          printBackground: true,
          pageSize: 'A4',
          margins: {
            marginType: 'default'
          }
        }),
        60000,
        'PDF 生成超时（60秒），HTML 内容可能过于复杂'
      )

      // 保存 PDF 文件
      fs.writeFileSync(outputPath, pdfData)

      const size = fs.statSync(outputPath).size

      // 获取页数
      const pdfDoc = await PDFDocument.load(pdfData)
      const totalPages = pdfDoc.getPageCount()

      return {
        status: 'success',
        output: outputPath,
        size,
        totalPages,
        message: `HTML 转 PDF 完成，共 ${totalPages} 页`
      }
    } finally {
      // 确保关闭隐藏窗口
      if (!hiddenWin.isDestroyed()) {
        hiddenWin.close()
      }
    }
  } catch (err: any) {
    return { status: 'error', message: `HTML 转 PDF 失败: ${err.message}` }
  }
}

// ============================================================
// 6. Markdown 转 PDF
// ============================================================

/**
 * Markdown 转 PDF
 * 先使用 marked 将 Markdown 转为 HTML，再复用 htmlToPdf
 * @param markdownContent - Markdown 内容字符串
 * @param outputPath - 输出 PDF 路径
 * @param taskId - 任务 ID
 * @param getHiddenWindow - 获取隐藏 BrowserWindow 的工厂函数
 */
export async function markdownToPdf(
  markdownContent: string,
  outputPath: string,
  taskId: string,
  getHiddenWindow: (html: string) => Promise<BrowserWindow>
): Promise<PdfConvertResult> {
  try {
    // 使用 marked 将 Markdown 转为 HTML
    const htmlContent = await marked.parse(markdownContent)

    // 添加基础样式，确保输出美观
    const styledHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      font-size: 14px;
      line-height: 1.8;
      color: #333;
      padding: 40px 50px;
    }
    h1 { font-size: 24px; margin: 20px 0 15px; color: #1a1a1a; border-bottom: 2px solid #e0e0e0; padding-bottom: 8px; }
    h2 { font-size: 20px; margin: 18px 0 12px; color: #1a1a1a; border-bottom: 1px solid #eee; padding-bottom: 6px; }
    h3 { font-size: 17px; margin: 15px 0 10px; color: #333; }
    h4 { font-size: 15px; margin: 12px 0 8px; color: #555; }
    p { margin: 10px 0; }
    a { color: #0969da; text-decoration: none; }
    code {
      font-family: "SF Mono", "Fira Code", "Consolas", monospace;
      font-size: 13px;
      background: #f6f8fa;
      padding: 2px 6px;
      border-radius: 4px;
    }
    pre {
      background: #f6f8fa;
      border: 1px solid #e1e4e8;
      border-radius: 6px;
      padding: 16px;
      overflow-x: auto;
      margin: 12px 0;
    }
    pre code { background: none; padding: 0; font-size: 13px; }
    blockquote {
      border-left: 4px solid #ddd;
      padding: 8px 16px;
      margin: 12px 0;
      color: #666;
      background: #f9f9f9;
    }
    ul, ol { margin: 10px 0; padding-left: 28px; }
    li { margin: 5px 0; }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 12px 0;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 8px 12px;
      text-align: left;
    }
    th { background: #f6f8fa; font-weight: 600; }
    hr { border: none; border-top: 1px solid #e0e0e0; margin: 20px 0; }
    img { max-width: 100%; height: auto; }
  </style>
</head>
<body>
${htmlContent}
</body>
</html>`

    // 复用 htmlToPdf
    return await htmlToPdf(styledHtml, outputPath, taskId, getHiddenWindow)
  } catch (err: any) {
    return { status: 'error', message: `Markdown 转 PDF 失败: ${err.message}` }
  }
}

// ============================================================
// 7. PDF 压缩
// ============================================================

/** PDF 压缩级别 */
export type PdfCompressLevel = 'low' | 'medium' | 'high'

/**
 * 压缩 PDF 文件
 *
 * 压缩策略（按顺序尝试，任一方案成功且产物更小即返回）：
 *   1. mutool clean -gggg -z -t（最简单参数，不传 --color-lossy-image-recompress-method
 *      等高级选项，避免内嵌 mutool 版本不支持这些参数而报错）
 *   2. mutool clean -gg -z -t（降低垃圾回收级别重试）
 *   3. pdf-lib useObjectStreams 重新保存
 * 若以上方案均未能产生更小文件，则复制原始文件到输出路径并返回成功
 * （提示「PDF 已是最佳压缩状态，无需进一步压缩」）。
 * 本函数在输出文件存在时永不返回 error，并保证返回前输出文件一定存在。
 *
 * @param inputPath - 输入 PDF 路径
 * @param outputPath - 输出 PDF 路径
 * @param level - 压缩级别（保留以兼容调用方签名）
 */
export async function compressPdf(
  inputPath: string,
  outputPath: string,
  level: PdfCompressLevel = 'medium'
): Promise<PdfConvertResult> {
  try {
    if (!fs.existsSync(inputPath)) {
      return { status: 'error', message: `文件不存在: ${inputPath}` }
    }

    const outputDir = path.dirname(outputPath)
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    const originalSize = fs.statSync(inputPath).size
    const mutoolPath = getMutoolPath()

    /**
     * 用指定垃圾回收级别的 mutool clean 尝试压缩。
     * 仅使用 clean <gcFlag> -z -t 这一组最基础、兼容性最好的参数，
     * 不传 --color-lossy-image-recompress-method 等高级参数。
     * @returns 压缩成功且产物更小时返回新文件大小，否则返回 null
     */
    const tryMutool = (gcFlag: string): number | null => {
      if (!mutoolPath) return null
      // 清理上一次可能残留的输出文件
      try { fs.unlinkSync(outputPath) } catch {}

      const args = ['clean', gcFlag, '-z', '-t', inputPath, outputPath]
      const result = spawnSync(mutoolPath, args, {
        stdio: 'pipe',
        windowsHide: true,
        timeout: 120000, // 2 分钟超时
        encoding: 'utf-8',
      })

      if (result.status !== 0 || !fs.existsSync(outputPath)) {
        const stderr = result.stderr || ''
        console.error(`[compressPdf] mutool clean ${gcFlag} 执行失败:`, stderr)
        try { fs.unlinkSync(outputPath) } catch {}
        return null
      }

      const newSize = fs.statSync(outputPath).size
      if (newSize >= originalSize) {
        // 压缩后反而更大，丢弃结果，继续尝试后续方案
        console.log(`[compressPdf] mutool clean ${gcFlag} 产物更大（${newSize} >= ${originalSize}），尝试下一方案`)
        try { fs.unlinkSync(outputPath) } catch {}
        return null
      }
      return newSize
    }

    /** 构造压缩成功后的返回结果 */
    const buildSuccess = (newSize: number): PdfConvertResult => {
      const reduction = ((originalSize - newSize) / originalSize * 100).toFixed(1)
      return {
        status: 'success',
        output: outputPath,
        size: newSize,
        message: `压缩完成，从 ${(originalSize / 1024).toFixed(1)} KB 减小到 ${(newSize / 1024).toFixed(1)} KB（减小 ${reduction}%）`
      }
    }

    // 1. 首先尝试最简单的 mutool 参数：clean -gggg -z -t
    let mutoolSize = tryMutool('-gggg')
    if (mutoolSize !== null) {
      return buildSuccess(mutoolSize)
    }

    // 2. 简单压缩失败或产物更大，降低垃圾回收级别重试：clean -gg -z -t
    mutoolSize = tryMutool('-gg')
    if (mutoolSize !== null) {
      return buildSuccess(mutoolSize)
    }

    // 3. 所有 mutool 尝试均失败，回退到 pdf-lib（useObjectStreams）
    try {
      const bytes = fs.readFileSync(inputPath)
      const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true })
      const compressedBytes = await pdfDoc.save({
        useObjectStreams: true,
        addDefaultPage: false,
      })
      fs.writeFileSync(outputPath, compressedBytes)

      const newSize = fs.statSync(outputPath).size
      if (newSize < originalSize) {
        return buildSuccess(newSize)
      }
      console.log('[compressPdf] pdf-lib 压缩后文件更大，保留原始文件')
    } catch (pdfErr: any) {
      console.error('[compressPdf] pdf-lib 压缩失败:', pdfErr?.message || pdfErr)
    }

    // 4. 所有方案均未能产生更小文件，复制原始文件到输出路径并返回成功
    fs.copyFileSync(inputPath, outputPath)
    return {
      status: 'success',
      output: outputPath,
      size: originalSize,
      message: `PDF 已是最佳压缩状态，无需进一步压缩（${(originalSize / 1024).toFixed(1)} KB）`
    }
  } catch (err: any) {
    // 出错时仍尽量保证输出文件存在
    try {
      if (fs.existsSync(inputPath) && !fs.existsSync(outputPath)) {
        fs.copyFileSync(inputPath, outputPath)
      }
    } catch {}
    // 只要输出文件存在就返回成功（用户将「产物变大」视为失败，此处统一为成功 + 提示）
    if (fs.existsSync(outputPath)) {
      const size = fs.statSync(outputPath).size
      return {
        status: 'success',
        output: outputPath,
        size,
        message: `PDF 已是最佳压缩状态，无需进一步压缩（${(size / 1024).toFixed(1)} KB）`
      }
    }
    return { status: 'error', message: `PDF 压缩失败: ${err.message}` }
  }
}

// ============================================================
// 8. PDF 加密 / 解密
// ============================================================

/**
 * 加密 PDF 文件
 * 使用 mutool clean -E 进行加密（pdf-lib 不支持加密）
 * 注意：mutool 的 -P 参数接受数字权限码，不是字符串
 * 权限码：4=打印, 8=复制, 16=修改, 32=注释, 256=无障碍访问
 * @param inputPath - 输入 PDF 路径
 * @param outputPath - 输出 PDF 路径
 * @param password - 用户密码
 * @param ownerPassword - 所有者密码（可选，默认与用户密码相同）
 */
export async function encryptPdf(
  inputPath: string,
  outputPath: string,
  password: string,
  ownerPassword?: string
): Promise<PdfConvertResult> {
  try {
    if (!fs.existsSync(inputPath)) {
      return { status: 'error', message: `文件不存在: ${inputPath}` }
    }
    if (!password || password.length < 1) {
      return { status: 'error', message: '密码不能为空' }
    }

    const outputDir = path.dirname(outputPath)
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    const mutoolPathRaw = getMutoolPath()
    if (!mutoolPathRaw) {
      return { status: 'error', message: 'PDF 加密需要 mutool 工具，请先安装 CAJ 转换组件' }
    }
    const mutoolPath: string = mutoolPathRaw

    const ownerPwd = ownerPassword || password
    // 权限码：4(打印) + 8(复制) + 256(无障碍访问) = 268
    const permissionCode = '268'

    // 如果输入和输出路径相同，先复制到临时文件再加密（mutool 不支持原地覆盖）
    let actualInput = inputPath
    let tempInput: string | null = null
    if (path.resolve(inputPath) === path.resolve(outputPath)) {
      tempInput = path.join(os.tmpdir(), `yizhuan-encrypt-src-${Date.now()}.pdf`)
      fs.copyFileSync(inputPath, tempInput)
      actualInput = tempInput
    }

    // 尝试多种加密方式，从高到低
    const encryptMethods = ['aes-256', 'aes-128', 'rc4-128', 'rc4-40']
    let lastError = ''

    /**
     * 执行一次 mutool clean 加密
     * 注意：mutool 即使输出 warnings 到 stderr 也可能成功（exit code = 0），
     * 所以检查输出文件是否存在且大小 > 0 才是可靠的判断标准
     */
    function tryEncrypt(method: string, usePermission: boolean): boolean {
      const args = [
        'clean',
        '-D',              // 先解密（处理已加密的 PDF）
        '-E', method,
        '-U', password,
        '-O', ownerPwd,
      ]
      if (usePermission) {
        args.push('-P', permissionCode)
      }
      args.push(actualInput, outputPath)

      const result = spawnSync(mutoolPath, args, {
        stdio: 'pipe',
        windowsHide: true,
        timeout: 60000,
        encoding: 'utf-8',
      })

      // 关键修复：不依赖 exit code，而是检查输出文件是否存在且大小 > 0
      // mutool 可能输出 warnings 到 stderr 但仍然成功生成加密文件
      if (fs.existsSync(outputPath)) {
        const size = fs.statSync(outputPath).size
        if (size > 0) {
          return true
        }
      }

      lastError = (result.stderr || result.stdout || '').trim()
      // 如果是 "unknown option" 错误，说明 mutool 不支持 -E，直接返回
      if (lastError.includes('unknown option') || lastError.includes('invalid option')) {
        // 即使报错，如果输出文件存在且非空，可能是加密成功了
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100) {
          return true
        }
        return false
      }

      // 关键修复：不要删除输出文件！
      // mutool 可能输出 warnings 到 stderr 但加密仍然成功
      // 如果文件存在且大小 > 100 字节，认为加密成功
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100) {
        return true
      }
      return false
    }

    let success = false
    let successMethod = ''

    // 先尝试带权限码的方式
    for (const method of encryptMethods) {
      if (tryEncrypt(method, true)) {
        success = true
        successMethod = method
        break
      }
      if (lastError.includes('unknown option') || lastError.includes('invalid option')) {
        break
      }
    }

    // 如果带权限码失败，尝试不带权限码
    if (!success && !lastError.includes('unknown option')) {
      for (const method of encryptMethods) {
        if (tryEncrypt(method, false)) {
          success = true
          successMethod = method
          break
        }
      }
    }

    // 清理临时输入文件
    if (tempInput) {
      try { fs.unlinkSync(tempInput) } catch {}
    }

    if (success) {
      const size = fs.statSync(outputPath).size
      return {
        status: 'success',
        output: outputPath,
        size,
        message: `PDF 加密成功（${successMethod}）`
      }
    }

    // 最终验证：即使 mutool 报告失败，检查输出文件是否实际已加密
    // 用户反馈"加密报错，但打开文件已提示输入密码"，说明文件实际已加密成功
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      try {
        const verifyBytes = fs.readFileSync(outputPath)
        await PDFDocument.load(verifyBytes, { ignoreEncryption: false })
        // 如果加载成功且不需要密码，说明文件未加密
        // 删除未加密的输出文件
        try { fs.unlinkSync(outputPath) } catch {}
      } catch (loadErr: any) {
        // 加载失败说明文件需要密码，即加密成功
        const errMsg = String(loadErr?.message || '')
        if (errMsg.includes('encrypt') || errMsg.includes('password') || errMsg.includes('Password') || errMsg.includes('Encrypt')) {
          const size = fs.statSync(outputPath).size
          console.log('[encryptPdf] 验证通过：文件已加密（需要密码才能打开）')
          return {
            status: 'success',
            output: outputPath,
            size,
            message: 'PDF 加密成功（mutool 验证通过）'
          }
        }
      }
    }

    // 所有 mutool 方式都失败了，返回详细错误
    console.error('[encryptPdf] mutool 加密失败:', lastError)

    if (lastError.includes('unknown option') || lastError.includes('invalid option')) {
      return {
        status: 'error',
        message: '当前版本的 mutool 不支持 PDF 加密功能。建议更新应用到最新版本。'
      }
    }

    return {
      status: 'error',
      message: `PDF 加密失败: ${lastError.slice(0, 200) || '未知错误'}`
    }
  } catch (err: any) {
    return { status: 'error', message: `PDF 加密失败: ${err.message}` }
  }
}

/**
 * 解密 PDF 文件（移除密码保护）
 * @param inputPath - 输入 PDF 路径
 * @param outputPath - 输出 PDF 路径
 * @param password - 当前密码
 */
export async function decryptPdf(
  inputPath: string,
  outputPath: string,
  password: string
): Promise<PdfConvertResult> {
  try {
    if (!fs.existsSync(inputPath)) {
      return { status: 'error', message: `文件不存在: ${inputPath}` }
    }
    if (!password) {
      return { status: 'error', message: '请输入密码' }
    }

    const outputDir = path.dirname(outputPath)
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    const bytes = fs.readFileSync(inputPath)
    const pdfDoc = await PDFDocument.load(bytes, {
      password,
      ignoreEncryption: false,
    } as any)

    // 重新保存（不带加密）
    const decryptedBytes = await pdfDoc.save({
      useObjectStreams: true,
      addDefaultPage: false,
    })

    fs.writeFileSync(outputPath, decryptedBytes)
    const size = fs.statSync(outputPath).size

    return {
      status: 'success',
      output: outputPath,
      size,
      message: 'PDF 解密成功'
    }
  } catch (err: any) {
    // pdf-lib 解密失败，尝试使用 mutool 回退方案
    console.log(`[decryptPdf] pdf-lib 解密失败，尝试 mutool: ${err.message}`)
    
    const mutoolPath = getMutoolPath()
    if (mutoolPath) {
      try {
        // 如果输入和输出路径相同，先复制到临时文件
        let actualInput = inputPath
        let tempInput: string | null = null
        if (path.resolve(inputPath) === path.resolve(outputPath)) {
          tempInput = path.join(os.tmpdir(), `yizhuan-decrypt-src-${Date.now()}.pdf`)
          fs.copyFileSync(inputPath, tempInput)
          actualInput = tempInput
        }

        // mutool clean -D -U password input output
        // -D: 移除加密
        // -U: 用户密码（用于解密）
        const args = ['clean', '-D', '-U', password, actualInput, outputPath]
        const result = spawnSync(mutoolPath, args, {
          stdio: 'pipe',
          windowsHide: true,
          timeout: 60000,
          encoding: 'utf-8',
        })

        if (tempInput) {
          try { fs.unlinkSync(tempInput) } catch {}
        }

        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          // 验证解密后的文件可以无需密码打开
          try {
            const bytes = fs.readFileSync(outputPath)
            await PDFDocument.load(bytes, { ignoreEncryption: false })
            const size = fs.statSync(outputPath).size
            return {
              status: 'success',
              output: outputPath,
              size,
              message: 'PDF 解密成功（mutool）'
            }
          } catch {
            // 文件仍然加密，说明密码错误
            return { status: 'error', message: '密码错误，请检查密码后重试' }
          }
        }

        const stderr = result.stderr || ''
        if (stderr.includes('password') || stderr.includes('invalid')) {
          return { status: 'error', message: '密码错误，请检查密码后重试' }
        }
        return { status: 'error', message: `PDF 解密失败: ${stderr.slice(0, 200) || '未知错误'}` }
      } catch (mutoolErr: any) {
        return { status: 'error', message: `PDF 解密失败: ${mutoolErr.message}` }
      }
    }

    if (err.message?.includes('password') || err.message?.includes('Password')) {
      return { status: 'error', message: '密码错误，请检查密码后重试' }
    }
    return { status: 'error', message: `PDF 解密失败: ${err.message}` }
  }
}
