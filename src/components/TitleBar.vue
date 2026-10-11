<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

const isMaximized = ref(false)
let removeListener: (() => void) | null = null

onMounted(async () => {
  if (window.electronAPI?.windowIsMaximized) {
    isMaximized.value = await window.electronAPI.windowIsMaximized()
  }
  if (window.electronAPI?.onWindowMaximizeChange) {
    removeListener = window.electronAPI.onWindowMaximizeChange((maximized) => {
      isMaximized.value = maximized
    })
  }
})

onUnmounted(() => {
  removeListener?.()
})

function minimize() {
  window.electronAPI?.windowMinimize()
}

function toggleMaximize() {
  window.electronAPI?.windowMaximize()
  // 状态变化通过事件监听更新
}

function close() {
  window.electronAPI?.windowClose()
}
</script>

<template>
  <div class="title-bar">
    <div class="title-bar-drag">
      <div class="app-title">
        <svg class="title-logo" viewBox="0 0 256 256">
          <defs>
            <linearGradient id="title-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" style="stop-color:#4f46e5"/>
              <stop offset="100%" style="stop-color:#06b6d4"/>
            </linearGradient>
          </defs>
          <g transform="translate(128, 128)">
            <path d="M -55 -20 Q -55 -50 -25 -50 L 25 -50 Q 55 -50 55 -20"
                  fill="none" stroke="url(#title-grad)" stroke-width="16" stroke-linecap="round"/>
            <path d="M 45 -55 L 65 -20 L 50 -15 Z" fill="url(#title-grad)"/>
            <path d="M 55 20 Q 55 50 25 50 L -25 50 Q -55 50 -55 20"
                  fill="none" stroke="url(#title-grad)" stroke-width="16" stroke-linecap="round"/>
            <path d="M -45 55 L -65 20 L -50 15 Z" fill="url(#title-grad)"/>
          </g>
        </svg>
        <span>易转</span>
      </div>
    </div>
    <div class="window-controls">
      <button class="control-btn minimize" @click="minimize" title="最小化">
        <svg viewBox="0 0 12 12">
          <rect x="2" y="5.5" width="8" height="1" rx="0.5"/>
        </svg>
      </button>
      <button class="control-btn maximize" @click="toggleMaximize" :title="isMaximized ? '还原' : '最大化'">
        <svg v-if="!isMaximized" viewBox="0 0 12 12">
          <rect x="2.5" y="2.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1"/>
        </svg>
        <svg v-else viewBox="0 0 12 12">
          <rect x="2.5" y="4" width="5" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1"/>
          <rect x="4" y="2.5" width="5" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1"/>
        </svg>
      </button>
      <button class="control-btn close" @click="close" title="关闭">
        <svg viewBox="0 0 12 12">
          <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.title-bar {
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--sidebar-bg);
  border-bottom: 1px solid var(--border);
  user-select: none;
  flex-shrink: 0;
}

.title-bar-drag {
  flex: 1;
  height: 100%;
  -webkit-app-region: drag;
  display: flex;
  align-items: center;
  padding-left: 12px;
}

.app-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-logo {
  width: 18px;
  height: 18px;
}

.app-title span {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}

.window-controls {
  display: flex;
  -webkit-app-region: no-drag;
}

.control-btn {
  width: 46px;
  height: 36px;
  border: none;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  transition: all 0.15s;
}

.control-btn svg {
  width: 12px;
  height: 12px;
}

.control-btn:hover {
  background: var(--hover-overlay);
  color: var(--ink);
}

.control-btn.close:hover {
  background: #e81123;
  color: white;
}
</style>
