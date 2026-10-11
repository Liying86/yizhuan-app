<script setup lang="ts">
import { ref, computed } from 'vue'

const props = defineProps<{
  defaultTab?: 'merge' | 'split' | 'compress' | 'encrypt' | 'decrypt'
}>()

const emit = defineEmits<{
  (e: 'complete', result: any): void
  (e: 'close'): void
}>()

// 生成唯一 taskId
function generateTaskId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

// 当前活跃的子 Tab
const activeTool = ref<'merge' | 'split' | 'compress' | 'encrypt' | 'decrypt'>(props.defaultTab || 'merge')

// 错误提示消息
const errorMessage = ref('')

// ==================== PDF 合并状态 ====================
const mergeFiles = ref<Array<{ path: string; name: string; pages: number }>>([])
const mergeBusy = ref(false)
const mergeResult = ref<{ filePath: string; totalPages: number; fileSize: number } | null>(null)
const mergeOutputDir = ref<string>('')

// 拖拽排序相关
const dragIndex = ref<number | null>(null)
const dropIndex = ref<number | null>(null)

// ==================== PDF 拆分状态 ====================
const splitFile = ref<{ path: string; name: string; pages: number; size: number } | null>(null)
// 拆分模式：each(逐页) | range(按范围) | interval(固定间隔) | extract(指定页码) | content(按内容)
const splitMode = ref<'each' | 'range' | 'interval' | 'extract' | 'content'>('each')
const splitOptions = ref({ start: 1, end: 1, pagesPerFile: 1, pages: '', keyword: '' })
const splitBusy = ref(false)
const splitResult = ref<Array<{ name: string; path: string; pages: number }> | null>(null)

// ==================== PDF 合并方法 ====================

// 拖拽状态
const mergeDragOver = ref(false)
const splitDragOver = ref(false)

async function selectMergeFiles() {
  try {
    const result = await window.electronAPI.selectFiles({
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      multi: true
    })
    if (!result || result.length === 0) return
    await addMergeFiles(result)
  } catch {
    // 用户取消选择
  }
}

async function addMergeFiles(filePaths: string[]) {
  for (const filePath of filePaths) {
    if (mergeFiles.value.some(f => f.path === filePath)) continue

    try {
      const info = await window.electronAPI.getPdfInfo(filePath)
      mergeFiles.value.push({
        path: filePath,
        name: filePath.split(/[/\\]/).pop() || '未知文件',
        pages: (info?.status === 'success' ? info.pages : 0) || 0
      })
    } catch {
      mergeFiles.value.push({
        path: filePath,
        name: filePath.split(/[/\\]/).pop() || '未知文件',
        pages: 0
      })
    }
  }
}

async function onMergeDrop(e: DragEvent) {
  e.preventDefault()
  mergeDragOver.value = false
  if (!e.dataTransfer?.files) return
  const pdfFiles = Array.from(e.dataTransfer.files)
    .map(f => window.electronAPI.getFilePathForFile(f))
    .filter(p => p && p.toLowerCase().endsWith('.pdf'))
  if (pdfFiles.length > 0) {
    await addMergeFiles(pdfFiles)
  }
}

async function selectMergeOutputDir() {
  try {
    const result = await window.electronAPI.selectFolder()
    if (result) {
      mergeOutputDir.value = result
    }
  } catch {
    // 用户取消选择
  }
}

function removeMergeFile(index: number) {
  mergeFiles.value.splice(index, 1)
}

function clearMergeFiles() {
  mergeFiles.value = []
  mergeResult.value = null
}

// 拖拽排序事件处理
function onDragStart(index: number) {
  dragIndex.value = index
}

function onDragOver(e: DragEvent, index: number) {
  e.preventDefault()
  // 只在内部排序拖拽时显示排序指示器（外部文件拖入时不显示）
  if (dragIndex.value !== null) {
    dropIndex.value = index
  }
}

function onDrop(e: DragEvent, index: number) {
  // 外部文件拖入时不处理排序，让事件冒泡到容器的 onMergeDrop
  if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
    return
  }
  e.preventDefault()
  e.stopPropagation()
  if (dragIndex.value !== null && dragIndex.value !== index) {
    const item = mergeFiles.value.splice(dragIndex.value, 1)[0]
    mergeFiles.value.splice(index, 0, item)
  }
  dragIndex.value = null
  dropIndex.value = null
}

function onDragEnd() {
  dragIndex.value = null
  dropIndex.value = null
}

async function doMerge() {
  if (mergeFiles.value.length < 2) return
  mergeBusy.value = true
  mergeResult.value = null
  errorMessage.value = ''

  try {
    const taskId = generateTaskId()
    const outputPath = mergeOutputDir.value || ''
    const result = await window.electronAPI.mergePdfs({
      taskId,
      filePaths: mergeFiles.value.map(f => f.path),
      outputPath: outputPath
    })

    if (result?.status === 'error') {
      console.error('PDF 合并失败:', result.message)
      errorMessage.value = '合并失败: ' + (result.message || '未知错误')
      mergeBusy.value = false
      return
    }

    mergeResult.value = {
      filePath: result?.output || '',
      totalPages: result?.totalPages || mergeFiles.value.reduce((sum, f) => sum + f.pages, 0),
      fileSize: result?.size || 0
    }
    emit('complete', { type: 'merge', result: mergeResult.value })
  } catch (err: any) {
    console.error('PDF 合并失败:', err)
    errorMessage.value = '合并失败: ' + (err.message || '未知错误')
  } finally {
    mergeBusy.value = false
  }
}

// ==================== PDF 压缩状态 ====================
const compressFile = ref<{ path: string; name: string; size: number } | null>(null)
const compressLevel = ref<'low' | 'medium' | 'high'>('medium')
const compressBusy = ref(false)
const compressResult = ref<{ filePath: string; originalSize: number; newSize: number; reduction: string } | null>(null)
const compressDragOver = ref(false)

// ==================== PDF 加密状态 ====================
const encryptFile = ref<{ path: string; name: string; size: number } | null>(null)
const encryptPassword = ref('')
const encryptConfirmPassword = ref('')
const encryptBusy = ref(false)
const encryptResult = ref<{ filePath: string; size: number } | null>(null)
const encryptDragOver = ref(false)

// ==================== PDF 解密状态 ====================
const decryptFile = ref<{ path: string; name: string; size: number } | null>(null)
const decryptPassword = ref('')
const decryptBusy = ref(false)
const decryptResult = ref<{ filePath: string; size: number } | null>(null)
const decryptDragOver = ref(false)

// ==================== PDF 拆分方法 ====================

async function selectSplitFile() {
  try {
    errorMessage.value = ''
    const result = await window.electronAPI.selectFiles({
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      multi: false
    })
    console.log('[PdfToolsPanel] selectSplitFile result:', result)
    if (!result || result.length === 0) {
      console.log('[PdfToolsPanel] 用户取消选择或未选中文件')
      return
    }
    await setSplitFile(result[0])
  } catch (err: any) {
    console.error('[PdfToolsPanel] 选择拆分文件失败:', err)
    errorMessage.value = '选择文件失败: ' + (err.message || '未知错误')
  }
}

async function setSplitFile(filePath: string) {
  try {
    const info = await window.electronAPI.getPdfInfo(filePath)
    if (!info || info.status === 'error') {
      // PDF 信息获取失败，仍显示文件，但页数为 0
      console.warn('[PdfToolsPanel] 获取 PDF 信息失败:', info?.message)
      splitFile.value = {
        path: filePath,
        name: filePath.split(/[/\\]/).pop() || '未知文件',
        pages: 0,
        size: 0
      }
      splitOptions.value.end = 1
      splitOptions.value.start = 1
      splitOptions.value.pagesPerFile = 1
      splitResult.value = null
      errorMessage.value = '无法读取 PDF 文件信息，请确认文件是否有效'
      return
    }
    splitFile.value = {
      path: filePath,
      name: filePath.split(/[/\\]/).pop() || '未知文件',
      pages: info.pages || 0,
      size: info.size || 0
    }
    splitOptions.value.end = info.pages || 1
    splitOptions.value.start = 1
    splitOptions.value.pagesPerFile = 1
    splitResult.value = null
    errorMessage.value = ''
  } catch (err: any) {
    console.error('[PdfToolsPanel] 设置拆分文件失败:', err)
    splitFile.value = {
      path: filePath,
      name: filePath.split(/[/\\]/).pop() || '未知文件',
      pages: 0,
      size: 0
    }
    errorMessage.value = '加载文件失败: ' + (err.message || '未知错误')
  }
}

async function onSplitDrop(e: DragEvent) {
  e.preventDefault()
  splitDragOver.value = false
  if (!e.dataTransfer?.files) return
  const pdfFile = Array.from(e.dataTransfer.files)
    .map(f => window.electronAPI.getFilePathForFile(f))
    .find(p => p && p.toLowerCase().endsWith('.pdf'))
  if (pdfFile) {
    await setSplitFile(pdfFile)
  }
}

async function doSplit() {
  if (!splitFile.value) return
  splitBusy.value = true
  splitResult.value = null
  errorMessage.value = ''

  try {
    const taskId = generateTaskId()

    // IPC handler 期望 { inputPath, outputDir, taskId, mode, options? }
    // start/end/pagesPerFile/pages 必须放在 options 子对象中
    const splitOptionsParam: any = {}

    if (splitMode.value === 'range') {
      splitOptionsParam.start = splitOptions.value.start
      splitOptionsParam.end = splitOptions.value.end
    } else if (splitMode.value === 'interval') {
      splitOptionsParam.pagesPerFile = splitOptions.value.pagesPerFile
    } else if (splitMode.value === 'extract') {
      // 后端期望 number[]，将 "1,3,5-8" 字符串解析为页码数组
      splitOptionsParam.pages = parsePageString(splitOptions.value.pages)
    } else if (splitMode.value === 'content') {
      // 按内容拆分：后端接收 keyword 字符串
      splitOptionsParam.keyword = splitOptions.value.keyword
    }

    console.log('[PdfToolsPanel] 开始拆分:', {
      file: splitFile.value.name,
      mode: splitMode.value,
      options: splitOptionsParam
    })

    const result = await window.electronAPI.splitPdf({
      taskId,
      inputPath: splitFile.value.path,
      outputDir: '',
      mode: splitMode.value,
      options: splitOptionsParam
    })

    console.log('[PdfToolsPanel] 拆分结果:', result)

    if (result?.status === 'error') {
      console.error('PDF 拆分失败:', result.message)
      errorMessage.value = '拆分失败: ' + (result.message || '未知错误')
      splitBusy.value = false
      return
    }

    splitResult.value = (result?.items || []).map(item => ({
      name: item.output.split(/[/\\]/).pop() || '',
      path: item.output,
      pages: item.pages
    }))
    emit('complete', { type: 'split', result: splitResult.value })
  } catch (err: any) {
    console.error('PDF 拆分失败:', err)
    errorMessage.value = '拆分失败: ' + (err.message || '未知错误')
  } finally {
    splitBusy.value = false
  }
}

/** 将 "1,3,5-8" 格式的页码字符串解析为 1-based 数字数组 */
function parsePageString(pageStr: string): number[] {
  const result: number[] = []
  const parts = pageStr.split(',').map(s => s.trim()).filter(Boolean)
  for (const part of parts) {
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-').map(s => s.trim())
      const start = parseInt(startStr, 10)
      const end = parseInt(endStr, 10)
      if (!isNaN(start) && !isNaN(end)) {
        for (let p = start; p <= end; p++) {
          if (!result.includes(p)) result.push(p)
        }
      }
    } else {
      const p = parseInt(part, 10)
      if (!isNaN(p) && !result.includes(p)) result.push(p)
    }
  }
  return result.sort((a, b) => a - b)
}

function clearSplitFile() {
  splitFile.value = null
  splitResult.value = null
  splitMode.value = 'each'
  splitOptions.value = { start: 1, end: 1, pagesPerFile: 1, pages: '', keyword: '' }
  errorMessage.value = ''
}

// ==================== PDF 压缩方法 ====================

async function selectCompressFile() {
  try {
    errorMessage.value = ''
    const result = await window.electronAPI.selectFiles({
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      multi: false
    })
    if (!result || result.length === 0) return
    await setCompressFile(result[0])
  } catch {
    // 用户取消选择
  }
}

async function setCompressFile(filePath: string) {
  try {
    const size = await window.electronAPI.getFileSize(filePath)
    compressFile.value = {
      path: filePath,
      name: filePath.split(/[/\\]/).pop() || '未知文件',
      size: size || 0
    }
    compressResult.value = null
    errorMessage.value = ''
  } catch (err: any) {
    compressFile.value = {
      path: filePath,
      name: filePath.split(/[/\\]/).pop() || '未知文件',
      size: 0
    }
    errorMessage.value = '加载文件失败: ' + (err.message || '未知错误')
  }
}

async function onCompressDrop(e: DragEvent) {
  e.preventDefault()
  compressDragOver.value = false
  if (!e.dataTransfer?.files) return
  const pdfFile = Array.from(e.dataTransfer.files)
    .map(f => window.electronAPI.getFilePathForFile(f))
    .find(p => p && p.toLowerCase().endsWith('.pdf'))
  if (pdfFile) {
    await setCompressFile(pdfFile)
  }
}

async function doCompress() {
  if (!compressFile.value) return
  compressBusy.value = true
  compressResult.value = null
  errorMessage.value = ''

  try {
    const outputPath = compressFile.value.path.replace(/\.pdf$/i, '_compressed.pdf')
    const result = await window.electronAPI.compressPdf({
      inputPath: compressFile.value.path,
      outputPath,
      level: compressLevel.value
    })

    if (result?.status === 'error') {
      errorMessage.value = '压缩失败: ' + (result.message || '未知错误')
      compressBusy.value = false
      return
    }

    const originalSize = compressFile.value.size
    const newSize = result?.size || 0
    const reduction = originalSize > 0 ? ((originalSize - newSize) / originalSize * 100).toFixed(1) : '0.0'

    compressResult.value = {
      filePath: result?.output || '',
      originalSize,
      newSize,
      reduction
    }
    emit('complete', { type: 'compress', result: compressResult.value })
  } catch (err: any) {
    errorMessage.value = '压缩失败: ' + (err.message || '未知错误')
  } finally {
    compressBusy.value = false
  }
}

function clearCompressFile() {
  compressFile.value = null
  compressResult.value = null
  compressLevel.value = 'medium'
  errorMessage.value = ''
}

// ==================== PDF 加密方法 ====================

async function selectEncryptFile() {
  try {
    errorMessage.value = ''
    const result = await window.electronAPI.selectFiles({
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      multi: false
    })
    if (!result || result.length === 0) return
    await setEncryptFile(result[0])
  } catch {
    // 用户取消选择
  }
}

async function setEncryptFile(filePath: string) {
  try {
    const size = await window.electronAPI.getFileSize(filePath)
    encryptFile.value = {
      path: filePath,
      name: filePath.split(/[/\\]/).pop() || '未知文件',
      size: size || 0
    }
    encryptResult.value = null
    encryptPassword.value = ''
    encryptConfirmPassword.value = ''
    errorMessage.value = ''
  } catch (err: any) {
    encryptFile.value = {
      path: filePath,
      name: filePath.split(/[/\\]/).pop() || '未知文件',
      size: 0
    }
    errorMessage.value = '加载文件失败: ' + (err.message || '未知错误')
  }
}

async function onEncryptDrop(e: DragEvent) {
  e.preventDefault()
  encryptDragOver.value = false
  if (!e.dataTransfer?.files) return
  const pdfFile = Array.from(e.dataTransfer.files)
    .map(f => window.electronAPI.getFilePathForFile(f))
    .find(p => p && p.toLowerCase().endsWith('.pdf'))
  if (pdfFile) {
    await setEncryptFile(pdfFile)
  }
}

async function doEncrypt() {
  if (!encryptFile.value) return
  if (!encryptPassword.value) {
    errorMessage.value = '请输入密码'
    return
  }
  if (encryptPassword.value !== encryptConfirmPassword.value) {
    errorMessage.value = '两次输入的密码不一致'
    return
  }
  if (encryptPassword.value.length < 1) {
    errorMessage.value = '密码不能为空'
    return
  }

  encryptBusy.value = true
  encryptResult.value = null
  errorMessage.value = ''

  try {
    const outputPath = encryptFile.value.path.replace(/\.pdf$/i, '_encrypted.pdf')
    const result = await window.electronAPI.encryptPdf({
      inputPath: encryptFile.value.path,
      outputPath,
      password: encryptPassword.value
    })

    if (result?.status === 'error') {
      errorMessage.value = '加密失败: ' + (result.message || '未知错误')
      encryptBusy.value = false
      return
    }

    encryptResult.value = {
      filePath: result?.output || '',
      size: result?.size || 0
    }
    emit('complete', { type: 'encrypt', result: encryptResult.value })
  } catch (err: any) {
    errorMessage.value = '加密失败: ' + (err.message || '未知错误')
  } finally {
    encryptBusy.value = false
  }
}

function clearEncryptFile() {
  encryptFile.value = null
  encryptResult.value = null
  encryptPassword.value = ''
  encryptConfirmPassword.value = ''
  errorMessage.value = ''
}

// ==================== PDF 解密方法 ====================

async function selectDecryptFile() {
  try {
    errorMessage.value = ''
    const result = await window.electronAPI.selectFiles({
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      multi: false
    })
    if (!result || result.length === 0) return
    await setDecryptFile(result[0])
  } catch {
    // 用户取消选择
  }
}

async function setDecryptFile(filePath: string) {
  try {
    const size = await window.electronAPI.getFileSize(filePath)
    decryptFile.value = {
      path: filePath,
      name: filePath.split(/[/\\]/).pop() || '未知文件',
      size: size || 0
    }
    decryptResult.value = null
    decryptPassword.value = ''
    errorMessage.value = ''
  } catch (err: any) {
    decryptFile.value = {
      path: filePath,
      name: filePath.split(/[/\\]/).pop() || '未知文件',
      size: 0
    }
    errorMessage.value = '加载文件失败: ' + (err.message || '未知错误')
  }
}

async function onDecryptDrop(e: DragEvent) {
  e.preventDefault()
  decryptDragOver.value = false
  if (!e.dataTransfer?.files) return
  const pdfFile = Array.from(e.dataTransfer.files)
    .map(f => window.electronAPI.getFilePathForFile(f))
    .find(p => p && p.toLowerCase().endsWith('.pdf'))
  if (pdfFile) {
    await setDecryptFile(pdfFile)
  }
}

async function doDecrypt() {
  if (!decryptFile.value) return
  if (!decryptPassword.value) {
    errorMessage.value = '请输入密码'
    return
  }

  decryptBusy.value = true
  decryptResult.value = null
  errorMessage.value = ''

  try {
    const outputPath = decryptFile.value.path.replace(/\.pdf$/i, '_decrypted.pdf')
    const result = await window.electronAPI.decryptPdf({
      inputPath: decryptFile.value.path,
      outputPath,
      password: decryptPassword.value
    })

    if (result?.status === 'error') {
      errorMessage.value = '解密失败: ' + (result.message || '未知错误')
      decryptBusy.value = false
      return
    }

    decryptResult.value = {
      filePath: result?.output || '',
      size: result?.size || 0
    }
    emit('complete', { type: 'decrypt', result: decryptResult.value })
  } catch (err: any) {
    errorMessage.value = '解密失败: ' + (err.message || '未知错误')
  } finally {
    decryptBusy.value = false
  }
}

function clearDecryptFile() {
  decryptFile.value = null
  decryptResult.value = null
  decryptPassword.value = ''
  errorMessage.value = ''
}

// ==================== 辅助方法 ====================

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}
</script>

<template>
  <section class="pdf-tools-panel">
    <!-- 头部：标题 + 关闭按钮 -->
    <div class="panel-header">
      <h3 class="panel-title">PDF 工具</h3>
      <div class="header-actions">
        <button
          v-if="activeTool === 'merge' && mergeFiles.length > 0"
          class="btn btn-primary btn-start-header"
          :disabled="mergeBusy || mergeFiles.length < 2"
          @click="doMerge"
        >
          <span v-if="mergeBusy" class="spinner spinner-sm"></span>
          {{ mergeBusy ? '合并中...' : '开始合并' }}
        </button>
        <button
          v-if="activeTool === 'split' && splitFile"
          class="btn btn-primary btn-start-header"
          :disabled="splitBusy"
          @click="doSplit"
        >
          <span v-if="splitBusy" class="spinner spinner-sm"></span>
          {{ splitBusy ? '拆分中...' : '开始拆分' }}
        </button>
        <button
          v-if="activeTool === 'compress' && compressFile"
          class="btn btn-primary btn-start-header"
          :disabled="compressBusy"
          @click="doCompress"
        >
          <span v-if="compressBusy" class="spinner spinner-sm"></span>
          {{ compressBusy ? '压缩中...' : '开始压缩' }}
        </button>
        <button
          v-if="activeTool === 'encrypt' && encryptFile"
          class="btn btn-primary btn-start-header"
          :disabled="encryptBusy || !encryptPassword || encryptPassword !== encryptConfirmPassword"
          @click="doEncrypt"
        >
          <span v-if="encryptBusy" class="spinner spinner-sm"></span>
          {{ encryptBusy ? '加密中...' : '开始加密' }}
        </button>
        <button
          v-if="activeTool === 'decrypt' && decryptFile"
          class="btn btn-primary btn-start-header"
          :disabled="decryptBusy || !decryptPassword"
          @click="doDecrypt"
        >
          <span v-if="decryptBusy" class="spinner spinner-sm"></span>
          {{ decryptBusy ? '解密中...' : '开始解密' }}
        </button>
        <button class="close-btn" @click="emit('close')" title="关闭">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>
    <!-- Tab 切换 -->
    <div class="tool-tabs">
      <button
        class="tab-btn"
        :class="{ active: activeTool === 'merge' }"
        @click="activeTool = 'merge'"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M5 6h14M5 10h14M12 14h7M12 18h7"/></svg>
        PDF 合并
      </button>
      <button
        class="tab-btn"
        :class="{ active: activeTool === 'split' }"
        @click="activeTool = 'split'"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h.01M8 17h.01M12 13h4v4h-4z"/></svg>
        PDF 拆分
      </button>
      <button
        class="tab-btn"
        :class="{ active: activeTool === 'compress' }"
        @click="activeTool = 'compress'"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M4 14.899A7 7 0 1115.71 8h1.79a4.5 4.5 0 015 5H19"/><path d="M12 12v9M8 17l4-4 4 4"/></svg>
        PDF 压缩
      </button>
      <button
        class="tab-btn"
        :class="{ active: activeTool === 'encrypt' }"
        @click="activeTool = 'encrypt'"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
        PDF 加密
      </button>
      <button
        class="tab-btn"
        :class="{ active: activeTool === 'decrypt' }"
        @click="activeTool = 'decrypt'"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/><path d="M12 16l1 1-1 1"/></svg>
        PDF 解密
      </button>
    </div>

    <!-- ==================== PDF 合并 ==================== -->
    <div v-if="activeTool === 'merge'" class="tool-content">
      <!-- 模式标识 -->
      <div class="tool-mode-badge">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M5 6h14M5 10h14M12 14h7M12 18h7"/></svg>
        <span>PDF 合并模式</span>
        <span class="mode-badge-hint">将多个 PDF 文件合并为一个</span>
      </div>
      <!-- 错误提示 -->
      <div v-if="errorMessage" class="error-banner">
        {{ errorMessage }}
      </div>
      <!-- 选择文件按钮 -->
      <div class="action-bar">
        <button class="btn btn-primary" @click="selectMergeFiles">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          添加 PDF 文件
        </button>
        <button v-if="mergeFiles.length > 0" class="btn btn-ghost" @click="selectMergeOutputDir">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
          {{ mergeOutputDir ? '输出目录已选' : '选择输出目录' }}
        </button>
      </div>

      <!-- 文件列表 -->
      <div v-if="mergeFiles.length > 0" class="file-list"
        @dragover.prevent
        @drop="onMergeDrop"
      >
        <div class="file-list-header">
          <span class="file-list-title">已选文件 ({{ mergeFiles.length }})</span>
          <div class="file-list-actions">
            <button class="btn btn-ghost btn-sm" @click="selectMergeFiles" :disabled="mergeBusy">追加文件</button>
            <button class="btn btn-ghost btn-sm" @click="clearMergeFiles" :disabled="mergeBusy">清空</button>
          </div>
        </div>
        <div
          v-for="(file, index) in mergeFiles"
          :key="file.path"
          class="file-item"
          :class="{
            'dragging': dragIndex === index,
            'drag-over': dropIndex === index && dragIndex !== index
          }"
          draggable="true"
          @dragstart="onDragStart(index)"
          @dragover="onDragOver($event, index)"
          @drop="onDrop($event, index)"
          @dragend="onDragEnd"
        >
          <span class="drag-handle" title="拖拽排序">
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>
          </span>
          <span class="file-index">{{ index + 1 }}</span>
          <div class="file-info">
            <span class="file-name" :title="file.name">{{ file.name }}</span>
            <span class="file-meta">{{ file.pages }} 页</span>
          </div>
          <button class="btn-icon btn-remove" @click="removeMergeFile(index)" title="移除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>

      <!-- 空状态 -->
      <div
        v-else
        class="empty-state drop-zone"
        :class="{ 'drag-active': mergeDragOver }"
        @click="selectMergeFiles"
        @dragover.prevent="mergeDragOver = true"
        @dragleave.prevent="mergeDragOver = false"
        @drop="onMergeDrop"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M5 6h14M5 10h14M12 14h7"/></svg>
        <p>点击选择或拖拽 PDF 文件到此处</p>
        <span class="empty-hint">支持拖拽排序调整合并顺序</span>
      </div>

      <!-- 合并结果 -->
      <div v-if="mergeResult" class="result-box">
        <div class="result-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" style="color: var(--accent)"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          <span>合并完成</span>
        </div>
        <div class="result-details">
          <div class="result-item">
            <span class="result-label">文件路径</span>
            <span class="result-value path-value" :title="mergeResult.filePath">{{ mergeResult.filePath }}</span>
          </div>
          <div class="result-row">
            <div class="result-item">
              <span class="result-label">总页数</span>
              <span class="result-value">{{ mergeResult.totalPages }} 页</span>
            </div>
            <div class="result-item">
              <span class="result-label">文件大小</span>
              <span class="result-value">{{ formatSize(mergeResult.fileSize) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== PDF 拆分 ==================== -->
    <div v-if="activeTool === 'split'" class="tool-content">
      <!-- 模式标识 -->
      <div class="tool-mode-badge">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h.01M8 17h.01M12 13h4v4h-4z"/></svg>
        <span>PDF 拆分模式</span>
        <span class="mode-badge-hint">将一个 PDF 文件拆分为多个文件</span>
      </div>
      <!-- 错误提示 -->
      <div v-if="errorMessage" class="error-banner">
        {{ errorMessage }}
      </div>
      <!-- 选择文件 -->
      <div class="action-bar">
        <button class="btn btn-primary" @click="selectSplitFile">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          选择 PDF 文件
        </button>
      </div>

      <!-- 文件信息 -->
      <div v-if="splitFile" class="file-info-card">
        <div class="file-info-card-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"/><path d="M14 2v6h6"/></svg>
        </div>
        <div class="file-info-card-content">
          <span class="file-info-card-name" :title="splitFile.name">{{ splitFile.name }}</span>
          <div class="file-info-card-meta">
            <span>{{ splitFile.pages }} 页</span>
            <span class="meta-divider">|</span>
            <span>{{ formatSize(splitFile.size) }}</span>
          </div>
        </div>
        <button class="btn-icon btn-remove" @click="clearSplitFile" :disabled="splitBusy" title="移除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <!-- 拆分模式 -->
      <div v-if="splitFile" class="split-options">
        <span class="option-label">拆分模式</span>
        <div class="mode-grid">
          <label class="mode-option" :class="{ active: splitMode === 'each' }">
            <input type="radio" v-model="splitMode" value="each" />
            <span class="mode-label">逐页拆分</span>
            <span class="mode-desc">每页生成一个文件</span>
          </label>
          <label class="mode-option" :class="{ active: splitMode === 'range' }">
            <input type="radio" v-model="splitMode" value="range" />
            <span class="mode-label">按范围拆分</span>
            <span class="mode-desc">提取指定页范围</span>
          </label>
          <label class="mode-option" :class="{ active: splitMode === 'interval' }">
            <input type="radio" v-model="splitMode" value="interval" />
            <span class="mode-label">固定间隔</span>
            <span class="mode-desc">每 N 页拆分一次</span>
          </label>
          <label class="mode-option" :class="{ active: splitMode === 'extract' }">
            <input type="radio" v-model="splitMode" value="extract" />
            <span class="mode-label">提取指定页</span>
            <span class="mode-desc">如 1,3,5-8</span>
          </label>
          <label class="mode-option" :class="{ active: splitMode === 'content' }">
            <input type="radio" v-model="splitMode" value="content" />
            <span class="mode-label">按内容拆分</span>
            <span class="mode-desc">按关键词拆分为多个文件</span>
          </label>
        </div>

        <!-- 范围输入 -->
        <div v-if="splitMode === 'range'" class="option-inputs">
          <div class="input-group">
            <label>起始页</label>
            <input type="number" v-model.number="splitOptions.start" :min="1" :max="splitFile.pages" />
          </div>
          <span class="input-sep">至</span>
          <div class="input-group">
            <label>结束页</label>
            <input type="number" v-model.number="splitOptions.end" :min="1" :max="splitFile.pages" />
          </div>
        </div>

        <!-- 间隔输入 -->
        <div v-if="splitMode === 'interval'" class="option-inputs">
          <div class="input-group">
            <label>每 N 页拆分</label>
            <input type="number" v-model.number="splitOptions.pagesPerFile" :min="1" :max="splitFile.pages" />
          </div>
        </div>

        <!-- 指定页输入 -->
        <div v-if="splitMode === 'extract'" class="option-inputs">
          <div class="input-group full">
            <label>页码（支持格式: 1,3,5-8）</label>
            <input type="text" v-model="splitOptions.pages" placeholder="例如: 1,3,5-8" />
          </div>
        </div>

        <!-- 按内容拆分 -->
        <div v-if="splitMode === 'content'" class="option-inputs">
          <div class="input-group full">
            <label>关键词（在包含此关键词的页面处拆分，如: 第一章）</label>
            <input type="text" v-model="splitOptions.keyword" placeholder="例如: 第一章、第1章、Chapter" />
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div
        v-if="!splitFile"
        class="empty-state drop-zone"
        :class="{ 'drag-active': splitDragOver }"
        @click="selectSplitFile"
        @dragover.prevent="splitDragOver = true"
        @dragleave.prevent="splitDragOver = false"
        @drop="onSplitDrop"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"/><path d="M14 2v6h6"/><path d="M8 13h.01M8 17h.01M12 13h4v4h-4z"/></svg>
        <p>点击选择或拖拽 PDF 文件到此处</p>
        <span class="empty-hint">支持逐页、按范围、固定间隔、提取指定页和按内容拆分</span>
      </div>

      <!-- 拆分结果 -->
      <div v-if="splitResult && splitResult.length > 0" class="result-box">
        <div class="result-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" style="color: var(--accent)"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          <span>拆分完成 ({{ splitResult.length }} 个文件)</span>
        </div>
        <div class="result-file-list">
          <div v-for="file in splitResult" :key="file.path" class="result-file-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="color: var(--muted)"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"/><path d="M14 2v6h6"/></svg>
            <span class="result-file-name" :title="file.path">{{ file.name }}</span>
            <span class="result-file-meta">{{ file.pages }} 页</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== PDF 压缩 ==================== -->
    <div v-if="activeTool === 'compress'" class="tool-content">
      <div class="tool-mode-badge">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M4 14.899A7 7 0 1115.71 8h1.79a4.5 4.5 0 015 5H19"/><path d="M12 12v9M8 17l4-4 4 4"/></svg>
        <span>PDF 压缩模式</span>
        <span class="mode-badge-hint">减小 PDF 文件体积</span>
      </div>
      <div v-if="errorMessage" class="error-banner">{{ errorMessage }}</div>
      <div class="action-bar">
        <button class="btn btn-primary" @click="selectCompressFile">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          选择 PDF 文件
        </button>
      </div>
      <div v-if="compressFile" class="file-info-card">
        <div class="file-info-card-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"/><path d="M14 2v6h6"/></svg>
        </div>
        <div class="file-info-card-content">
          <span class="file-info-card-name" :title="compressFile.name">{{ compressFile.name }}</span>
          <div class="file-info-card-meta">
            <span>{{ formatSize(compressFile.size) }}</span>
          </div>
        </div>
        <button class="btn-icon btn-remove" @click="clearCompressFile" :disabled="compressBusy" title="移除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div v-if="compressFile" class="compress-options">
        <span class="option-label">压缩级别</span>
        <div class="mode-grid">
          <label class="mode-option" :class="{ active: compressLevel === 'low' }">
            <input type="radio" v-model="compressLevel" value="low" />
            <span class="mode-label">轻度压缩</span>
            <span class="mode-desc">画质损失较小</span>
          </label>
          <label class="mode-option" :class="{ active: compressLevel === 'medium' }">
            <input type="radio" v-model="compressLevel" value="medium" />
            <span class="mode-label">标准压缩</span>
            <span class="mode-desc">平衡画质与体积</span>
          </label>
          <label class="mode-option" :class="{ active: compressLevel === 'high' }">
            <input type="radio" v-model="compressLevel" value="high" />
            <span class="mode-label">深度压缩</span>
            <span class="mode-desc">最小体积</span>
          </label>
        </div>
      </div>
      <div v-if="!compressFile" class="empty-state drop-zone" :class="{ 'drag-active': compressDragOver }" @click="selectCompressFile" @dragover.prevent="compressDragOver = true" @dragleave.prevent="compressDragOver = false" @drop="onCompressDrop">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48"><path d="M4 14.899A7 7 0 1115.71 8h1.79a4.5 4.5 0 015 5H19"/><path d="M12 12v9M8 17l4-4 4 4"/></svg>
        <p>点击选择或拖拽 PDF 文件到此处</p>
        <span class="empty-hint">支持轻度、标准、深度三种压缩级别</span>
      </div>
      <div v-if="compressResult" class="result-box">
        <div class="result-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" style="color: var(--accent)"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          <span>压缩完成</span>
        </div>
        <div class="result-details">
          <div class="result-item"><span class="result-label">文件路径</span><span class="result-value path-value" :title="compressResult.filePath">{{ compressResult.filePath }}</span></div>
          <div class="result-row">
            <div class="result-item"><span class="result-label">原大小</span><span class="result-value">{{ formatSize(compressResult.originalSize) }}</span></div>
            <div class="result-item"><span class="result-label">压缩后</span><span class="result-value">{{ formatSize(compressResult.newSize) }}</span></div>
            <div class="result-item"><span class="result-label">减小比例</span><span class="result-value" style="color: var(--accent)">{{ compressResult.reduction }}%</span></div>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== PDF 加密 ==================== -->
    <div v-if="activeTool === 'encrypt'" class="tool-content">
      <div class="tool-mode-badge">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
        <span>PDF 加密模式</span>
        <span class="mode-badge-hint">为 PDF 文件设置打开密码</span>
      </div>
      <div v-if="errorMessage" class="error-banner">{{ errorMessage }}</div>
      <div class="action-bar">
        <button class="btn btn-primary" @click="selectEncryptFile">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          选择 PDF 文件
        </button>
      </div>
      <div v-if="encryptFile" class="file-info-card">
        <div class="file-info-card-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"/><path d="M14 2v6h6"/></svg>
        </div>
        <div class="file-info-card-content">
          <span class="file-info-card-name" :title="encryptFile.name">{{ encryptFile.name }}</span>
          <div class="file-info-card-meta"><span>{{ formatSize(encryptFile.size) }}</span></div>
        </div>
        <button class="btn-icon btn-remove" @click="clearEncryptFile" :disabled="encryptBusy" title="移除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div v-if="encryptFile" class="encrypt-options">
        <div class="input-group full">
          <label>设置密码</label>
          <input type="password" v-model="encryptPassword" placeholder="请输入打开密码" />
        </div>
        <div class="input-group full">
          <label>确认密码</label>
          <input type="password" v-model="encryptConfirmPassword" placeholder="请再次输入密码" />
        </div>
      </div>
      <div v-if="!encryptFile" class="empty-state drop-zone" :class="{ 'drag-active': encryptDragOver }" @click="selectEncryptFile" @dragover.prevent="encryptDragOver = true" @dragleave.prevent="encryptDragOver = false" @drop="onEncryptDrop">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
        <p>点击选择或拖拽 PDF 文件到此处</p>
        <span class="empty-hint">设置密码后，打开 PDF 需要输入密码</span>
      </div>
      <div v-if="encryptResult" class="result-box">
        <div class="result-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" style="color: var(--accent)"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          <span>加密完成</span>
        </div>
        <div class="result-details">
          <div class="result-item"><span class="result-label">文件路径</span><span class="result-value path-value" :title="encryptResult.filePath">{{ encryptResult.filePath }}</span></div>
          <div class="result-item"><span class="result-label">文件大小</span><span class="result-value">{{ formatSize(encryptResult.size) }}</span></div>
        </div>
      </div>
    </div>

    <!-- ==================== PDF 解密 ==================== -->
    <div v-if="activeTool === 'decrypt'" class="tool-content">
      <div class="tool-mode-badge">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/><path d="M12 16l1 1-1 1"/></svg>
        <span>PDF 解密模式</span>
        <span class="mode-badge-hint">移除 PDF 文件的打开密码</span>
      </div>
      <div v-if="errorMessage" class="error-banner">{{ errorMessage }}</div>
      <div class="action-bar">
        <button class="btn btn-primary" @click="selectDecryptFile">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          选择 PDF 文件
        </button>
      </div>
      <div v-if="decryptFile" class="file-info-card">
        <div class="file-info-card-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"/><path d="M14 2v6h6"/></svg>
        </div>
        <div class="file-info-card-content">
          <span class="file-info-card-name" :title="decryptFile.name">{{ decryptFile.name }}</span>
          <div class="file-info-card-meta"><span>{{ formatSize(decryptFile.size) }}</span></div>
        </div>
        <button class="btn-icon btn-remove" @click="clearDecryptFile" :disabled="decryptBusy" title="移除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div v-if="decryptFile" class="decrypt-options">
        <div class="input-group full">
          <label>输入密码</label>
          <input type="password" v-model="decryptPassword" placeholder="请输入 PDF 的打开密码" />
        </div>
      </div>
      <div v-if="!decryptFile" class="empty-state drop-zone" :class="{ 'drag-active': decryptDragOver }" @click="selectDecryptFile" @dragover.prevent="decryptDragOver = true" @dragleave.prevent="decryptDragOver = false" @drop="onDecryptDrop">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/><path d="M12 16l1 1-1 1"/></svg>
        <p>点击选择或拖拽 PDF 文件到此处</p>
        <span class="empty-hint">输入正确密码后即可移除密码保护</span>
      </div>
      <div v-if="decryptResult" class="result-box">
        <div class="result-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" style="color: var(--accent)"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          <span>解密完成</span>
        </div>
        <div class="result-details">
          <div class="result-item"><span class="result-label">文件路径</span><span class="result-value path-value" :title="decryptResult.filePath">{{ decryptResult.filePath }}</span></div>
          <div class="result-item"><span class="result-label">文件大小</span><span class="result-value">{{ formatSize(decryptResult.size) }}</span></div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pdf-tools-panel {
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

/* ==================== Tab 切换 ==================== */
.tool-tabs {
  display: flex;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 4px;
  margin-bottom: 20px;
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
}

.action-bar.bottom-bar {
  margin-top: 20px;
  margin-bottom: 16px;
  position: sticky;
  bottom: 0;
  z-index: 10;
  padding: 12px 0;
  background: var(--bg, #fff);
  justify-content: center;
}

.inline-action {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 0;
  margin-top: 8px;
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

.btn-ghost:hover {
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

.bottom-hint {
  font-size: 12px;
  color: var(--muted);
  margin-left: 8px;
}

/* ==================== 模式标识 ==================== */
.tool-mode-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: rgba(124, 92, 252, 0.06);
  border: 1px solid rgba(124, 92, 252, 0.15);
  border-radius: var(--radius-sm);
  margin-bottom: 16px;
  font-size: 14px;
  font-weight: 600;
  color: var(--accent);
}

.tool-mode-badge svg {
  flex-shrink: 0;
}

.mode-badge-hint {
  font-size: 12px;
  font-weight: 400;
  color: var(--muted);
  margin-left: 4px;
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

/* ==================== 文件列表（合并） ==================== */
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

.file-item.dragging {
  opacity: 0.4;
}

.file-item.drag-over {
  border-top: 2px solid var(--accent);
  padding-top: 9px;
}

.drag-handle {
  color: var(--muted);
  cursor: grab;
  opacity: 0.4;
  transition: opacity 0.2s;
}

.file-item:hover .drag-handle {
  opacity: 1;
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

.result-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.result-row {
  display: flex;
  gap: 24px;
  margin-top: 8px;
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
}

/* ==================== 文件信息卡片（拆分） ==================== */
.file-info-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  margin-bottom: 20px;
}

.file-info-card-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(59, 130, 246, 0.1);
  color: #3B82F6;
  flex-shrink: 0;
}

.file-info-card-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.file-info-card-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-info-card-meta {
  font-size: 12px;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 6px;
}

.meta-divider {
  opacity: 0.3;
}

/* ==================== 拆分模式选项 ==================== */
.split-options {
  margin-bottom: 4px;
}

.option-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 12px;
}

.mode-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  margin-bottom: 16px;
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

.option-inputs {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  padding: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.input-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}

.input-group.full {
  width: 100%;
}

.input-group label {
  font-size: 12px;
  color: var(--muted);
}

.input-group input {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 14px;
  color: var(--ink);
  background: #fff;
  outline: none;
  transition: border-color 0.2s;
  width: 100%;
  box-sizing: border-box;
}

.input-group input:focus {
  border-color: var(--accent);
}

.input-sep {
  font-size: 13px;
  color: var(--muted);
  padding-bottom: 8px;
  flex-shrink: 0;
}

/* ==================== 工具内容区 ==================== */
.tool-content {
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ==================== 压缩/加密/解密选项 ==================== */
.compress-options,
.encrypt-options,
.decrypt-options {
  margin-bottom: 16px;
}

.encrypt-options .input-group,
.decrypt-options .input-group {
  margin-bottom: 12px;
}

.encrypt-options .input-group:last-child,
.decrypt-options .input-group:last-child {
  margin-bottom: 0;
}
</style>
