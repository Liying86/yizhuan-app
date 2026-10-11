/**
 * OCR 服务 - 基于 Tesseract.js
 * 支持中英文识别，进度回传
 * 支持多格式输出：TXT / DOCX / XLSX / 可搜索 PDF
 *
 * 注意：Electron 打包环境下，tesseract.js 和 tesseract.js-core
 * 必须在 package.json 的 asarUnpack 中解包，否则 worker_threads
 * 无法正确加载 worker 脚本和 WASM 文件。
 */
import { createWorker, PSM } from 'tesseract.js'
import { join, dirname } from 'path'
import fs from 'fs'
import { app } from 'electron'
import AdmZip from 'adm-zip'

// 训练数据缓存目录（用于存放从 CDN 下载的语言包）
function getCachePath(): string {
  const userDataPath = app.getPath('userData')
  const cachePath = join(userDataPath, 'tessdata')
  if (!fs.existsSync(cachePath)) {
    fs.mkdirSync(cachePath, { recursive: true })
  }
  return cachePath
}

interface OcrOptions {
  lang: string        // 'chi_sim+eng' | 'eng' | 'chi_sim'
  psm: number         // Page segmentation mode
  taskId: string
}

/**
 * 执行 OCR 识别
 * @param imagePath 图片路径
 * @param options OCR 选项
 * @param onProgress 进度回调
 *
 * 策略说明：
 * - 不设置 langPath：让 Tesseract.js 从默认 CDN（jsdelivr）下载训练数据
 * - 设置 cachePath：下载后的训练数据缓存到用户数据目录，下次直接使用
 * - 设置 cacheMethod: 'write'：允许写入缓存
 */
export async function performOcr(
  imagePath: string,
  options: OcrOptions,
  onProgress?: (progress: number, status: string) => void
): Promise<{ status: 'success' | 'error', text?: string, message?: string }> {
  try {
    if (!fs.existsSync(imagePath)) {
      return { status: 'error', message: `文件不存在: ${imagePath}` }
    }

    const cachePath = getCachePath()

    // 创建 worker
    // 关键：Electron 打包后，workerPath 和 corePath 依赖 asarUnpack 配置
    const worker = await createWorker(options.lang, 1, {
      // 不设置 langPath → 使用默认 CDN 下载训练数据
      // 设置 cachePath → 下载后缓存到本地，避免重复下载
      cachePath,
      cacheMethod: 'write',
      logger: (m: any) => {
        if (m.status && onProgress) {
          const progress = Math.round((m.progress || 0) * 100)
          onProgress(progress, m.status)
        }
      }
    })

    // 设置页面分割模式
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.AUTO
    })

    // 执行识别
    const { data: { text } } = await worker.recognize(imagePath)
    await worker.terminate()

    if (text && text.trim().length > 0) {
      return {
        status: 'success',
        text: text.trim()
      }
    } else {
      return {
        status: 'error',
        message: '未识别到文字内容，请尝试更换图片或调整图片质量'
      }
    }
  } catch (err: any) {
    return {
      status: 'error',
      message: err.message || 'OCR 识别失败'
    }
  }
}

// ============================================================
// 多格式输出
// ============================================================

export type OcrOutputFormat = 'txt' | 'docx' | 'xlsx' | 'pdf'

/**
 * 确保输出目录存在
 */
function ensureOutputDir(outputPath: string): void {
  const dir = dirname(outputPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/**
 * 将识别结果保存为 TXT 文件
 */
export function saveOcrResult(text: string, outputPath: string): { success: boolean, path?: string, error?: string } {
  try {
    ensureOutputDir(outputPath)
    fs.writeFileSync(outputPath, text, 'utf-8')
    return { success: true, path: outputPath }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

/**
 * XML 特殊字符转义
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 将识别结果保存为 DOCX 文件（基于 OOXML，使用 adm-zip 打包）
 * 每行文本对应一个段落
 */
export function saveOcrAsDocx(text: string, outputPath: string): { success: boolean, path?: string, error?: string } {
  try {
    // 动态引入 adm-zip（已在 dependencies 中）
    // 使用顶部导入的 AdmZip
    const zip = new AdmZip()

    // [Content_Types].xml
    zip.addFile('[Content_Types].xml', Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '</Types>'
    ))

    // _rels/.rels
    zip.addFile('_rels/.rels', Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>'
    ))

    // word/_rels/document.xml.rels
    zip.addFile('word/_rels/document.xml.rels', Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>'
    ))

    // word/styles.xml - 定义正文样式
    zip.addFile('word/styles.xml', Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:docDefaults><w:rPrDefault><w:rPr>' +
      '<w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei" w:hAnsi="Microsoft YaHei"/>' +
      '<w:sz w:val="22"/><w:szCs w:val="22"/>' +
      '</w:rPr></w:rPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
      '<w:name w:val="Normal"/>' +
      '<w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr>' +
      '</w:style>' +
      '</w:styles>'
    ))

    // word/document.xml - 将文本按行分割为段落
    const lines = text.split('\n')
    const paragraphs = lines.map(line => {
      const escaped = escapeXml(line)
      // 空行也保留为空段落
      if (!escaped.trim()) {
        return '<w:p/>'
      }
      return `<w:p><w:r><w:t xml:space="preserve">${escaped}</w:t></w:r></w:p>`
    }).join('')

    zip.addFile('word/document.xml', Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${paragraphs}` +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' +
      '</w:body></w:document>'
    ))

    ensureOutputDir(outputPath)
    zip.writeZip(outputPath)
    return { success: true, path: outputPath }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

/**
 * 将识别结果保存为 XLSX 文件（基于 OOXML，使用 adm-zip 打包）
 * 每行文本对应一行，按制表符或连续空格分列
 */
export function saveOcrAsXlsx(text: string, outputPath: string): { success: boolean, path?: string, error?: string } {
  try {
    // 使用顶部导入的 AdmZip
    const zip = new AdmZip()

    // [Content_Types].xml
    zip.addFile('[Content_Types].xml', Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
      '</Types>'
    ))

    // _rels/.rels
    zip.addFile('_rels/.rels', Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>'
    ))

    // xl/_rels/workbook.xml.rels
    zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
      '</Relationships>'
    ))

    // xl/workbook.xml
    zip.addFile('xl/workbook.xml', Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="OCR结果" sheetId="1" r:id="rId1"/></sheets>' +
      '</workbook>'
    ))

    // xl/styles.xml - 基础样式
    zip.addFile('xl/styles.xml', Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="1"><font><sz val="11"/><name val="Microsoft YaHei"/></font></fonts>' +
      '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
      '<borders count="1"><border/></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
      '</styleSheet>'
    ))

    // 解析文本为行列
    const lines = text.split('\n').filter(l => l.length > 0)
    const rows: string[][] = lines.map(line => {
      // 优先按制表符分割，其次按 2+ 连续空格分割
      if (line.includes('\t')) {
        return line.split('\t').map(c => c.trim()).filter(c => c)
      }
      return line.split(/ {2,}/).map(c => c.trim()).filter(c => c)
    })

    // 构建共享字符串表
    const sharedStrings: string[] = []
    const stringIndexMap = new Map<string, number>()
    for (const row of rows) {
      for (const cell of row) {
        if (!stringIndexMap.has(cell)) {
          stringIndexMap.set(cell, sharedStrings.length)
          sharedStrings.push(cell)
        }
      }
    }

    // xl/sharedStrings.xml
    const sharedStringsXml = sharedStrings.map(s =>
      `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`
    ).join('')
    zip.addFile('xl/sharedStrings.xml', Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${sharedStringsXml}</sst>`
    ))

    // xl/worksheets/sheet1.xml
    const sheetRows = rows.map((row, rowIdx) => {
      const cells = row.map((cell, colIdx) => {
        const colLetter = colIdx < 26
          ? String.fromCharCode(65 + colIdx)
          : String.fromCharCode(65 + Math.floor(colIdx / 26) - 1) + String.fromCharCode(65 + (colIdx % 26))
        const idx = stringIndexMap.get(cell)!
        return `<c r="${colLetter}${rowIdx + 1}" t="s"><v>${idx}</v></c>`
      }).join('')
      return `<row r="${rowIdx + 1}">${cells}</row>`
    }).join('')

    zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<sheetData>${sheetRows}</sheetData>` +
      '</worksheet>'
    ))

    ensureOutputDir(outputPath)
    zip.writeZip(outputPath)
    return { success: true, path: outputPath }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

/**
 * 将识别结果保存为可搜索 PDF（图片层 + 隐形文字层）
 * 使用 pdf-lib 嵌入图片，叠加近乎透明的文字使 PDF 可搜索
 */
export async function saveOcrAsSearchablePdf(
  imagePath: string,
  text: string,
  outputPath: string
): Promise<{ success: boolean, path?: string, error?: string }> {
  try {
    const { PDFDocument, rgb, StandardFonts } = await import('pdf-lib')
    const fontkit = (await import('@pdf-lib/fontkit')).default

    const pdfDoc = await PDFDocument.create()
    pdfDoc.registerFontkit(fontkit)

    // 尝试加载 Windows 系统中文字体（用于渲染中文文字层）
    let cjkFont: any = null
    const fontCandidates = [
      'C:\\Windows\\Fonts\\msyh.ttc',
      'C:\\Windows\\Fonts\\msyhbd.ttc',
      'C:\\Windows\\Fonts\\simhei.ttf',
      'C:\\Windows\\Fonts\\simsun.ttc',
    ]
    for (const fontPath of fontCandidates) {
      if (fs.existsSync(fontPath)) {
        try {
          const fontBytes = fs.readFileSync(fontPath)
          cjkFont = await pdfDoc.embedFont(fontBytes, { subset: true })
          break
        } catch {
          // 该字体加载失败，尝试下一个
        }
      }
    }

    // 回退到标准字体（英文环境）
    const textFont = cjkFont || await pdfDoc.embedFont(StandardFonts.Helvetica)

    // 读取并嵌入图片
    const imageBytes = fs.readFileSync(imagePath)
    const ext = imagePath.toLowerCase().split('.').pop()
    let image: any
    if (ext === 'png') {
      image = await pdfDoc.embedPng(imageBytes)
    } else {
      // jpg/jpeg/bmp/webp 等通过 sharp 转为 jpg 后嵌入
      try {
        const sharp = (await import('sharp')).default
        const jpgBuffer = await sharp(imagePath).jpeg({ quality: 95 }).toBuffer()
        image = await pdfDoc.embedJpg(jpgBuffer)
      } catch {
        // sharp 不可用时直接尝试当 jpg 嵌入
        image = await pdfDoc.embedJpg(imageBytes)
      }
    }

    // 创建页面（A4 纵向，按图片比例适配）
    const pageWidth = 595.28  // A4 宽度 (pt)
    const pageHeight = 841.89 // A4 高度 (pt)
    const margin = 36 // 0.5 inch 边距
    const maxWidth = pageWidth - margin * 2
    const maxHeight = pageHeight - margin * 2

    // 按比例缩放图片
    const imgRatio = image.width / image.height
    let drawWidth = maxWidth
    let drawHeight = drawWidth / imgRatio
    if (drawHeight > maxHeight) {
      drawHeight = maxHeight
      drawWidth = drawHeight * imgRatio
    }
    const drawX = (pageWidth - drawWidth) / 2
    const drawY = pageHeight - margin - drawHeight

    const page = pdfDoc.addPage([pageWidth, pageHeight])
    page.drawImage(image, {
      x: drawX,
      y: drawY,
      width: drawWidth,
      height: drawHeight,
    })

    // 在图片下方添加隐形文字层（可搜索、可复制）
    // 使用极低透明度使文字不可见但可选
    const lines = text.split('\n')
    const fontSize = 10
    const lineHeight = fontSize * 1.3
    let textY = drawY - 4 // 从图片底部开始

    for (const line of lines) {
      if (textY < margin) break // 超出页面底部停止
      try {
        page.drawText(line, {
          x: margin,
          y: textY,
          size: fontSize,
          font: textFont,
          color: rgb(0, 0, 0),
          opacity: 0.01, // 近乎透明，视觉不可见但可搜索
        })
      } catch {
        // 某些字符可能无法渲染，跳过该行
      }
      textY -= lineHeight
    }

    const pdfBytes = await pdfDoc.save()
    ensureOutputDir(outputPath)
    fs.writeFileSync(outputPath, pdfBytes)
    return { success: true, path: outputPath }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

/**
 * 多格式保存统一入口
 */
export async function saveOcrMultiFormat(
  text: string,
  imagePath: string,
  outputPath: string,
  format: OcrOutputFormat
): Promise<{ success: boolean, path?: string, error?: string }> {
  switch (format) {
    case 'txt':
      return saveOcrResult(text, outputPath)
    case 'docx':
      return saveOcrAsDocx(text, outputPath)
    case 'xlsx':
      return saveOcrAsXlsx(text, outputPath)
    case 'pdf':
      return await saveOcrAsSearchablePdf(imagePath, text, outputPath)
    default:
      return { success: false, error: `不支持的格式: ${format}` }
  }
}
