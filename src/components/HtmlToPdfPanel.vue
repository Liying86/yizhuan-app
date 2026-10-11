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

function getDirFromPath(filePath: string): string {
  if (!filePath) return ''
  // 统一使用正斜杠处理，然后提取目录
  const normalized = filePath.replace(/\\/g, '/')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash <= 0) return ''
  const dir = normalized.substring(0, lastSlash)
  // 恢复为原始分隔符格式（Windows 用反斜杠）
  return dir.replace(/\//g, '\\')
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'output'
}

// ==================== 状态 ====================

const activeTab = ref<'html' | 'markdown'>('html')
const isBusy = ref(false)
const errorMessage = ref('')

// HTML 内容
const htmlContent = ref<string>('')
// Markdown 内容
const markdownContent = ref<string>('')

// 已加载的源文件名（仅用于显示）
const loadedHtmlName = ref<string>('')
const loadedMdName = ref<string>('')

// 输出设置
const outputDir = ref<string>('')
const outputFileName = ref<string>('output')

// 结果
const resultPath = ref<string>('')
const resultSize = ref<number>(0)
const showResult = ref(false)

// 拖拽状态
const isDragOver = ref(false)

// 隐藏的文件输入元素引用
const fileInputHtml = ref<HTMLInputElement | null>(null)
const fileInputMd = ref<HTMLInputElement | null>(null)

// ==================== 计算属性 ====================

const currentContent = computed(() => activeTab.value === 'html' ? htmlContent.value : markdownContent.value)

const hasContent = computed(() => currentContent.value.trim().length > 0)

const canStart = computed(() => hasContent.value && !isBusy.value && outputFileName.value.trim().length > 0)

const charCount = computed(() => currentContent.value.length)

const currentExt = computed(() => activeTab.value === 'html' ? '.pdf' : '.pdf')

// ==================== 文件选择（加载内容） ====================

function triggerLoadHtml() {
  fileInputHtml.value?.click()
}

function triggerLoadMd() {
  fileInputMd.value?.click()
}

async function onHtmlFilePicked(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    htmlContent.value = text
    loadedHtmlName.value = file.name
    errorMessage.value = ''
  } catch (err: any) {
    errorMessage.value = '读取 HTML 文件失败: ' + (err?.message || '未知错误')
  } finally {
    target.value = ''
  }
}

async function onMdFilePicked(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    markdownContent.value = text
    loadedMdName.value = file.name
    errorMessage.value = ''
  } catch (err: any) {
    errorMessage.value = '读取 Markdown 文件失败: ' + (err?.message || '未知错误')
  } finally {
    target.value = ''
  }
}

// ==================== 拖拽支持 ====================

function isAcceptedFile(file: File): boolean {
  const name = file.name.toLowerCase()
  if (activeTab.value === 'html') {
    return name.endsWith('.html') || name.endsWith('.htm')
  }
  return name.endsWith('.md') || name.endsWith('.markdown')
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
  isDragOver.value = true
}

function onDragLeave(e: DragEvent) {
  e.preventDefault()
  isDragOver.value = false
}

async function onDrop(e: DragEvent) {
  e.preventDefault()
  isDragOver.value = false
  if (!e.dataTransfer?.files) return
  const file = Array.from(e.dataTransfer.files).find(isAcceptedFile)
  if (!file) return
  try {
    const text = await file.text()
    if (activeTab.value === 'html') {
      htmlContent.value = text
      loadedHtmlName.value = file.name
    } else {
      markdownContent.value = text
      loadedMdName.value = file.name
    }
    errorMessage.value = ''
  } catch (err: any) {
    errorMessage.value = '读取文件失败: ' + (err?.message || '未知错误')
  }
}

// ==================== 输出目录 ====================

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

// ==================== 清空内容 ====================

function clearContent() {
  if (isBusy.value) return
  if (activeTab.value === 'html') {
    htmlContent.value = ''
    loadedHtmlName.value = ''
  } else {
    markdownContent.value = ''
    loadedMdName.value = ''
  }
  showResult.value = false
}

// ==================== 构建输出路径 ====================

function buildOutputPath(): string {
  const baseName = sanitizeFileName(outputFileName.value)
  const ext = '.pdf'
  // 统一添加 _易转 后缀，避免文件名冲突（符合项目规范）
  const suffix = baseName.endsWith('_易转') ? '' : '_易转'
  const fullName = `${baseName}${suffix}${ext}`
  if (outputDir.value) {
    const sep = outputDir.value.includes('\\') ? '\\' : '/'
    return `${outputDir.value}${sep}${fullName}`
  } else {
    // 默认保存到下载目录，后端会将相对路径解析为绝对路径
    return fullName
  }
}

// ==================== 执行转换 ====================

async function startConvert() {
  if (!hasContent.value || isBusy.value) return
  if (!outputFileName.value.trim()) {
    errorMessage.value = '请输入输出文件名'
    return
  }

  isBusy.value = true
  errorMessage.value = ''
  showResult.value = false

  const taskId = generateTaskId()
  const outputPath = buildOutputPath()

  try {
    let result: any
    if (activeTab.value === 'html') {
      result = await window.electronAPI.htmlToPdf({
        htmlContent: htmlContent.value,
        outputPath,
        taskId
      })
    } else {
      result = await window.electronAPI.markdownToPdf({
        content: markdownContent.value,
        outputPath,
        taskId
      })
    }

    if (result?.status === 'error') {
      errorMessage.value = '转换失败: ' + (result.message || '未知错误')
      isBusy.value = false
      emit('complete', { status: 'error', output: '', message: errorMessage.value })
      return
    }

    const finalPath = result?.output || outputPath
    resultPath.value = finalPath
    try {
      resultSize.value = await window.electronAPI.getFileSize(finalPath)
    } catch {
      resultSize.value = 0
    }
    showResult.value = true
    isBusy.value = false
    emit('complete', { status: 'success', output: finalPath, message: '转换完成' })
  } catch (err: any) {
    errorMessage.value = '转换失败: ' + (err?.message || '未知错误')
    isBusy.value = false
    emit('complete', { status: 'error', output: '', message: errorMessage.value })
  }
}

// ==================== 打开操作 ====================

function openFile(path: string) {
  window.electronAPI.openFile(path)
}

function openFolder(path: string) {
  window.electronAPI.openFolder(path)
}

function openResultFolder() {
  const dir = outputDir.value || getDirFromPath(resultPath.value)
  if (dir) {
    openFolder(dir)
  } else {
    console.warn('[HtmlToPdfPanel] 无法确定输出目录')
  }
}

// ==================== 切换 Tab ====================

function switchTab(tab: 'html' | 'markdown') {
  if (isBusy.value) return
  activeTab.value = tab
  isDragOver.value = false
}
</script>

<template>
  <section class="html-to-pdf-panel">
    <!-- 头部：标题 + 关闭按钮 -->
    <div class="panel-header">
      <h3 class="panel-title">HTML/MD 转 PDF</h3>
      <div class="header-actions">
        <button
          v-if="hasContent"
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

    <!-- Tab 切换 -->
    <div class="tool-tabs">
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'html' }"
        @click="switchTab('html')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        HTML 转 PDF
      </button>
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'markdown' }"
        @click="switchTab('markdown')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>
        Markdown 转 PDF
      </button>
    </div>

    <!-- 内容编辑区 -->
    <div class="tool-content">
      <div class="action-bar">
        <button
          v-if="activeTab === 'html'"
          class="btn btn-primary"
          @click="triggerLoadHtml"
          :disabled="isBusy"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          选择 .html 文件
        </button>
        <button
          v-else
          class="btn btn-primary"
          @click="triggerLoadMd"
          :disabled="isBusy"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          选择 .md 文件
        </button>
        <button
          v-if="hasContent"
          class="btn btn-ghost"
          @click="clearContent"
          :disabled="isBusy"
        >
          清空内容
        </button>
        <span v-if="activeTab === 'html' && loadedHtmlName" class="loaded-hint">
          已加载: {{ loadedHtmlName }}
        </span>
        <span v-else-if="activeTab === 'markdown' && loadedMdName" class="loaded-hint">
          已加载: {{ loadedMdName }}
        </span>
      </div>

      <!-- 文本编辑区 / 拖拽区 -->
      <div
        class="editor-wrap"
        :class="{ 'drag-active': isDragOver }"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop="onDrop"
      >
        <textarea
          v-if="activeTab === 'html'"
          class="content-editor"
          v-model="htmlContent"
          :disabled="isBusy"
          placeholder="在此粘贴 HTML 内容，或拖拽 .html 文件到此处&#10;&#10;示例：&#10;<h1>标题</h1>&#10;<p>这是一段正文内容。</p>"
          spellcheck="false"
        ></textarea>
        <textarea
          v-else
          class="content-editor"
          v-model="markdownContent"
          :disabled="isBusy"
          placeholder="在此粘贴 Markdown 内容，或拖拽 .md 文件到此处&#10;&#10;示例：&#10;# 标题&#10;&#10;这是一段正文内容。"
          spellcheck="false"
        ></textarea>
      </div>

      <div class="editor-footer">
        <span class="char-count">字符数: {{ charCount }}</span>
        <span class="editor-tip">提示：可直接粘贴内容或拖拽文件加载</span>
      </div>

      <!-- 输出设置 -->
      <div class="output-settings">
        <div class="filename-group">
          <label class="option-label">输出文件名</label>
          <div class="filename-row">
            <input
              type="text"
              class="text-input"
              v-model="outputFileName"
              placeholder="输出文件名（不含扩展名）"
              :disabled="isBusy"
            />
            <span class="filename-ext">.pdf</span>
          </div>
        </div>

        <div class="output-dir-section">
          <label class="option-label">输出目录</label>
          <div class="output-dir-row">
            <button class="btn btn-ghost" @click="selectOutputDir" :disabled="isBusy">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
              {{ outputDir ? '已选择输出目录' : '选择输出目录（可选）' }}
            </button>
            <button v-if="outputDir" class="btn-icon" @click="outputDir = ''" :disabled="isBusy" title="清除">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            <span v-if="!outputDir" class="output-hint">默认保存到应用默认目录</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 转换结果 -->
    <div v-if="showResult" class="result-box">
      <div class="result-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" style="color: var(--accent)"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <span>转换完成</span>
      </div>
      <div class="result-details">
        <div class="result-item">
          <span class="result-label">文件路径</span>
          <span class="result-value path-value" :title="resultPath">{{ resultPath }}</span>
        </div>
        <div class="result-row">
          <div class="result-item">
            <span class="result-label">文件大小</span>
            <span class="result-value">{{ formatSize(resultSize) }}</span>
          </div>
          <div class="result-item">
            <span class="result-label">源格式</span>
            <span class="result-value">{{ activeTab === 'html' ? 'HTML' : 'Markdown' }}</span>
          </div>
        </div>
        <div class="result-actions">
          <button class="btn btn-ghost" @click="openFile(resultPath)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            打开 PDF
          </button>
          <button class="btn btn-ghost" @click="openResultFolder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
            打开文件夹
          </button>
        </div>
      </div>
    </div>

    <!-- 隐藏的文件输入 -->
    <input
      ref="fileInputHtml"
      type="file"
      accept=".html,.htm"
      style="display: none"
      @change="onHtmlFilePicked"
    />
    <input
      ref="fileInputMd"
      type="file"
      accept=".md,.markdown"
      style="display: none"
      @change="onMdFilePicked"
    />
  </section>
</template>

<style scoped>
.html-to-pdf-panel {
  margin-top: 16px;
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

/* ==================== Tab 切换 ==================== */
.tool-tabs {
  display: flex;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 4px;
  margin-bottom: 16px;
}

.tab-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 16px;
  background: transparent;
  border: none;
  border-radius: calc(var(--radius-sm) - 2px);
  font-size: 14px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  transition: all 0.2s;
}

.tab-btn:hover {
  color: var(--ink);
}

.tab-btn.active {
  background: var(--accent);
  color: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.tab-btn svg {
  flex-shrink: 0;
}

/* ==================== 通用按钮 ==================== */
.action-bar {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
  align-items: center;
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

.loaded-hint {
  font-size: 12px;
  color: var(--accent);
  font-weight: 500;
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

/* ==================== 工具内容区 ==================== */
.tool-content {
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ==================== 编辑器 ==================== */
.editor-wrap {
  border: 2px dashed var(--border);
  border-radius: var(--radius-sm);
  transition: all 0.2s;
  background: #fff;
}

.editor-wrap.drag-active {
  border-color: var(--accent);
  background: rgba(124, 92, 252, 0.04);
}

.content-editor {
  width: 100%;
  box-sizing: border-box;
  min-height: 220px;
  max-height: 360px;
  padding: 14px;
  border: none;
  border-radius: var(--radius-sm);
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink);
  background: transparent;
  outline: none;
  resize: vertical;
}

.content-editor::placeholder {
  color: var(--muted);
  opacity: 0.7;
}

.content-editor:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.editor-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  margin-bottom: 16px;
}

.char-count {
  font-size: 12px;
  color: var(--muted);
  font-weight: 500;
}

.editor-tip {
  font-size: 12px;
  color: var(--muted);
}

/* ==================== 输出设置 ==================== */
.output-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.option-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 8px;
}

.filename-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filename-row .text-input {
  flex: 1;
}

.text-input {
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 14px;
  color: var(--ink);
  background: #fff;
  outline: none;
  transition: border-color 0.2s;
  box-sizing: border-box;
}

.text-input:focus {
  border-color: var(--accent);
}

.text-input:disabled {
  background: var(--surface);
  cursor: not-allowed;
}

.filename-ext {
  font-size: 14px;
  font-weight: 600;
  color: var(--muted);
  flex-shrink: 0;
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

.result-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 8px;
}

.result-row {
  display: flex;
  gap: 24px;
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

.path-value {
  word-break: break-all;
}

.result-actions {
  margin-top: 12px;
  display: flex;
  gap: 10px;
  justify-content: center;
}
</style>
