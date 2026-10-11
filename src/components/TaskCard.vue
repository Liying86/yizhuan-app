<script setup lang="ts">
import type { ConvertTask } from '../services/converter'

defineProps<{
  task: ConvertTask
}>()

const emit = defineEmits<{
  (e: 'cancel', taskId: string): void
  (e: 'open', path: string): void
  (e: 'open-folder', path: string): void
}>()

function formatSize(bytes?: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function getFileName(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

function copyPath(path: string) {
  if (!path) return
  try {
    navigator.clipboard.writeText(path)
  } catch {
    // fallback
    const ta = document.createElement('textarea')
    ta.value = path
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
}
</script>

<template>
  <div class="task-card" :class="`status-${task.status}`">
    <div class="task-header">
      <div class="task-icon">
        <svg v-if="task.type === 'pdf2docx'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
          <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <path d="M21 15l-5-5L5 21"/>
        </svg>
      </div>
      <div class="task-info">
        <span class="task-name">{{ task.inputName }}</span>
        <span class="task-meta">
          <span v-if="task.status === 'processing'">转换中... {{ task.progress }}%</span>
          <span v-else-if="task.status === 'success'">
            转换成功 · {{ formatSize(task.result?.size) }}
            <span v-if="task.result?.output" class="task-output-path">→ {{ getFileName(task.result.output) }}</span>
          </span>
          <span v-else-if="task.status === 'error'">转换失败</span>
          <span v-else>等待中</span>
        </span>
      </div>
      <div class="task-actions">
        <button
          v-if="task.status === 'success'"
          class="action-btn"
          @click="emit('open-folder', task.result?.output || task.outputPath || '')"
          title="在文件夹中显示"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
          </svg>
        </button>
        <button
          v-if="task.status === 'success'"
          class="action-btn"
          @click="emit('open', task.result?.output || task.outputPath || '')"
          title="打开文件"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M5 13l4 4L19 7"/>
          </svg>
        </button>
        <button
          v-if="task.status === 'processing' || task.status === 'pending'"
          class="action-btn cancel"
          @click="emit('cancel', task.id)"
          title="取消"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
    </div>

    <div v-if="task.status === 'processing'" class="progress-bar">
      <div class="progress-fill" :style="{ width: task.progress + '%' }"></div>
    </div>

    <div v-if="task.status === 'error'" class="error-msg">
      {{ task.result?.message || '未知错误' }}
    </div>
  </div>
</template>

<style scoped>
.task-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 14px 16px;
  transition: all 0.2s;
}

.task-card.status-processing {
  border-color: var(--primary-light);
  background: rgba(79, 70, 229, 0.02);
}

.task-card.status-success {
  border-color: rgba(16, 185, 129, 0.3);
}

.task-card.status-error {
  border-color: rgba(239, 68, 68, 0.3);
}

.task-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.task-icon {
  width: 36px;
  height: 36px;
  background: var(--primary-bg);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--primary);
  flex-shrink: 0;
}

.status-success .task-icon {
  background: rgba(16, 185, 129, 0.1);
  color: var(--success);
}

.status-error .task-icon {
  background: rgba(239, 68, 68, 0.1);
  color: var(--danger);
}

.task-icon svg {
  width: 18px;
  height: 18px;
}

.task-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.task-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-meta {
  font-size: 12px;
  color: var(--muted);
}

.task-output-path {
  color: var(--accent);
  font-weight: 500;
}

.task-actions {
  display: flex;
  gap: 6px;
}

.action-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: var(--bg);
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  transition: all 0.2s;
}

.action-btn svg {
  width: 16px;
  height: 16px;
}

.action-btn:hover {
  background: var(--primary-bg);
  color: var(--primary);
}

.action-btn.cancel:hover {
  background: rgba(239, 68, 68, 0.1);
  color: var(--danger);
}

.progress-bar {
  margin-top: 12px;
  height: 4px;
  background: var(--bg);
  border-radius: 2px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--primary), var(--secondary));
  border-radius: 2px;
  transition: width 0.3s ease;
}

.error-msg {
  margin-top: 10px;
  padding: 8px 12px;
  background: rgba(239, 68, 68, 0.06);
  border-radius: 6px;
  font-size: 12px;
  color: var(--danger);
}
</style>
