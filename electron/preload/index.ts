import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // 文件选择
  selectFiles: (options?: { filters?: any[], multi?: boolean }) =>
    ipcRenderer.invoke('select-files', options || {}),
  selectFolder: () =>
    ipcRenderer.invoke('select-folder'),
  showSaveDialog: (options?: { defaultPath?: string, filters?: any[] }) =>
    ipcRenderer.invoke('show-save-dialog', options || {}),

  // PDF 转 Word
  convertPdfToDocx: (params: { inputPath: string, outputPath: string, taskId: string }) =>
    ipcRenderer.invoke('convert-pdf-to-docx', params),

  // PDF 转 Excel
  convertPdfToXlsx: (params: { inputPath: string, outputPath: string, taskId: string }) =>
    ipcRenderer.invoke('convert-pdf-to-xlsx', params),

  // PDF 转 PPT
  convertPdfToPpt: (params: { inputPath: string, outputPath: string, taskId: string }) =>
    ipcRenderer.invoke('convert-pdf-to-ppt', params),

  // Word 转 PDF
  convertDocxToPdf: (params: { inputPath: string, outputPath: string, taskId: string }) =>
    ipcRenderer.invoke('convert-docx-to-pdf', params),

  // 取消转换
  cancelConversion: (taskId: string) =>
    ipcRenderer.invoke('cancel-conversion', { taskId }),

  // 打开文件 / 文件夹
  openFile: (path: string) =>
    ipcRenderer.invoke('open-file', { path }),
  openFolder: (path: string) =>
    ipcRenderer.invoke('open-folder', { path }),

  // 获取文件大小
  getFileSize: (path: string) =>
    ipcRenderer.invoke('get-file-size', { path }),

  // 窗口控制
  windowMinimize: () =>
    ipcRenderer.invoke('window-minimize'),
  windowMaximize: () =>
    ipcRenderer.invoke('window-maximize'),
  windowClose: () =>
    ipcRenderer.invoke('window-close'),
  windowIsMaximized: () =>
    ipcRenderer.invoke('window-is-maximized'),
  setNativeTheme: (theme: 'light' | 'dark') =>
    ipcRenderer.invoke('set-native-theme', theme),
  onWindowMaximizeChange: (callback: (isMaximized: boolean) => void) => {
    const handler = (_event: any, isMaximized: boolean) => callback(isMaximized)
    ipcRenderer.on('window-maximize-changed', handler)
    return () => ipcRenderer.removeListener('window-maximize-changed', handler)
  },

  // 应用信息
  getAppVersion: () =>
    ipcRenderer.invoke('get-app-version'),
  checkPythonEnv: () =>
    ipcRenderer.invoke('check-python-env'),
  checkLibreOffice: () =>
    ipcRenderer.invoke('check-libreoffice'),

  // 内嵌 Python 运行时管理
  checkEmbeddedPython: () =>
    ipcRenderer.invoke('check-embedded-python'),
  installEmbeddedPython: () =>
    ipcRenderer.invoke('install-embedded-python'),
  installPdf2docx: () =>
    ipcRenderer.invoke('install-pdf2docx'),
  cancelPythonInstall: () =>
    ipcRenderer.invoke('cancel-python-install'),
  onPythonInstallProgress: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('python-install-progress', handler)
    return () => ipcRenderer.removeListener('python-install-progress', handler)
  },

  // OCR 文字识别
  ocrRecognize: (params: { imagePath: string, taskId: string, lang?: string }) =>
    ipcRenderer.invoke('ocr-recognize', params),
  ocrSave: (params: { text: string, outputPath: string }) =>
    ipcRenderer.invoke('ocr-save', params),
  ocrSaveMultiFormat: (params: { text: string, imagePath: string, outputPath: string, format: string }) =>
    ipcRenderer.invoke('ocr-save-multiformat', params),

  // 图片格式转换
  convertImage: (params: {
    inputPath: string
    outputPath: string
    targetFormat: 'png' | 'jpg' | 'webp'
    taskId: string
    quality?: number
    width?: number
    height?: number
  }) => ipcRenderer.invoke('convert-image', params),

  batchConvertImages: (params: {
    items: Array<{ inputPath: string, outputPath: string, targetFormat: 'png' | 'jpg' | 'webp' }>
    taskId: string
    quality?: number
    width?: number
    height?: number
  }) => ipcRenderer.invoke('batch-convert-images', params),

  // PDF 工具（V0.6）
  getPdfInfo: (inputPath: string) =>
    ipcRenderer.invoke('get-pdf-info', { inputPath }),
  mergePdfs: (params: { filePaths: string[], outputPath: string, taskId: string }) =>
    ipcRenderer.invoke('merge-pdfs', params),
  splitPdf: (params: { inputPath: string, outputDir: string, taskId: string, mode: string, options?: any }) =>
    ipcRenderer.invoke('split-pdf', params),
  pdfToImages: (params: { inputPath: string, outputDir: string, taskId: string, options?: any }) =>
    ipcRenderer.invoke('pdf-to-images', params),
  htmlToPdf: (params: { htmlContent: string, outputPath: string, taskId: string }) =>
    ipcRenderer.invoke('html-to-pdf', params),
  markdownToPdf: (params: { content: string, outputPath: string, taskId: string }) =>
    ipcRenderer.invoke('markdown-to-pdf', params),

  // PDF 加密 / 解密 / 压缩（V0.7）
  encryptPdf: (params: { inputPath: string, outputPath: string, password: string, ownerPassword?: string }) =>
    ipcRenderer.invoke('encrypt-pdf', params),
  decryptPdf: (params: { inputPath: string, outputPath: string, password: string }) =>
    ipcRenderer.invoke('decrypt-pdf', params),
  compressPdf: (params: { inputPath: string, outputPath: string, level?: 'low' | 'medium' | 'high' }) =>
    ipcRenderer.invoke('compress-pdf', params),

  // 图片压缩（V0.6）
  compressImage: (params: { inputPath: string, outputPath: string, taskId: string, options?: any }) =>
    ipcRenderer.invoke('compress-image', params),
  batchCompressImages: (params: { items: Array<{ inputPath: string, outputPath: string }>, taskId: string, options?: any }) =>
    ipcRenderer.invoke('batch-compress-images', params),

  // 图片转 HTML/MD
  imageToHtml: (params: { inputPath: string, outputPath: string, taskId: string, options?: any }) =>
    ipcRenderer.invoke('image-to-html', params),

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
  }) => ipcRenderer.invoke('convert-video', params),

  getVideoInfo: (videoPath: string) =>
    ipcRenderer.invoke('get-video-info', { videoPath }),

  // CAJ 转 PDF
  convertCajToPdf: (params: { inputPath: string, outputPath: string, taskId: string }) =>
    ipcRenderer.invoke('convert-caj-to-pdf', params),
  checkCajEnv: () =>
    ipcRenderer.invoke('check-caj-env'),
  installCajRuntime: () =>
    ipcRenderer.invoke('install-caj-runtime'),
  cancelCajInstall: () =>
    ipcRenderer.invoke('cancel-caj-install'),
  onCajInstallProgress: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('caj-install-progress', handler)
    return () => ipcRenderer.removeListener('caj-install-progress', handler)
  },

  // 右键菜单管理
  registerContextMenu: () => ipcRenderer.invoke('register-context-menu'),
  unregisterContextMenu: () => ipcRenderer.invoke('unregister-context-menu'),
  checkContextMenu: () => ipcRenderer.invoke('check-context-menu'),

  // 右键菜单事件监听
  onContextMenuAction: (callback: (data: { action: string, filePath: string }) => void) => {
    const handler = (_event: any, data: { action: string, filePath: string }) => callback(data)
    ipcRenderer.on('context-menu-action', handler)
    return () => ipcRenderer.removeListener('context-menu-action', handler)
  },

  // 批量转换
  scanFolder: (params: { folderPath: string, type: string, recursive?: boolean }) =>
    ipcRenderer.invoke('scan-folder', params),
  buildBatchItems: (params: { filePaths: string[], type: string, outputDir?: string }) =>
    ipcRenderer.invoke('build-batch-items', params),
  batchConvert: (params: { taskId: string, items: any[], options: any }) =>
    ipcRenderer.invoke('batch-convert', params),
  batchCancel: (taskId: string) =>
    ipcRenderer.invoke('batch-cancel', { taskId }),
  onBatchProgress: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('batch-progress', handler)
    return () => ipcRenderer.removeListener('batch-progress', handler)
  },

  // 历史记录持久化
  historyLoad: () => ipcRenderer.invoke('history-load'),
  historySave: (records: any[]) => ipcRenderer.invoke('history-save', { records }),
  historyClear: () => ipcRenderer.invoke('history-clear'),
  historyDeleteItem: (id: string) => ipcRenderer.invoke('history-delete-item', { id }),

  // 应用设置持久化
  settingsLoad: () => ipcRenderer.invoke('settings-load'),
  settingsSave: (settings: any) => ipcRenderer.invoke('settings-save', { settings }),

  // 会员系统
  licenseActivate: (code: string) =>
    ipcRenderer.invoke('license-activate', { code }),
  licenseDeactivate: () =>
    ipcRenderer.invoke('license-deactivate'),
  licenseStatus: () =>
    ipcRenderer.invoke('license-status'),
  licenseLimits: () =>
    ipcRenderer.invoke('license-limits'),
  licenseOcrCheck: () =>
    ipcRenderer.invoke('license-ocr-check'),
  licenseOcrIncrement: () =>
    ipcRenderer.invoke('license-ocr-increment'),

  // 邀请码系统
  referralGetCode: () =>
    ipcRenderer.invoke('referral-get-code'),
  referralActivate: (code: string) =>
    ipcRenderer.invoke('referral-activate', { code }),
  referralStats: () =>
    ipcRenderer.invoke('referral-stats'),

  // 虎皮椒支付
  paymentCreateOrder: (params: { tier: string }) =>
    ipcRenderer.invoke('payment-create-order', params),
  paymentQueryOrder: (tradeOrderId: string) =>
    ipcRenderer.invoke('payment-query-order', { tradeOrderId }),

  // 进度监听
  onProgress: (callback: (data: { taskId: string, progress: number }) => void) => {
    const handler = (_event: any, data: { taskId: string, progress: number }) => callback(data)
    ipcRenderer.on('conversion-progress', handler)
    return () => ipcRenderer.removeListener('conversion-progress', handler)
  },

  // 获取拖拽文件的本地路径（解决 Electron 新版本 File.path 不可用问题）
  getFilePathForFile: (file: File): string => {
    return webUtils.getPathForFile(file)
  },

  // 自动更新检查
  checkForUpdates: () =>
    ipcRenderer.invoke('check-for-updates'),
  openDownloadPage: (url: string) =>
    ipcRenderer.invoke('open-download-page', { url }),

  // 系统通知
  showNotification: (params: { title: string, body?: string, silent?: boolean }) =>
    ipcRenderer.invoke('show-notification', params),

  // 全局快捷键管理
  registerShortcuts: () =>
    ipcRenderer.invoke('register-shortcuts'),
  unregisterShortcuts: () =>
    ipcRenderer.invoke('unregister-shortcuts'),
  checkShortcutsRegistered: () =>
    ipcRenderer.invoke('check-shortcuts-registered'),

  // 截图 OCR 事件监听
  onScreenshotOcrReady: (callback: (data: { screenshotPath: string | null }) => void) => {
    const handler = (_event: any, data: { screenshotPath: string | null }) => callback(data)
    ipcRenderer.on('screenshot-ocr-ready', handler)
    return () => ipcRenderer.removeListener('screenshot-ocr-ready', handler)
  },

  // 使用统计
  usageStatsLoad: () =>
    ipcRenderer.invoke('usage-stats-load'),
  usageStatsRecord: (params: { type: string, success: boolean, bytesSaved?: number }) =>
    ipcRenderer.invoke('usage-stats-record', params),
})
