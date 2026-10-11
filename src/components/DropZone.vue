<script setup lang="ts">
import { ref, computed } from 'vue'

const emit = defineEmits<{
  (e: 'files-dropped', files: File[]): void
  (e: 'paths-dropped', paths: string[]): void
  (e: 'folder-dropped', folderPath: string): void
}>()

const isDragging = ref(false)
const dragCount = ref(0)
const detectedFiles = ref<{ name: string, ext: string, path: string }[]>([])
const detectedFolder = ref<string | null>(null)

// 格式识别与推荐
const FORMAT_RECOMMENDATIONS: Record<string, { type: string, label: string, color: string }> = {
  'pdf':  { type: 'pdf2docx', label: 'PDF → Word', color: '#ef4444' },
  'docx': { type: 'docx2pdf', label: 'Word → PDF', color: '#4f46e5' },
  'doc':  { type: 'docx2pdf', label: 'Word → PDF', color: '#4f46e5' },
  'jpg':  { type: 'img2png', label: 'JPG → PNG', color: '#10b981' },
  'jpeg': { type: 'img2png', label: 'JPEG → PNG', color: '#10b981' },
  'png':  { type: 'img2jpg', label: 'PNG → JPG', color: '#f59e0b' },
  'bmp':  { type: 'img2png', label: 'BMP → PNG', color: '#10b981' },
  'webp': { type: 'img2png', label: 'WebP → PNG', color: '#10b981' },
  'tiff': { type: 'img2png', label: 'TIFF → PNG', color: '#10b981' },
  'gif':  { type: 'img2png', label: 'GIF → PNG', color: '#10b981' },
  'heic': { type: 'heic2jpg', label: 'HEIC → JPG', color: '#8b5cf6' },
  'heif': { type: 'heic2jpg', label: 'HEIF → JPG', color: '#8b5cf6' },
}

const detectedFormats = computed(() => {
  const exts = new Set(detectedFiles.value.map(f => f.ext))
  const recs: { ext: string, label: string, color: string }[] = []
  for (const ext of exts) {
    const rec = FORMAT_RECOMMENDATIONS[ext]
    if (rec) {
      recs.push({ ext, label: rec.label, color: rec.color })
    }
  }
  return recs
})

function getExt(filename: string): string {
  const parts = filename.split('.')
  return parts.length > 1 ? parts.pop()!.toLowerCase() : ''
}

function getFilePath(file: File): string {
  // 优先使用 Electron 的 webUtils.getPathForFile（新版本推荐）
  if (window.electronAPI?.getFilePathForFile) {
    return window.electronAPI.getFilePathForFile(file)
  }
  // 回退到旧版 File.path 属性
  return (file as any).path || file.name
}

function onDragEnter(e: DragEvent) {
  e.preventDefault()
  dragCount.value++
  isDragging.value = true

  // 预检测拖入的文件
  if (e.dataTransfer?.files) {
    detectedFiles.value = []
    detectedFolder.value = null

    for (const file of Array.from(e.dataTransfer.files)) {
      const path = getFilePath(file)
      const ext = getExt(file.name)

      // 检测是否是文件夹（Electron 中文件夹的 type 为空且 size 为 0 或很大）
      if (!ext && file.size === 0) {
        detectedFolder.value = path
      } else if (FORMAT_RECOMMENDATIONS[ext]) {
        detectedFiles.value.push({ name: file.name, ext, path })
      }
    }
  }
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
}

function onDragLeave() {
  dragCount.value--
  if (dragCount.value <= 0) {
    isDragging.value = false
    dragCount.value = 0
  }
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  isDragging.value = false
  dragCount.value = 0

  const files = Array.from(e.dataTransfer?.files || [])
  if (files.length === 0) return

  // 检测文件夹拖入
  let hasFolder = false
  const filePaths: string[] = []

  for (const file of files) {
    const path = getFilePath(file)
    const ext = getExt(file.name)

    // 文件夹检测：无扩展名且 size 为 0（Electron 特性）
    if (!ext && file.size === 0 && path) {
      emit('folder-dropped', path)
      hasFolder = true
    } else {
      filePaths.push(path)
    }
  }

  // 也发送文件路径
  if (filePaths.length > 0) {
    emit('paths-dropped', filePaths)
  }

  // 清除检测状态
  detectedFiles.value = []
  detectedFolder.value = null
}

async function onClickSelect() {
  if (window.electronAPI) {
    const paths = await window.electronAPI.selectFiles({ multi: true })
    if (paths.length > 0) {
      // 直接传递路径数组，避免 File 对象 path 属性丢失问题
      emit('paths-dropped', paths)
    }
  }
}
</script>

<template>
  <div
    class="drop-zone"
    :class="{ dragging: isDragging }"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
    @click="onClickSelect"
  >
    <div class="drop-content">
      <div class="drop-icon" :class="{ active: isDragging }">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
        </svg>
      </div>

      <!-- 默认状态 -->
      <template v-if="!isDragging">
        <h3>拖拽文件到此处</h3>
        <p>支持 PDF、Word、图片，也可直接拖入文件夹</p>
        <div class="format-tags">
          <span class="tag">PDF</span>
          <span class="tag">Word</span>
          <span class="tag">JPG</span>
          <span class="tag">PNG</span>
          <span class="tag">HEIC</span>
          <span class="tag">WebP</span>
        </div>
      </template>

      <!-- 拖拽中状态 -->
      <template v-else>
        <h3 class="dragging-title">松开即可转换</h3>

        <!-- 检测到文件夹 -->
        <div v-if="detectedFolder" class="detected-folder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
          </svg>
          <span>{{ detectedFolder.split(/[/\\]/).pop() }}</span>
          <span class="folder-badge">文件夹</span>
        </div>

        <!-- 检测到文件 -->
        <div v-if="detectedFiles.length > 0" class="detected-info">
          <p class="detected-count">检测到 {{ detectedFiles.length }} 个文件</p>
          <div class="detected-formats">
            <span
              v-for="rec in detectedFormats"
              :key="rec.ext"
              class="format-rec"
              :style="{ borderColor: rec.color + '40', color: rec.color }"
            >
              {{ rec.label }}
            </span>
          </div>
        </div>

        <!-- 等待检测 -->
        <p v-if="!detectedFolder && detectedFiles.length === 0" class="detecting">
          正在识别文件格式...
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.drop-zone {
  border: 2px dashed var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 40px 32px;
  text-align: center;
  cursor: pointer;
  transition: all 0.25s ease;
  position: relative;
}

.drop-zone:hover {
  border-color: var(--primary-light);
  background: var(--primary-bg);
}

.drop-zone.dragging {
  border-color: var(--primary);
  background: var(--primary-bg);
  transform: scale(1.01);
  box-shadow: 0 0 0 4px rgba(79, 70, 229, 0.08);
}

.drop-icon {
  width: 56px;
  height: 56px;
  margin: 0 auto 16px;
  background: var(--primary-bg);
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--primary);
  transition: all 0.25s;
}

.drop-icon.active {
  background: var(--primary);
  color: white;
  transform: scale(1.1);
  animation: bounce 0.6s ease infinite alternate;
}

@keyframes bounce {
  from { transform: scale(1.1) translateY(0); }
  to { transform: scale(1.1) translateY(-4px); }
}

.drop-icon svg {
  width: 28px;
  height: 28px;
}

.drop-content h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 6px;
}

.dragging-title {
  color: var(--primary) !important;
}

.drop-content p {
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 16px;
}

.format-tags {
  display: flex;
  gap: 8px;
  justify-content: center;
  flex-wrap: wrap;
}

.tag {
  padding: 4px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 20px;
  font-size: 12px;
  color: var(--muted);
}

/* 拖拽检测状态 */
.detected-folder {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 14px;
  color: var(--primary);
  font-weight: 600;
}

.detected-folder svg {
  width: 20px;
  height: 20px;
}

.folder-badge {
  padding: 2px 8px;
  background: var(--primary-bg);
  border-radius: 10px;
  font-size: 11px;
  font-weight: 500;
}

.detected-info {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.detected-count {
  font-size: 14px;
  color: var(--ink);
  font-weight: 600;
}

.detected-formats {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
}

.format-rec {
  padding: 4px 12px;
  background: var(--surface);
  border: 1px solid;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
}

.detecting {
  font-size: 13px;
  color: var(--muted);
  animation: pulse 1.2s ease infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}
</style>
