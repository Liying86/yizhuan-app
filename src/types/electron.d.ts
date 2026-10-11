export interface ElectronAPI {
  // 文件选择
  selectFiles: (options?: { filters?: any[], multi?: boolean }) => Promise<string[]>
  selectFolder: () => Promise<string | null>
  showSaveDialog: (options?: { defaultPath?: string, filters?: any[] }) => Promise<string | null>

  // PDF 转 Word
  convertPdfToDocx: (params: { inputPath: string, outputPath: string, taskId: string }) => Promise<ConversionResult>

  // PDF 转 Excel
  convertPdfToXlsx: (params: { inputPath: string, outputPath: string, taskId: string }) => Promise<ConversionResult>

  // PDF 转 PPT
  convertPdfToPpt: (params: { inputPath: string, outputPath: string, taskId: string }) => Promise<ConversionResult>

  // Word 转 PDF
  convertDocxToPdf: (params: { inputPath: string, outputPath: string, taskId: string }) => Promise<ConversionResult>

  // 取消转换
  cancelConversion: (taskId: string) => Promise<{ success: boolean, message?: string }>

  // 打开文件 / 文件夹
  openFile: (path: string) => Promise<{ success: boolean }>
  openFolder: (path: string) => Promise<{ success: boolean }>
  getFileSize: (path: string) => Promise<number>

  // 窗口控制
  windowMinimize: () => Promise<void>
  windowMaximize: () => Promise<void>
  windowClose: () => Promise<void>
  windowIsMaximized: () => Promise<boolean>
  setNativeTheme: (theme: 'light' | 'dark') => Promise<{ success: boolean }>
  onWindowMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void

  // 应用信息
  getAppVersion: () => Promise<string>
  checkPythonEnv: () => Promise<{
    pythonPath: string | null
    pdf2docxReady: boolean
    embeddedReady?: boolean
    needsInstall?: boolean
    busy?: boolean
    phase?: string | null
    progress?: number
    error: string | null
  }>
  checkLibreOffice: () => Promise<{ installed: boolean, path: string | null }>

  // 内嵌 Python 运行时管理
  checkEmbeddedPython: () => Promise<{
    pythonPath: string | null
    pythonReady: boolean
    pdf2docxReady: boolean
    busy: boolean
    phase: string | null
    progress: number
  }>
  installEmbeddedPython: () => Promise<{ success: boolean, error?: string }>
  installPdf2docx: () => Promise<{ success: boolean, error?: string }>
  cancelPythonInstall: () => Promise<{ success: boolean }>
  onPythonInstallProgress: (callback: (data: {
    busy?: boolean
    phase?: string | null
    progress?: number
    retryCount?: number
    pythonReady?: boolean
    pdf2docxReady?: boolean
  }) => void) => () => void

  // OCR 文字识别
  ocrRecognize: (params: { imagePath: string, taskId: string, lang?: string }) => Promise<OcrResult>
  ocrSave: (params: { text: string, outputPath: string }) => Promise<{ success: boolean, path?: string, error?: string }>
  ocrSaveMultiFormat: (params: { text: string, imagePath: string, outputPath: string, format: string }) => Promise<{ success: boolean, path?: string, error?: string }>

  // 图片格式转换
  convertImage: (params: {
    inputPath: string
    outputPath: string
    targetFormat: 'png' | 'jpg' | 'webp' | 'heic'
    taskId: string
    quality?: number
    width?: number
    height?: number
  }) => Promise<ConversionResult>

  batchConvertImages: (params: {
    items: Array<{ inputPath: string, outputPath: string, targetFormat: 'png' | 'jpg' | 'webp' | 'heic' }>
    taskId: string
    quality?: number
    width?: number
    height?: number
  }) => Promise<ConversionResult[]>

  // PDF 工具（V0.6）
  getPdfInfo: (inputPath: string) => Promise<{ status: 'success' | 'error', pages?: number, size?: number, message?: string }>
  mergePdfs: (params: { filePaths: string[], outputPath: string, taskId: string }) =>
    Promise<{ status: 'success' | 'error', output?: string, size?: number, totalPages?: number, message?: string }>
  splitPdf: (params: { inputPath: string, outputDir: string, taskId: string, mode: string, options?: any }) =>
    Promise<{ status: 'success' | 'error', items: Array<{ output: string, pages: number }>, totalItems: number, message?: string }>
  pdfToImages: (params: { inputPath: string, outputDir: string, taskId: string, options?: any }) =>
    Promise<{ status: 'success' | 'error', items: Array<{ output: string, page: number, size: number }>, totalItems: number, message?: string }>
  htmlToPdf: (params: { htmlContent: string, outputPath: string, taskId: string }) => Promise<ConversionResult>
  markdownToPdf: (params: { content: string, outputPath: string, taskId: string }) => Promise<ConversionResult>

  // PDF 加密 / 解密 / 压缩（V0.7）
  encryptPdf: (params: { inputPath: string, outputPath: string, password: string, ownerPassword?: string }) => Promise<ConversionResult>
  decryptPdf: (params: { inputPath: string, outputPath: string, password: string }) => Promise<ConversionResult>
  compressPdf: (params: { inputPath: string, outputPath: string, level?: 'low' | 'medium' | 'high' }) => Promise<ConversionResult>

  // 图片压缩（V0.6）
  compressImage: (params: { inputPath: string, outputPath: string, taskId: string, options?: { level: 'light' | 'standard' | 'aggressive' | 'custom', format?: 'keep' | 'png' | 'jpg' | 'webp', customMaxWidth?: number, customMaxHeight?: number, customQuality?: number, maintainAspectRatio?: boolean, customMaxSizeKb?: number } }) =>
    Promise<{ status: 'success' | 'error', output?: string, originalSize?: number, compressedSize?: number, savedPercent?: number, message?: string }>
  batchCompressImages: (params: { items: Array<{ inputPath: string, outputPath: string }>, taskId: string, options?: { level: 'light' | 'standard' | 'aggressive' | 'custom', format?: 'keep' | 'png' | 'jpg' | 'webp', customMaxWidth?: number, customMaxHeight?: number, customQuality?: number, maintainAspectRatio?: boolean, customMaxSizeKb?: number } }) =>
    Promise<Array<{ status: 'success' | 'error', output?: string, originalSize?: number, compressedSize?: number, savedPercent?: number, message?: string }>>

  // 图片转 HTML/MD（V0.7）
  imageToHtml: (params: {
    inputPath: string
    outputPath: string
    taskId: string
    options?: {
      format: 'html' | 'md'
      title?: string
    }
  }) => Promise<{ status: 'success' | 'error', output?: string, message?: string }>

  // 视频转换
  convertVideo: (params: {
    inputPath: string
    outputPath: string
    targetFormat: string
    taskId: string
    options?: {
      videoCodec?: string
      videoBitrate?: string
      resolution?: string
      fps?: number
      qualityPreset?: string
    }
  }) => Promise<ConversionResult>

  getVideoInfo: (videoPath: string) => Promise<VideoInfo>

  // CAJ 转 PDF
  convertCajToPdf: (params: { inputPath: string, outputPath: string, taskId: string }) => Promise<ConversionResult>
  checkCajEnv: () => Promise<{
    cajReady: boolean
    caj2pdfInstalled: boolean
    mutoolReady: boolean
    mutoolPath: string | null
    busy: boolean
    phase: string | null
    progress: number
  }>
  installCajRuntime: () => Promise<{ success: boolean, error?: string }>
  cancelCajInstall: () => Promise<{ success: boolean }>
  onCajInstallProgress: (callback: (data: {
    busy?: boolean
    phase?: string | null
    progress?: number
    retryCount?: number
    cajReady?: boolean
    caj2pdfInstalled?: boolean
    mutoolReady?: boolean
  }) => void) => () => void

  // 右键菜单管理
  registerContextMenu: () => Promise<{ success: boolean, registered: string[], errors: string[] }>
  unregisterContextMenu: () => Promise<{ success: boolean, removed: string[], errors: string[] }>
  checkContextMenu: () => Promise<{ registered: boolean }>

  // 右键菜单事件监听
  onContextMenuAction: (callback: (data: { action: string, filePath: string }) => void) => () => void

  // 批量转换
  scanFolder: (params: { folderPath: string, type: string, recursive?: boolean }) =>
    Promise<{ success: boolean, items: BatchFileItem[], error?: string }>
  buildBatchItems: (params: { filePaths: string[], type: string, outputDir?: string }) =>
    Promise<{ success: boolean, items: BatchFileItem[], error?: string }>
  batchConvert: (params: { taskId: string, items: BatchFileItem[], options: BatchOptions }) =>
    Promise<BatchResult>
  batchCancel: (taskId: string) => Promise<{ success: boolean }>
  onBatchProgress: (callback: (data: BatchProgress) => void) => () => void

  // 历史记录持久化
  historyLoad: () => Promise<HistoryRecord[]>
  historySave: (records: HistoryRecord[]) => Promise<{ success: boolean }>
  historyClear: () => Promise<{ success: boolean }>
  historyDeleteItem: (id: string) => Promise<{ success: boolean, remaining: HistoryRecord[] }>

  // 应用设置持久化
  settingsLoad: () => Promise<AppSettings>
  settingsSave: (settings: Partial<AppSettings>) => Promise<{ success: boolean, settings: AppSettings }>

  // 会员系统
  licenseActivate: (code: string) => Promise<ActivationResult>
  licenseDeactivate: () => Promise<{ success: boolean, message: string }>
  licenseStatus: () => Promise<LicenseStatus>
  licenseLimits: () => Promise<UsageLimits>
  licenseOcrCheck: () => Promise<{ allowed: boolean, remaining: number, limit: number }>
  licenseOcrIncrement: () => Promise<{ success: boolean }>

  // 邀请码系统
  referralGetCode: () => Promise<{ code: string }>
  referralActivate: (code: string) => Promise<ActivationResult>
  referralStats: () => Promise<{ myCode: string, invitedCount: number }>

  // 虎皮椒支付
  paymentCreateOrder: (params: { tier: PaymentTier }) => Promise<PaymentOrderResult>
  paymentQueryOrder: (tradeOrderId: string) => Promise<PaymentQueryResult>

  // 进度监听
  onProgress: (callback: (data: { taskId: string, progress: number }) => void) => () => void

  // 获取拖拽文件的本地路径
  getFilePathForFile: (file: File) => string

  // 自动更新检查
  checkForUpdates: () => Promise<{
    hasUpdate: boolean
    latestVersion: string
    currentVersion: string
    downloadUrl: string
    releaseNotes: string
    releasePage: string
  }>
  openDownloadPage: (url: string) => Promise<{ success: boolean }>

  // 系统通知
  showNotification: (params: { title: string, body?: string, silent?: boolean }) => Promise<{ success: boolean, error?: string }>

  // 全局快捷键管理
  registerShortcuts: () => Promise<{ success: boolean, yRegistered?: boolean, sRegistered?: boolean, error?: string }>
  unregisterShortcuts: () => Promise<{ success: boolean, error?: string }>
  checkShortcutsRegistered: () => Promise<{ yRegistered: boolean, sRegistered: boolean }>

  // 截图 OCR 事件监听
  onScreenshotOcrReady: (callback: (data: { screenshotPath: string | null }) => void) => () => void

  // 使用统计
  usageStatsLoad: () => Promise<{
    totalConversions: number
    totalSuccess: number
    totalFailed: number
    totalBytesSaved: number
    formatBreakdown: Record<string, number>
    firstUsedAt: string
    lastUsedAt: string
  }>
  usageStatsRecord: (params: { type: string, success: boolean, bytesSaved?: number }) => Promise<{ success: boolean, stats: any }>
}

// ============================================================
// 历史记录
// ============================================================
export interface HistoryRecord {
  id: string
  filename: string
  fromFormat: string
  toFormat: string
  status: 'success' | 'error'
  message?: string
  outputPath?: string
  createdAt: string
}

// ============================================================
// 应用设置
// ============================================================
export interface AppSettings {
  outputDir: string           // 自定义输出目录，空字符串表示同源目录
  autoOpenFolder: boolean     // 转换完成后自动打开文件夹
  defaultImageQuality: number // 默认图片质量 1-100
  ocrLang: string             // OCR 默认语言
  concurrency: number         // 默认并发数
  theme: 'light' | 'dark'     // 主题
  enableNotifications: boolean // 转换完成后显示系统通知
  enableGlobalShortcuts: boolean // 启用全局快捷键
  contextMenuAutoRegistered?: boolean  // 右键菜单是否已尝试自动注册
}

export interface ConversionResult {
  status: 'success' | 'error'
  output?: string
  size?: number
  message?: string
}

export interface OcrResult {
  status: 'success' | 'error'
  text?: string
  message?: string
}

export interface VideoInfo {
  duration: number
  width: number
  height: number
  fps: number
  bitrate: number
  hasAudio: boolean
}

// 批量转换类型
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
  outputDir?: string
  quality?: number
  concurrency?: number
  overwrite?: boolean
}

export interface BatchProgress {
  taskId: string
  current: number
  total: number
  filename: string
  overallProgress: number
  itemStatus: BatchFileItem['status']
}

export interface BatchResult {
  taskId: string
  total: number
  success: number
  failed: number
  skipped: number
  items: BatchFileItem[]
  duration: number
}

// ============================================================
// 支付系统类型
// ============================================================
export type PaymentTier = 'monthly' | 'quarterly' | 'pro' | 'lifetime'

export interface PaymentOrderResult {
  success: boolean
  message?: string
  tradeOrderId?: string
  codeUrl?: string
  payUrl?: string
  totalFee?: number
  tier?: PaymentTier
}

export interface PaymentQueryResult {
  success: boolean
  message?: string
  tradeOrderId?: string
  status?: 'paid' | 'awaiting' | 'closed'
  totalFee?: number
  paidAt?: string
}

// ============================================================
// 会员系统类型
// ============================================================
export type MemberTier = 'free' | 'monthly' | 'quarterly' | 'pro' | 'lifetime' | 'referral'

export interface LicenseStatus {
  tier: MemberTier
  isActive: boolean
  activatedAt: string | null
  expiresAt: string | null
  daysRemaining: number | null
  machineId: string
  referralCode?: string
}

export interface UsageLimits {
  maxFileSize: number
  maxBatchCount: number
  ocrDailyLimit: number
  hasWatermark: boolean
  supportedFormats: string[]
  canUseBatch: boolean
  canUseOcr: boolean
}

export interface ActivationResult {
  success: boolean
  message: string
  license?: {
    code: string
    tier: MemberTier
    activatedAt: string
    expiresAt: string | null
    machineId: string
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
