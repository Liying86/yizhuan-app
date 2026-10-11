import { ref, readonly } from 'vue'

// ============================================================
// Toast 通知类型
// ============================================================
export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface ToastItem {
  id: number
  type: ToastType
  title: string
  message?: string
  duration: number
  closable: boolean
}

// ============================================================
// 全局状态（单例）
// ============================================================
const toasts = ref<ToastItem[]>([])
let nextId = 1

// 默认持续时间（毫秒）
const DEFAULT_DURATION: Record<ToastType, number> = {
  success: 3000,
  error: 5000,
  info: 3500,
  warning: 4000,
}

// ============================================================
// 内部方法
// ============================================================
function addToast(
  type: ToastType,
  title: string,
  options?: {
    message?: string
    duration?: number
    closable?: boolean
  }
): number {
  const id = nextId++
  const duration = options?.duration ?? DEFAULT_DURATION[type]
  const item: ToastItem = {
    id,
    type,
    title,
    message: options?.message,
    duration,
    closable: options?.closable ?? true,
  }

  toasts.value.push(item)

  // 自动消失
  if (duration > 0) {
    setTimeout(() => {
      removeToast(id)
    }, duration)
  }

  // 限制最多显示 5 条
  if (toasts.value.length > 5) {
    toasts.value.shift()
  }

  return id
}

function removeToast(id: number) {
  const index = toasts.value.findIndex(t => t.id === id)
  if (index > -1) {
    toasts.value.splice(index, 1)
  }
}

function clearAll() {
  toasts.value = []
}

// ============================================================
// 导出 API
// ============================================================
export function useToast() {
  return {
    toasts: readonly(toasts),
    success: (title: string, options?: { message?: string; duration?: number }) =>
      addToast('success', title, options),
    error: (title: string, options?: { message?: string; duration?: number }) =>
      addToast('error', title, options),
    info: (title: string, options?: { message?: string; duration?: number }) =>
      addToast('info', title, options),
    warning: (title: string, options?: { message?: string; duration?: number }) =>
      addToast('warning', title, options),
    remove: removeToast,
    clear: clearAll,
  }
}
