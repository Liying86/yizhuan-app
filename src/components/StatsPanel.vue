<script setup lang="ts">
import { ref, onMounted } from 'vue'

interface UsageStats {
  totalConversions: number
  totalSuccess: number
  totalFailed: number
  totalBytesSaved: number
  formatBreakdown: Record<string, number>
  firstUsedAt: string
  lastUsedAt: string
}

const emit = defineEmits<{
  (e: 'close'): void
}>()

const stats = ref<UsageStats | null>(null)
const loading = ref(true)

onMounted(async () => {
  try {
    if (window.electronAPI?.usageStatsLoad) {
      stats.value = await window.electronAPI.usageStatsLoad()
    }
  } catch (err) {
    console.error('加载使用统计失败:', err)
  } finally {
    loading.value = false
  }
})

function formatDate(iso: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleString('zh-CN')
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}

function formatFormatLabel(key: string): string {
  const map: Record<string, string> = {
    'pdf2docx': 'PDF 转 Word',
    'pdf2xlsx': 'PDF 转 Excel',
    'pdf2ppt': 'PDF 转 PPT',
    'docx2pdf': 'Office 转 PDF',
    'img2png': '图片转 PNG',
    'img2jpg': '图片转 JPG',
    'heic2jpg': 'HEIC 转 JPG',
    'compress': '图片压缩',
    'ocr': 'OCR 识别',
    'merge': 'PDF 合并',
    'split': 'PDF 拆分',
    'compress-pdf': 'PDF 压缩',
    'encrypt': 'PDF 加密',
    'decrypt': 'PDF 解密',
    'html-to-pdf': 'HTML 转 PDF',
    'markdown-to-pdf': 'MD 转 PDF',
    'pdf-to-image': 'PDF 转图片',
    'videoConvert': '视频转换',
    'caj2pdf': 'CAJ 转 PDF',
    'img-to-html': '图片转 HTML/MD',
  }
  return map[key] || key
}

function getSortedFormats(): Array<{ key: string; count: number }> {
  if (!stats.value) return []
  return Object.entries(stats.value.formatBreakdown)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
}
</script>

<template>
  <section class="stats-panel">
    <div class="panel-header">
      <h3 class="panel-title">使用统计</h3>
      <button class="close-btn" @click="emit('close')" title="关闭">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>

    <div v-if="loading" class="loading-state">
      <span class="spinner"></span>
      <span>加载中...</span>
    </div>

    <div v-else-if="!stats || stats.totalConversions === 0" class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48"><path d="M12 20v-6M6 20V10M18 20V4"/></svg>
      <p>暂无使用数据</p>
      <span class="empty-hint">完成转换后将在这里显示统计信息</span>
    </div>

    <div v-else class="stats-content">
      <!-- 概览卡片 -->
      <div class="stats-grid">
        <div class="stat-card">
          <span class="stat-value">{{ stats.totalConversions }}</span>
          <span class="stat-label">总转换次数</span>
        </div>
        <div class="stat-card success">
          <span class="stat-value">{{ stats.totalSuccess }}</span>
          <span class="stat-label">成功</span>
        </div>
        <div class="stat-card error">
          <span class="stat-value">{{ stats.totalFailed }}</span>
          <span class="stat-label">失败</span>
        </div>
        <div class="stat-card accent">
          <span class="stat-value">{{ formatBytes(stats.totalBytesSaved) }}</span>
          <span class="stat-label">节省空间</span>
        </div>
      </div>

      <!-- 成功率 -->
      <div class="success-rate-bar">
        <div class="rate-header">
          <span>成功率</span>
          <span class="rate-value">
            {{ stats.totalConversions > 0 ? ((stats.totalSuccess / stats.totalConversions) * 100).toFixed(1) : 0 }}%
          </span>
        </div>
        <div class="rate-track">
          <div
            class="rate-fill"
            :style="{ width: stats.totalConversions > 0 ? ((stats.totalSuccess / stats.totalConversions) * 100) + '%' : '0%' }"
          ></div>
        </div>
      </div>

      <!-- 格式分布 -->
      <div class="format-section">
        <h4 class="section-subtitle">格式分布</h4>
        <div class="format-list">
          <div v-for="fmt in getSortedFormats()" :key="fmt.key" class="format-item">
            <span class="format-name">{{ formatFormatLabel(fmt.key) }}</span>
            <div class="format-bar-wrap">
              <div
                class="format-bar"
                :style="{ width: (stats.totalConversions > 0 ? ((fmt.count / stats.totalConversions) * 100) : 0) + '%' }"
              ></div>
            </div>
            <span class="format-count">{{ fmt.count }}</span>
          </div>
        </div>
      </div>

      <!-- 时间信息 -->
      <div class="time-info">
        <div class="time-item">
          <span class="time-label">首次使用</span>
          <span class="time-value">{{ formatDate(stats.firstUsedAt) }}</span>
        </div>
        <div class="time-item">
          <span class="time-label">最近使用</span>
          <span class="time-value">{{ formatDate(stats.lastUsedAt) }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.stats-panel {
  margin-top: 16px;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
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

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 60px 0;
  color: var(--muted);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 0;
  color: var(--muted);
  gap: 8px;
}

.empty-state p {
  font-size: 15px;
  color: var(--ink);
}

.empty-hint {
  font-size: 13px;
  color: var(--muted);
}

/* 概览卡片 */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 24px;
}

.stat-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 16px 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.stat-value {
  font-size: 22px;
  font-weight: 700;
  color: var(--ink);
}

.stat-label {
  font-size: 12px;
  color: var(--muted);
}

.stat-card.success .stat-value {
  color: #10b981;
}

.stat-card.error .stat-value {
  color: #ef4444;
}

.stat-card.accent .stat-value {
  color: var(--accent);
}

/* 成功率 */
.success-rate-bar {
  margin-bottom: 24px;
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.rate-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
  font-size: 13px;
  color: var(--ink);
}

.rate-value {
  font-weight: 700;
  color: var(--accent);
}

.rate-track {
  height: 8px;
  background: var(--border);
  border-radius: 4px;
  overflow: hidden;
}

.rate-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 4px;
  transition: width 0.6s ease;
}

/* 格式分布 */
.format-section {
  margin-bottom: 24px;
}

.section-subtitle {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 12px;
}

.format-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.format-item {
  display: flex;
  align-items: center;
  gap: 12px;
}

.format-name {
  width: 120px;
  font-size: 13px;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
}

.format-bar-wrap {
  flex: 1;
  height: 8px;
  background: var(--border);
  border-radius: 4px;
  overflow: hidden;
}

.format-bar {
  height: 100%;
  background: var(--accent);
  border-radius: 4px;
  transition: width 0.6s ease;
}

.format-count {
  width: 36px;
  text-align: right;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
  flex-shrink: 0;
}

/* 时间信息 */
.time-info {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.time-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}

.time-label {
  color: var(--muted);
}

.time-value {
  color: var(--ink);
  font-weight: 500;
}

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
