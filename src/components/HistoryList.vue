<script setup lang="ts">
import { ref } from 'vue'

export interface HistoryItem {
  id: string
  filename: string
  fromFormat: string
  toFormat: string
  status: 'success' | 'error' | 'pending'
  createdAt: string
  outputPath?: string
}

const props = withDefaults(defineProps<{
  items: HistoryItem[]
  maxItems?: number  // 0 表示显示全部
}>(), {
  maxItems: 5
})

const emit = defineEmits<{
  (e: 'open-file', path: string): void
  (e: 'clear-history'): void
  (e: 'delete-item', id: string): void
}>()

// 正在显示删除确认的状态
const confirmingDelete = ref<string | null>(null)

function statusIcon(status: string) {
  if (status === 'success') return 'M5 13l4 4L19 7'
  if (status === 'error') return 'M6 18L18 6M6 6l12 12'
  return 'M12 8v4l3 3'
}

function statusColor(status: string) {
  if (status === 'success') return '#10b981'
  if (status === 'error') return '#ef4444'
  return '#f59e0b'
}

function statusLabel(status: string) {
  if (status === 'success') return '成功'
  if (status === 'error') return '失败'
  return '处理中'
}

function formatTime(iso: string) {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function onItemClick(item: HistoryItem, event: MouseEvent) {
  // 如果点击的是删除按钮区域，不触发打开文件
  const target = event.target as HTMLElement
  if (target.closest('.delete-area')) return
  if (item.outputPath) {
    emit('open-file', item.outputPath)
  }
}

function onDeleteClick(id: string) {
  if (confirmingDelete.value === id) {
    // 第二次点击确认删除
    emit('delete-item', id)
    confirmingDelete.value = null
  } else {
    // 第一次点击显示确认
    confirmingDelete.value = id
    // 3 秒后自动取消确认状态
    setTimeout(() => {
      if (confirmingDelete.value === id) {
        confirmingDelete.value = null
      }
    }, 3000)
  }
}
</script>

<template>
  <section class="history-section">
    <div class="history-header">
      <h2 class="section-title">最近记录</h2>
      <button v-if="items.length > 0" class="clear-btn" @click="emit('clear-history')">
        清空
      </button>
    </div>

    <div v-if="items.length === 0" class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
      <p>暂无转换记录</p>
    </div>

    <div v-else class="history-list">
      <div
        v-for="item in (maxItems > 0 ? items.slice(0, maxItems) : items)"
        :key="item.id"
        class="history-item"
        :class="{ clickable: item.outputPath }"
        @click="onItemClick(item, $event)"
      >
        <div class="status-icon" :style="{ background: statusColor(item.status) + '12', color: statusColor(item.status) }">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path :d="statusIcon(item.status)"/>
          </svg>
        </div>
        <div class="item-info">
          <span class="filename">{{ item.filename }}</span>
          <span class="meta">
            {{ item.fromFormat.toUpperCase() }} → {{ item.toFormat.toUpperCase() }} · {{ formatTime(item.createdAt) }}
          </span>
        </div>
        <div class="item-actions">
          <span class="status-badge" :style="{ color: statusColor(item.status) }">
            {{ statusLabel(item.status) }}
          </span>
          <div class="delete-area">
            <button
              class="delete-btn"
              :class="{ confirm: confirmingDelete === item.id }"
              @click.stop="onDeleteClick(item.id)"
              :title="confirmingDelete === item.id ? '点击确认删除' : '删除此记录'"
            >
              <svg v-if="confirmingDelete !== item.id" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
              </svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 13l4 4L19 7"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.history-section {
  margin-top: 24px;
}

.history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--ink);
}

.clear-btn {
  font-size: 12px;
  color: var(--muted);
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}

.clear-btn:hover {
  color: var(--danger);
  background: rgba(239, 68, 68, 0.06);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px;
  color: var(--muted);
}

.empty-state svg {
  width: 32px;
  height: 32px;
  opacity: 0.4;
}

.empty-state p {
  font-size: 13px;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.history-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: default;
  transition: all 0.2s;
}

.history-item.clickable {
  cursor: pointer;
}

.history-item.clickable:hover {
  border-color: var(--primary-light);
  box-shadow: var(--shadow);
}

.status-icon {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.status-icon svg {
  width: 16px;
  height: 16px;
}

.item-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.filename {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta {
  font-size: 12px;
  color: var(--muted);
}

.item-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.status-badge {
  font-size: 12px;
  font-weight: 500;
}

.delete-area {
  display: flex;
  align-items: center;
}

.delete-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  opacity: 0;
  transition: all 0.2s;
}

.history-item:hover .delete-btn {
  opacity: 1;
}

.delete-btn:hover {
  background: rgba(239, 68, 68, 0.1);
  color: var(--danger);
}

.delete-btn.confirm {
  opacity: 1;
  background: rgba(239, 68, 68, 0.15);
  color: var(--danger);
  animation: pulse 0.5s ease;
}

.delete-btn svg {
  width: 14px;
  height: 14px;
}

@keyframes pulse {
  0% { transform: scale(1); }
  50% { transform: scale(1.15); }
  100% { transform: scale(1); }
}
</style>
