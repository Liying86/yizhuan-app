<script setup lang="ts">
import { ref } from 'vue'
import { useLicense, closeReferralPopup } from '../composables/useLicense'

const { myReferralCode } = useLicense()

const emit = defineEmits<{
  (e: 'go-to-membership'): void
}>()

const copied = ref(false)

function goToMembership() {
  closeReferralPopup()
  emit('go-to-membership')
}

function dismiss() {
  closeReferralPopup()
}

function copyReferralCode() {
  if (myReferralCode.value) {
    navigator.clipboard.writeText(myReferralCode.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  }
}

function copyShareText() {
  const text = `推荐你用「易转」—— 全能格式转换工具，PDF转Word/Excel、图片转换、视频转换、OCR识别都能搞定。下载地址：https://yizhuan-app.cn\n输入我的邀请码 ${myReferralCode.value}，双方各得30天免费会员！`
  navigator.clipboard.writeText(text)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}
</script>

<template>
  <Transition name="promo-fade">
    <div v-if="useLicense().referralPopupVisible.value" class="promo-overlay" @click.self="dismiss">
      <div class="promo-modal">
        <button class="promo-close" @click="dismiss">✕</button>

        <div class="promo-header">
          <div class="promo-tag">邀请好友免费领</div>
          <h2 class="promo-title">分享好友 <span class="price">首月免费</span></h2>
          <p class="promo-subtitle">邀请好友下载使用，双方各得30天会员</p>
        </div>

        <div class="promo-benefits">
          <div class="benefit-item">
            <span class="benefit-icon">✓</span>
            <span>OCR 无限次使用</span>
          </div>
          <div class="benefit-item">
            <span class="benefit-icon">✓</span>
            <span>批量转换无限制</span>
          </div>
          <div class="benefit-item">
            <span class="benefit-icon">✓</span>
            <span>文件大小无限制</span>
          </div>
          <div class="benefit-item">
            <span class="benefit-icon">✓</span>
            <span>无水印输出</span>
          </div>
          <div class="benefit-item">
            <span class="benefit-icon">✓</span>
            <span>全部格式转换</span>
          </div>
        </div>

        <div class="referral-code-section">
          <div class="referral-code-label">你的专属邀请码</div>
          <div class="referral-code-display">
            <span class="code-text">{{ myReferralCode }}</span>
            <button class="copy-small-btn" @click="copyReferralCode">
              {{ copied ? '已复制' : '复制' }}
            </button>
          </div>
        </div>

        <button class="promo-cta" @click="copyShareText">
          {{ copied ? '✓ 已复制分享文案' : '📋 一键复制分享文案' }}
        </button>
        <button class="promo-more" @click="goToMembership">
          去会员中心了解更多 →
        </button>
        <button class="promo-skip" @click="dismiss">
          暂不分享
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.promo-overlay {
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

.promo-modal {
  position: relative;
  width: 400px;
  max-width: 90vw;
  background: var(--surface, #fff);
  border-radius: 16px;
  padding: 28px 24px 20px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  text-align: center;
}

.promo-close {
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

.promo-close:hover {
  background: rgba(0, 0, 0, 0.1);
}

.promo-header {
  margin-bottom: 16px;
}

.promo-tag {
  display: inline-block;
  padding: 4px 16px;
  background: linear-gradient(90deg, #8b5cf6, #4f46e5);
  color: white;
  font-size: 12px;
  font-weight: 600;
  border-radius: 12px;
  margin-bottom: 12px;
}

.promo-title {
  font-size: 24px;
  font-weight: 700;
  color: var(--ink, #1a1a2e);
  margin: 0 0 6px 0;
}

.promo-title .price {
  color: #8b5cf6;
  font-size: 28px;
}

.promo-subtitle {
  font-size: 14px;
  color: var(--muted, #64748b);
  margin: 0;
}

.promo-benefits {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 16px;
  margin-bottom: 16px;
  text-align: left;
}

.benefit-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--ink, #1a1a2e);
}

.benefit-icon {
  color: #10b981;
  font-weight: 700;
  font-size: 14px;
}

.referral-code-section {
  margin-bottom: 16px;
  padding: 14px;
  background: linear-gradient(135deg, rgba(139, 92, 246, 0.1), rgba(79, 70, 229, 0.06));
  border-radius: 10px;
  border: 1px solid rgba(139, 92, 246, 0.2);
}

.referral-code-label {
  font-size: 12px;
  color: var(--muted, #64748b);
  margin-bottom: 8px;
}

.referral-code-display {
  display: flex;
  align-items: center;
  gap: 10px;
}

.code-text {
  flex: 1;
  font-size: 20px;
  font-family: 'Courier New', monospace;
  font-weight: 700;
  color: #8b5cf6;
  letter-spacing: 3px;
}

.copy-small-btn {
  padding: 6px 14px;
  background: var(--primary);
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.copy-small-btn:hover {
  background: var(--primary-light);
}

.promo-cta {
  width: 100%;
  padding: 12px;
  background: linear-gradient(90deg, #8b5cf6, #4f46e5);
  color: white;
  border: none;
  border-radius: 10px;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.2s;
  margin-bottom: 8px;
}

.promo-cta:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(139, 92, 246, 0.35);
}

.promo-more {
  width: 100%;
  padding: 8px;
  background: transparent;
  border: none;
  color: var(--primary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.2s;
  margin-bottom: 4px;
}

.promo-more:hover {
  color: var(--primary-light);
}

.promo-skip {
  width: 100%;
  padding: 8px;
  background: transparent;
  border: none;
  color: var(--muted, #999);
  font-size: 13px;
  cursor: pointer;
  transition: color 0.2s;
}

.promo-skip:hover {
  color: var(--ink, #1a1a2e);
}

/* 动画 */
.promo-fade-enter-active,
.promo-fade-leave-active {
  transition: opacity 0.25s ease;
}

.promo-fade-enter-active .promo-modal,
.promo-fade-leave-active .promo-modal {
  transition: transform 0.25s ease;
}

.promo-fade-enter-from,
.promo-fade-leave-to {
  opacity: 0;
}

.promo-fade-enter-from .promo-modal,
.promo-fade-leave-to .promo-modal {
  transform: scale(0.9) translateY(20px);
}
</style>
