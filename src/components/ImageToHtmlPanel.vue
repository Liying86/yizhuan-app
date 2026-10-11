<script setup lang="ts">
import { ref, computed } from 'vue'

const props = defineProps<{}>()

const emit = defineEmits<{
  (e: 'complete', result: { status: 'success' | 'error', output: string, message: string }): void
  (e: 'close'): void
}>()

// ==================== 辅助方法 ====================

function generateTaskId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
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

type OutputFormat = 'html' | 'md'

interface FileItem {
  inputPath: string
  name: string
  originalSize: number
  status: 'pending' | 'converting' | 'done' | 'error'
  outputPath?: string
  error?: string
}

// ==================== 状态 ====================

const files = ref<FileItem[]>([])
const outputFormat = ref<OutputFormat>('html')
const pageTitle = ref<string>('')
const outputDir = ref<string>('')
const isBusy = ref(false)
const currentIndex = ref(-1)
const errorMessage = ref('')

// 支持的图片扩展名
const SUPPORTED_EXTS = ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'tiff']

function isSupportedImage(filePath: string): boolean {
  const ext = filePath.toLowerCase().split('.').pop() || ''
  return SUPPORTED_EXTS.includes(ext)
}

const formatExtMap: Record<OutputFormat, string> = {
  html: '.html',
  md: '.md'
}

// ==================== 计算属性 ====================

const hasFiles = computed(() => files.value.length > 0)

const canStart = computed(() => hasFiles.value && !isBusy.value)

const completedItems = computed(() => files.value.filter(f => f.status === 'done'))

const showResults = computed(() => completedItems.value.length > 0 && !isBusy.value)

const progressText = computed(() => {
  if (!isBusy.value) return ''
  return `${currentIndex.value + 1} / ${files.value.length}`
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

      let size = 0
      try {
        size = await window.electronAPI.getFileSize(filePath)
      } catch {
        size = 0
      }
      files.value.push({
        inputPath: filePath,
        name: getFileNameFromPath(filePath),
        originalSize: size || 0,
        status: 'pending'
      })
    }
  } catch {
    // 用户取消选择
  }
}

// ==================== 拖拽支持 ====================

const isDragOver = ref(false)

async function onDropFiles(droppedFiles: File[] | null) {
  if (!droppedFiles || droppedFiles.length === 0) return

  for (const file of droppedFiles) {
    const filePath = window.electronAPI.getFilePathForFile(file)
    if (!filePath || !isSupportedImage(filePath)) continue
    if (files.value.some(f => f.inputPath === filePath)) continue

    let size = 0
    try {
      size = await window.electronAPI.getFileSize(filePath)
    } catch {
      size = 0
    }
    files.value.push({
      inputPath: filePath,
      name: file.name,
      originalSize: size || 0,
      status: 'pending'
    })
  }
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

// ==================== 文件列表操作 ====================

function removeFile(index: number) {
  if (isBusy.value) return
  files.value.splice(index, 1)
}

function clearFiles() {
  if (isBusy.value) return
  files.value = []
}

// ==================== 构建输出路径 ====================

function buildOutputPath(inputPath: string): string {
  const baseName = getBaseNameWithoutExt(inputPath)
  const ext = formatExtMap[outputFormat.value]

  if (outputDir.value) {
    const sep = outputDir.value.includes('\\') ? '\\' : '/'
    const suffix = baseName.endsWith('_易转') ? '' : '_易转'
    return `${outputDir.value}${sep}${baseName}${suffix}${ext}`
  } else {
    const dir = getDirFromPath(inputPath)
    const sep = dir.includes('\\') ? '\\' : '/'
    const suffix = baseName.endsWith('_易转') ? '' : '_易转'
    return `${dir}${sep}${baseName}${suffix}${ext}`
  }
}

// ==================== 执行转换 ====================

async function startConvert() {
  if (files.value.length === 0 || isBusy.value) return

  isBusy.value = true
  errorMessage.value = ''
  currentIndex.value = -1

  // 重置所有文件状态
  for (const file of files.value) {
    file.status = 'pending'
    file.outputPath = undefined
    file.error = undefined
  }

  const taskId = generateTaskId()
  const options: { format: OutputFormat; title?: string } = {
    format: outputFormat.value
  }
  const title = pageTitle.value.trim()
  if (title) {
    options.title = title
  }

  let lastOutput = ''
  let doneCount = 0

  for (let i = 0; i < files.value.length; i++) {
    const file = files.value[i]
    file.status = 'converting'
    currentIndex.value = i

    const outputPath = buildOutputPath(file.inputPath)

    try {
      const result = await window.electronAPI.imageToHtml({
        inputPath: file.inputPath,
        outputPath,
        taskId,
        options
      })

      if (result?.status === 'error') {
        file.status = 'error'
        file.error = result.message || '转换失败'
        continue
      }

      file.status = 'done'
      file.outputPath = result?.output || outputPath
      lastOutput = file.outputPath
      doneCount++
    } catch (err: any) {
      file.status = 'error'
      file.error = err?.message || '转换失败'
    }
  }

  currentIndex.value = -1
  isBusy.value = false

  const status = doneCount > 0 ? 'success' : 'error'
  const message = doneCount === files.value.length
    ? `转换完成，共处理 ${doneCount} 个文件`
    : doneCount > 0
      ? `部分成功，共处理 ${doneCount} 个文件`
      : '转换失败'

  emit('complete', { status, output: lastOutput, message })
}

// ==================== 打开操作 ====================

function openFile(path: string) {
  window.electronAPI.openFile(path)
}

function openFolder(path: string) {
  window.electronAPI.openFolder(path)
}

function openOutputFolder() {
  if (outputDir.value) {
    openFolder(outputDir.value)
  } else {
    const firstDone = files.value.find(f => f.status === 'done' && f.outputPath)
    if (firstDone?.outputPath) {
      openFolder(getDirFromPath(firstDone.outputPath))
    }
  }
}
</script>

<template>
  <section class="image-to-html-panel">
    <!-- 头部：标题 + 关闭按钮 -->
    <div class="panel-header">
      <h3 class="panel-title">图片转 HTML/MD</h3>
      <div class="header-actions">
        <button
          v-if="files.length > 0"
          class="btn btn-primary btn-start-header"
          :disabled="!canStart"
          @click="startConvert"
        >
          <span v-if="isBusy" class="spinner spinner-sm"></span>
          {{ isBusy ? '转换中...' : '开始转换' }}
        </button>
        <button class="close-btn" @click="emit('close')" title="关闭">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>

    <!-- 错误提示 -->
    <div v-if="errorMessage" class="error-banner">
      {{ errorMessage }}
    </div>

    <!-- 选择文件按钮 -->
    <div class="action-bar">
      <button class="btn btn-primary" @click="selectFiles" :disabled="isBusy">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        选择图片文件
      </button>
    </div>

    <!-- 转换设置区 -->
    <div v-if="hasFiles" class="setting-group">
      <!-- 输出格式 -->
      <div class="format-section">
        <span class="option-label">输出格式</span>
        <div class="format-options">
          <label class="format-option" :class="{ active: outputFormat === 'html' }">
            <input type="radio" v-model="outputFormat" value="html" />
            <span class="format-dot"></span>
            <span class="format-name">HTML（图片内嵌 base64）</span>
          </label>
          <label class="format-option" :class="{ active: outputFormat === 'md' }">
            <input type="radio" v-model="outputFormat" value="md" />
            <span class="format-dot"></span>
            <span class="format-name">Markdown（图片引用）</span>
          </label>
        </div>
      </div>

      <!-- 页面标题 -->
      <div class="title-section">
        <span class="option-label">页面标题（可选）</span>
        <input
          type="text"
          class="text-input"
          v-model="pageTitle"
          placeholder="例如：我的图片页面（留空则使用文件名）"
          :disabled="isBusy"
        />
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
          <span v-if="isBusy" class="progress-text">{{ progressText }}</span>
          <button class="btn btn-ghost btn-sm" @click="clearFiles" :disabled="isBusy">清空</button>
        </div>
      </div>
      <div
        v-for="(file, index) in files"
        :key="file.inputPath"
        class="file-item"
        :class="{ converting: file.status === 'converting', error: file.status === 'error', done: file.status === 'done' }"
      >
        <span class="file-index">{{ index + 1 }}</span>
        <div class="file-info">
          <span class="file-name" :title="file.name">{{ file.name }}</span>
          <span class="file-meta">
            {{ formatSize(file.originalSize) }}
            <template v-if="file.status === 'converting'"> - 转换中...</template>
            <template v-else-if="file.status === 'done' && file.outputPath">
              - 已生成 {{ getFileNameFromPath(file.outputPath) }}
            </template>
            <template v-else-if="file.status === 'error'">
              - <span class="error-text">{{ file.error || '转换失败' }}</span>
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
      <span class="empty-hint">支持将图片转换为 HTML（base64 内嵌）或 Markdown 文件</span>
    </div>

    <!-- 转换结果区 -->
    <div v-if="showResults" class="result-box">
      <div class="result-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" style="color: var(--accent)"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <span>转换完成</span>
      </div>
      <div class="result-details">
        <div class="result-summary">
          <div class="result-row">
            <div class="result-item">
              <span class="result-label">输出格式</span>
              <span class="result-value">{{ outputFormat === 'html' ? 'HTML' : 'Markdown' }}</span>
            </div>
            <div class="result-item">
              <span class="result-label">成功/总计</span>
              <span class="result-value">{{ completedItems.length }} / {{ files.length }}</span>
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
              <template v-if="file.status === 'done' && file.outputPath">{{ getFileNameFromPath(file.outputPath) }}</template>
              <template v-else>{{ file.error || '失败' }}</template>
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
.image-to-html-panel {
  margin-top: 16px;
}

.file-list-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.progress-text {
  font-size: 12px;
  color: var(--accent);
  font-weight: 500;
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

.spinner-sm {
  width: 12px;
  height: 12px;
  border-width: 1.5px;
}

/* ==================== 通用按钮 ==================== */
.action-bar {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}

.inline-action {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 20px 0;
  margin-top: 12px;
  margin-bottom: 8px;
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

/* ==================== 错误提示 ==================== */
.error-banner {
  padding: 10px 14px;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: #ef4444;
  margin-bottom: 14px;
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
  padding: 10px 14px;
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

/* 页面标题输入 */
.title-section {
  margin-bottom: 16px;
}

.text-input {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 14px;
  color: var(--ink);
  background: #fff;
  outline: none;
  transition: border-color 0.2s;
}

.text-input:focus {
  border-color: var(--accent);
}

.text-input:disabled {
  background: var(--surface);
  cursor: not-allowed;
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

.file-item.converting {
  background: rgba(124, 92, 252, 0.03);
}

.file-item.error {
  background: rgba(239, 68, 68, 0.03);
}

.file-item.done {
  background: rgba(16, 185, 129, 0.03);
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

.result-actions {
  margin-top: 12px;
  display: flex;
  gap: 10px;
  justify-content: center;
}
</style>
