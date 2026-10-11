<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import SidebarNav from './components/SidebarNav.vue'
import TitleBar from './components/TitleBar.vue'
import DropZone from './components/DropZone.vue'
import QuickEntry from './components/QuickEntry.vue'
import HistoryList, { type HistoryItem } from './components/HistoryList.vue'
import TaskCard from './components/TaskCard.vue'
import OcrResultModal from './components/OcrResultModal.vue'
import ToastContainer from './components/ToastContainer.vue'
import FormatSelectModal, { type PendingFile } from './components/FormatSelectModal.vue'
// 懒加载非首屏组件，减少初始包大小
const BatchPanel = defineAsyncComponent(() => import('./components/BatchPanel.vue'))
const MembershipPanel = defineAsyncComponent(() => import('./components/MembershipPanel.vue'))
const PdfToolsPanel = defineAsyncComponent(() => import('./components/PdfToolsPanel.vue'))
const ImageCompressPanel = defineAsyncComponent(() => import('./components/ImageCompressPanel.vue'))
const PdfToImagePanel = defineAsyncComponent(() => import('./components/PdfToImagePanel.vue'))
const HtmlToPdfPanel = defineAsyncComponent(() => import('./components/HtmlToPdfPanel.vue'))
const ImageToHtmlPanel = defineAsyncComponent(() => import('./components/ImageToHtmlPanel.vue'))
const StatsPanel = defineAsyncComponent(() => import('./components/StatsPanel.vue'))
const PromoPopup = defineAsyncComponent(() => import('./components/PromoPopup.vue'))
import { useToast } from './composables/useToast'
import { useLicense, checkFileSize, checkBatchCount, checkAndConsumeOcr, checkFormatSupported, showReferralIfEligible } from './composables/useLicense'
import {
  convertPdfToDocx,
  convertPdfToXlsx,
  convertPdfToPpt,
  convertDocxToPdf,
  performOcrRecognition,
  convertImageFormat,
  convertVideoFormat,
  convertCajToPdf,
  getFileMeta,
  inferConversionType,
  getSourceExts,
  getOutputPath,
  generateTaskId,
  type ConvertTask,
  type ConversionType,
  type VideoTargetFormat,
  type VideoQualityPreset
} from './services/converter'
import type { OcrSaveFormat } from './components/OcrResultModal.vue'
import type { AppSettings, HistoryRecord } from './types/electron'

const toast = useToast()
const license = useLicense()

const activeTab = ref('convert')
const tasks = reactive<ConvertTask[]>([])
const history = reactive<HistoryItem[]>([])
const pythonReady = ref<boolean | null>(null)
const libreOfficeReady = ref<boolean | null>(null)
const contextMenuEnabled = ref<boolean>(false)
const contextMenuBusy = ref<boolean>(false)

// 内嵌 Python 安装状态
const pythonInstallBusy = ref(false)
const pythonInstallPhase = ref<string | null>(null)
const pythonInstallProgress = ref(0)
const pythonInstallRetryCount = ref(0)
const pythonNeedsInstall = ref(false)

// CAJ 运行时状态
const cajReady = ref<boolean | null>(null)
const cajInstallBusy = ref(false)
const cajInstallPhase = ref<string | null>(null)
const cajInstallProgress = ref(0)
const cajInstallRetryCount = ref(0)

// 自动更新状态
const updateChecking = ref(false)
const updateInfo = ref<{ hasUpdate: boolean, latestVersion: string, currentVersion: string, downloadUrl: string, releaseNotes: string, releasePage: string } | null>(null)

// 应用设置（从本地存储加载）
const appSettings = reactive<AppSettings>({
  outputDir: '',
  autoOpenFolder: false,
  defaultImageQuality: 90,
  ocrLang: 'chi_sim+eng',
  concurrency: 3,
  theme: 'light',
  contextMenuAutoRegistered: false,
  enableNotifications: true,
  enableGlobalShortcuts: true,
})

// OCR 结果弹窗状态
const ocrModalVisible = ref(false)
const ocrResultText = ref('')
const ocrFileName = ref('')
const ocrImagePath = ref('')  // 保存 OCR 图片路径用于多格式输出

// 格式选择弹窗状态
const formatModalVisible = ref(false)
const pendingFiles = ref<PendingFile[]>([])

// 视频转换画质预设（从格式选择弹窗传入）
let pendingVideoQualityPreset: VideoQualityPreset | undefined = undefined

// PDF 工具面板状态
const showPdfTools = ref(false)
const pdfToolsDefaultTab = ref<'merge' | 'split' | 'compress' | 'encrypt' | 'decrypt'>('merge')

// 图片压缩面板状态
const showImageCompress = ref(false)

// 新增工具面板状态（PDF转图片、图片水印、HTML/MD转PDF、图片转HTML/MD）
const activeToolPanel = ref<string | null>(null)

// 使用统计面板
const showStats = ref(false)

let removeProgressListener: (() => void) | null = null
let removeContextMenuListener: (() => void) | null = null
let removePythonInstallListener: (() => void) | null = null
let removeCajInstallListener: (() => void) | null = null
let removeScreenshotOcrListener: (() => void) | null = null

onMounted(async () => {
  // 阶段1：加载关键数据（设置、历史记录），让 UI 快速呈现
  const [historyResult, settingsResult] = await Promise.all([
    window.electronAPI?.historyLoad?.().catch(() => []) || [],
    window.electronAPI?.settingsLoad?.().catch(() => null),
  ])

  // 历史记录
  history.push(...historyResult)

  // 应用设置
  if (settingsResult) {
    Object.assign(appSettings, settingsResult)
  }
  applyTheme(appSettings.theme)

  // 立即注册事件监听（不阻塞 UI）
  if (window.electronAPI?.onProgress) {
    removeProgressListener = window.electronAPI.onProgress((data) => {
      const task = tasks.find(t => t.id === data.taskId)
      if (task) {
        task.progress = data.progress
      }
    })
  }

  if (window.electronAPI?.onContextMenuAction) {
    removeContextMenuListener = window.electronAPI.onContextMenuAction((data) => {
      handleContextMenuAction(data.action, data.filePath)
    })
  }

  // 阶段2：延迟检查环境（不阻塞首屏渲染）
  const idleCallback = (window as any).requestIdleCallback || ((cb: () => void) => setTimeout(cb, 100))
  idleCallback(() => {
    Promise.all([
      window.electronAPI?.checkPythonEnv?.().catch(() => null),
      window.electronAPI?.checkLibreOffice?.().catch(() => null),
      window.electronAPI?.checkContextMenu?.().catch(() => null),
      window.electronAPI?.checkCajEnv?.().catch(() => null),
    ]).then(async ([pythonResult, libreResult, contextMenuResult, cajResult]) => {
      if (pythonResult) {
        pythonReady.value = pythonResult.pdf2docxReady
        pythonNeedsInstall.value = pythonResult.needsInstall === true
        pythonInstallBusy.value = pythonResult.busy === true
        pythonInstallPhase.value = pythonResult.phase || null
        pythonInstallProgress.value = pythonResult.progress || 0
      }
      if (libreResult) {
        libreOfficeReady.value = libreResult.installed
      }
      if (contextMenuResult) {
        contextMenuEnabled.value = contextMenuResult.registered
        // 启动时自动注册右键菜单（仅打包环境）
        // 如果上次注册失败，下次启动仍会重试
        if (!contextMenuResult.registered) {
          try {
            const regResult = await window.electronAPI?.registerContextMenu?.()
            if (regResult?.success) {
              contextMenuEnabled.value = true
              // 仅首次成功时显示提示
              if (!appSettings.contextMenuAutoRegistered) {
                toast.success('右键菜单已启用', { message: '右键文件即可快速转换' })
              }
            }
          } catch {
            // 注册失败不影响正常使用
          }
          // 无论成功失败都标记，避免每次启动都弹提示
          // 但 isContextMenuRegistered() 会检测实际注册状态，未注册时仍会重试
          appSettings.contextMenuAutoRegistered = true
          await saveAppSettings({ contextMenuAutoRegistered: true } as any)
        }
      }
      if (cajResult) {
        cajReady.value = cajResult.cajReady
      }
    })
  }, { timeout: 2000 })

  // 注册 Python 安装进度监听
  if (window.electronAPI?.onPythonInstallProgress) {
    removePythonInstallListener = window.electronAPI.onPythonInstallProgress((data) => {
      pythonInstallBusy.value = data.busy !== false
      pythonInstallPhase.value = data.phase || null
      pythonInstallProgress.value = data.progress || 0
      pythonInstallRetryCount.value = data.retryCount || 0
      if (data.pythonReady) pythonReady.value = true
      if (data.pdf2docxReady) pythonReady.value = true
      if (!data.busy) {
        pythonNeedsInstall.value = !data.pdf2docxReady
      }
      // 链式安装：Python 安装进度同步到 CAJ 进度条
      if (cajInstallBusy.value && data.busy !== false) {
        cajInstallPhase.value = 'download-runtime'
        cajInstallProgress.value = Math.round((data.progress || 0) / 2)  // Python 占 CAJ 总进度的前 50%
        cajInstallRetryCount.value = data.retryCount || 0
      }
    })
  }

  // 注册 CAJ 安装进度监听
  if (window.electronAPI?.onCajInstallProgress) {
    removeCajInstallListener = window.electronAPI.onCajInstallProgress((data) => {
      cajInstallBusy.value = data.busy !== false
      cajInstallPhase.value = data.phase || null
      cajInstallProgress.value = data.progress || 0
      cajInstallRetryCount.value = data.retryCount || 0
      if (data.cajReady) cajReady.value = true
      if (!data.busy && data.caj2pdfInstalled && data.mutoolReady) {
        cajReady.value = true
      }
    })
  }
  // 注册截图 OCR 事件监听
  if (window.electronAPI?.onScreenshotOcrReady) {
    removeScreenshotOcrListener = window.electronAPI.onScreenshotOcrReady(async (data) => {
      if (data.screenshotPath) {
        // 截图成功，自动执行 OCR
        toast.info('截图 OCR', { message: '正在识别截图内容...' })
        await executeConversion('ocr', data.screenshotPath, `截图_${Date.now()}.png`)
      } else {
        toast.info('截图已取消')
      }
    })
  }

  // 阶段3：延迟自动检查更新（启动 5 秒后，不干扰首屏体验）
  setTimeout(async () => {
    if (!window.electronAPI?.checkForUpdates) return
    try {
      const result = await window.electronAPI.checkForUpdates()
      if (result.hasUpdate) {
        updateInfo.value = result
        toast.success(`发现新版本 v${result.latestVersion}`, {
          message: '点击"检查更新"查看详情并下载',
          duration: 10000,
        })
      }
    } catch {
      // 静默失败，不影响用户使用
    }
  }, 5000)
})

onUnmounted(() => {
  removeProgressListener?.()
  removeContextMenuListener?.()
  removePythonInstallListener?.()
  removeCajInstallListener?.()
  removeScreenshotOcrListener?.()
  flushHistory()
})

// ============================================================
// 右键菜单触发处理
// ============================================================
function handleContextMenuAction(action: string, filePath: string) {
  const meta = getFileMeta(filePath)
  // action 来自右键菜单参数（--to=xxx 或 --ocr）
  // --to=docx → PDF转Word；--to=pdf → Word转PDF
  // --to=png → 转为PNG；--to=jpg → 转为JPG
  // --to=ocr → OCR识别；--to=caj2pdf → CAJ转PDF
  // mp4/mkv/... → 视频转换（弹出格式选择）
  const typeMap: Record<string, ConversionType> = {
    'docx': 'pdf2docx',
    'pdf': 'docx2pdf',
    'png': 'img2png',
    'jpg': 'img2jpg',
    'ocr': 'ocr',
    'caj2pdf': 'caj2pdf',
  }

  // 视频格式右键菜单：弹出格式选择
  if (action === 'video') {
    pendingFiles.value = [{ path: filePath, name: meta.name, ext: meta.ext }]
    formatModalVisible.value = true
    return
  }

  const type = typeMap[action]
  if (type) {
    toast.info('开始转换', { message: meta.name })
    executeConversion(type, filePath, meta.name)
  }
}

// ============================================================
// 右键菜单开关
// ============================================================
async function toggleContextMenu() {
  if (!window.electronAPI || contextMenuBusy.value) return

  contextMenuBusy.value = true

  try {
    if (contextMenuEnabled.value) {
      const result = await window.electronAPI.unregisterContextMenu()
      contextMenuEnabled.value = false
      toast.success('右键菜单已移除', { message: `共移除 ${result.removed.length} 项` })
    } else {
      const result = await window.electronAPI.registerContextMenu()
      contextMenuEnabled.value = result.success
      if (result.success) {
        toast.success('右键菜单已启用', { message: '右键文件即可快速转换' })
      } else {
        toast.error('右键菜单注册失败', { message: result.errors.join('; ') || '未知错误' })
      }
    }
  } catch (err: any) {
    toast.error('操作失败', { message: err.message || '未知错误' })
  } finally {
    contextMenuBusy.value = false
  }
}

// ============================================================
// 文件拖放处理 — 收集文件后弹出格式选择弹窗
// ============================================================
async function onFilesDropped(files: File[]) {
  const collected: PendingFile[] = []
  for (const file of files) {
    // 从 File 对象获取路径（Electron 特有）
    const filePath = (file as any).path || file.name
    if (!filePath) continue
    const meta = getFileMeta(filePath)
    collected.push({ path: filePath, name: file.name, ext: meta.ext })
  }
  if (collected.length > 0) {
    pendingFiles.value = collected
    formatModalVisible.value = true
  }
}

// ============================================================
// 文件路径列表处理 — 收集文件后弹出格式选择弹窗
// ============================================================
async function onPathsDropped(paths: string[]) {
  const collected: PendingFile[] = []
  for (const path of paths) {
    const meta = getFileMeta(path)
    collected.push({ path, name: meta.name, ext: meta.ext })
  }
  if (collected.length > 0) {
    pendingFiles.value = collected
    formatModalVisible.value = true
  }
}

// ============================================================
// 格式选择弹窗确认 — 按用户选择的类型执行转换
// ============================================================
async function onFormatConfirm(type: ConversionType, videoTargetFormat?: VideoTargetFormat, videoQualityPreset?: VideoQualityPreset) {
  formatModalVisible.value = false
  pendingVideoQualityPreset = videoQualityPreset
  const compatibleExts = getSourceExts(type)
  const filesToConvert = pendingFiles.value.filter(f => compatibleExts.includes(f.ext))
  const skipped = pendingFiles.value.length - filesToConvert.length

  if (filesToConvert.length === 0) {
    toast.warning('没有兼容的文件', { message: '所选格式不匹配任何文件' })
    return
  }

  if (skipped > 0) {
    toast.info('开始转换', { message: `${filesToConvert.length} 个文件将转换，${skipped} 个不兼容已跳过` })
  } else {
    toast.info('开始转换', { message: `${filesToConvert.length} 个文件` })
  }

  for (const file of filesToConvert) {
    await executeConversion(type, file.path, file.name, videoTargetFormat)
  }
  pendingFiles.value = []
  pendingVideoQualityPreset = undefined
}

// ============================================================
// 文件夹拖入处理 — 扫描文件夹并跳转到批量转换
// ============================================================
async function onFolderDropped(folderPath: string) {
  // 切换到批量转换页面
  activeTab.value = 'batch'
  toast.info('已切换到批量转换', { message: '请在批量转换页面选择操作' })
}

// ============================================================
// PDF 工具面板完成回调
// ============================================================
function onPdfToolsComplete(result: any) {
  // PDF 工具面板 emit 的数据结构：
  // merge: { type: 'merge', result: { filePath, totalPages, fileSize } }
  // split: { type: 'split', result: [{ name, path, pages }] }
  // compress: { type: 'compress', result: { filePath, originalSize, newSize } }
  // encrypt: { type: 'encrypt', result: { filePath, size } }
  // decrypt: { type: 'decrypt', result: { filePath, size } }
  if (result.type === 'merge' && result.result?.filePath) {
    toast.success('PDF 合并成功', {
      message: `${result.result.totalPages} 页，${(result.result.fileSize / 1024).toFixed(1)} KB`,
      duration: 6000,
    })
    if (result.result.filePath && appSettings.autoOpenFolder) {
      window.electronAPI?.openFolder(result.result.filePath)
    }
  } else if (result.type === 'split' && result.result?.length > 0) {
    toast.success('PDF 拆分成功', {
      message: `共生成 ${result.result.length} 个文件`,
      duration: 6000,
    })
    // 打开第一个拆分文件所在的文件夹
    if (result.result[0]?.path && appSettings.autoOpenFolder) {
      window.electronAPI?.openFolder(result.result[0].path)
    }
  } else if (result.type === 'compress' && result.result?.filePath) {
    const saved = result.result.originalSize && result.result.newSize
      ? Math.max(0, result.result.originalSize - result.result.newSize)
      : 0
    toast.success('PDF 压缩成功', {
      message: saved > 0 ? `节省 ${(saved / 1024).toFixed(1)} KB` : '压缩完成',
      duration: 6000,
    })
    if (appSettings.autoOpenFolder) {
      window.electronAPI?.openFolder(result.result.filePath)
    }
  } else if (result.type === 'encrypt' && result.result?.filePath) {
    toast.success('PDF 加密成功', {
      message: `文件大小 ${(result.result.size / 1024).toFixed(1)} KB`,
      duration: 6000,
    })
    if (appSettings.autoOpenFolder) {
      window.electronAPI?.openFolder(result.result.filePath)
    }
  } else if (result.type === 'decrypt' && result.result?.filePath) {
    toast.success('PDF 解密成功', {
      message: `文件大小 ${(result.result.size / 1024).toFixed(1)} KB`,
      duration: 6000,
    })
    if (appSettings.autoOpenFolder) {
      window.electronAPI?.openFolder(result.result.filePath)
    }
  } else if (result.type === 'merge' || result.type === 'split') {
    // 有结果对象但内容为空，说明操作可能失败
    toast.error('PDF 操作失败', { message: result.result?.message || '未知错误' })
  } else {
    toast.error('PDF 操作失败', { message: result.result?.message || '未知错误' })
  }

  // 记录使用统计
  try {
    const isSuccess = (result.type === 'merge' && result.result?.filePath) ||
                      (result.type === 'split' && result.result?.length > 0) ||
                      (result.type === 'compress' && result.result?.filePath) ||
                      (result.type === 'encrypt' && result.result?.filePath) ||
                      (result.type === 'decrypt' && result.result?.filePath)
    window.electronAPI?.usageStatsRecord?.({
      type: result.type,
      success: !!isSuccess,
      bytesSaved: result.type === 'compress' && result.result?.originalSize && result.result?.newSize
        ? Math.max(0, result.result.originalSize - result.result.newSize)
        : 0
    })
  } catch {
    // 统计记录失败不影响主流程
  }
}

// ============================================================
// 图片压缩面板完成回调
// ============================================================
function onImageCompressComplete(result: any) {
  if (result.itemCount > 0) {
    toast.success('图片压缩完成', {
      message: `共压缩 ${result.itemCount} 张图片，节省 ${formatFileSize(result.totalSaved)}`,
      duration: 6000,
    })
  } else {
    toast.error('图片压缩失败', { message: '没有文件被成功压缩' })
  }
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}

// ============================================================
// PDF 转图片完成回调
// ============================================================
function onPdfToImageComplete(result: any) {
  if (result.status === 'success') {
    toast.success('PDF 转图片完成', {
      message: `共生成 ${result.totalItems} 张图片`,
      duration: 6000,
    })
    if (result.outputPath && appSettings.autoOpenFolder) {
      window.electronAPI?.openFolder(result.outputPath)
    }
  } else {
    toast.error('PDF 转图片失败', { message: result.message || '未知错误' })
  }
}

// ============================================================
// HTML/MD 转 PDF 完成回调
// ============================================================
function onHtmlToPdfComplete(result: any) {
  if (result.status === 'success') {
    toast.success('转 PDF 成功', {
      message: result.message || '转换完成',
      duration: 6000,
    })
    if (result.output && appSettings.autoOpenFolder) {
      window.electronAPI?.openFolder(result.output)
    }
  } else {
    toast.error('转 PDF 失败', { message: result.message || '未知错误' })
  }
}

// ============================================================
// 图片转 HTML/MD 完成回调
// ============================================================
function onImageToHtmlComplete(result: any) {
  if (result.status === 'success') {
    toast.success('转换完成', {
      message: result.message || '转换完成',
      duration: 6000,
    })
    if (result.output) {
      window.electronAPI?.openFolder(result.output)
    }
  } else {
    toast.error('转换失败', { message: result.message || '未知错误' })
  }
}

// ============================================================
// 快捷入口处理
// ============================================================
async function onQuickAction(action: string) {
  if (!window.electronAPI) return

  // ====== 工具面板类操作：直接打开面板，不弹文件选择框 ======
  // PDF 合并/拆分/压缩/加密/解密 — 直接打开 PDF 工具面板
  if (action === 'pdf-merge' || action === 'pdf-split' || action === 'pdf-compress' || action === 'pdf-encrypt' || action === 'pdf-decrypt') {
    activeTab.value = 'convert'
    const tabMap: Record<string, 'merge' | 'split' | 'compress' | 'encrypt' | 'decrypt'> = {
      'pdf-merge': 'merge',
      'pdf-split': 'split',
      'pdf-compress': 'compress',
      'pdf-encrypt': 'encrypt',
      'pdf-decrypt': 'decrypt'
    }
    pdfToolsDefaultTab.value = tabMap[action] || 'merge'
    showPdfTools.value = true
    return
  }

  // 图片压缩 — 直接打开图片压缩面板
  if (action === 'img-compress') {
    activeTab.value = 'convert'
    showImageCompress.value = true
    return
  }

  // PDF 转图片 — 直接打开 PDF 转图片面板
  if (action === 'pdf-to-image') {
    activeTab.value = 'convert'
    activeToolPanel.value = 'pdf-to-image'
    return
  }

  // HTML/MD 转 PDF — 直接打开面板
  if (action === 'html-to-pdf') {
    activeTab.value = 'convert'
    activeToolPanel.value = 'html-to-pdf'
    return
  }

  // 图片转 HTML/MD — 直接打开面板
  if (action === 'img-to-html') {
    activeTab.value = 'convert'
    activeToolPanel.value = 'img-to-html'
    return
  }

  // ====== 直接转换类操作：弹文件选择框 ======
  const filters: Record<string, any[]> = {
    'pdf2docx': [{ name: 'PDF 文件', extensions: ['pdf'] }],
    'pdf2xlsx': [{ name: 'PDF 文件', extensions: ['pdf'] }],
    'pdf2ppt': [{ name: 'PDF 文件', extensions: ['pdf'] }],
    'docx2pdf': [{ name: 'Office 文件', extensions: ['docx', 'doc', 'ppt', 'pptx', 'xls', 'xlsx'] }],
    'img2png': [{ name: '图片文件', extensions: ['jpg', 'jpeg', 'bmp', 'webp', 'tiff', 'gif'] }],
    'img2jpg': [{ name: '图片文件', extensions: ['png', 'bmp', 'webp', 'tiff', 'gif'] }],
    'img2webp': [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'tiff', 'gif'] }],
    'img2heic': [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'tiff', 'gif'] }],
    'heic2jpg': [{ name: 'HEIC 图片', extensions: ['heic', 'heif'] }],
    'ocr': [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp'] }],
    'videoConvert': [{ name: '视频文件', extensions: ['mp4', 'avi', 'mkv', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts'] }],
    'caj2pdf': [{ name: 'CAJ 文件', extensions: ['caj', 'nh'] }],
  }

  const paths = await window.electronAPI.selectFiles({
    filters: filters[action] || [{ name: '所有文件', extensions: ['*'] }],
    multi: true
  })

  if (paths.length === 0) return

  // 视频转换需要选择目标格式，通过格式选择弹窗处理
  if (action === 'videoConvert') {
    const collected: PendingFile[] = paths.map(path => {
      const meta = getFileMeta(path)
      return { path, name: meta.name, ext: meta.ext }
    })
    pendingFiles.value = collected
    formatModalVisible.value = true
    return
  }

  for (const path of paths) {
    const meta = getFileMeta(path)
    await executeConversion(action as ConversionType, path, meta.name)
  }
}

// ============================================================
// 执行转换
// ============================================================
async function executeConversion(type: ConversionType, inputPath: string, inputName: string, videoTargetFormat?: VideoTargetFormat) {
  const taskId = generateTaskId()

  // ============================================================
  // 会员限制检查
  // ============================================================
  // 检查文件格式是否支持
  const ext = inputPath.split('.').pop()?.toLowerCase() || ''
  if (!checkFormatSupported(ext)) {
    showReferralIfEligible()
    toast.warning('该格式需升级 Pro 会员', { message: `${ext.toUpperCase()} 格式仅 Pro 会员可用` })
    addHistoryItem(inputName, ext, 'unknown', 'error', '格式需升级会员')
    return
  }

  // 检查文件大小（需要获取文件大小）
  if (window.electronAPI?.getFileSize) {
    const size = await window.electronAPI.getFileSize(inputPath)
    const sizeCheck = checkFileSize(size)
    if (!sizeCheck.allowed) {
      showReferralIfEligible()
      toast.error('文件过大', { message: sizeCheck.message })
      addHistoryItem(inputName, ext, 'unknown', 'error', '文件大小超出限制')
      return
    }
  }

  // OCR 特殊检查：每日次数限制
  if (type === 'ocr') {
    const ocrCheck = await checkAndConsumeOcr()
    if (!ocrCheck.allowed) {
      showReferralIfEligible()
      toast.error('OCR 次数已用完', { message: ocrCheck.message })
      addHistoryItem(inputName, ext, 'txt', 'error', 'OCR 次数已用完')
      return
    }
  }

  // 确定输出扩展名
  const outputExt = type === 'videoConvert'
    ? (videoTargetFormat || 'mp4')
    : ({
        'pdf2docx': 'docx',
        'pdf2xlsx': 'xlsx',
        'pdf2ppt': 'pptx',
        'docx2pdf': 'pdf',
        'img2png': 'png',
        'img2jpg': 'jpg',
        'img2webp': 'webp',
        'img2heic': 'avif',
        'heic2jpg': 'jpg',
        'ocr': 'txt',
        'caj2pdf': 'pdf',
      } as Record<ConversionType, string>)[type]
  const outputPath = getOutputPath(inputPath, outputExt, appSettings.outputDir)

  const task: ConvertTask = reactive({
    id: taskId,
    type,
    inputPath,
    inputName,
    outputPath,
    status: 'processing',
    progress: 0,
    createdAt: new Date().toISOString()
  })

  tasks.unshift(task)

  try {
    let result

    if (type === 'pdf2docx') {
      result = await convertPdfToDocx(inputPath, outputPath)
    } else if (type === 'pdf2xlsx') {
      result = await convertPdfToXlsx(inputPath, outputPath)
    } else if (type === 'pdf2ppt') {
      result = await convertPdfToPpt(inputPath, outputPath)
    } else if (type === 'ocr') {
      const ocrResult = await performOcrRecognition(inputPath, appSettings.ocrLang, appSettings.outputDir || undefined)
      // 保存图片路径供多格式保存使用
      ocrImagePath.value = inputPath
      if (ocrResult.status === 'success' && ocrResult.text) {
        // 弹出结果窗口
        ocrResultText.value = ocrResult.text
        ocrFileName.value = inputName
        ocrModalVisible.value = true
        result = {
          status: 'success' as const,
          output: ocrResult.outputPath,
          message: `识别到 ${ocrResult.text.length} 个字符`
        }
      } else {
        result = {
          status: 'error' as const,
          message: ocrResult.message || 'OCR 识别失败'
        }
      }
    } else if (type === 'img2png') {
      result = await convertImageFormat(inputPath, 'png', { outputPath })
    } else if (type === 'img2jpg') {
      result = await convertImageFormat(inputPath, 'jpg', { quality: appSettings.defaultImageQuality, outputPath })
    } else if (type === 'img2webp') {
      result = await convertImageFormat(inputPath, 'webp', { quality: appSettings.defaultImageQuality, outputPath })
    } else if (type === 'img2heic') {
      result = await convertImageFormat(inputPath, 'heic', { quality: appSettings.defaultImageQuality, outputPath })
    } else if (type === 'heic2jpg') {
      result = await convertImageFormat(inputPath, 'jpg', { quality: appSettings.defaultImageQuality, outputPath })
    } else if (type === 'docx2pdf') {
      result = await convertDocxToPdf(inputPath, outputPath)
    } else if (type === 'videoConvert') {
      result = await convertVideoFormat(inputPath, videoTargetFormat || 'mp4', appSettings.outputDir || undefined, {
        qualityPreset: pendingVideoQualityPreset
      })
    } else if (type === 'caj2pdf') {
      // 检查 CAJ 环境（cajReady 为 null 或 false 时都阻止转换）
      if (!cajReady.value) {
        cajReady.value = false  // 确保安装按钮显示
        toast.warning('CAJ 转换组件未安装', { message: '请先安装 CAJ 转换依赖' })
        task.status = 'error'
        task.result = { status: 'error', message: 'CAJ 转换组件未安装，请先安装依赖' }
        return
      }
      result = await convertCajToPdf(inputPath, outputPath)
      // 转换失败时，标记 CAJ 环境为不可用，确保安装按钮显示
      if (result.status === 'error') {
        cajReady.value = false
      }
    } else {
      result = {
        status: 'error' as const,
        message: `${type} 功能即将上线，敬请期待`
      }
    }

    task.result = result
    task.status = result.status === 'success' ? 'success' : 'error'
    task.progress = 100

    // Toast 通知
    if (result.status === 'success') {
      const typeLabels: Record<ConversionType, string> = {
        'pdf2docx': 'PDF 转 Word',
        'pdf2xlsx': 'PDF 转 Excel',
        'pdf2ppt': 'PDF 转 PPT',
        'docx2pdf': 'Office 转 PDF',
        'img2png': '图片转 PNG',
        'img2jpg': '图片转 JPG',
        'img2webp': '图片转 WebP',
        'img2heic': '图片转 AVIF',
        'heic2jpg': 'HEIC 转 JPG',
        'ocr': 'OCR 识别',
        'videoConvert': `视频转 ${outputExt.toUpperCase()}`,
        'caj2pdf': 'CAJ 转 PDF',
      }
      // 提取输出文件名和目录用于 Toast 显示
      const outputFileName = result.output
        ? result.output.replace(/^.*[/\\]/, '')
        : inputName
      const outputDirLabel = result.output
        ? result.output.replace(/[/\\][^/\\]+$/, '')
        : ''
      toast.success(`${typeLabels[type]}成功`, {
        message: `文件名: ${outputFileName}\n保存位置: ${outputDirLabel}`,
        duration: 8000,
      })

      // 系统通知（转换完成时推送桌面通知，包含完整路径）
      if (appSettings.enableNotifications && window.electronAPI?.showNotification) {
        try {
          window.electronAPI.showNotification({
            title: `${typeLabels[type]}完成 - ${outputFileName}`,
            body: `保存位置: ${outputDirLabel}`,
          })
        } catch (e) {
          console.warn('发送系统通知失败:', e)
        }
      }

      // 转换成功后打开文件夹并选中文件（失败不影响转换结果）
      if (result.output && appSettings.autoOpenFolder) {
        try {
          await window.electronAPI?.openFolder(result.output)
        } catch (e) {
          console.warn('打开文件夹失败:', e)
        }
      }
    } else {
      const errorLabel = type === 'pdf2docx' ? 'PDF 转 Word'
        : type === 'pdf2xlsx' ? 'PDF 转 Excel'
        : type === 'pdf2ppt' ? 'PDF 转 PPT'
        : type === 'docx2pdf' ? 'Office 转 PDF'
        : type === 'ocr' ? 'OCR 识别'
        : type === 'videoConvert' ? '视频转换'
        : type === 'caj2pdf' ? 'CAJ 转换'
        : '图片转换'
      toast.error(`${errorLabel}失败`, {
        message: result.message || '请重试或检查文件',
      })

      // 失败时也推送系统通知
      if (appSettings.enableNotifications && window.electronAPI?.showNotification) {
        try {
          window.electronAPI.showNotification({
            title: `${errorLabel}失败`,
            body: result.message || '请重试或检查文件',
          })
        } catch (e) {
          console.warn('发送系统通知失败:', e)
        }
      }
    }

    // 添加到历史记录
    addHistoryItem(
      inputName,
      inputPath.split('.').pop() || '',
      outputExt,
      task.status === 'success' ? 'success' : 'error',
      result.message,
      result.output
    )

    // 记录使用统计
    try {
      window.electronAPI?.usageStatsRecord?.({
        type: type === 'videoConvert' ? (videoTargetFormat || 'mp4') : type,
        success: task.status === 'success',
        bytesSaved: 0
      })
    } catch {
      // 统计记录失败不影响主流程
    }
  } catch (err: any) {
    task.status = 'error'
    task.result = { status: 'error', message: err.message || '未知错误' }
    toast.error('转换失败', { message: err.message || '未知错误' })
    addHistoryItem(inputName, '', outputExt, 'error', err.message)

    // 记录使用统计（失败）
    try {
      window.electronAPI?.usageStatsRecord?.({
        type: type === 'videoConvert' ? (videoTargetFormat || 'mp4') : type,
        success: false,
        bytesSaved: 0
      })
    } catch {
      // 统计记录失败不影响主流程
    }
  }
}

// ============================================================
// 取消任务
// ============================================================
async function onCancelTask(taskId: string) {
  if (window.electronAPI?.cancelConversion) {
    await window.electronAPI.cancelConversion(taskId)
  }
  const task = tasks.find(t => t.id === taskId)
  if (task) {
    task.status = 'error'
    task.result = { status: 'error', message: '已取消' }
  }
}

// ============================================================
// 打开文件
// ============================================================
function onOpenFile(path: string) {
  window.electronAPI?.openFile(path)
}

function onOpenFolder(path: string) {
  window.electronAPI?.openFolder(path)
}

// ============================================================
// 历史记录
// ============================================================
// 防抖保存：批量转换时避免频繁写入磁盘
let historySaveTimer: ReturnType<typeof setTimeout> | null = null

function persistHistory() {
  if (historySaveTimer) clearTimeout(historySaveTimer)
  historySaveTimer = setTimeout(() => {
    const records: HistoryRecord[] = history.map(h => ({
      id: h.id,
      filename: h.filename,
      fromFormat: h.fromFormat,
      toFormat: h.toFormat,
      status: h.status === 'success' ? 'success' : 'error',
      message: undefined,
      outputPath: h.outputPath,
      createdAt: h.createdAt,
    }))
    window.electronAPI?.historySave(records)
    historySaveTimer = null
  }, 500)
}

// 页面卸载前立即保存
function flushHistory() {
  if (historySaveTimer) {
    clearTimeout(historySaveTimer)
    historySaveTimer = null
    const records: HistoryRecord[] = history.map(h => ({
      id: h.id,
      filename: h.filename,
      fromFormat: h.fromFormat,
      toFormat: h.toFormat,
      status: h.status === 'success' ? 'success' : 'error',
      outputPath: h.outputPath,
      createdAt: h.createdAt,
    }))
    window.electronAPI?.historySave(records)
  }
}

function addHistoryItem(
  filename: string,
  fromFormat: string,
  toFormat: string,
  status: 'success' | 'error' | 'pending',
  message?: string,
  outputPath?: string
) {
  const item: HistoryItem = {
    id: generateTaskId(),
    filename,
    fromFormat,
    toFormat,
    status,
    createdAt: new Date().toISOString(),
    outputPath
  }
  history.unshift(item)
  if (history.length > 100) history.pop()
  persistHistory()
}

async function onClearHistory() {
  history.length = 0
  await window.electronAPI?.historyClear()
  toast.success('历史记录已清空')
}

async function onDeleteHistoryItem(id: string) {
  const index = history.findIndex(h => h.id === id)
  if (index >= 0) {
    history.splice(index, 1)
    await window.electronAPI?.historyDeleteItem(id)
    toast.success('已删除记录')
  }
}

function onClearTasks() {
  tasks.length = 0
}

// ============================================================
// 设置管理
// ============================================================
async function selectOutputDir() {
  if (!window.electronAPI) return
  const folder = await window.electronAPI.selectFolder()
  if (folder) {
    appSettings.outputDir = folder
    await saveAppSettings({ outputDir: folder })
  }
}

async function clearOutputDir() {
  appSettings.outputDir = ''
  await saveAppSettings({ outputDir: '' })
}

async function saveAppSettings(partial: Partial<AppSettings>) {
  if (!window.electronAPI?.settingsSave) return
  const result = await window.electronAPI.settingsSave(partial)
  if (result.success) {
    Object.assign(appSettings, result.settings)
    toast.success('设置已保存')
  } else {
    toast.error('设置保存失败')
  }
}

async function onAutoOpenFolderChange(e: Event) {
  const checked = (e.target as HTMLInputElement).checked
  appSettings.autoOpenFolder = checked
  await saveAppSettings({ autoOpenFolder: checked })
}

async function onImageQualityChange(e: Event) {
  const value = parseInt((e.target as HTMLInputElement).value)
  appSettings.defaultImageQuality = value
  await saveAppSettings({ defaultImageQuality: value })
}

async function onOcrLangChange(e: Event) {
  const value = (e.target as HTMLSelectElement).value
  appSettings.ocrLang = value
  await saveAppSettings({ ocrLang: value })
}

async function onConcurrencyChange(e: Event) {
  const value = parseInt((e.target as HTMLInputElement).value)
  appSettings.concurrency = value
  await saveAppSettings({ concurrency: value })
}

async function onNotificationsChange(e: Event) {
  const checked = (e.target as HTMLInputElement).checked
  appSettings.enableNotifications = checked
  await saveAppSettings({ enableNotifications: checked })
}

async function onGlobalShortcutsChange(e: Event) {
  const checked = (e.target as HTMLInputElement).checked
  appSettings.enableGlobalShortcuts = checked
  await saveAppSettings({ enableGlobalShortcuts: checked })
  // 立即注册/注销快捷键
  if (checked) {
    const result = await window.electronAPI?.registerShortcuts()
    if (result?.success) {
      toast.success('全局快捷键已启用', { message: 'Ctrl+Shift+Y 显示窗口\nCtrl+Shift+S 截图 OCR' })
    } else {
      toast.error('快捷键注册失败', { message: result?.error || '可能被其他程序占用' })
    }
  } else {
    await window.electronAPI?.unregisterShortcuts()
    toast.info('全局快捷键已关闭')
  }
}

// ============================================================
// 主题切换
// ============================================================

// Python 安装阶段中文描述
const pythonPhaseLabels: Record<string, string> = {
  'download-runtime': '正在下载 Python 运行时',
  'extracting': '正在解压运行时',
  'installing-pdf2docx': '正在安装转换组件',
  'verifying': '正在验证安装',
}

function getPythonPhaseLabel(phase: string | null): string {
  if (!phase) return ''
  return pythonPhaseLabels[phase] || '正在处理...'
}

function getPythonPhaseDisplay(): string {
  const label = getPythonPhaseLabel(pythonInstallPhase.value)
  const retry = pythonInstallRetryCount.value
  if (retry > 0) {
    return `${label}（网络波动，正在重试第 ${retry} 次...）`
  }
  return label
}

async function onInstallPython() {
  if (!window.electronAPI || pythonInstallBusy.value) return

  pythonInstallBusy.value = true
  pythonInstallProgress.value = 0

  try {
    const result = await window.electronAPI.installEmbeddedPython()
    if (result.success) {
      pythonReady.value = true
      pythonNeedsInstall.value = false
      toast.success('Python 环境安装成功', { message: 'PDF 转 Word 功能已就绪' })
    } else {
      toast.error('Python 环境安装失败', { message: result.error || '请检查网络连接后重试' })
    }
  } catch (err: any) {
    toast.error('安装出错', { message: err.message || '未知错误' })
  } finally {
    pythonInstallBusy.value = false
    pythonInstallPhase.value = null
    pythonInstallProgress.value = 0
  }
}

// CAJ 安装阶段中文描述
const cajPhaseLabels: Record<string, string> = {
  'download-runtime': '正在安装 Python 运行时（CAJ 依赖）',
  'download-mupdf': '正在下载 CAJ 转换工具',
  'extracting-mupdf': '正在解压工具文件',
  'installing-caj2pdf': '正在安装 CAJ 转换组件',
  'verifying': '正在验证安装',
}

function getCajPhaseLabel(phase: string | null): string {
  if (!phase) return ''
  return cajPhaseLabels[phase] || '正在处理...'
}

function getCajPhaseDisplay(): string {
  const label = getCajPhaseLabel(cajInstallPhase.value)
  const retry = cajInstallRetryCount.value
  if (retry > 0) {
    return `${label}（网络波动，正在重试第 ${retry} 次...）`
  }
  if (retry === -1) {
    return `${label}（主源失败，正在切换备用源...）`
  }
  return label
}

async function onInstallCaj() {
  if (!window.electronAPI || cajInstallBusy.value) return

  cajInstallBusy.value = true
  cajInstallProgress.value = 0

  try {
    // 第一次尝试直接安装 CAJ（如果 Python 已存在则直接成功）
    let result = await window.electronAPI.installCajRuntime()

    // 如果失败原因是 Python 未安装，自动安装 Python 后重试
    if (!result.success && result.error && result.error.includes('Python 运行时未安装')) {
      toast.info('正在安装 Python 运行时', { message: 'CAJ 组件依赖 Python，正在自动安装...' })
      cajInstallPhase.value = 'download-runtime'
      cajInstallProgress.value = 0

      const pythonOk = await installPythonSilently()
      if (!pythonOk) {
        toast.error('Python 安装失败', { message: 'CAJ 组件安装已中止，请检查网络连接后重试' })
        return
      }

      toast.success('Python 安装完成', { message: '正在继续安装 CAJ 转换组件...' })
      cajInstallPhase.value = null
      cajInstallProgress.value = 0

      // Python 安装成功后重试 CAJ 安装
      result = await window.electronAPI.installCajRuntime()
    }

    if (result.success) {
      cajReady.value = true
      toast.success('CAJ 转换组件安装成功', { message: 'CAJ 转 PDF 功能已就绪' })
    } else {
      toast.error('CAJ 转换组件安装失败', { message: result.error || '请检查网络连接后重试' })
    }
  } catch (err: any) {
    toast.error('安装出错', { message: err.message || '未知错误' })
  } finally {
    cajInstallBusy.value = false
    cajInstallPhase.value = null
    cajInstallProgress.value = 0
  }
}

/**
 * 静默安装 Python 运行时（不显示独立的 Python 安装 UI，复用 CAJ 安装进度条）
 * @returns 安装是否成功
 */
async function installPythonSilently(): Promise<boolean> {
  if (!window.electronAPI) return false

  pythonInstallBusy.value = true
  pythonInstallProgress.value = 0

  try {
    const result = await window.electronAPI.installEmbeddedPython()
    if (result.success) {
      pythonReady.value = true
      pythonNeedsInstall.value = false
      return true
    }
    return false
  } catch {
    return false
  } finally {
    pythonInstallBusy.value = false
    pythonInstallPhase.value = null
    pythonInstallProgress.value = 0
  }
}

async function onCancelCajInstall() {
  await window.electronAPI?.cancelCajInstall()
  cajInstallBusy.value = false
  cajInstallPhase.value = null
  cajInstallProgress.value = 0
  toast.info('CAJ 安装已取消')
}

// ============================================================
// 自动更新检查
// ============================================================
async function onCheckUpdates() {
  if (!window.electronAPI?.checkForUpdates || updateChecking.value) return

  updateChecking.value = true
  updateInfo.value = null

  try {
    const result = await window.electronAPI.checkForUpdates()
    updateInfo.value = result

    if (result.hasUpdate) {
      toast.success('发现新版本', { message: `v${result.latestVersion} 已发布，点击下载` })
    } else {
      toast.info('已是最新版本', { message: `当前版本 v${result.currentVersion}` })
    }
  } catch (err: any) {
    toast.error('检查更新失败', { message: err.message || '请检查网络连接' })
  } finally {
    updateChecking.value = false
  }
}

async function onDownloadUpdate() {
  if (updateInfo.value?.downloadUrl) {
    await window.electronAPI?.openDownloadPage(updateInfo.value.downloadUrl)
  }
}

function onOpenFeedback() {
  const feedbackUrl = 'mailto:support@yizhuan.app?subject=易转反馈&body=请描述您遇到的问题或建议：\n\n版本：v0.6.0\n系统：Windows'
  window.electronAPI?.openDownloadPage?.(feedbackUrl)
}

function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', theme)
  window.electronAPI?.setNativeTheme?.(theme)
}

async function onThemeChange(e: Event) {
  const value = (e.target as HTMLSelectElement).value as 'light' | 'dark'
  appSettings.theme = value
  applyTheme(value)
  await saveAppSettings({ theme: value })
}

// ============================================================
// 批量转换完成回调
// ============================================================
function onBatchComplete(result: any) {
  // 将批量结果添加到历史记录
  let successCount = 0
  let failCount = 0
  for (const item of result.items) {
    if (item.status === 'success' || item.status === 'error') {
      addHistoryItem(
        item.filename,
        item.ext,
        item.outputPath.split('.').pop() || '',
        item.status === 'success' ? 'success' : 'error',
        item.message,
        item.status === 'success' ? item.outputPath : undefined
      )
      if (item.status === 'success') successCount++
      else failCount++
    }
  }

  // 批量转换完成 Toast 通知
  if (failCount === 0) {
    toast.success('批量转换完成', {
      message: `共 ${successCount} 个文件转换成功`,
      duration: 6000,
    })
  } else if (successCount === 0) {
    toast.error('批量转换失败', { message: `共 ${failCount} 个文件转换失败` })
  } else {
    toast.warning('批量转换部分完成', {
      message: `成功 ${successCount} 个，失败 ${failCount} 个`,
      duration: 6000,
    })
  }

  // 自动打开第一个成功文件的文件夹
  const firstSuccess = result.items.find((item: any) => item.status === 'success' && item.outputPath)
  if (firstSuccess?.outputPath && appSettings.autoOpenFolder) {
    window.electronAPI?.openFolder(firstSuccess.outputPath)
  }
}

// ============================================================
// OCR 保存（支持多格式：TXT / DOCX / XLSX / PDF）
// ============================================================
async function onOcrSave(format: OcrSaveFormat) {
  if (!window.electronAPI || !ocrResultText.value) return

  const formatFilterMap: Record<OcrSaveFormat, { name: string, ext: string }> = {
    'txt': { name: '文本文件', ext: 'txt' },
    'docx': { name: 'Word 文档', ext: 'docx' },
    'xlsx': { name: 'Excel 表格', ext: 'xlsx' },
    'pdf': { name: 'PDF 文件', ext: 'pdf' },
  }

  const filterInfo = formatFilterMap[format]
  const baseName = ocrFileName.value.split('.')[0] || 'OCR_Result'

  const outputPath = await window.electronAPI.showSaveDialog({
    defaultPath: `${baseName}_OCR.${filterInfo.ext}`,
    filters: [{ name: filterInfo.name, extensions: [filterInfo.ext] }]
  })

  if (outputPath) {
    const result = await window.electronAPI.ocrSaveMultiFormat({
      text: ocrResultText.value,
      imagePath: ocrImagePath.value,
      outputPath,
      format
    })
    if (result.success) {
      ocrModalVisible.value = false
      toast.success('OCR 结果已保存', { message: outputPath })
      // 自动打开文件夹
      if (appSettings.autoOpenFolder) {
        window.electronAPI?.openFolder(result.path || outputPath)
      }
    } else {
      toast.error('保存失败', { message: result.error || '未知错误' })
    }
  }
}
</script>

<template>
  <div class="app-wrapper">
    <TitleBar />
    <div class="app-body">
      <SidebarNav v-model:active-tab="activeTab" :is-pro="license.isPro()" />

      <main class="main-content">
        <div class="content-scroll">
      <header class="page-header">
        <h1>{{ activeTab === 'convert' ? '转换中心' : activeTab === 'batch' ? '批量转换' : activeTab === 'history' ? '历史记录' : activeTab === 'membership' ? '会员中心' : '设置' }}</h1>
        <p class="subtitle">简单高效的办公格式转换工具</p>
      </header>

      <template v-if="activeTab === 'convert'">
        <!-- Python 环境状态提示 -->
        <div v-if="pythonReady === false && !pythonInstallBusy" class="env-warning">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0L3.16 16.25A2 2 0 005 19z"/>
          </svg>
          <span>PDF 转换组件未安装，点击一键安装即可使用</span>
          <button class="env-install-btn" @click="onInstallPython">一键安装</button>
        </div>

        <!-- Python 安装进度 -->
        <div v-if="pythonInstallBusy" class="env-warning install-progress">
          <svg class="spin-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83"/>
          </svg>
          <div class="install-info">
            <span>{{ getPythonPhaseDisplay() || '正在安装...' }}</span>
            <div class="install-progress-bar">
              <div class="install-progress-fill" :style="{ width: pythonInstallProgress + '%' }"></div>
            </div>
          </div>
          <span class="install-pct">{{ pythonInstallProgress }}%</span>
        </div>

        <div v-if="libreOfficeReady === false" class="env-warning">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0L3.16 16.25A2 2 0 005 19z"/>
          </svg>
          <span>LibreOffice 未安装，Office 转 PDF 功能不可用</span>
          <a class="env-download-btn" href="https://www.libreoffice.org/download/download-libreoffice/" target="_blank" rel="noopener" @click.stop>下载 LibreOffice</a>
        </div>

        <!-- CAJ 环境状态提示 -->
        <div v-if="cajReady === false && !cajInstallBusy" class="env-warning">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0L3.16 16.25A2 2 0 005 19z"/>
          </svg>
          <span>CAJ 转换组件未安装，点击一键安装即可使用 CAJ 转 PDF</span>
          <button class="env-install-btn" @click="onInstallCaj">一键安装</button>
        </div>

        <!-- CAJ 安装进度 -->
        <div v-if="cajInstallBusy" class="env-warning install-progress">
          <svg class="spin-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83"/>
          </svg>
          <div class="install-info">
            <span>{{ getCajPhaseDisplay() || '正在安装...' }}</span>
            <div class="install-progress-bar">
              <div class="install-progress-fill" :style="{ width: cajInstallProgress + '%' }"></div>
            </div>
          </div>
          <span class="install-pct">{{ cajInstallProgress }}%</span>
          <button class="btn-secondary btn-sm" @click="onCancelCajInstall" style="margin-left: 8px;">取消</button>
        </div>

        <!-- 活跃任务列表 -->
        <section v-if="tasks.length > 0" class="active-tasks">
          <div class="tasks-header">
            <h2 class="section-title">转换任务 ({{ tasks.length }})</h2>
            <button class="clear-btn" @click="onClearTasks">清空</button>
          </div>
          <div class="task-list">
            <TaskCard
              v-for="task in tasks"
              :key="task.id"
              :task="task"
              @cancel="onCancelTask"
              @open="onOpenFile"
              @open-folder="onOpenFolder"
            />
          </div>
        </section>

        <DropZone @files-dropped="onFilesDropped" @paths-dropped="onPathsDropped" @folder-dropped="onFolderDropped" />
        <QuickEntry @quick-action="onQuickAction" />

        <!-- PDF 工具面板（合并/拆分） -->
        <PdfToolsPanel
          v-if="showPdfTools"
          :default-tab="pdfToolsDefaultTab"
          @close="showPdfTools = false"
          @complete="onPdfToolsComplete"
        />

        <!-- 图片压缩面板 -->
        <ImageCompressPanel
          v-if="showImageCompress"
          @close="showImageCompress = false"
          @complete="onImageCompressComplete"
        />

        <!-- PDF 转图片面板 -->
        <PdfToImagePanel
          v-if="activeToolPanel === 'pdf-to-image'"
          @close="activeToolPanel = null"
          @complete="onPdfToImageComplete"
        />

        <!-- HTML/MD 转 PDF 面板 -->
        <HtmlToPdfPanel
          v-if="activeToolPanel === 'html-to-pdf'"
          @close="activeToolPanel = null"
          @complete="onHtmlToPdfComplete"
        />

        <!-- 图片转 HTML/MD 面板 -->
        <ImageToHtmlPanel
          v-if="activeToolPanel === 'img-to-html'"
          @close="activeToolPanel = null"
          @complete="onImageToHtmlComplete"
        />
        <HistoryList
          :items="history"
          @open-file="onOpenFile"
          @clear-history="onClearHistory"
          @delete-item="onDeleteHistoryItem"
        />
      </template>

      <template v-else-if="activeTab === 'batch'">
        <BatchPanel
          :default-concurrency="appSettings.concurrency"
          :default-output-dir="appSettings.outputDir"
          @batch-complete="onBatchComplete"
        />
      </template>

      <template v-else-if="activeTab === 'history'">
        <HistoryList
          :items="history"
          :max-items="0"
          @open-file="onOpenFile"
          @clear-history="onClearHistory"
          @delete-item="onDeleteHistoryItem"
        />
      </template>

      <template v-else-if="activeTab === 'membership'">
        <MembershipPanel />
      </template>

      <template v-else-if="activeTab === 'stats'">
        <StatsPanel @close="activeTab = 'convert'" />
      </template>

      <template v-else-if="activeTab === 'settings'">
        <section class="settings-section">
          <h2 class="section-title">环境状态</h2>
          <div class="setting-item">
            <div class="setting-text">
              <span class="setting-label">PDF 转换组件 (Python + pdf2docx)</span>
              <span v-if="pythonInstallBusy" class="setting-desc">{{ getPythonPhaseDisplay() }} {{ pythonInstallProgress }}%</span>
            </div>
            <div class="setting-actions">
              <span class="status-tag" :class="pythonReady === null ? 'pending' : pythonReady ? 'ok' : 'fail'">
                {{ pythonReady === null ? '检测中...' : pythonReady ? '已就绪' : '未安装' }}
              </span>
              <button v-if="pythonReady === false && !pythonInstallBusy" class="btn-secondary" @click="onInstallPython">一键安装</button>
              <span v-if="pythonInstallBusy" class="status-tag pending">安装中...</span>
            </div>
          </div>
          <div class="setting-item">
            <div class="setting-text">
              <span class="setting-label">LibreOffice (Office→PDF)</span>
            </div>
            <div class="setting-actions">
              <span class="status-tag" :class="libreOfficeReady === null ? 'pending' : libreOfficeReady ? 'ok' : 'fail'">
                {{ libreOfficeReady === null ? '检测中...' : libreOfficeReady ? '已就绪' : '未安装' }}
              </span>
              <a v-if="libreOfficeReady === false" class="setting-link" href="https://www.libreoffice.org/download/download-libreoffice/" target="_blank" rel="noopener">下载</a>
            </div>
          </div>
          <div class="setting-item">
            <div class="setting-text">
              <span class="setting-label">CAJ 转换组件 (mutool + caj2pdf)</span>
              <span v-if="cajInstallBusy" class="setting-desc">{{ getCajPhaseDisplay() }} {{ cajInstallProgress }}%</span>
            </div>
            <div class="setting-actions">
              <span class="status-tag" :class="cajReady === null ? 'pending' : cajReady ? 'ok' : 'fail'">
                {{ cajReady === null ? '检测中...' : cajReady ? '已就绪' : '未安装' }}
              </span>
              <button v-if="cajReady === false && !cajInstallBusy" class="btn-secondary" @click="onInstallCaj">一键安装</button>
              <span v-if="cajInstallBusy" class="status-tag pending">安装中...</span>
            </div>
          </div>

          <h2 class="section-title">通用设置</h2>
          <div class="setting-item">
            <span>外观主题</span>
            <select class="select-input" :value="appSettings.theme" @change="onThemeChange">
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </div>
          <div class="setting-item">
            <div class="setting-text">
              <span class="setting-label">输出目录</span>
              <span class="setting-desc">{{ appSettings.outputDir || '默认保存到源文件同目录' }}</span>
            </div>
            <div class="setting-actions">
              <button v-if="appSettings.outputDir" class="btn-secondary btn-sm" @click="clearOutputDir">清除</button>
              <button class="btn-secondary" @click="selectOutputDir">选择文件夹</button>
            </div>
          </div>
          <div class="setting-item">
            <span>转换完成后打开文件夹</span>
            <label class="toggle">
              <input
                type="checkbox"
                :checked="appSettings.autoOpenFolder"
                @change="onAutoOpenFolderChange"
              >
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="setting-item flex-col">
            <div class="setting-row">
              <span>默认图片质量</span>
              <span class="quality-value">{{ appSettings.defaultImageQuality }}%</span>
            </div>
            <input
              type="range"
              min="50"
              max="100"
              :value="appSettings.defaultImageQuality"
              class="quality-slider"
              @change="onImageQualityChange"
            >
            <span class="setting-hint">仅对 JPG / WebP 格式有效，质量越低文件越小</span>
          </div>

          <h2 class="section-title">OCR 设置</h2>
          <div class="setting-item">
            <span>默认识别语言</span>
            <select class="select-input" :value="appSettings.ocrLang" @change="onOcrLangChange">
              <option value="chi_sim+eng">中文 + 英文</option>
              <option value="chi_sim">纯中文</option>
              <option value="eng">纯英文</option>
            </select>
          </div>

          <h2 class="section-title">批量转换</h2>
          <div class="setting-item flex-col">
            <div class="setting-row">
              <span>默认并发数</span>
              <span class="quality-value">{{ appSettings.concurrency }}</span>
            </div>
            <input
              type="range"
              min="1"
              max="6"
              :value="appSettings.concurrency"
              class="quality-slider"
              @change="onConcurrencyChange"
            >
            <span class="setting-hint">同时处理的文件数量，数值越大转换越快但占用资源越多</span>
          </div>

          <h2 class="section-title">系统集成</h2>
          <div class="setting-item context-menu-item">
            <div class="setting-text">
              <span class="setting-label">右键菜单集成</span>
              <span class="setting-desc">在文件右键菜单中添加"易转"快捷转换入口</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                :checked="contextMenuEnabled"
                :disabled="contextMenuBusy"
                @change="toggleContextMenu"
              >
              <span class="toggle-slider" :class="{ disabled: contextMenuBusy }"></span>
            </label>
          </div>
          <div v-if="contextMenuEnabled" class="context-menu-info">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            <span>右键点击 PDF/Word/图片文件，选择"易转"即可快速转换</span>
          </div>
          <div class="setting-item">
            <div class="setting-text">
              <span class="setting-label">转换完成通知</span>
              <span class="setting-desc">转换完成后弹出系统桌面通知提醒</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                :checked="appSettings.enableNotifications"
                @change="onNotificationsChange"
              >
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="setting-item">
            <div class="setting-text">
              <span class="setting-label">全局快捷键</span>
              <span class="setting-desc">Ctrl+Shift+Y 显示窗口 · Ctrl+Shift+S 截图 OCR</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                :checked="appSettings.enableGlobalShortcuts"
                @change="onGlobalShortcutsChange"
              >
              <span class="toggle-slider"></span>
            </label>
          </div>

          <h2 class="section-title">关于</h2>
          <div class="vip-card">
            <div class="vip-info">
              <strong>易转 v0.6.0</strong>
              <span>免费版 · 离线转换，安全无忧</span>
            </div>
            <button class="btn-primary" :disabled="updateChecking" @click="onCheckUpdates">
              {{ updateChecking ? '检查中...' : '检查更新' }}
            </button>
          </div>
          <div v-if="updateInfo" class="update-info" :class="{ 'has-update': updateInfo.hasUpdate }">
            <div v-if="updateInfo.hasUpdate" class="update-available">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              <div class="update-text">
                <span class="update-title">发现新版本 v{{ updateInfo.latestVersion }}</span>
                <span class="update-desc">当前版本 v{{ updateInfo.currentVersion }}，建议更新到最新版本</span>
              </div>
              <button class="btn-primary" @click="onDownloadUpdate">下载更新</button>
            </div>
            <div v-else class="update-latest">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
                <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
              <span>当前已是最新版本 v{{ updateInfo.currentVersion }}</span>
            </div>
          </div>

          <h2 class="section-title">反馈与支持</h2>
          <div class="feedback-card">
            <div class="feedback-info">
              <strong>遇到问题或有建议？</strong>
              <span>欢迎通过邮件联系我们，帮助我们做得更好</span>
            </div>
            <button class="btn-primary" @click="onOpenFeedback">发送反馈</button>
          </div>
        </section>
      </template>
    </div>
      </main>
    </div>
  </div>

  <!-- OCR 结果弹窗 -->
  <OcrResultModal
    :visible="ocrModalVisible"
    :text="ocrResultText"
    :file-name="ocrFileName"
    @close="ocrModalVisible = false"
    @save="(format: OcrSaveFormat) => onOcrSave(format)"
  />

  <!-- 格式选择弹窗 -->
  <FormatSelectModal
    :visible="formatModalVisible"
    :files="pendingFiles"
    :output-dir="appSettings.outputDir"
    @close="formatModalVisible = false"
    @confirm="onFormatConfirm"
  />

  <!-- Toast 通知容器 -->
  <ToastContainer />

  <!-- 特惠弹窗 -->
  <PromoPopup @go-to-membership="activeTab = 'membership'" />
</template>

<style scoped>
.app-wrapper {
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}

.app-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}

.content-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 28px 32px 60px;
  max-width: 800px;
  width: 100%;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 24px;
}

.page-header h1 {
  font-size: 22px;
  font-weight: 700;
  color: var(--ink);
  margin-bottom: 4px;
}

.subtitle {
  font-size: 13px;
  color: var(--muted);
}

.env-warning {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  background: var(--warning-bg);
  border: 1px solid var(--warning-border);
  border-radius: var(--radius-sm);
  margin-bottom: 20px;
  font-size: 13px;
  color: var(--warning-text);
}

.env-warning svg {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.env-warning span {
  flex: 1;
}

.env-download-btn {
  display: inline-flex;
  align-items: center;
  padding: 4px 12px;
  background: var(--warning-bg);
  border: 1px solid var(--warning-border);
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--warning-text);
  text-decoration: none;
  cursor: pointer;
  transition: all 0.2s;
  flex-shrink: 0;
}

.env-download-btn:hover {
  background: rgba(245, 158, 11, 0.2);
  border-color: rgba(245, 158, 11, 0.6);
}

.env-install-btn {
  display: inline-flex;
  align-items: center;
  padding: 5px 14px;
  background: var(--primary);
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  color: white;
  cursor: pointer;
  transition: all 0.2s;
  flex-shrink: 0;
}

.env-install-btn:hover {
  background: var(--primary-light);
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(79, 70, 229, 0.25);
}

.install-progress {
  align-items: center;
  gap: 12px;
}

.install-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.install-progress-bar {
  width: 100%;
  height: 6px;
  background: var(--warning-bg);
  border-radius: 3px;
  overflow: hidden;
}

.install-progress-fill {
  height: 100%;
  background: var(--primary);
  border-radius: 3px;
  transition: width 0.3s ease;
}

.install-pct {
  font-size: 13px;
  font-weight: 600;
  color: var(--primary);
  flex-shrink: 0;
  min-width: 36px;
  text-align: right;
}

.spin-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  animation: spin 1.2s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.setting-link {
  display: inline-flex;
  align-items: center;
  padding: 3px 10px;
  background: var(--primary-light, rgba(59, 130, 246, 0.1));
  border: 1px solid var(--primary, rgba(59, 130, 246, 0.3));
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--primary, #3b82f6);
  text-decoration: none;
  cursor: pointer;
  transition: all 0.2s;
}

.setting-link:hover {
  background: var(--primary, rgba(59, 130, 246, 0.18));
}

.active-tasks {
  margin-bottom: 24px;
}

.tasks-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--ink);
}

.clear-btn {
  font-size: 12px;
  color: var(--muted);
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}

.clear-btn:hover {
  color: var(--danger);
  background: rgba(239, 68, 68, 0.06);
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.setting-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 14px;
}

.status-tag {
  padding: 3px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
}

.status-tag.ok {
  background: rgba(16, 185, 129, 0.1);
  color: var(--success);
}

.status-tag.fail {
  background: rgba(239, 68, 68, 0.1);
  color: var(--danger);
}

.status-tag.pending {
  background: var(--bg);
  color: var(--muted);
}

.btn-secondary {
  padding: 6px 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  color: var(--ink);
  transition: all 0.2s;
}

.btn-secondary:hover {
  border-color: var(--primary-light);
  color: var(--primary);
}

.toggle {
  position: relative;
  width: 40px;
  height: 22px;
  cursor: pointer;
}

.toggle input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--border);
  border-radius: 22px;
  transition: 0.25s;
}

.toggle-slider::before {
  content: '';
  position: absolute;
  height: 18px;
  width: 18px;
  left: 2px;
  bottom: 2px;
  background: var(--surface);
  border-radius: 50%;
  transition: 0.25s;
  box-shadow: 0 1px 3px rgba(0,0,0,0.15);
}

.toggle input:checked + .toggle-slider {
  background: var(--primary);
}

.toggle input:checked + .toggle-slider::before {
  transform: translateX(18px);
}

.vip-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  background: linear-gradient(135deg, rgba(79,70,229,0.06), rgba(6,182,212,0.06));
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.vip-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.vip-info strong {
  font-size: 15px;
  color: var(--ink);
}

.vip-info span {
  font-size: 13px;
  color: var(--muted);
}

.btn-primary {
  padding: 8px 18px;
  background: var(--primary);
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-primary:hover {
  background: var(--primary-light);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(79, 70, 229, 0.25);
}

/* 右键菜单集成设置项 */
.context-menu-item {
  align-items: flex-start;
  padding: 16px;
}

.setting-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}

.setting-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--ink);
}

.setting-desc {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}

.toggle-slider.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.context-menu-tip {
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  margin-top: -4px;
  animation: tipFadeIn 0.25s ease;
}

.context-menu-tip.success {
  background: rgba(16, 185, 129, 0.08);
  color: var(--success);
  border: 1px solid rgba(16, 185, 129, 0.2);
}

.context-menu-tip.error {
  background: rgba(239, 68, 68, 0.08);
  color: var(--danger);
  border: 1px solid rgba(239, 68, 68, 0.2);
}

.context-menu-info {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: rgba(79, 70, 229, 0.05);
  border: 1px solid rgba(79, 70, 229, 0.15);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--primary);
  margin-top: -4px;
}

.context-menu-info svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

@keyframes tipFadeIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 设置页面新增样式 */
.setting-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}

.setting-item.flex-col {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}

.setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.quality-value {
  font-size: 14px;
  font-weight: 600;
  color: var(--primary);
}

.quality-slider {
  width: 100%;
  height: 6px;
  -webkit-appearance: none;
  appearance: none;
  background: var(--bg);
  border-radius: 3px;
  outline: none;
  cursor: pointer;
}

.quality-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  background: var(--primary);
  border-radius: 50%;
  cursor: pointer;
  border: 2px solid var(--surface);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
}

.setting-hint {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.4;
}

.select-input {
  padding: 6px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  color: var(--ink);
  cursor: pointer;
  outline: none;
  transition: all 0.2s;
}

.select-input:hover {
  border-color: var(--primary-light);
}

.select-input:focus {
  border-color: var(--primary);
}

/* 更新信息 */
.update-info {
  margin-top: 12px;
  padding: 14px 16px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface);
}

.update-info.has-update {
  border-color: rgba(16, 185, 129, 0.3);
  background: rgba(16, 185, 129, 0.04);
}

.update-available {
  display: flex;
  align-items: center;
  gap: 12px;
}

.update-available svg {
  color: var(--success);
  flex-shrink: 0;
}

.update-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.update-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--success);
}

.update-desc {
  font-size: 12px;
  color: var(--muted);
}

.update-latest {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--success);
}

.update-latest svg {
  flex-shrink: 0;
}

/* ==================== 反馈入口 ==================== */
.feedback-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.feedback-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.feedback-info strong {
  font-size: 14px;
  color: var(--ink);
}

.feedback-info span {
  font-size: 12px;
  color: var(--muted);
}
</style>
