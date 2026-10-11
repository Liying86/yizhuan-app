<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useLicense } from '../composables/useLicense'

const { isPro } = useLicense()

const props = defineProps<{}>()

const emit = defineEmits<{
  (e: 'complete', result: { totalSaved: number, totalOriginal: number, totalCompressed: number, itemCount: number }): void
  (e: 'close'): void
}>()

// 支持的图片扩展名
const SUPPORTED_EXTS = ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'tiff']

function isSupportedImage(filePath: string): boolean {
  const ext = filePath.toLowerCase().split('.').pop() || ''
  return SUPPORTED_EXTS.includes(ext)
}

// ==================== 辅助方法 ====================

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}

function generateTaskId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function getFileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() || '未知文件'
}

function getBaseNameWithoutExt(path: string): string {
  const name = getFileNameFromPath(path)
  const lastDot = name.lastIndexOf('.')
  return lastDot > 0 ? name.slice(0, lastDot) : name
}

function getExtFromPath(path: string): string {
  const name = getFileNameFromPath(path)
  const lastDot = name.lastIndexOf('.')
  return lastDot > 0 ? name.slice(lastDot) : ''
}

function getDirFromPath(path: string): string {
  const sep = path.includes('\\') ? '\\' : '/'
  const parts = path.split(sep)
  parts.pop()
  return parts.join(sep)
}

// ==================== 类型定义 ====================

type CompressLevel = 'light' | 'standard' | 'aggressive' | 'custom'
type OutputFormat = 'keep' | 'png' | 'jpg' | 'webp'

interface FileItem {
  inputPath: string
  name: string
  originalSize: number
  status: 'pending' | 'compressing' | 'done' | 'error'
  compressedSize?: number
  outputPath?: string
  error?: string
}

// ==================== 状态 ====================

const files = ref<FileItem[]>([])
const compressLevel = ref<CompressLevel>('standard')
const outputFormat = ref<OutputFormat>('keep')
const outputDir = ref<string>('')
const isBusy = ref(false)
const currentCompressIndex = ref(-1)
const results = ref<FileItem[]>([])

// 自定义压缩设置
const customMaxWidth = ref<number | undefined>(undefined)
const customMaxHeight = ref<number | undefined>(undefined)
const customQuality = ref(60)
const maintainAspectRatio = ref(true)  // 固定长宽比
const sizeUnit = ref<'pixel' | 'kb'>('pixel')  // 尺寸单位：像素 / 体积
const customMaxSizeKb = ref<number | undefined>(undefined)  // 自定义最大文件大小（KB）

// 固定长宽比时，用户输入一边尺寸后自动清空另一边，由后端按比例等比缩放
watch([customMaxWidth, customMaxHeight], ([newWidth, newHeight], [oldWidth, oldHeight]) => {
  if (!maintainAspectRatio.value) return
  // 用 Number() 统一处理：空字符串/undefined 都会转为非正数，避免清空输入时误触发
  const w = Number(newWidth)
  const h = Number(newHeight)
  // 宽度变为有效正数，且高度也有有效值 -> 清空高度（让后端按宽度等比缩放）
  if (w > 0 && h > 0 && newWidth !== oldWidth) {
    customMaxHeight.value = undefined
  }
  // 高度变为有效正数，且宽度也有有效值 -> 清空宽度（让后端按高度等比缩放）
  if (h > 0 && w > 0 && newHeight !== oldHeight) {
    customMaxWidth.value = undefined
  }
})

// 压缩级别配置
const levelConfig: Record<CompressLevel, { quality: number; scale?: number; label: string; desc: string; isPro?: boolean }> = {
  light: { quality: 85, label: '轻度压缩', desc: '高质量，文件略小' },
  standard: { quality: 65, label: '标准压缩', desc: '平衡质量与大小' },
  aggressive: { quality: 35, scale: 2048, label: '强力压缩', desc: '最大压缩，最小体积', isPro: true },
  custom: { quality: 60, label: '自定义', desc: '自由调整尺寸和清晰度', isPro: true }
}

// 输出格式扩展名映射
const formatExtMap: Record<OutputFormat, string> = {
  keep: '',
  png: '.png',
  jpg: '.jpg',
  webp: '.webp'
}

// ==================== 计算属性 ====================

const hasFiles = computed(() => files.value.length > 0)

const completedResults = computed(() => files.value.filter(f => f.status === 'done'))

const totalOriginal = computed(() => {
  return files.value.filter(f => f.status === 'done').reduce((sum, f) => sum + f.originalSize, 0)
})

const totalCompressed = computed(() => {
  return files.value.filter(f => f.status === 'done').reduce((sum, f) => sum + (f.compressedSize || 0), 0)
})

const totalSaved = computed(() => {
  return totalOriginal.value - totalCompressed.value
})

const averageSavedPercent = computed(() => {
  const doneItems = files.value.filter(f => f.status === 'done')
  if (doneItems.length === 0) return 0
  const totalPercent = doneItems.reduce((sum, f) => {
    if (!f.compressedSize || f.originalSize === 0) return sum
    return sum + ((f.originalSize - f.compressedSize) / f.originalSize) * 100
  }, 0)
  return totalPercent / doneItems.length
})

const showResults = computed(() => {
  return completedResults.value.length > 0 && !isBusy.value
})

// ==================== 文件选择 ====================

async function selectFiles() {
  try {
    const result = await window.electronAPI.selectFiles({
      filters: [{ name: '图片文件', extensions: SUPPORTED_EXTS }],
      multi: true
    })
    if (!result || result.length === 0) return

    for (const filePath of result) {
      if (files.value.some(f => f.inputPath === filePath)) continue

      try {
        const size = await window.electronAPI.getFileSize(filePath)
        files.value.push({
          inputPath: filePath,
          name: getFileNameFromPath(filePath),
          originalSize: size || 0,
          status: 'pending'
        })
      } catch {
        files.value.push({
          inputPath: filePath,
          name: getFileNameFromPath(filePath),
          originalSize: 0,
          status: 'pending'
        })
      }
    }
    // 重置结果
    results.value = []
  } catch {
    // 用户取消选择
  }
}

// ==================== 拖拽支持 ====================

const isDragOver = ref(false)

async function onDropFiles(droppedFiles: File[] | null) {
  if (!droppedFiles || droppedFiles.length === 0) return

  for (const file of droppedFiles) {
    // 通过 webUtils.getPathForFile 获取本地路径
    const filePath = window.electronAPI.getFilePathForFile(file)
    if (!filePath || !isSupportedImage(filePath)) continue
    if (files.value.some(f => f.inputPath === filePath)) continue

    try {
      const size = await window.electronAPI.getFileSize(filePath)
      files.value.push({
        inputPath: filePath,
        name: file.name,
        originalSize: size || 0,
        status: 'pending'
      })
    } catch {
      files.value.push({
        inputPath: filePath,
        name: file.name,
        originalSize: 0,
        status: 'pending'
      })
    }
  }
  results.value = []
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
  isDragOver.value = true
}

function onDragLeave(e: DragEvent) {
  e.preventDefault()
  isDragOver.value = false
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  isDragOver.value = false
  if (e.dataTransfer?.files) {
    onDropFiles(Array.from(e.dataTransfer.files))
  }
}

async function selectOutputDir() {
  try {
    const result = await window.electronAPI.selectFolder()
    if (result) {
      outputDir.value = result
    }
  } catch {
    // 用户取消选择
  }
}

// ==================== 构建输出路径 ====================

function buildOutputPath(inputPath: string): string {
  const baseName = getBaseNameWithoutExt(inputPath)
  let ext: string

  if (outputFormat.value === 'keep') {
    ext = getExtFromPath(inputPath)
  } else {
    ext = formatExtMap[outputFormat.value]
  }

  if (outputDir.value) {
    const sep = outputDir.value.includes('\\') ? '\\' : '/'
    return `${outputDir.value}${sep}compressed_${baseName}${ext}`
  } else {
    const dir = getDirFromPath(inputPath)
    const sep = dir.includes('\\') ? '\\' : '/'
    return `${dir}${sep}compressed_${baseName}${ext}`
  }
}

// ==================== 压缩执行 ====================

async function startCompress() {
  if (files.value.length === 0 || isBusy.value) return

  isBusy.value = true
  results.value = []
  currentCompressIndex.value = -1

  // 重置所有文件状态
  for (const file of files.value) {
    file.status = 'pending'
    file.compressedSize = undefined
    file.outputPath = undefined
    file.error = undefined
  }

  const taskId = generateTaskId()

  for (let i = 0; i < files.value.length; i++) {
    const file = files.value[i]
    file.status = 'compressing'
    currentCompressIndex.value = i

    const outputPath = buildOutputPath(file.inputPath)

    try {
      const result = await window.electronAPI.compressImage({
        inputPath: file.inputPath,
        outputPath,
        taskId,
        options: {
          level: compressLevel.value,
          format: outputFormat.value === 'keep' ? undefined : outputFormat.value,
          customMaxWidth: compressLevel.value === 'custom' && sizeUnit.value === 'pixel' ? customMaxWidth.value : undefined,
          customMaxHeight: compressLevel.value === 'custom' && sizeUnit.value === 'pixel' ? customMaxHeight.value : undefined,
          customQuality: compressLevel.value === 'custom' ? customQuality.value : undefined,
          maintainAspectRatio: compressLevel.value === 'custom' ? maintainAspectRatio.value : undefined,
          customMaxSizeKb: compressLevel.value === 'custom' && sizeUnit.value === 'kb' ? customMaxSizeKb.value : undefined,
        }
      })

      // 检查压缩结果状态
      if (result?.status === 'error') {
        file.status = 'error'
        file.error = result.message || '压缩失败'
        continue
      }

      // 压缩完成后获取输出文件大小
      let compressedSize = 0
      try {
        compressedSize = await window.electronAPI.getFileSize(outputPath)
      } catch {
        // 如果获取不到，使用估算值
        compressedSize = Math.floor(file.originalSize * (compressLevel.value === 'light' ? 0.85 : compressLevel.value === 'standard' ? 0.65 : 0.35))
      }

      file.status = 'done'
      file.compressedSize = compressedSize
      file.outputPath = outputPath
    } catch (err: any) {
      file.status = 'error'
      file.error = err?.message || '压缩失败'
    }
  }

  currentCompressIndex.value = -1
  isBusy.value = false
  results.value = [...files.value]

  // emit complete
  const doneItems = files.value.filter(f => f.status === 'done')
  const tOriginal = doneItems.reduce((s, f) => s + f.originalSize, 0)
  const tCompressed = doneItems.reduce((s, f) => s + (f.compressedSize || 0), 0)
  emit('complete', {
    totalSaved: tOriginal - tCompressed,
    totalOriginal: tOriginal,
    totalCompressed: tCompressed,
    itemCount: doneItems.length
  })
}

// ==================== 文件列表操作 ====================

function removeFile(index: number) {
  files.value.splice(index, 1)
  // 如果正在压缩或已有结果，重置
  if (isBusy.value) return
  if (files.value.length === 0) {
    results.value = []
  }
}

function clearFiles() {
  if (isBusy.value) return
  files.value = []
  results.value = []
}

// ==================== 打开操作 ====================

function openFile(path: string) {
  window.electronAPI.openFile(path)
}

function openFolder(path: string) {
  window.electronAPI.openFolder(path)
}

function openOutputFolder() {
  // 打开第一个成功文件的所在目录
  const firstDone = files.value.find(f => f.status === 'done' && f.outputPath)
  if (firstDone?.outputPath) {
    openFolder(getDirFromPath(firstDone.outputPath))
  } else if (outputDir.value) {
    openFolder(outputDir.value)
  }
}
</script>

<template>
  <section class="compress-panel">
    <!-- 头部：标题 + 关闭按钮 -->
    <div class="panel-header">
      <h3 class="panel-title">图片压缩</h3>
      <div class="header-actions">
        <button
          v-if="files.length > 0"
          class="btn btn-primary btn-start-header"
          :disabled="isBusy"
          @click="startCompress"
        >
          <span v-if="isBusy" class="spinner spinner-sm"></span>
          {{ isBusy ? '压缩中...' : '开始压缩' }}
        </button>
        <button class="close-btn" @click="emit('close')" title="关闭">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>

    <!-- 选择文件按钮 -->
    <div class="action-bar">
      <button class="btn btn-primary" @click="selectFiles" :disabled="isBusy">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        选择图片文件
      </button>
    </div>

    <!-- 压缩设置区 -->
    <div v-if="hasFiles" class="setting-group">
      <!-- 压缩级别 -->
      <div class="level-section">
        <span class="option-label">压缩级别</span>
        <div class="level-options">
          <label
            v-for="(config, key) in levelConfig"
            :key="key"
            class="mode-option"
            :class="{ active: compressLevel === key, disabled: config.isPro && !isPro() }"
          >
            <input
              type="radio"
              v-model="compressLevel"
              :value="key"
              :disabled="config.isPro && !isPro()"
            />
            <span class="mode-label">{{ config.label }}</span>
            <span class="mode-desc">
              {{ config.desc }}
              <span v-if="config.isPro" class="pro-tag">会员专享</span>
            </span>
          </label>
        </div>

        <!-- 自定义压缩设置 -->
        <div v-if="compressLevel === 'custom'" class="custom-settings">
          <!-- 尺寸单位切换：像素 / 体积 -->
          <div class="custom-row">
            <div class="custom-field">
              <label class="custom-label">尺寸单位</label>
              <div class="unit-toggle">
                <label class="unit-option" :class="{ active: sizeUnit === 'pixel' }">
                  <input type="radio" v-model="sizeUnit" value="pixel" />
                  <span>像素</span>
                </label>
                <label class="unit-option" :class="{ active: sizeUnit === 'kb' }">
                  <input type="radio" v-model="sizeUnit" value="kb" />
                  <span>体积 (KB)</span>
                </label>
              </div>
            </div>
          </div>

          <!-- 像素单位：最大宽高 + 固定长宽比 -->
          <div v-if="sizeUnit === 'pixel'" class="custom-row">
            <div class="custom-field">
              <label class="custom-label">最大宽度 (px)</label>
              <input
                type="number"
                class="custom-input"
                v-model="customMaxWidth"
                :min="100"
                :max="8000"
                placeholder="不限"
              />
            </div>
            <div class="custom-field">
              <label class="custom-label">最大高度 (px)</label>
              <input
                type="number"
                class="custom-input"
                v-model="customMaxHeight"
                :min="100"
                :max="8000"
                placeholder="不限"
              />
            </div>
            <div class="custom-field">
              <label class="checkbox-label">
                <input type="checkbox" v-model="maintainAspectRatio" />
                <span>固定长宽比</span>
              </label>
            </div>
          </div>

          <!-- 体积单位：目标文件大小 -->
          <div v-if="sizeUnit === 'kb'" class="custom-row">
            <div class="custom-field">
              <label class="custom-label">目标文件大小 (KB)</label>
              <input
                type="number"
                class="custom-input"
                v-model="customMaxSizeKb"
                :min="10"
                :max="10240"
                placeholder="如: 200"
              />
              <span class="custom-hint">压缩到指定大小以内</span>
            </div>
          </div>

          <div class="custom-field custom-slider-field">
            <label class="custom-label">
              清晰度: <span class="custom-value">{{ customQuality }}</span>
            </label>
            <input
              type="range"
              class="custom-slider"
              v-model.number="customQuality"
              min="1"
              max="100"
            />
          </div>
        </div>
      </div>

      <!-- 输出格式 -->
      <div class="format-section">
        <span class="option-label">输出格式</span>
        <div class="format-options">
          <label class="format-option" :class="{ active: outputFormat === 'keep' }">
            <input type="radio" v-model="outputFormat" value="keep" />
            <span class="format-dot"></span>
            <span class="format-name">保持原格式</span>
          </label>
          <label class="format-option" :class="{ active: outputFormat === 'png' }">
            <input type="radio" v-model="outputFormat" value="png" />
            <span class="format-dot"></span>
            <span class="format-name">PNG</span>
          </label>
          <label class="format-option" :class="{ active: outputFormat === 'jpg' }">
            <input type="radio" v-model="outputFormat" value="jpg" />
            <span class="format-dot"></span>
            <span class="format-name">JPG</span>
          </label>
          <label class="format-option" :class="{ active: outputFormat === 'webp' }">
            <input type="radio" v-model="outputFormat" value="webp" />
            <span class="format-dot"></span>
            <span class="format-name">WebP</span>
          </label>
        </div>
      </div>

      <!-- 输出目录 -->
      <div class="output-dir-section">
        <span class="option-label">输出目录</span>
        <div class="output-dir-row">
          <button class="btn btn-ghost" @click="selectOutputDir" :disabled="isBusy">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
            {{ outputDir ? '已选择输出目录' : '选择输出目录（可选）' }}
          </button>
          <button v-if="outputDir" class="btn-icon" @click="outputDir = ''" :disabled="isBusy" title="清除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
          <span v-if="!outputDir" class="output-hint">默认保存到源文件同目录</span>
        </div>
      </div>
    </div>

    <!-- 文件列表 -->
    <div v-if="hasFiles" class="file-list">
      <div class="file-list-header">
        <span class="file-list-title">已选文件 ({{ files.length }})</span>
        <div class="file-list-actions">
          <button class="btn btn-ghost btn-sm" @click="clearFiles" :disabled="isBusy">清空</button>
        </div>
      </div>
      <div
        v-for="(file, index) in files"
        :key="file.inputPath"
        class="file-item"
        :class="{ compressing: file.status === 'compressing', error: file.status === 'error' }"
      >
        <span class="file-index">{{ index + 1 }}</span>
        <div class="file-info">
          <span class="file-name" :title="file.name">{{ file.name }}</span>
          <span class="file-meta">
            {{ formatSize(file.originalSize) }}
            <template v-if="file.status === 'compressing'"> - 压缩中...</template>
            <template v-else-if="file.status === 'done' && file.compressedSize !== undefined">
              &rarr; {{ formatSize(file.compressedSize) }}
              <span class="saved-percent" :class="{ negative: file.compressedSize >= file.originalSize }">
                ({{ file.originalSize > 0 ? ((file.originalSize - file.compressedSize) / file.originalSize * 100).toFixed(1) : 0 }}%)
              </span>
            </template>
            <template v-else-if="file.status === 'error'">
              - <span class="error-text">{{ file.error || '压缩失败' }}</span>
            </template>
          </span>
        </div>
        <button class="btn-icon btn-remove" @click="removeFile(index)" :disabled="isBusy" title="移除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>

    <!-- 空状态 -->
    <div
      v-if="!hasFiles && !isBusy"
      class="empty-state drop-zone"
      :class="{ 'drag-active': isDragOver }"
      @click="selectFiles"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
      <p>点击选择或拖拽图片到此处</p>
      <span class="empty-hint">支持 PNG、JPG、BMP、WebP、TIFF 格式</span>
    </div>

    <!-- 压缩结果区 -->
    <div v-if="showResults" class="result-box">
      <div class="result-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" style="color: var(--accent)"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <span>压缩完成</span>
      </div>
      <div class="result-details">
        <!-- 汇总信息 -->
        <div class="result-summary">
          <div class="result-row">
            <div class="result-item">
              <span class="result-label">总计节省</span>
              <span class="result-value saved-value">{{ formatSize(totalSaved) }}</span>
            </div>
            <div class="result-item">
              <span class="result-label">平均节省</span>
              <span class="result-value saved-value">{{ averageSavedPercent.toFixed(1) }}%</span>
            </div>
            <div class="result-item">
              <span class="result-label">成功/总计</span>
              <span class="result-value">{{ completedResults.length }} / {{ files.length }}</span>
            </div>
          </div>
        </div>

        <!-- 每个文件的结果 -->
        <div class="result-file-list">
          <div
            v-for="file in files"
            :key="file.inputPath"
            class="result-file-item"
          >
            <svg v-if="file.status === 'done'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="color: #10b981"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="color: #ef4444"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
            <span class="result-file-name" :title="file.name">{{ file.name }}</span>
            <span class="result-file-meta">
              <template v-if="file.status === 'done' && file.compressedSize !== undefined">
                {{ formatSize(file.originalSize) }} &rarr; {{ formatSize(file.compressedSize) }}
                <span class="result-saved-percent" :class="{ negative: file.compressedSize >= file.originalSize }">
                  -{{ ((file.originalSize - file.compressedSize) / file.originalSize * 100).toFixed(1) }}%
                </span>
              </template>
              <template v-else>
                {{ file.error || '失败' }}
              </template>
            </span>
            <button
              v-if="file.status === 'done' && file.outputPath"
              class="btn-icon"
              @click="openFile(file.outputPath!)"
              title="打开文件"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </button>
          </div>
        </div>

        <!-- 打开文件夹按钮 -->
        <div class="result-actions">
          <button class="btn btn-ghost" @click="openOutputFolder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
            打开文件夹
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.compress-panel {
  margin-top: 16px;
}

/* 文件列表标题栏操作按钮组 */
.file-list-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

/* 小尺寸 spinner */
.spinner-sm {
  width: 12px;
  height: 12px;
  border-width: 1.5px;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.panel-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--ink);
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  color: var(--muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s;
}

.close-btn:hover {
  background: var(--surface);
  color: var(--ink);
}

.close-btn svg {
  width: 16px;
  height: 16px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-start-header {
  padding: 6px 16px;
  font-size: 13px;
  white-space: nowrap;
}

/* ==================== 通用按钮 ==================== */
.action-bar {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}

.action-bar.bottom-bar {
  margin-top: 20px;
  margin-bottom: 16px;
  justify-content: center;
  position: sticky;
  bottom: 0;
  z-index: 100;
  padding: 16px 0;
  background: var(--bg, #fff);
  border-top: 1px solid var(--border);
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.06);
}

.inline-action {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 0;
  margin-top: 8px;
}

.bottom-hint {
  font-size: 12px;
  color: var(--muted);
  margin-left: 8px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 18px;
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-weight: 500;
  border: none;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-primary {
  background: var(--accent);
  color: #fff;
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-ghost {
  background: var(--surface);
  color: var(--ink);
  border: 1px solid var(--border);
}

.btn-ghost:hover:not(:disabled) {
  border-color: var(--primary-light);
}

.btn-sm {
  padding: 4px 12px;
  font-size: 12px;
}

.btn-lg {
  padding: 12px 32px;
  font-size: 15px;
}

.btn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  color: var(--muted);
  transition: all 0.2s;
  flex-shrink: 0;
}

.btn-icon:hover {
  background: var(--surface);
  color: var(--ink);
}

.btn-icon:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-remove:hover {
  color: #ef4444;
  background: #fef2f2;
}

.btn svg {
  flex-shrink: 0;
}

/* ==================== 加载动画 ==================== */
.spinner {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ==================== 设置组 ==================== */
.setting-group {
  margin-bottom: 16px;
}

.option-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 10px;
}

/* 压缩级别选项 */
.level-section {
  margin-bottom: 16px;
}

.level-options {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}

.mode-option {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px;
  background: var(--surface);
  border: 2px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.2s;
}

.mode-option:hover {
  border-color: var(--primary-light);
}

.mode-option.active {
  border-color: var(--accent);
  background: rgba(124, 92, 252, 0.04);
}

.mode-option.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.mode-option.disabled:hover {
  border-color: var(--border);
}

.pro-tag {
  display: inline-block;
  margin-left: 4px;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, #f59e0b, #f97316);
  border-radius: 4px;
  vertical-align: middle;
}

.mode-option input[type="radio"] {
  display: none;
}

.mode-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
}

.mode-desc {
  font-size: 12px;
  color: var(--muted);
}

/* 自定义压缩设置 */
.custom-settings {
  margin-top: 12px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.custom-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 12px;
}

.custom-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.custom-slider-field {
  margin-bottom: 0;
}

.custom-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--ink);
}

.custom-value {
  font-weight: 600;
  color: var(--accent);
}

.custom-input {
  width: 100%;
  padding: 8px 10px;
  font-size: 13px;
  color: var(--ink);
  background: var(--bg, #fff);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  transition: border-color 0.2s;
  box-sizing: border-box;
}

.custom-input:focus {
  outline: none;
  border-color: var(--accent);
}

.custom-input::placeholder {
  color: var(--muted);
}

.custom-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 6px;
  background: var(--border);
  border-radius: 3px;
  outline: none;
  cursor: pointer;
}

.custom-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--accent);
  cursor: pointer;
  border: 2px solid #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  transition: transform 0.15s;
}

.custom-slider::-webkit-slider-thumb:hover {
  transform: scale(1.15);
}

.custom-slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--accent);
  cursor: pointer;
  border: 2px solid #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

/* 尺寸单位切换 */
.unit-toggle {
  display: flex;
  gap: 8px;
}

.unit-option {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 16px;
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--ink);
  background: var(--bg, #fff);
  transition: all 0.2s;
}

.unit-option:hover {
  border-color: var(--primary-light);
}

.unit-option.active {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}

.unit-option input {
  display: none;
}

/* 固定长宽比勾选框 */
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--ink);
  user-select: none;
}

.checkbox-label input[type="checkbox"] {
  width: 15px;
  height: 15px;
  cursor: pointer;
  accent-color: var(--accent);
}

/* 体积单位提示文字 */
.custom-hint {
  font-size: 11px;
  color: var(--muted);
  margin-top: 4px;
}

/* 输出格式选项 */
.format-section {
  margin-bottom: 16px;
}

.format-options {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.format-option {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  transition: all 0.2s;
  font-size: 13px;
  color: var(--ink);
}

.format-option:hover {
  border-color: var(--primary-light);
}

.format-option.active {
  border-color: var(--accent);
  background: rgba(124, 92, 252, 0.04);
  color: var(--accent);
}

.format-option input[type="radio"] {
  display: none;
}

.format-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--border);
  transition: all 0.2s;
  flex-shrink: 0;
  position: relative;
}

.format-option.active .format-dot {
  border-color: var(--accent);
}

.format-option.active .format-dot::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  right: 2px;
  bottom: 2px;
  border-radius: 50%;
  background: var(--accent);
}

.format-name {
  font-weight: 500;
}

/* 输出目录 */
.output-dir-section {
  margin-bottom: 4px;
}

.output-dir-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.output-hint {
  font-size: 12px;
  color: var(--muted);
}

/* ==================== 文件列表 ==================== */
.file-list {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.file-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.file-list-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}

.file-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  transition: background 0.15s;
  cursor: default;
}

.file-item:last-child {
  border-bottom: none;
}

.file-item:hover {
  background: var(--surface);
}

.file-item.compressing {
  background: rgba(124, 92, 252, 0.03);
}

.file-item.error {
  background: rgba(239, 68, 68, 0.03);
}

.file-index {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  width: 20px;
  text-align: center;
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

.file-meta {
  font-size: 12px;
  color: var(--muted);
}

.saved-percent {
  color: #10b981;
  font-weight: 500;
}

.saved-percent.negative {
  color: #ef4444;
}

.error-text {
  color: #ef4444;
}

/* ==================== 空状态 ==================== */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: var(--muted);
  text-align: center;
}

.empty-state.drop-zone {
  cursor: pointer;
  border: 2px dashed var(--border);
  border-radius: var(--radius-sm);
  transition: all 0.2s;
}

.empty-state.drop-zone:hover {
  border-color: var(--accent);
  background: rgba(124, 92, 252, 0.02);
}

.empty-state.drop-zone.drag-active {
  border-color: var(--accent);
  background: rgba(124, 92, 252, 0.06);
}

.empty-state svg {
  margin-bottom: 16px;
  opacity: 0.3;
}

.empty-state p {
  font-size: 14px;
  color: var(--ink);
  margin-bottom: 6px;
}

.empty-hint {
  font-size: 12px;
  color: var(--muted);
}

/* ==================== 结果展示 ==================== */
.result-box {
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  overflow: hidden;
  margin-top: 16px;
}

.result-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  background: rgba(124, 92, 252, 0.06);
  font-size: 14px;
  font-weight: 600;
  color: var(--accent);
}

.result-details {
  padding: 14px;
}

.result-summary {
  margin-bottom: 12px;
}

.result-row {
  display: flex;
  gap: 24px;
  margin-top: 8px;
}

.result-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.result-label {
  font-size: 12px;
  color: var(--muted);
}

.result-value {
  font-size: 13px;
  color: var(--ink);
  font-weight: 500;
}

.saved-value {
  color: #10b981;
  font-weight: 600;
}

.result-file-list {
  max-height: 240px;
  overflow-y: auto;
}

.result-file-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-top: 1px solid var(--border);
}

.result-file-item:first-child {
  border-top: none;
}

.result-file-name {
  flex: 1;
  font-size: 13px;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.result-file-meta {
  font-size: 12px;
  color: var(--muted);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.result-saved-percent {
  color: #10b981;
  font-weight: 500;
}

.result-saved-percent.negative {
  color: #ef4444;
}

.result-actions {
  margin-top: 12px;
  display: flex;
  gap: 10px;
  justify-content: center;
}
</style>
