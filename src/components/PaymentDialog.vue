<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import { usePayment, closePayment } from '../composables/usePayment'
import { useLicense, activateLicense } from '../composables/useLicense'
import { useToast } from '../composables/useToast'
import type { PaymentTier } from '../types/electron'

const toast = useToast()
const { paymentVisible, currentTier, orderInfo, paymentStatus } = usePayment()
const { loadLicenseInfo } = useLicense()

// 激活码输入模式
const showActivationMode = ref(false)
const activationCode = ref('')
const isActivating = ref(false)

// 倒计时（秒）
const countdown = ref(300)
let countdownTimer: ReturnType<typeof setInterval> | null = null

// 支付成功后是否已触发激活
let activationTriggered = false

// 套餐信息映射
const tierInfoMap: Record<PaymentTier, { name: string; price: string; color: string }> = {
  monthly: { name: '月度会员', price: '¥5.9', color: '#06b6d4' },
  quarterly: { name: '季度会员', price: '¥9.9', color: '#10b981' },
  pro: { name: '年卡 Pro', price: '¥39', color: '#4f46e5' },
  lifetime: { name: '终身会员', price: '¥69', color: '#8b5cf6' },
}

const currentTierInfo = computed(() => tierInfoMap[currentTier.value] || tierInfoMap.pro)

// 二维码图片 URL
const qrCodeUrl = computed(() => {
  if (!orderInfo.value?.codeUrl) return ''
  return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(orderInfo.value.codeUrl)}`
})

// 格式化倒计时
const formattedCountdown = computed(() => {
  const mins = Math.floor(countdown.value / 60)
  const secs = countdown.value % 60
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
})

// 支付状态文本
const statusText = computed(() => {
  switch (paymentStatus.value) {
    case 'creating': return '正在创建订单...'
    case 'pending': return '请使用支付宝扫码支付'
    case 'paid': return '支付成功'
    case 'failed': return '订单创建失败'
    case 'closed': return '支付已关闭'
    default: return ''
  }
})

// 开始倒计时
function startCountdown() {
  stopCountdown()
  countdown.value = 300
  countdownTimer = setInterval(() => {
    countdown.value--
    if (countdown.value <= 0) {
      stopCountdown()
    }
  }, 1000)
}

// 停止倒计时
function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}

// 关闭弹窗
function handleClose() {
  stopCountdown()
  showActivationMode.value = false
  activationCode.value = ''
  isActivating.value = false
  activationTriggered = false
  closePayment()
}

// 切换到激活码模式
function switchToActivation() {
  showActivationMode.value = true
}

// 切换到扫码支付模式
function switchToScanPay() {
  showActivationMode.value = false
}

// 激活码输入格式化
function onCodeInput(e: Event) {
  const input = e.target as HTMLInputElement
  let value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const formatted = value.match(/.{1,4}/g)?.join('-') || ''
  activationCode.value = formatted
}

// 手动激活
async function onActivate() {
  const code = activationCode.value.trim()
  if (!code) {
    toast.warning('请输入激活码')
    return
  }

  isActivating.value = true
  try {
    const result = await activateLicense(code)
    if (result.success) {
      toast.success('激活成功', { message: result.message })
      handleClose()
    } else {
      toast.error('激活失败', { message: result.message })
    }
  } finally {
    isActivating.value = false
  }
}

// 监听支付状态变化
watch(paymentStatus, (newStatus) => {
  if (newStatus === 'pending') {
    startCountdown()
  } else if (newStatus === 'paid' && !activationTriggered) {
    activationTriggered = true
    stopCountdown()
    // 支付成功后自动激活会员
    handlePaymentSuccess()
  } else if (newStatus === 'closed' || newStatus === 'failed') {
    stopCountdown()
  }
})

// 支付成功处理
async function handlePaymentSuccess() {
  try {
    // 刷新会员信息
    await loadLicenseInfo()
    toast.success('支付成功', { message: '会员已自动激活' })
  } catch {
    toast.error('会员激活失败', { message: '请联系客服处理' })
  }
}

// 监听弹窗关闭，重置状态
watch(paymentVisible, (visible) => {
  if (!visible) {
    stopCountdown()
    showActivationMode.value = false
    activationCode.value = ''
    activationTriggered = false
  }
})

onUnmounted(() => {
  stopCountdown()
})
</script>

<template>
  <Transition name="payment-fade">
    <div v-if="paymentVisible" class="payment-overlay" @click.self="handleClose">
      <div class="payment-modal">
        <button class="payment-close" @click="handleClose">✕</button>

        <!-- 头部：套餐信息 -->
        <div class="payment-header">
          <div class="payment-tier-badge" :style="{ background: currentTierInfo.color }">
            {{ currentTierInfo.name }}
          </div>
          <div class="payment-price">
            <span class="price-symbol">¥</span>
            <span class="price-value">{{ currentTierInfo.price.replace('¥', '') }}</span>
          </div>
        </div>

        <!-- 激活码输入模式 -->
        <div v-if="showActivationMode" class="activation-section">
          <h3 class="section-title">输入激活码</h3>
          <p class="section-desc">输入激活码，立即解锁会员权益</p>
          <div class="activation-input-group">
            <input
              type="text"
              class="code-input"
              v-model="activationCode"
              @input="onCodeInput"
              placeholder="XXXX-XXXX-XXXX-XXXX"
              maxlength="19"
            />
            <button
              class="activate-btn"
              :disabled="isActivating || !activationCode"
              @click="onActivate"
            >
              {{ isActivating ? '激活中...' : '立即激活' }}
            </button>
          </div>
          <button class="switch-link" @click="switchToScanPay">
            ← 返回扫码支付
          </button>
        </div>

        <!-- 扫码支付模式 -->
        <div v-else class="qrcode-section">
          <!-- 二维码区域 -->
          <div class="qrcode-wrapper">
            <div v-if="paymentStatus === 'creating'" class="qrcode-loading">
              <div class="spinner"></div>
              <p class="loading-text">正在生成支付二维码...</p>
            </div>

            <div v-else-if="paymentStatus === 'failed'" class="qrcode-error">
              <div class="error-icon">!</div>
              <p class="error-text">订单创建失败</p>
              <p class="error-subtext">{{ orderInfo?.message || '请稍后重试' }}</p>
            </div>

            <div v-else-if="paymentStatus === 'closed'" class="qrcode-closed">
              <div class="closed-icon">✕</div>
              <p class="closed-text">支付已关闭</p>
              <p class="closed-subtext">二维码已过期，请重新发起支付</p>
            </div>

            <template v-else>
              <div class="qrcode-img-wrapper">
                <img
                  v-if="qrCodeUrl && paymentStatus === 'pending'"
                  :src="qrCodeUrl"
                  alt="支付宝二维码"
                  class="qrcode-img"
                />
                <!-- 支付成功遮罩 -->
                <div v-if="paymentStatus === 'paid'" class="paid-overlay">
                  <div class="paid-check">✓</div>
                  <p class="paid-text">支付成功</p>
                </div>
              </div>
            </template>
          </div>

          <!-- 状态提示 -->
          <div class="status-row">
            <span
              class="status-dot"
              :class="{
                pending: paymentStatus === 'pending',
                paid: paymentStatus === 'paid',
                closed: paymentStatus === 'closed' || paymentStatus === 'failed',
              }"
            ></span>
            <span class="status-text">{{ statusText }}</span>
          </div>

          <!-- 倒计时 -->
          <div v-if="paymentStatus === 'pending'" class="countdown-row">
            <span class="countdown-label">二维码有效期</span>
            <span class="countdown-value">{{ formattedCountdown }}</span>
          </div>

          <!-- 底部提示 -->
          <div class="payment-footer">
            <p class="footer-tip">
              <span class="wechat-icon">💰</span>
              请使用支付宝扫一扫支付
            </p>
            <button class="switch-link" @click="switchToActivation">
              已有激活码？点击输入
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.payment-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.payment-modal {
  position: relative;
  width: 360px;
  max-width: 90vw;
  background: var(--surface, #fff);
  border-radius: 16px;
  padding: 28px 24px 20px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  text-align: center;
}

.payment-close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 28px;
  height: 28px;
  border: none;
  background: rgba(0, 0, 0, 0.05);
  border-radius: 50%;
  font-size: 14px;
  color: var(--muted, #999);
  cursor: pointer;
  transition: all 0.2s;
}

.payment-close:hover {
  background: rgba(0, 0, 0, 0.1);
}

/* 头部 */
.payment-header {
  margin-bottom: 20px;
}

.payment-tier-badge {
  display: inline-block;
  padding: 4px 16px;
  color: white;
  font-size: 12px;
  font-weight: 600;
  border-radius: 12px;
  margin-bottom: 10px;
}

.payment-price {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 2px;
}

.price-symbol {
  font-size: 18px;
  font-weight: 600;
  color: var(--primary, #4f46e5);
}

.price-value {
  font-size: 36px;
  font-weight: 700;
  color: var(--primary, #4f46e5);
  line-height: 1;
}

/* 二维码区域 */
.qrcode-section {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.qrcode-wrapper {
  width: 220px;
  height: 220px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}

.qrcode-img-wrapper {
  position: relative;
  width: 200px;
  height: 200px;
  border-radius: 12px;
  overflow: hidden;
  background: white;
  border: 2px solid var(--border, #e5e7eb);
  padding: 8px;
}

.qrcode-img {
  width: 100%;
  height: 100%;
  display: block;
}

/* 支付成功遮罩 */
.paid-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(16, 185, 129, 0.92);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  animation: fadeIn 0.3s ease;
}

.paid-check {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background: white;
  color: #10b981;
  font-size: 36px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: scaleIn 0.4s ease;
}

.paid-text {
  color: white;
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes scaleIn {
  from { transform: scale(0); }
  to { transform: scale(1); }
}

/* 加载状态 */
.qrcode-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--border, #e5e7eb);
  border-top-color: var(--primary, #4f46e5);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.loading-text {
  font-size: 13px;
  color: var(--muted, #64748b);
  margin: 0;
}

/* 错误状态 */
.qrcode-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.error-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
  font-size: 24px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.error-text {
  font-size: 14px;
  font-weight: 600;
  color: var(--danger, #ef4444);
  margin: 0;
}

.error-subtext {
  font-size: 12px;
  color: var(--muted, #64748b);
  margin: 0;
}

/* 关闭状态 */
.qrcode-closed {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.closed-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: rgba(100, 116, 139, 0.1);
  color: var(--muted, #64748b);
  font-size: 20px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.closed-text {
  font-size: 14px;
  font-weight: 600;
  color: var(--muted, #64748b);
  margin: 0;
}

.closed-subtext {
  font-size: 12px;
  color: var(--muted, #94a3b8);
  margin: 0;
}

/* 状态行 */
.status-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-bottom: 12px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted, #94a3b8);
}

.status-dot.pending {
  background: #f59e0b;
  animation: pulse 1.5s ease-in-out infinite;
}

.status-dot.paid {
  background: #10b981;
}

.status-dot.closed {
  background: var(--muted, #94a3b8);
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.status-text {
  font-size: 13px;
  color: var(--ink, #1a1a2e);
  font-weight: 500;
}

/* 倒计时 */
.countdown-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-bottom: 16px;
  padding: 6px 14px;
  background: rgba(245, 158, 11, 0.08);
  border-radius: 20px;
}

.countdown-label {
  font-size: 12px;
  color: var(--muted, #64748b);
}

.countdown-value {
  font-size: 14px;
  font-weight: 600;
  color: #f59e0b;
  font-family: 'Courier New', monospace;
}

/* 底部 */
.payment-footer {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.footer-tip {
  font-size: 12px;
  color: var(--muted, #64748b);
  margin: 0;
  display: flex;
  align-items: center;
  gap: 4px;
}

.wechat-icon {
  font-size: 14px;
}

.switch-link {
  background: none;
  border: none;
  font-size: 12px;
  color: var(--primary, #4f46e5);
  cursor: pointer;
  padding: 4px 8px;
  transition: color 0.2s;
}

.switch-link:hover {
  color: var(--primary-light, #6366f1);
  text-decoration: underline;
}

/* 激活码模式 */
.activation-section {
  padding: 10px 0;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--ink, #1a1a2e);
  margin: 0 0 4px 0;
}

.section-desc {
  font-size: 13px;
  color: var(--muted, #64748b);
  margin: 0 0 16px 0;
}

.activation-input-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 16px;
}

.code-input {
  width: 100%;
  padding: 12px 14px;
  background: var(--bg, #f8fafc);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: var(--radius-sm, 8px);
  font-size: 16px;
  font-family: 'Courier New', monospace;
  letter-spacing: 2px;
  color: var(--ink, #1a1a2e);
  outline: none;
  transition: all 0.2s;
  text-align: center;
  box-sizing: border-box;
}

.code-input:focus {
  border-color: var(--primary, #4f46e5);
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
}

.activate-btn {
  width: 100%;
  padding: 12px;
  background: var(--primary, #4f46e5);
  color: white;
  border: none;
  border-radius: var(--radius-sm, 8px);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.activate-btn:hover:not(:disabled) {
  background: var(--primary-light, #6366f1);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(79, 70, 229, 0.25);
}

.activate-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 动画 */
.payment-fade-enter-active,
.payment-fade-leave-active {
  transition: opacity 0.25s ease;
}

.payment-fade-enter-active .payment-modal,
.payment-fade-leave-active .payment-modal {
  transition: transform 0.25s ease;
}

.payment-fade-enter-from,
.payment-fade-leave-to {
  opacity: 0;
}

.payment-fade-enter-from .payment-modal,
.payment-fade-leave-to .payment-modal {
  transform: scale(0.9) translateY(20px);
}
</style>
