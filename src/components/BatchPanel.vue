<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import type { BatchFileItem, BatchConversionType, BatchProgress, BatchResult } from '../types/electron'
import { useToast } from '../composables/useToast'
import { checkBatchCount, useLicense, showReferralIfEligible } from '../composables/useLicense'

const toast = useToast()
const license = useLicense()

const props = withDefaults(defineProps<{
  defaultConcurrency?: number
  defaultOutputDir?: string
}>(), {
  defaultConcurrency: 3,
  defaultOutputDir: '',
})

const emit = defineEmits<{
  (e: 'batch-complete', result: BatchResult): void
}>()

// ============================================================
// 状态
// ============================================================

const batchType = ref<BatchConversionType>('img2jpg')
const fileItems = reactive<BatchFileItem[]>([])
const isScanning = ref(false)
const isConverting = ref(false)
const overallProgress = ref(0)
const currentFileName = ref('')
const batchResult = ref<BatchResult | null>(null)
const outputDir = ref<string>(props.defaultOutputDir)
const overwrite = ref(false)
const concurrency = ref(props.defaultConcurrency)
const errorMessage = ref('')
const currentTaskId = ref<string>('')
const imageQuality = ref(90) // 图片质量 1-100，仅图片转换类型显示
const isDragOver = ref(false) // 拖拽状态

// 非会员图片质量上限 85%，会员可使用 100%
const maxImageQuality = computed(() => license.isPro() ? 100 : 85)
const imageQualityLabel = computed(() => {
  if (!license.isPro() && imageQuality.value >= 85) return `${imageQuality.value}% (非会员上限)`
  return `${imageQuality.value}%`
})

// 非会员质量超限时自动钳制
watch(maxImageQuality, (maxVal) => {
  if (imageQuality.value > maxVal) {
    imageQuality.value = maxVal
  }
})

let removeProgressListener: (() => void) | null = null

onMounted(() => {
  if (window.electronAPI?.onBatchProgress) {
    removeProgressListener = window.electronAPI.onBatchProgress((data: BatchProgress) => {
      overallProgress.value = data.overallProgress
      currentFileName.value = data.filename

      // 更新对应文件项的状态
      const item = fileItems.find(f => f.filename === data.filename)
      if (item) {
        item.status = data.itemStatus
      }
    })
  }
})

onUnmounted(() => {
  removeProgressListener?.()
})

// ============================================================
// 转换类型选项
// ============================================================

const typeOptions = [
  { value: 'img2jpg' as BatchConversionType, label: '图片转 JPG', desc: 'PNG/BMP/WebP → JPG', icon: 'jpg', color: '#f59e0b' },
  { value: 'img2png' as BatchConversionType, label: '图片转 PNG', desc: 'JPG/BMP/WebP → PNG', icon: 'png', color: '#10b981' },
  { value: 'img2webp' as BatchConversionType, label: '图片转 WebP', desc: 'JPG/PNG/BMP → WebP', icon: 'webp', color: '#06b6d4' },
  { value: 'heic2jpg' as BatchConversionType, label: 'HEIC 转 JPG', desc: 'iPhone 照片 → JPG', icon: 'heic', color: '#8b5cf6' },
  { value: 'ocr' as BatchConversionType, label: '批量 OCR', desc: '图片 → 文字 TXT', icon: 'ocr', color: '#ec4899' },
  { value: 'pdf2docx' as BatchConversionType, label: 'PDF 转 Word', desc: 'PDF → DOCX', icon: 'pdf', color: '#ef4444' },
  { value: 'docx2pdf' as BatchConversionType, label: 'Word 转 PDF', desc: 'DOCX → PDF', icon: 'docx', color: '#4f46e5' },
]

// ============================================================
// 文件选择
// ============================================================

async function onSelectFiles() {
  if (!window.electronAPI) return
  errorMessage.value = ''

  const typeConfig = typeOptions.find(t => t.value === batchType.value)
  const extMap: Record<string, string[]> = {
    'img2jpg': ['png', 'bmp', 'webp', 'tiff', 'gif'],
    'img2png': ['jpg', 'jpeg', 'bmp', 'webp', 'tiff', 'gif'],
    'img2webp': ['png', 'jpg', 'jpeg', 'bmp', 'tiff', 'gif'],
    'heic2jpg': ['heic', 'heif'],
    'ocr': ['png', 'jpg', 'jpeg', 'bmp', 'webp'],
    'pdf2docx': ['pdf'],
    'docx2pdf': ['docx', 'doc'],
  }
  const exts = extMap[batchType.value] || ['*']

  const paths = await window.electronAPI.selectFiles({
    filters: [{ name: '可转换文件', extensions: exts }],
    multi: true
  })

  if (paths.length === 0) return

  isScanning.value = true
  const result = await window.electronAPI.buildBatchItems({
    filePaths: paths,
    type: batchType.value,
    outputDir: outputDir.value || undefined
  })
  isScanning.value = false

  if (result.success) {
    // 合并新文件，去重
    const existingPaths = new Set(fileItems.map(f => f.inputPath))
    let addedCount = 0
    for (const item of result.items) {
      if (!existingPaths.has(item.inputPath)) {
        fileItems.push(item)
        addedCount++
      }
    }
    // 添加新文件后重置结果状态，以便显示"开始转换"按钮
    if (addedCount > 0) {
      batchResult.value = null
      overallProgress.value = 0
    }
  }
}

async function onSelectFolder() {
  if (!window.electronAPI) return
  errorMessage.value = ''

  const folder = await window.electronAPI.selectFolder()
  if (!folder) return

  isScanning.value = true
  const result = await window.electronAPI.scanFolder({
    folderPath: folder,
    type: batchType.value,
    recursive: true
  })
  isScanning.value = false

  if (result.success) {
    const existingPaths = new Set(fileItems.map(f => f.inputPath))
    let addedCount = 0
    for (const item of result.items) {
      if (!existingPaths.has(item.inputPath)) {
        fileItems.push(item)
        addedCount++
      }
    }
    // 添加新文件后重置结果状态，以便显示"开始转换"按钮
    if (addedCount > 0) {
      batchResult.value = null
      overallProgress.value = 0
    }
  } else {
    errorMessage.value = result.error || '扫描文件夹失败'
  }
}

async function onSelectOutputDir() {
  if (!window.electronAPI) return
  const folder = await window.electronAPI.selectFolder()
  if (folder) {
    outputDir.value = folder
    // 更新所有文件项的输出路径
    for (const item of fileItems) {
      const baseName = item.filename.replace(/\.\w+$/, '')
      const outputExt = item.outputPath.split('.').pop()
      const suffix = baseName.endsWith('_易转') ? '' : '_易转'
      item.outputPath = `${folder}\\${baseName}${suffix}.${outputExt}`
    }
  }
}

// ============================================================
// 文件列表操作
// ============================================================

function removeItem(index: number) {
  fileItems.splice(index, 1)
}

function clearAll() {
  fileItems.length = 0
  batchResult.value = null
  overallProgress.value = 0
}

// ============================================================
// 拖拽支持
// ============================================================

/** 判断当前转换类型是否为图片类 */
const isImageType = computed(() => {
  return ['img2jpg', 'img2png', 'img2webp', 'heic2jpg'].includes(batchType.value)
})

/** 格式 → 推荐转换类型 映射 */
const FORMAT_TO_TYPE: Record<string, BatchConversionType> = {
  'pdf': 'pdf2docx',
  'docx': 'docx2pdf',
  'doc': 'docx2pdf',
  'jpg': 'img2png',
  'jpeg': 'img2png',
  'png': 'img2jpg',
  'bmp': 'img2png',
  'webp': 'img2jpg',
  'tiff': 'img2png',
  'gif': 'img2png',
  'heic': 'heic2jpg',
  'heif': 'heic2jpg',
}

/** 各类型支持的输入格式 */
const TYPE_INPUT_EXTS: Record<string, string[]> = {
  'img2jpg': ['.png', '.bmp', '.webp', '.tiff', '.gif'],
  'img2png': ['.jpg', '.jpeg', '.bmp', '.webp', '.tiff', '.gif'],
  'img2webp': ['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.gif'],
  'heic2jpg': ['.heic', '.heif'],
  'ocr': ['.png', '.jpg', '.jpeg', '.bmp', '.webp'],
  'pdf2docx': ['.pdf'],
  'docx2pdf': ['.docx', '.doc'],
}

/** 获取拖拽文件的本地路径（带回退机制） */
function getFilePath(file: File): string {
  if (window.electronAPI?.getFilePathForFile) {
    try {
      const path = window.electronAPI.getFilePathForFile(file)
      if (path) return path
    } catch { /* ignore */ }
  }
  return (file as any).path || ''
}

/** 获取文件扩展名（小写，含点） */
function getExt(path: string): string {
  const idx = path.lastIndexOf('.')
  if (idx < 0) return ''
  return path.substring(idx).toLowerCase()
}

/** 拖拽进入 */
function onDragOver(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  if (!isConverting.value) {
    isDragOver.value = true
  }
}

/** 拖拽离开 */
function onDragLeave(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  isDragOver.value = false
}

/** 将扫描到的文件添加到列表（去重） */
function mergeItems(newItems: any[]): number {
  const existingPaths = new Set(fileItems.map(f => f.inputPath))
  let addedCount = 0
  for (const item of newItems) {
    if (!existingPaths.has(item.inputPath)) {
      fileItems.push(item)
      addedCount++
    }
  }
  if (addedCount > 0) {
    batchResult.value = null
    overallProgress.value = 0
  }
  return addedCount
}

/** 拖拽放下 — 添加文件到列表 */
async function onDrop(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  isDragOver.value = false
  if (!window.electronAPI || isConverting.value) return

  const files = e.dataTransfer?.files
  if (!files || files.length === 0) {
    toast.error('拖拽失败', { message: '未检测到文件，请重试' })
    return
  }

  // 获取文件路径，并检测文件夹
  const filePaths: string[] = []
  const folderPaths: string[] = []

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const filePath = getFilePath(file)
    if (!filePath) continue

    // 文件夹检测：Electron 中拖拽文件夹时 File.type 为空且 size 为 0
    const ext = getExt(filePath)
    if (!ext && file.size === 0) {
      folderPaths.push(filePath)
    } else {
      filePaths.push(filePath)
    }
  }

  // 1. 处理文件夹：扫描文件夹内匹配的文件
  if (folderPaths.length > 0) {
    isScanning.value = true
    try {
      let totalAdded = 0
      for (const folder of folderPaths) {
        const result = await window.electronAPI.scanFolder({
          folderPath: folder,
          type: batchType.value,
          recursive: true
        })
        if (result.success && result.items.length > 0) {
          totalAdded += mergeItems(result.items)
        }
      }
      isScanning.value = false
      if (totalAdded > 0) {
        toast.success(`已添加 ${totalAdded} 个文件`)
      } else {
        toast.warning('文件夹中无可转换文件', { message: `请确保文件夹中包含"${typeOptions.find(t => t.value === batchType.value)?.label}"支持的格式` })
      }
    } catch (err: any) {
      isScanning.value = false
      toast.error('扫描文件夹失败', { message: err.message || '未知错误' })
    }
  }

  // 2. 处理文件：构建批量任务项
  if (filePaths.length === 0) return

  // 先检查格式是否匹配当前类型
  const validExts = TYPE_INPUT_EXTS[batchType.value] || []
  const matchedFiles: string[] = []
  const unmatchedFiles: string[] = []

  for (const p of filePaths) {
    const ext = getExt(p)
    if (validExts.includes(ext)) {
      matchedFiles.push(p)
    } else {
      unmatchedFiles.push(p)
    }
  }

  // 如果有格式不匹配的文件，尝试自动切换类型
  if (matchedFiles.length === 0 && unmatchedFiles.length > 0) {
    // 检测拖入文件的实际格式，推荐切换类型
    const firstExt = getExt(unmatchedFiles[0]).substring(1) // 去掉点
    const recommendedType = FORMAT_TO_TYPE[firstExt]
    if (recommendedType && recommendedType !== batchType.value) {
      const recommendedLabel = typeOptions.find(t => t.value === recommendedType)?.label
      toast.warning('格式不匹配', { message: `当前类型不支持 ${firstExt.toUpperCase()} 格式，已自动切换到"${recommendedLabel}"` })
      batchType.value = recommendedType
      // 切换后重新匹配
      const newValidExts = TYPE_INPUT_EXTS[recommendedType] || []
      for (const p of unmatchedFiles) {
        if (newValidExts.includes(getExt(p))) {
          matchedFiles.push(p)
        }
      }
    }
  }

  if (matchedFiles.length === 0) {
    if (unmatchedFiles.length > 0) {
      const currentLabel = typeOptions.find(t => t.value === batchType.value)?.label
      const firstExt = getExt(unmatchedFiles[0]).substring(1).toUpperCase()
      toast.warning('格式不匹配', { message: `"${currentLabel}"不支持 ${firstExt} 格式，请选择对应的转换类型` })
    }
    return
  }

  isScanning.value = true
  try {
    const result = await window.electronAPI.buildBatchItems({
      filePaths: matchedFiles,
      type: batchType.value,
      outputDir: outputDir.value || undefined,
    })
    isScanning.value = false

    if (result.success) {
      if (result.items.length === 0) {
        toast.warning('未找到可转换的文件', { message: '请检查文件格式是否匹配' })
        return
      }
      const addedCount = mergeItems(result.items)
      if (addedCount > 0) {
        toast.success(`已添加 ${addedCount} 个文件`)
      } else {
        toast.info('文件已存在', { message: '选中的文件已在列表中' })
      }
    } else {
      toast.error('添加文件失败', { message: result.error || '未知错误' })
    }
  } catch (err: any) {
    isScanning.value = false
    toast.error('添加文件失败', { message: err.message || '未知错误' })
  }
}

// ============================================================
// 执行批量转换
// ============================================================

async function startBatch() {
  if (fileItems.length === 0 || isConverting.value) return
  if (!window.electronAPI) return

  // 批量转换数量限制检查
  const countCheck = checkBatchCount(fileItems.length)
  if (!countCheck.allowed) {
    showReferralIfEligible()
    toast.error('批量转换数量超限', { message: countCheck.message })
    return
  }

  errorMessage.value = ''
  batchResult.value = null
  isConverting.value = true
  overallProgress.value = 0

  // 重置待转换项的状态（保留已成功项不再重试）
  for (const item of fileItems) {
    if (item.status !== 'success') {
      item.status = 'pending'
      item.message = undefined
    }
  }

  // 只转换非成功的文件
  const itemsToConvert = fileItems.filter(f => f.status === 'pending')

  const taskId = `batch_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
  currentTaskId.value = taskId

  try {
    const result = await window.electronAPI.batchConvert({
      taskId,
      items: JSON.parse(JSON.stringify(itemsToConvert)),
      options: {
        type: batchType.value,
        outputDir: outputDir.value || undefined,
        concurrency: concurrency.value,
        overwrite: overwrite.value,
        quality: isImageType.value ? imageQuality.value : undefined,
      }
    })

    batchResult.value = result

    // 用最终结果更新文件列表状态
    for (let i = 0; i < itemsToConvert.length; i++) {
      if (result.items[i]) {
        itemsToConvert[i].status = result.items[i].status
        itemsToConvert[i].message = result.items[i].message
        itemsToConvert[i].size = result.items[i].size
      }
    }

    overallProgress.value = 100
    emit('batch-complete', result)
  } catch (err: any) {
    errorMessage.value = err.message || '批量转换失败'
  } finally {
    isConverting.value = false
  }
}

async function cancelBatch() {
  if (!window.electronAPI || !isConverting.value || !currentTaskId.value) return
  await window.electronAPI.batchCancel(currentTaskId.value)
  isConverting.value = false
  // 标记所有未完成项为已取消
  for (const item of fileItems) {
    if (item.status === 'pending' || item.status === 'processing') {
      item.status = 'cancelled'
      item.message = '已取消'
    }
  }
}

// ============================================================
// 工具函数
// ============================================================

const statusCount = computed(() => {
  let success = 0, failed = 0, pending = 0, skipped = 0, processing = 0
  for (const item of fileItems) {
    if (item.status === 'success') success++
    else if (item.status === 'error') failed++
    else if (item.status === 'processing') processing++
    else if (item.status === 'skipped') skipped++
    else pending++
  }
  return { success, failed, pending, skipped, processing, total: fileItems.length }
})

function formatSize(bytes?: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}秒`
  return `${Math.floor(ms / 60000)}分${Math.round((ms % 60000) / 1000)}秒`
}

function statusColor(status: string): string {
  const map: Record<string, string> = {
    'success': '#10b981',
    'error': '#ef4444',
    'processing': '#4f46e5',
    'pending': '#94a3b8',
    'skipped': '#f59e0b',
    'cancelled': '#6b7280',
  }
  return map[status] || '#94a3b8'
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    'success': '成功',
    'error': '失败',
    'processing': '转换中',
    'pending': '等待中',
    'skipped': '已跳过',
    'cancelled': '已取消',
  }
  return map[status] || '未知'
}
</script>

<template>
  <section class="batch-panel">
    <div class="section-header">
      <h2 class="section-title">批量转换</h2>
      <div class="header-actions">
        <button
          v-if="fileItems.length > 0 && !isConverting"
          class="btn btn-primary btn-start-header"
          @click="startBatch"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M5 3l14 9-14 9V3z"/></svg>
          开始批量转换
        </button>
        <button
          v-if="isConverting"
          class="btn-cancel-header"
          @click="cancelBatch"
        >
          取消转换
        </button>
      </div>
    </div>

    <!-- 转换类型选择 -->
    <div class="type-selector">
      <button
        v-for="opt in typeOptions"
        :key="opt.value"
        class="type-card"
        :class="{ active: batchType === opt.value }"
        @click="batchType = opt.value"
      >
        <div class="type-dot" :style="{ background: opt.color }"></div>
        <div class="type-info">
          <span class="type-label">{{ opt.label }}</span>
          <span class="type-desc">{{ opt.desc }}</span>
        </div>
      </button>
    </div>

    <!-- 操作栏 -->
    <div class="action-bar">
      <button class="btn-action" @click="onSelectFiles" :disabled="isConverting">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>
        添加文件
      </button>
      <button class="btn-action" @click="onSelectFolder" :disabled="isConverting">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>
        扫描文件夹
      </button>
      <div class="spacer"></div>
      <button v-if="fileItems.length > 0" class="btn-clear" @click="clearAll" :disabled="isConverting">
        清空列表
      </button>
    </div>

    <!-- 输出设置 -->
    <div class="output-settings">
      <div class="setting-row" v-if="isImageType">
        <span class="setting-name">图片质量</span>
        <div class="quality-control">
          <input
            type="range"
            min="10"
            :max="maxImageQuality"
            v-model.number="imageQuality"
            class="quality-slider"
            :disabled="isConverting"
          >
          <span class="quality-value">{{ imageQualityLabel }}</span>
          <span v-if="!license.isPro()" class="quality-hint">会员可解锁 100% 最高清</span>
        </div>
      </div>
      <div class="setting-row">
        <span class="setting-name">输出目录</span>
        <button class="btn-output" @click="onSelectOutputDir" :disabled="isConverting">
          {{ outputDir ? outputDir : '同源目录（默认）' }}
        </button>
      </div>
      <div class="setting-row">
        <span class="setting-name">并发数</span>
        <select v-model="concurrency" class="concurrency-select" :disabled="isConverting">
          <option :value="1">1（低速）</option>
          <option :value="2">2</option>
          <option :value="3">3（推荐）</option>
          <option :value="5">5</option>
          <option :value="8">8（高速）</option>
        </select>
      </div>
      <div class="setting-row">
        <span class="setting-name">覆盖已存在文件</span>
        <label class="toggle">
          <input type="checkbox" v-model="overwrite" :disabled="isConverting">
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <!-- 错误提示 -->
    <div v-if="errorMessage" class="error-banner">
      {{ errorMessage }}
    </div>

    <!-- 文件列表 -->
    <div
      v-if="fileItems.length > 0"
      class="file-list-section"
      :class="{ 'drag-active': isDragOver }"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <div class="list-header">
        <span class="list-title">文件列表 ({{ fileItems.length }})</span>
        <div v-if="isConverting || batchResult" class="progress-info">
          <span v-if="isConverting">{{ overallProgress }}% · {{ currentFileName }}</span>
        </div>
      </div>

      <!-- 总进度条 -->
      <div v-if="isConverting" class="overall-progress">
        <div class="progress-track">
          <div class="progress-fill" :style="{ width: overallProgress + '%' }"></div>
        </div>
      </div>

      <!-- 文件项列表 -->
      <div class="file-list">
        <div
          v-for="(item, index) in fileItems"
          :key="item.inputPath"
          class="file-item"
        >
          <div class="file-status-dot" :style="{ background: statusColor(item.status) }"></div>
          <div class="file-info">
            <span class="file-name" :title="item.inputPath">{{ item.filename }}</span>
            <span class="file-detail">
              <span class="file-ext">{{ item.ext.toUpperCase() }}</span>
              <span v-if="item.size" class="file-size">{{ formatSize(item.size) }}</span>
              <span v-if="item.message" class="file-msg" :style="{ color: statusColor(item.status) }">{{ item.message }}</span>
            </span>
          </div>
          <span class="file-status-text" :style="{ color: statusColor(item.status) }">
            {{ statusLabel(item.status) }}
          </span>
          <button
            v-if="!isConverting"
            class="file-remove"
            @click="removeItem(index)"
            title="移除"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
      </div>

      <!-- 汇总报告 -->
      <div v-if="batchResult" class="summary-report">
        <div class="summary-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          <span>批量转换完成</span>
        </div>
        <div class="summary-stats">
          <div class="stat-item success">
            <span class="stat-num">{{ batchResult.success }}</span>
            <span class="stat-label">成功</span>
          </div>
          <div class="stat-item failed">
            <span class="stat-num">{{ batchResult.failed }}</span>
            <span class="stat-label">失败</span>
          </div>
          <div v-if="batchResult.skipped > 0" class="stat-item skipped">
            <span class="stat-num">{{ batchResult.skipped }}</span>
            <span class="stat-label">跳过</span>
          </div>
          <div class="stat-item duration">
            <span class="stat-num">{{ formatDuration(batchResult.duration) }}</span>
            <span class="stat-label">耗时</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 空状态（支持拖拽） -->
    <div
      v-else-if="!isScanning"
      class="empty-batch"
      :class="{ 'drag-active': isDragOver }"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
      </svg>
      <p>选择转换类型后，添加文件或扫描文件夹开始批量转换</p>
      <p class="drag-hint">也可以直接拖拽文件到此处</p>
    </div>
  </section>
</template>

<style scoped>
.batch-panel {
  margin-bottom: 24px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 14px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 18px;
  border-radius: var(--radius-sm, 8px);
  font-size: 14px;
  font-weight: 500;
  border: none;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-primary {
  background: var(--accent, #7c5cf2);
  color: #fff;
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-start-header {
  padding: 6px 16px;
  font-size: 13px;
  white-space: nowrap;
}

.btn-start-header:hover:not(:disabled) {
  opacity: 0.9;
}

.btn-cancel-header {
  padding: 6px 16px;
  background: var(--danger);
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.btn-cancel-header:hover {
  opacity: 0.9;
}

/* 转换类型选择 */
.type-selector {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 16px;
}

.type-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.2s;
  text-align: left;
}

.type-card:hover {
  border-color: var(--primary-light);
}

.type-card.active {
  border-color: var(--primary);
  background: rgba(79, 70, 229, 0.04);
  box-shadow: 0 0 0 1px var(--primary);
}

.type-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.type-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.type-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}

.type-desc {
  font-size: 11px;
  color: var(--muted);
}

/* 操作栏 */
.action-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.spacer {
  flex: 1;
}

.btn-action {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
  color: var(--ink);
  cursor: pointer;
  transition: all 0.2s;
}

.btn-action:hover:not(:disabled) {
  border-color: var(--primary-light);
  color: var(--primary);
  background: rgba(79, 70, 229, 0.03);
}

.btn-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-action svg {
  width: 16px;
  height: 16px;
}

.btn-clear {
  font-size: 12px;
  color: var(--muted);
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 8px;
}

.btn-clear:hover:not(:disabled) {
  color: var(--danger);
}

.btn-clear:disabled {
  opacity: 0.5;
}

/* 输出设置 */
.output-settings {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  margin-bottom: 14px;
}

.setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}

.setting-name {
  color: var(--muted);
}

.btn-output {
  font-size: 12px;
  color: var(--primary);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 12px;
  cursor: pointer;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn-output:hover:not(:disabled) {
  border-color: var(--primary-light);
}

.btn-output:disabled {
  opacity: 0.5;
}

.concurrency-select {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
  background: var(--bg);
  color: var(--ink);
  cursor: pointer;
}

.concurrency-select:disabled {
  opacity: 0.5;
}

/* Toggle 开关 */
.toggle {
  position: relative;
  width: 36px;
  height: 20px;
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
  border-radius: 20px;
  transition: 0.25s;
}

.toggle-slider::before {
  content: '';
  position: absolute;
  height: 16px;
  width: 16px;
  left: 2px;
  bottom: 2px;
  background: var(--surface);
  border-radius: 50%;
  transition: 0.25s;
}

.toggle input:checked + .toggle-slider {
  background: var(--primary);
}

.toggle input:checked + .toggle-slider::before {
  transform: translateX(16px);
}

.toggle input:disabled + .toggle-slider {
  opacity: 0.5;
}

/* 图片质量滑块 */
.quality-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.quality-slider {
  width: 120px;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: var(--border);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}

.quality-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  background: var(--primary);
  border-radius: 50%;
  cursor: pointer;
  transition: transform 0.2s;
}

.quality-slider::-webkit-slider-thumb:hover {
  transform: scale(1.2);
}

.quality-slider:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.quality-value {
  font-size: 12px;
  font-weight: 600;
  color: var(--primary);
  min-width: 36px;
  text-align: right;
}

.quality-hint {
  font-size: 11px;
  color: #f59e0b;
  margin-left: 8px;
  white-space: nowrap;
}

/* 拖拽高亮 */
.drag-active {
  border: 2px dashed var(--primary) !important;
  background: rgba(79, 70, 229, 0.04) !important;
  border-radius: var(--radius-sm);
}

.empty-batch.drag-active {
  border-color: var(--primary) !important;
  background: rgba(79, 70, 229, 0.06) !important;
  color: var(--primary);
}

.drag-hint {
  font-size: 12px;
  color: var(--primary);
  margin-top: 4px;
  opacity: 0.8;
}

/* 错误提示 */
.error-banner {
  padding: 10px 14px;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--danger);
  margin-bottom: 14px;
}

/* 文件列表 */
.file-list-section {
  margin-top: 16px;
}

.list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.list-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
}

.progress-info {
  font-size: 12px;
  color: var(--primary);
}

/* 总进度条 */
.overall-progress {
  margin-bottom: 12px;
}

.progress-track {
  height: 6px;
  background: var(--bg);
  border-radius: 3px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--primary), var(--secondary));
  border-radius: 3px;
  transition: width 0.3s ease;
}

/* 文件项 */
.file-list {
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 4px;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  transition: all 0.2s;
}

.file-item:hover {
  border-color: var(--primary-light);
}

.file-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.file-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.file-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-detail {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 11px;
  color: var(--muted);
}

.file-ext {
  padding: 1px 6px;
  background: var(--bg);
  border-radius: 4px;
  font-weight: 500;
}

.file-size {
  color: var(--success);
}

.file-msg {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-status-text {
  font-size: 12px;
  font-weight: 500;
  flex-shrink: 0;
  min-width: 50px;
  text-align: right;
}

.file-remove {
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  opacity: 0;
  transition: opacity 0.2s;
}

.file-item:hover .file-remove {
  opacity: 1;
}

.file-remove:hover {
  background: rgba(239, 68, 68, 0.1);
  color: var(--danger);
}

.file-remove svg {
  width: 14px;
  height: 14px;
}

/* 转换按钮 */
.convert-actions {
  margin-top: 16px;
  display: flex;
  justify-content: center;
}

.btn-start {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 32px;
  background: var(--primary);
  color: white;
  border: none;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-start:hover {
  background: var(--primary-light);
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(79, 70, 229, 0.3);
}

.btn-start svg {
  width: 18px;
  height: 18px;
}

.btn-cancel {
  padding: 12px 32px;
  background: var(--danger);
  color: white;
  border: none;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-cancel:hover {
  opacity: 0.9;
}

/* 汇总报告 */
.summary-report {
  margin-top: 16px;
  padding: 16px;
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.06), rgba(6, 182, 212, 0.04));
  border: 1px solid rgba(16, 185, 129, 0.2);
  border-radius: var(--radius-sm);
}

.summary-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--success);
  margin-bottom: 14px;
}

.summary-header svg {
  width: 20px;
  height: 20px;
}

.summary-stats {
  display: flex;
  gap: 20px;
  justify-content: center;
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.stat-num {
  font-size: 24px;
  font-weight: 700;
}

.stat-item.success .stat-num { color: var(--success); }
.stat-item.failed .stat-num { color: var(--danger); }
.stat-item.skipped .stat-num { color: #f59e0b; }
.stat-item.duration .stat-num { color: var(--primary); font-size: 18px; }

.stat-label {
  font-size: 12px;
  color: var(--muted);
}

/* 空状态 */
.empty-batch {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 40px 20px;
  color: var(--muted);
}

.empty-batch svg {
  width: 40px;
  height: 40px;
  opacity: 0.3;
}

.empty-batch p {
  font-size: 13px;
  text-align: center;
}
</style>
