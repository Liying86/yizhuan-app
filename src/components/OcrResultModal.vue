<script setup lang="ts">
import { ref, watch, computed } from 'vue'

export type OcrSaveFormat = 'txt' | 'docx' | 'xlsx' | 'pdf'

const props = defineProps<{
  visible: boolean
  text: string
  fileName: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'save', format: OcrSaveFormat): void
}>()

const copied = ref(false)
const selectedFormat = ref<OcrSaveFormat>('txt')

const formatOptions: { value: OcrSaveFormat, label: string, ext: string }[] = [
  { value: 'txt', label: 'TXT 文本', ext: 'txt' },
  { value: 'docx', label: 'Word 文档', ext: 'docx' },
  { value: 'xlsx', label: 'Excel 表格', ext: 'xlsx' },
  { value: 'pdf', label: '可搜索 PDF', ext: 'pdf' },
]

const saveButtonLabel = computed(() => {
  const opt = formatOptions.find(o => o.value === selectedFormat.value)
  return `保存为 ${opt?.label || 'TXT'}`
})

async function copyText() {
  try {
    await navigator.clipboard.writeText(props.text)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // Fallback
    const textarea = document.createElement('textarea')
    textarea.value = props.text
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  }
}

watch(() => props.visible, (val) => {
  if (!val) {
    copied.value = false
    selectedFormat.value = 'txt'
  }
})
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-overlay" @click.self="emit('close')">
      <div class="modal-content">
        <header class="modal-header">
          <div class="header-info">
            <h3>OCR 识别结果</h3>
            <span class="file-name">{{ fileName }}</span>
          </div>
          <button class="close-btn" @click="emit('close')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </header>

        <div class="modal-body">
          <div class="text-toolbar">
            <span class="char-count">{{ text.length }} 字符</span>
            <div class="toolbar-actions">
              <button class="tool-btn" @click="copyText">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2"/>
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                </svg>
                <span>{{ copied ? '已复制' : '复制' }}</span>
              </button>
            </div>
          </div>
          <div class="text-display">
            <pre>{{ text }}</pre>
          </div>
        </div>

        <footer class="modal-footer">
          <div class="format-selector">
            <span class="format-label">保存格式</span>
            <div class="format-options">
              <button
                v-for="opt in formatOptions"
                :key="opt.value"
                class="format-chip"
                :class="{ active: selectedFormat === opt.value }"
                @click="selectedFormat = opt.value"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>
          <button class="btn-save" @click="emit('save', selectedFormat)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>
              <path d="M17 21v-8H7v8M7 3v5h8"/>
            </svg>
            <span>{{ saveButtonLabel }}</span>
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(15, 23, 42, 0.4);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.modal-content {
  width: 90%;
  max-width: 640px;
  max-height: 80vh;
  background: var(--surface);
  border-radius: 16px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: slideUp 0.25s ease;
}

@keyframes slideUp {
  from { transform: translateY(20px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18px 24px;
  border-bottom: 1px solid var(--border);
}

.header-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.modal-header h3 {
  font-size: 17px;
  font-weight: 700;
  color: var(--ink);
}

.file-name {
  font-size: 13px;
  color: var(--muted);
}

.close-btn {
  width: 32px;
  height: 32px;
  border: none;
  background: var(--bg);
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  transition: all 0.2s;
}

.close-btn:hover {
  background: rgba(239, 68, 68, 0.1);
  color: var(--danger);
}

.close-btn svg {
  width: 18px;
  height: 18px;
}

.modal-body {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.text-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 24px;
  border-bottom: 1px solid var(--border);
}

.char-count {
  font-size: 12px;
  color: var(--muted);
}

.toolbar-actions {
  display: flex;
  gap: 8px;
}

.tool-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  color: var(--ink);
  cursor: pointer;
  transition: all 0.2s;
}

.tool-btn svg {
  width: 15px;
  height: 15px;
}

.tool-btn:hover {
  border-color: var(--primary-light);
  color: var(--primary);
  background: var(--primary-bg);
}

.text-display {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

.text-display pre {
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.8;
  color: var(--ink);
  white-space: pre-wrap;
  word-wrap: break-word;
  margin: 0;
}

/* 底部保存区域 */
.modal-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 24px;
  border-top: 1px solid var(--border);
  gap: 12px;
  flex-wrap: wrap;
}

.format-selector {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
}

.format-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  white-space: nowrap;
}

.format-options {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.format-chip {
  padding: 5px 12px;
  background: var(--bg);
  border: 1.5px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--ink);
  cursor: pointer;
  transition: all 0.2s;
}

.format-chip:hover {
  border-color: var(--primary-light);
}

.format-chip.active {
  background: var(--primary);
  border-color: var(--primary);
  color: white;
}

.btn-save {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 20px;
  background: var(--primary);
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.btn-save svg {
  width: 15px;
  height: 15px;
}

.btn-save:hover {
  background: var(--primary-light);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3);
}
</style>
