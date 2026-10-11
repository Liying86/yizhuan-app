/**
 * 转换服务层 - 封装所有格式转换逻辑
 */
import type { ConversionResult } from '../types/electron'

export type ConversionType = 'pdf2docx' | 'pdf2xlsx' | 'pdf2ppt' | 'docx2pdf' | 'img2png' | 'img2jpg' | 'img2webp' | 'img2heic' | 'heic2jpg' | 'ocr' | 'videoConvert' | 'caj2pdf'

// 视频转换目标格式
export type VideoTargetFormat = 'mp4' | 'avi' | 'mkv' | 'mov' | 'webm' | 'flv' | 'gif' | 'mp3' | 'wav' | 'aac' | 'flac'

// 视频画质预设
export type VideoQualityPreset = 'original' | '1080p' | '720p' | '480p' | 'minimal'

// 支持的视频输入格式
export const VIDEO_INPUT_EXTS = ['mp4', 'avi', 'mkv', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts']
// 视频输出格式选项
export const VIDEO_OUTPUT_FORMATS: { value: VideoTargetFormat, label: string, type: 'video' | 'audio' | 'gif' }[] = [
  { value: 'mp4', label: 'MP4', type: 'video' },
  { value: 'mkv', label: 'MKV', type: 'video' },
  { value: 'mov', label: 'MOV', type: 'video' },
  { value: 'webm', label: 'WebM', type: 'video' },
  { value: 'avi', label: 'AVI', type: 'video' },
  { value: 'flv', label: 'FLV', type: 'video' },
  { value: 'gif', label: 'GIF 动图', type: 'gif' },
  { value: 'mp3', label: 'MP3 音频', type: 'audio' },
  { value: 'wav', label: 'WAV 音频', type: 'audio' },
  { value: 'aac', label: 'AAC 音频', type: 'audio' },
  { value: 'flac', label: 'FLAC 音频', type: 'audio' },
]

// 视频画质预设选项
export const VIDEO_QUALITY_PRESETS: { value: VideoQualityPreset, label: string, desc: string }[] = [
  { value: 'original', label: '原画质', desc: '保持源视频质量' },
  { value: '1080p', label: '1080P', desc: '1920×1080 高清' },
  { value: '720p', label: '720P', desc: '1280×720 标清' },
  { value: '480p', label: '480P', desc: '854×480 流畅' },
  { value: 'minimal', label: '最小体积', desc: '360P + 低码率' },
]

export interface ConvertTask {
  id: string
  type: ConversionType
  inputPath: string
  inputName: string
  outputPath: string
  status: 'pending' | 'processing' | 'success' | 'error'
  progress: number
  result?: ConversionResult
  createdAt: string
}

export interface FileMeta {
  path: string
  name: string
  ext: string
  size: number
}

/**
 * 从文件路径提取元信息
 */
export function getFileMeta(filePath: string): FileMeta {
  const sep = filePath.includes('\\') ? '\\' : '/'
  const parts = filePath.split(sep)
  const name = parts[parts.length - 1] || ''
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return { path: filePath, name, ext, size: 0 }
}

/**
 * 根据文件扩展名推断转换类型
 */
export function inferConversionType(ext: string): ConversionType | null {
  const map: Record<string, ConversionType> = {
    'pdf': 'pdf2docx',
    'doc': 'docx2pdf',
    'docx': 'docx2pdf',
    'ppt': 'docx2pdf',
    'pptx': 'docx2pdf',
    'xls': 'docx2pdf',
    'xlsx': 'docx2pdf',
    'jpg': 'img2png',
    'jpeg': 'img2png',
    'png': 'img2jpg',
    'bmp': 'img2png',
    'webp': 'img2png',
    'tiff': 'img2png',
    'gif': 'img2png',
    'heic': 'heic2jpg',
    'heif': 'heic2jpg',
  }
  // 视频格式
  if (VIDEO_INPUT_EXTS.includes(ext)) {
    return 'videoConvert'
  }
  // CAJ 格式
  if (ext === 'caj' || ext === 'nh') {
    return 'caj2pdf'
  }
  return map[ext] || null
}

/**
 * 根据转换类型获取兼容的源文件扩展名列表
 */
export function getSourceExts(type: ConversionType): string[] {
  const map: Record<ConversionType, string[]> = {
    'pdf2docx': ['pdf'],
    'pdf2xlsx': ['pdf'],
    'pdf2ppt': ['pdf'],
    'docx2pdf': ['docx', 'doc', 'ppt', 'pptx', 'xls', 'xlsx'],
    'img2png': ['jpg', 'jpeg', 'bmp', 'webp', 'tiff', 'gif', 'heic', 'heif'],
    'img2jpg': ['png', 'bmp', 'webp', 'tiff', 'gif', 'heic', 'heif'],
    'img2webp': ['png', 'jpg', 'jpeg', 'bmp', 'tiff', 'gif', 'heic', 'heif'],
    'img2heic': ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'tiff', 'gif', 'heic', 'heif'],
    'heic2jpg': ['heic', 'heif'],
    'ocr': ['png', 'jpg', 'jpeg', 'bmp', 'webp'],
    'videoConvert': VIDEO_INPUT_EXTS,
    'caj2pdf': ['caj', 'nh'],
  }
  return map[type] || []
}

/**
 * 生成输出文件路径
 * @param outputDir 自定义输出目录，不传则同源目录
 * 始终添加 _易转 后缀，确保输出文件与源文件可区分
 * （Windows 默认隐藏文件扩展名，同名不同扩展名的文件会显示为相同名称）
 * 使用品牌名 _易转 作为后缀，即使源文件名已包含 _converted 也能区分
 */
export function getOutputPath(inputPath: string, targetExt: string, outputDir?: string): string {
  const sep = inputPath.includes('\\') ? '\\' : '/'
  const dir = outputDir || inputPath.substring(0, inputPath.lastIndexOf(sep))
  const name = inputPath.substring(inputPath.lastIndexOf(sep) + 1)
  const baseName = name.includes('.') ? name.substring(0, name.lastIndexOf('.')) : name

  // 始终添加 _易转 后缀，确保在隐藏扩展名时也能与源文件区分
  // 即使源文件名已包含 _converted，_易转 后缀仍能让用户在文件夹中区分输出文件
  const suffix = baseName.endsWith('_易转') ? '' : '_易转'
  return `${dir}${sep}${baseName}${suffix}.${targetExt}`
}

/**
 * 生成唯一任务 ID
 */
export function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
}

/**
 * 执行 PDF 转 Word
 * @param outputPath 自定义输出路径，不传则自动生成
 */
export async function convertPdfToDocx(inputPath: string, outputPath?: string): Promise<ConversionResult> {
  const taskId = generateTaskId()
  const finalOutputPath = outputPath || getOutputPath(inputPath, 'docx')

  if (!window.electronAPI) {
    return { status: 'error', message: 'Electron API 不可用（非桌面环境）' }
  }

  return await window.electronAPI.convertPdfToDocx({
    inputPath,
    outputPath: finalOutputPath,
    taskId
  })
}

/**
 * 执行 PDF 转 Excel
 */
export async function convertPdfToXlsx(inputPath: string, outputPath?: string): Promise<ConversionResult> {
  const taskId = generateTaskId()
  const finalOutputPath = outputPath || getOutputPath(inputPath, 'xlsx')

  if (!window.electronAPI) {
    return { status: 'error', message: 'Electron API 不可用（非桌面环境）' }
  }

  return await window.electronAPI.convertPdfToXlsx({
    inputPath,
    outputPath: finalOutputPath,
    taskId
  })
}

/**
 * 执行 PDF 转 PPT
 */
export async function convertPdfToPpt(inputPath: string, outputPath?: string): Promise<ConversionResult> {
  const taskId = generateTaskId()
  const finalOutputPath = outputPath || getOutputPath(inputPath, 'pptx')

  if (!window.electronAPI) {
    return { status: 'error', message: 'Electron API 不可用（非桌面环境）' }
  }

  return await window.electronAPI.convertPdfToPpt({
    inputPath,
    outputPath: finalOutputPath,
    taskId
  })
}

/**
 * 执行 Word 转 PDF（通过 LibreOffice）
 * @param outputPath 自定义输出路径，不传则自动生成
 */
export async function convertDocxToPdf(inputPath: string, outputPath?: string): Promise<ConversionResult> {
  const taskId = generateTaskId()
  const finalOutputPath = outputPath || getOutputPath(inputPath, 'pdf')

  if (!window.electronAPI) {
    return { status: 'error', message: 'Electron API 不可用（非桌面环境）' }
  }

  return await window.electronAPI.convertDocxToPdf({
    inputPath,
    outputPath: finalOutputPath,
    taskId
  })
}

/**
 * 执行 OCR 文字识别
 * @param lang OCR 语言，默认中英混合
 * @param outputDir 自定义输出目录，不传则同源目录
 */
export async function performOcrRecognition(
  imagePath: string,
  lang: string = 'chi_sim+eng',
  outputDir?: string
): Promise<{ status: 'success' | 'error', text?: string, message?: string, outputPath?: string }> {
  const taskId = generateTaskId()

  if (!window.electronAPI) {
    return { status: 'error', message: 'Electron API 不可用（非桌面环境）' }
  }

  const result = await window.electronAPI.ocrRecognize({
    imagePath,
    taskId,
    lang
  })

  if (result.status === 'success' && result.text) {
    // 自动保存识别结果到 TXT 文件
    const outputPath = getOutputPath(imagePath, 'txt', outputDir)
    const saveResult = await window.electronAPI.ocrSave({
      text: result.text,
      outputPath
    })

    return {
      status: 'success',
      text: result.text,
      outputPath: saveResult.success ? outputPath : undefined
    }
  }

  return result
}

/**
 * 执行图片格式转换
 * @param outputPath 自定义输出路径，不传则自动生成
 */
export async function convertImageFormat(
  inputPath: string,
  targetFormat: 'png' | 'jpg' | 'webp' | 'heic',
  options?: { quality?: number, width?: number, height?: number, outputPath?: string }
): Promise<ConversionResult> {
  const taskId = generateTaskId()
  const finalOutputPath = options?.outputPath || getOutputPath(inputPath, targetFormat)

  if (!window.electronAPI) {
    return { status: 'error', message: 'Electron API 不可用（非桌面环境）' }
  }

  return await window.electronAPI.convertImage({
    inputPath,
    outputPath: finalOutputPath,
    targetFormat,
    taskId,
    quality: options?.quality,
    width: options?.width,
    height: options?.height
  })
}

/**
 * 执行视频/音频转换
 * @param targetFormat 目标格式
 * @param outputDir 自定义输出目录，不传则同源目录
 * @param options 高级选项（分辨率、码率、画质预设等）
 */
export async function convertVideoFormat(
  inputPath: string,
  targetFormat: VideoTargetFormat,
  outputDir?: string,
  options?: {
    videoCodec?: string
    videoBitrate?: string
    resolution?: string
    fps?: number
    qualityPreset?: VideoQualityPreset
  }
): Promise<ConversionResult> {
  const taskId = generateTaskId()
  const finalOutputPath = getOutputPath(inputPath, targetFormat, outputDir)

  if (!window.electronAPI) {
    return { status: 'error', message: 'Electron API 不可用（非桌面环境）' }
  }

  return await window.electronAPI.convertVideo({
    inputPath,
    outputPath: finalOutputPath,
    targetFormat,
    taskId,
    options
  })
}

/**
 * 执行 CAJ 转 PDF
 * @param outputPath 自定义输出路径，不传则自动生成
 */
export async function convertCajToPdf(inputPath: string, outputPath?: string): Promise<ConversionResult> {
  const taskId = generateTaskId()
  const finalOutputPath = outputPath || getOutputPath(inputPath, 'pdf')

  if (!window.electronAPI) {
    return { status: 'error', message: 'Electron API 不可用（非桌面环境）' }
  }

  return await window.electronAPI.convertCajToPdf({
    inputPath,
    outputPath: finalOutputPath,
    taskId
  })
}
