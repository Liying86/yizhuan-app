<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import type { ConversionType, VideoTargetFormat, VideoQualityPreset } from '../services/converter'
import { VIDEO_INPUT_EXTS, VIDEO_OUTPUT_FORMATS, VIDEO_QUALITY_PRESETS } from '../services/converter'

export interface PendingFile {
  path: string
  name: string
  ext: string
}

interface ConvOption {
  type: ConversionType
  label: string
  targetExt: string
  color: string
  desc: string
  sourceExts: string[]
}

// 所有支持的转换选项定义
const CONV_OPTIONS: ConvOption[] = [
  { type: 'pdf2docx', label: '转 Word', targetExt: 'docx', color: '#4f46e5', desc: '保留排版，可编辑', sourceExts: ['pdf'] },
  { type: 'pdf2xlsx', label: '转 Excel', targetExt: 'xlsx', color: '#10b981', desc: '提取表格数据', sourceExts: ['pdf'] },
  { type: 'pdf2ppt', label: '转 PPT', targetExt: 'pptx', color: '#f59e0b', desc: '转为演示文稿', sourceExts: ['pdf'] },
  { type: 'docx2pdf', label: '转 PDF', targetExt: 'pdf', color: '#ef4444', desc: 'Word/PPT/Excel 转PDF', sourceExts: ['docx', 'doc', 'ppt', 'pptx', 'xls', 'xlsx'] },
  { type: 'img2png', label: '转 PNG', targetExt: 'png', color: '#10b981', desc: '无损格式', sourceExts: ['jpg', 'jpeg', 'bmp', 'webp', 'tiff', 'gif'] },
  { type: 'img2jpg', label: '转 JPG', targetExt: 'jpg', color: '#f59e0b', desc: '体积更小', sourceExts: ['png', 'bmp', 'webp', 'tiff', 'gif'] },
  { type: 'img2webp', label: '转 WebP', targetExt: 'webp', color: '#06b6d4', desc: '现代高效格式', sourceExts: ['png', 'jpg', 'jpeg', 'bmp', 'tiff', 'gif'] },
  { type: 'img2heic', label: '转 AVIF', targetExt: 'avif', color: '#8b5cf6', desc: '高压缩比现代格式', sourceExts: ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'tiff', 'gif'] },
  { type: 'heic2jpg', label: '转 JPG', targetExt: 'jpg', color: '#8b5cf6', desc: '苹果照片兼容', sourceExts: ['heic', 'heif'] },
  { type: 'ocr', label: 'OCR 文字识别', targetExt: 'txt', color: '#ec4899', desc: '提取图片中的文字', sourceExts: ['png', 'jpg', 'jpeg', 'bmp', 'webp'] },
  { type: 'videoConvert', label: '视频/音频转换', targetExt: 'mp4', color: '#0d9488', desc: '视频格式互转、提取音频', sourceExts: VIDEO_INPUT_EXTS },
  { type: 'caj2pdf', label: 'CAJ 转 PDF', targetExt: 'pdf', color: '#dc2626', desc: '知网文献转PDF', sourceExts: ['caj', 'nh'] },
]

const props = defineProps<{
  visible: boolean
  files: PendingFile[]
  outputDir: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'confirm', type: ConversionType, videoTargetFormat?: VideoTargetFormat, videoQualityPreset?: VideoQualityPreset): void
}>()

const selectedType = ref<ConversionType | null>(null)
const selectedVideoFormat = ref<VideoTargetFormat>('mp4')
const selectedQualityPreset = ref<VideoQualityPreset>('original')
const confirmBtnRef = ref<HTMLButtonElement | null>(null)

// 判断当前选中的视频格式是否为音频或GIF（不显示画质设置）
const showQualitySettings = computed(() => {
  return selectedType.value === 'videoConvert' &&
    selectedVideoFormat.value !== 'mp3' &&
    selectedVideoFormat.value !== 'wav' &&
    selectedVideoFormat.value !== 'aac' &&
    selectedVideoFormat.value !== 'flac' &&
    selectedVideoFormat.value !== 'gif'
})

// 根据检测到的文件格式，计算可用的转换选项
const availableOptions = computed(() => {
  const detectedExts = new Set(props.files.map(f => f.ext))
  return CONV_OPTIONS.filter(opt =>
    opt.sourceExts.some(ext => detectedExts.has(ext))
  )
})

// 每个选项能转换的文件数量
function filesCountFor(opt: ConvOption): number {
  return props.files.filter(f => opt.sourceExts.includes(f.ext)).length
}

// 不支持的文件列表
const unsupportedFiles = computed(() => {
  const allSourceExts = new Set(CONV_OPTIONS.flatMap(o => o.sourceExts))
  return props.files.filter(f => !allSourceExts.has(f.ext))
})

// 按格式分组统计
const formatSummary = computed(() => {
  const map: Record<string, number> = {}
  for (const f of props.files) {
    const key = f.ext || '未知'
    map[key] = (map[key] || 0) + 1
  }
  return Object.entries(map).map(([ext, count]) => ({ ext, count }))
})

// 弹窗打开时自动选中第一个可用选项
watch(() => props.visible, (val) => {
  if (val) {
    selectedType.value = availableOptions.value.length > 0
      ? availableOptions.value[0].type
      : null
    selectedVideoFormat.value = 'mp4'
    selectedQualityPreset.value = 'original'
    // 自动聚焦确认按钮
    nextTick(() => {
      confirmBtnRef.value?.focus()
    })
  }
})

function onConfirm() {
  if (selectedType.value) {
    if (selectedType.value === 'videoConvert') {
      emit('confirm', selectedType.value, selectedVideoFormat.value, selectedQualityPreset.value)
    } else {
      emit('confirm', selectedType.value)
    }
  }
}

// 输出位置显示文本
const outputLocation = computed(() => {
  if (props.outputDir) return props.outputDir
  return '源文件所在目录'
})
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-overlay" @click.self="emit('close')">
      <div class="modal-content">
        <header class="modal-header">
          <div class="header-info">
            <h3>选择转换格式</h3>
            <span class="file-count">{{ files.length }} 个文件待转换</span>
          </div>
          <button class="close-btn" @click="emit('close')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </header>

        <div class="modal-body">
          <!-- 文件预览 -->
          <section class="file-preview">
            <div class="preview-header">
              <span class="preview-title">检测到的文件</span>
              <div class="format-badges">
                <span
                  v-for="item in formatSummary"
                  :key="item.ext"
                  class="format-badge"
                >
                  {{ item.ext.toUpperCase() }} ×{{ item.count }}
                </span>
              </div>
            </div>
            <div class="file-list">
              <div v-for="file in files.slice(0, 8)" :key="file.path" class="file-row">
                <span class="file-ext-tag">{{ (file.ext || '?').toUpperCase() }}</span>
                <span class="file-name-text" :title="file.name">{{ file.name }}</span>
              </div>
              <div v-if="files.length > 8" class="file-more">
                还有 {{ files.length - 8 }} 个文件...
              </div>
            </div>
            <!-- 不支持的文件提示 -->
            <div v-if="unsupportedFiles.length > 0" class="unsupported-hint">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0L3.16 16.25A2 2 0 005 19z"/>
              </svg>
              <span>{{ unsupportedFiles.length }} 个文件格式不支持，将被跳过</span>
            </div>
          </section>

          <!-- 格式选择 -->
          <section v-if="availableOptions.length > 0" class="format-section">
            <span class="section-label">选择目标格式</span>
            <div class="option-grid">
              <button
                v-for="opt in availableOptions"
                :key="opt.type"
                class="option-card"
                :class="{ active: selectedType === opt.type }"
                :style="selectedType === opt.type ? { borderColor: opt.color, background: opt.color + '08' } : {}"
                @click="selectedType = opt.type"
              >
                <div class="option-dot" :style="{ background: opt.color }"></div>
                <div class="option-info">
                  <span class="option-label">{{ opt.label }}</span>
                  <span class="option-desc">{{ opt.desc }}</span>
                </div>
                <span class="option-count">{{ filesCountFor(opt) }} 个文件</span>
              </button>
            </div>

            <!-- 视频转换目标格式选择 -->
            <div v-if="selectedType === 'videoConvert'" class="video-format-select">
              <span class="video-format-label">目标格式</span>
              <div class="video-format-grid">
                <button
                  v-for="fmt in VIDEO_OUTPUT_FORMATS"
                  :key="fmt.value"
                  class="video-format-chip"
                  :class="{
                    active: selectedVideoFormat === fmt.value,
                    'audio-chip': fmt.type === 'audio',
                    'gif-chip': fmt.type === 'gif'
                  }"
                  @click="selectedVideoFormat = fmt.value"
                >
                  {{ fmt.label }}
                </button>
              </div>
            </div>

            <!-- 视频画质设置（仅视频格式显示，音频和GIF不显示） -->
            <div v-if="showQualitySettings" class="video-quality-select">
              <span class="video-format-label">画质</span>
              <div class="quality-grid">
                <button
                  v-for="preset in VIDEO_QUALITY_PRESETS"
                  :key="preset.value"
                  class="quality-chip"
                  :class="{ active: selectedQualityPreset === preset.value }"
                  @click="selectedQualityPreset = preset.value"
                >
                  <span class="quality-name">{{ preset.label }}</span>
                  <span class="quality-desc">{{ preset.desc }}</span>
                </button>
              </div>
            </div>
          </section>

          <!-- 无可用选项 -->
          <div v-else class="no-options">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            <p>没有可用的转换选项</p>
          </div>

          <!-- 输出位置 -->
          <section v-if="availableOptions.length > 0" class="output-section">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
            </svg>
            <div class="output-info">
              <span class="output-label">保存位置</span>
              <span class="output-path">{{ outputLocation }}</span>
            </div>
          </section>
        </div>

        <footer class="modal-footer">
          <button class="btn-cancel" @click="emit('close')">取消</button>
          <button
            ref="confirmBtnRef"
            class="btn-confirm"
            :disabled="!selectedType"
            @click="onConfirm"
          >
            开始转换
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
  max-width: 560px;
  max-height: 85vh;
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

.file-count {
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
  overflow-y: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* 文件预览 */
.file-preview {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.preview-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}

.format-badges {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.format-badge {
  padding: 2px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
}

.file-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 160px;
  overflow-y: auto;
  padding: 2px;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--bg);
  border-radius: 6px;
}

.file-ext-tag {
  padding: 1px 6px;
  background: var(--primary-bg);
  color: var(--primary);
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  flex-shrink: 0;
}

.file-name-text {
  font-size: 13px;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-more {
  font-size: 12px;
  color: var(--muted);
  text-align: center;
  padding: 4px;
}

.unsupported-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: var(--warning-bg);
  border-radius: 6px;
  font-size: 12px;
  color: var(--warning-text);
}

.unsupported-hint svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

/* 格式选择 */
.format-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}

.option-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}

.option-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px;
  background: var(--surface);
  border: 2px solid var(--border);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s;
  text-align: left;
  position: relative;
}

.option-card:hover {
  border-color: var(--primary-light);
}

.option-card.active {
  border-width: 2px;
}

.option-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.option-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.option-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
}

.option-desc {
  font-size: 11px;
  color: var(--muted);
}

.option-count {
  font-size: 11px;
  color: var(--muted);
  background: var(--bg);
  padding: 2px 6px;
  border-radius: 8px;
  flex-shrink: 0;
}

/* 视频格式选择 */
.video-format-select {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  background: var(--bg);
  border-radius: 10px;
  animation: slideDown 0.2s ease;
}

@keyframes slideDown {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

.video-format-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
}

.video-format-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.video-format-chip {
  padding: 6px 14px;
  background: var(--surface);
  border: 1.5px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
  cursor: pointer;
  transition: all 0.2s;
}

.video-format-chip:hover {
  border-color: #0d9488;
  color: #0d9488;
}

.video-format-chip.active {
  background: #0d9488;
  border-color: #0d9488;
  color: white;
}

.video-format-chip.audio-chip.active {
  background: #8b5cf6;
  border-color: #8b5cf6;
}

.video-format-chip.gif-chip.active {
  background: #ec4899;
  border-color: #ec4899;
}

.video-format-chip.gif-chip:hover {
  border-color: #ec4899;
  color: #ec4899;
}

/* 画质设置 */
.video-quality-select {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  background: var(--bg);
  border-radius: 10px;
  animation: slideDown 0.2s ease;
}

.quality-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 8px;
}

.quality-chip {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 8px 12px;
  background: var(--surface);
  border: 1.5px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
  text-align: left;
}

.quality-chip:hover {
  border-color: #0d9488;
}

.quality-chip.active {
  background: #0d9488;
  border-color: #0d9488;
}

.quality-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}

.quality-chip.active .quality-name {
  color: white;
}

.quality-desc {
  font-size: 10px;
  color: var(--muted);
}

.quality-chip.active .quality-desc {
  color: rgba(255, 255, 255, 0.8);
}

/* 无选项 */
.no-options {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 40px 20px;
  color: var(--muted);
}

.no-options svg {
  width: 40px;
  height: 40px;
  opacity: 0.3;
}

.no-options p {
  font-size: 14px;
}

/* 输出位置 */
.output-section {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: var(--bg);
  border-radius: 8px;
}

.output-section svg {
  width: 18px;
  height: 18px;
  color: var(--primary);
  flex-shrink: 0;
}

.output-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.output-label {
  font-size: 12px;
  color: var(--muted);
}

.output-path {
  font-size: 13px;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 底部按钮 */
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 16px 24px;
  border-top: 1px solid var(--border);
}

.btn-cancel {
  padding: 8px 20px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
  color: var(--ink);
  cursor: pointer;
  transition: all 0.2s;
}

.btn-cancel:hover {
  border-color: var(--muted);
}

.btn-confirm {
  padding: 8px 28px;
  background: var(--primary);
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-confirm:hover:not(:disabled) {
  background: var(--primary-light);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3);
}

.btn-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
