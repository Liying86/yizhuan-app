/**
 * 支付服务 - 前端组合式函数
 * 封装支付弹窗状态、订单创建、支付轮询等逻辑
 */
import { ref, readonly } from 'vue'
import type { PaymentTier, PaymentOrderResult, PaymentQueryResult } from '../types/electron'

// ============================================================
// 全局状态（单例）
// ============================================================

// 支付弹窗可见性
const paymentVisible = ref(false)

// 当前选择的套餐
const currentTier = ref<PaymentTier>('pro')

// 订单信息
const orderInfo = ref<PaymentOrderResult | null>(null)

// 支付状态
const paymentStatus = ref<'idle' | 'creating' | 'pending' | 'paid' | 'failed' | 'closed'>('idle')

// 轮询定时器
let pollTimer: ReturnType<typeof setInterval> | null = null

// 轮询间隔（毫秒）
const POLL_INTERVAL = 3000

// 最大轮询次数（10 分钟）
const MAX_POLL_COUNT = 200

let pollCount = 0

// ============================================================
// 支付轮询
// ============================================================

/**
 * 开始轮询支付状态
 * @param tradeOrderId 商户订单号
 */
function startPolling(tradeOrderId: string): void {
  stopPolling()
  pollCount = 0

  pollTimer = setInterval(async () => {
    pollCount++

    if (pollCount >= MAX_POLL_COUNT) {
      stopPolling()
      paymentStatus.value = 'closed'
      return
    }

    if (!window.electronAPI) return

    const result: PaymentQueryResult = await window.electronAPI.paymentQueryOrder(tradeOrderId)

    if (result.success && result.status === 'paid') {
      stopPolling()
      paymentStatus.value = 'paid'
    } else if (result.success && result.status === 'closed') {
      stopPolling()
      paymentStatus.value = 'closed'
    }
  }, POLL_INTERVAL)
}

/**
 * 停止轮询
 */
function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

// ============================================================
// 打开 / 关闭支付弹窗
// ============================================================

/**
 * 打开支付弹窗并创建订单
 * @param tier 套餐类型
 */
export async function openPayment(tier: PaymentTier): Promise<void> {
  if (!window.electronAPI) return

  currentTier.value = tier
  paymentVisible.value = true
  paymentStatus.value = 'creating'
  orderInfo.value = null

  try {
    const result = await window.electronAPI.paymentCreateOrder({ tier })

    if (result.success && result.tradeOrderId && result.codeUrl) {
      orderInfo.value = result
      paymentStatus.value = 'pending'
      // 开始轮询支付状态
      startPolling(result.tradeOrderId)
    } else {
      paymentStatus.value = 'failed'
      orderInfo.value = result
    }
  } catch {
    paymentStatus.value = 'failed'
  }
}

/**
 * 关闭支付弹窗
 */
export function closePayment(): void {
  stopPolling()
  paymentVisible.value = false
  paymentStatus.value = 'idle'
  orderInfo.value = null
}

/**
 * 手动轮询查询订单状态（供组件主动调用）
 * @param tradeOrderId 商户订单号
 */
export async function pollPaymentStatus(tradeOrderId: string): Promise<PaymentQueryResult | null> {
  if (!window.electronAPI) return null

  const result = await window.electronAPI.paymentQueryOrder(tradeOrderId)

  if (result.success && result.status === 'paid') {
    stopPolling()
    paymentStatus.value = 'paid'
  } else if (result.success && result.status === 'closed') {
    stopPolling()
    paymentStatus.value = 'closed'
  }

  return result
}

// ============================================================
// 导出 API
// ============================================================

export function usePayment() {
  return {
    paymentVisible: readonly(paymentVisible),
    currentTier: readonly(currentTier),
    orderInfo: readonly(orderInfo),
    paymentStatus: readonly(paymentStatus),
    openPayment,
    closePayment,
    pollPaymentStatus,
  }
}
