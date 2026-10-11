<script setup lang="ts">
import { ref, computed } from 'vue'
import { useLicense, activateLicense, deactivateLicense, activateWithReferralCode } from '../composables/useLicense'
import { usePayment, openPayment } from '../composables/usePayment'
import { useToast } from '../composables/useToast'
import PaymentDialog from './PaymentDialog.vue'

const toast = useToast()
const { licenseStatus, ocrUsage, myReferralCode } = useLicense()
usePayment() // 初始化支付状态单例

// 激活码输入
const activationCode = ref('')
const isActivating = ref(false)

// 邀请码输入
const referralCodeInput = ref('')
const isReferralActivating = ref(false)

// 功能对比数据
const featureComparison = [
  { feature: 'PDF 转 Word', free: true, pro: true },
  { feature: 'Word/PPT/Excel 转 PDF', free: true, pro: true },
  { feature: 'CAJ 转 PDF', free: true, pro: true },
  { feature: '图片格式转换', free: true, pro: true },
  { feature: 'HEIC 转 JPG', free: true, pro: true },
  { feature: '视频格式转换', free: true, pro: true },
  { feature: 'PDF 合并/拆分', free: true, pro: true },
  { feature: 'PDF 转图片', free: true, pro: true },
  { feature: '图片压缩', free: true, pro: true },
  { feature: 'HTML/MD 转 PDF', free: true, pro: true },
  { feature: '图片转 HTML/MD', free: true, pro: true },
  { feature: 'OCR 文字识别', free: '每日 3 次', pro: '无限次' },
  { feature: '批量转换', free: '每次 5 个', pro: '无限个' },
  { feature: '最大文件大小', free: '50MB', pro: '无限制' },
  { feature: 'TIFF/GIF 格式', free: false, pro: true },
  { feature: '输出水印', free: '带品牌水印', pro: '无水印' },
  { feature: '右键菜单集成', free: true, pro: true },
  { feature: '优先技术支持', free: false, pro: true },
]

// 格式化日期
function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

// 会员等级标签
const tierLabel = computed(() => {
  switch (licenseStatus.value.tier) {
    case 'referral': return '邀请会员'
    case 'monthly': return '月度会员'
    case 'quarterly': return '季度会员'
    case 'pro': return 'Pro 会员'
    case 'lifetime': return '终身会员'
    default: return '免费版'
  }
})

const tierColor = computed(() => {
  switch (licenseStatus.value.tier) {
    case 'referral': return '#8b5cf6'
    case 'monthly': return '#06b6d4'
    case 'quarterly': return '#10b981'
    case 'pro': return '#4f46e5'
    case 'lifetime': return '#8b5cf6'
    default: return '#64748b'
  }
})

// 激活
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
      activationCode.value = ''
    } else {
      toast.error('激活失败', { message: result.message })
    }
  } finally {
    isActivating.value = false
  }
}

// 使用邀请码激活
async function onReferralActivate() {
  const code = referralCodeInput.value.trim()
  if (!code) {
    toast.warning('请输入邀请码')
    return
  }

  isReferralActivating.value = true
  try {
    const result = await activateWithReferralCode(code)
    if (result.success) {
      toast.success('激活成功', { message: result.message })
      referralCodeInput.value = ''
    } else {
      toast.error('激活失败', { message: result.message })
    }
  } finally {
    isReferralActivating.value = false
  }
}

// 停用
async function onDeactivate() {
  const result = await deactivateLicense()
  if (result.success) {
    toast.success('已取消会员激活')
  } else {
    toast.error('取消失败', { message: result.message })
  }
}

// 自动格式化激活码输入
function onCodeInput(e: Event) {
  const input = e.target as HTMLInputElement
  let value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
  // 每 4 位加一个连字符
  const formatted = value.match(/.{1,4}/g)?.join('-') || ''
  activationCode.value = formatted
}

// 格式化邀请码输入
function onReferralCodeInput(e: Event) {
  const input = e.target as HTMLInputElement
  let value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
  // 8 位邀请码，格式 XXXX-XXXX
  if (value.length > 4) {
    value = value.substring(0, 4) + '-' + value.substring(4, 8)
  }
  referralCodeInput.value = value
}

// 复制邀请码
function copyReferralCode() {
  if (myReferralCode.value) {
    navigator.clipboard.writeText(myReferralCode.value)
    toast.success('邀请码已复制')
  }
}

// 复制下载链接
function copyDownloadLink() {
  const link = 'https://yizhuan-app.cn'
  navigator.clipboard.writeText(link)
  toast.success('下载链接已复制')
}

// 点击购买按钮：打开支付弹窗
function handleBuy(tier: 'monthly' | 'quarterly' | 'pro' | 'lifetime') {
  openPayment(tier)
}

// 判断某个套餐是否对当前用户可购买（已激活更高等级则不可降级购买）
function canBuyTier(tier: string): boolean {
  if (!licenseStatus.value.isActive) return true
  const currentTier = licenseStatus.value.tier
  const tierRank: Record<string, number> = { free: 0, referral: 1, monthly: 2, quarterly: 3, pro: 4, lifetime: 5 }
  const currentRank = tierRank[currentTier] ?? 0
  const targetRank = tierRank[tier] ?? 0
  return targetRank > currentRank
}
</script>

<template>
  <section class="membership-section">
    <!-- 当前状态卡片 -->
    <div class="status-card" :style="{ borderColor: tierColor + '40' }">
      <div class="status-badge" :style="{ background: tierColor }">
        {{ tierLabel }}
      </div>
      <div class="status-info">
        <div v-if="licenseStatus.isActive" class="status-detail">
          <div class="detail-row">
            <span class="detail-label">激活时间</span>
            <span class="detail-value">{{ formatDate(licenseStatus.activatedAt) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">到期时间</span>
            <span class="detail-value">
              {{ licenseStatus.expiresAt ? formatDate(licenseStatus.expiresAt) : '永久有效' }}
            </span>
          </div>
          <div v-if="licenseStatus.daysRemaining !== null" class="detail-row">
            <span class="detail-label">剩余天数</span>
            <span class="detail-value" :class="{ urgent: licenseStatus.daysRemaining <= 7 }">
              {{ licenseStatus.daysRemaining }} 天
            </span>
          </div>
        </div>
        <div v-else class="status-detail">
          <p class="free-desc">正在使用免费版，升级会员解锁全部功能</p>
          <div class="usage-row">
            <span>OCR 今日剩余</span>
            <span class="usage-value">
              {{ ocrUsage.remaining === -1 ? '无限' : `${ocrUsage.remaining} / ${ocrUsage.limit}` }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- 邀请好友卡片（免费用户显示邀请码输入，会员显示分享入口） -->
    <div class="referral-card">
      <h3 class="card-title">
        <span class="referral-icon">🎁</span>
        邀请好友得免费会员
      </h3>
      <p class="card-desc">分享邀请码给好友，好友激活后双方各得30天免费会员</p>

      <!-- 我的邀请码 -->
      <div class="my-referral-section">
        <div class="referral-label">我的邀请码</div>
        <div class="referral-code-box">
          <span class="referral-code">{{ myReferralCode }}</span>
          <button class="copy-btn" @click="copyReferralCode">复制</button>
        </div>
        <button class="share-btn" @click="copyDownloadLink">
          📋 复制下载链接 + 邀请码
        </button>
      </div>

      <!-- 输入邀请码（仅免费用户） -->
      <div v-if="!licenseStatus.isActive" class="referral-input-section">
        <div class="referral-divider">
          <span>或输入好友邀请码</span>
        </div>
        <div class="input-group">
          <input
            type="text"
            class="code-input referral-input"
            v-model="referralCodeInput"
            @input="onReferralCodeInput"
            placeholder="XXXX-XXXX"
            maxlength="9"
          />
          <button
            class="activate-btn referral-activate-btn"
            :disabled="isReferralActivating || !referralCodeInput"
            @click="onReferralActivate"
          >
            {{ isReferralActivating ? '激活中...' : '立即激活' }}
          </button>
        </div>
        <p class="referral-hint">输入邀请码即可获得30天免费会员，每位用户仅限使用一次</p>
      </div>
    </div>

    <!-- 激活码输入区 -->
    <div v-if="!licenseStatus.isActive" class="activate-card">
      <h3 class="card-title">输入激活码</h3>
      <p class="card-desc">输入激活码，解锁对应会员权益</p>
      <div class="input-group">
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
    </div>

    <!-- 已激活：管理区 -->
    <div v-else class="activated-card">
      <button class="deactivate-btn" @click="onDeactivate">
        取消会员激活
      </button>
    </div>

    <!-- 功能对比表 -->
    <div class="comparison-card">
      <h3 class="card-title">功能对比</h3>
      <table class="comparison-table">
        <thead>
          <tr>
            <th>功能</th>
            <th class="col-free">免费版</th>
            <th class="col-pro">Pro 会员</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, idx) in featureComparison" :key="idx">
            <td class="feat-name">{{ row.feature }}</td>
            <td class="feat-val">
              <span v-if="row.free === true" class="check">✓</span>
              <span v-else-if="row.free === false" class="cross">—</span>
              <span v-else class="text-val">{{ row.free }}</span>
            </td>
            <td class="feat-val">
              <span v-if="row.pro === true" class="check pro">✓</span>
              <span v-else-if="row.pro === false" class="cross">—</span>
              <span v-else class="text-val pro">{{ row.pro }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 定价展示 -->
    <div class="pricing-cards">
      <!-- 1. 免费版 -->
      <div class="pricing-card free">
        <div class="pricing-header">
          <span class="pricing-name">免费版</span>
          <span class="pricing-price">¥0</span>
        </div>
        <ul class="pricing-features">
          <li>基础格式转换</li>
          <li>OCR 每日 3 次</li>
          <li>批量每次 5 个</li>
          <li>最大 50MB 文件</li>
          <li>输出带品牌水印</li>
        </ul>
        <span v-if="licenseStatus.tier === 'free' && !licenseStatus.isActive" class="current-tag">当前方案</span>
        <span v-else class="current-tag-placeholder"></span>
      </div>

      <!-- 2. 月度会员 -->
      <div class="pricing-card monthly" :class="{ current: licenseStatus.tier === 'monthly' || licenseStatus.tier === 'referral' }">
        <div class="pricing-header">
          <span class="pricing-name">月度会员</span>
          <span class="pricing-price">¥5.9<span class="per">/月</span></span>
        </div>
        <ul class="pricing-features">
          <li>全部格式转换</li>
          <li>OCR 无限次使用</li>
          <li>批量无限制</li>
          <li>文件大小无限制</li>
          <li>无水印输出</li>
          <li>30 天有效</li>
        </ul>
        <button v-if="canBuyTier('monthly')" class="buy-btn" @click="handleBuy('monthly')">
          立即购买
        </button>
        <span v-else-if="licenseStatus.tier === 'monthly' || licenseStatus.tier === 'referral'" class="current-tag">当前方案</span>
        <span v-else class="current-tag-placeholder"></span>
      </div>

      <!-- 3. 季度卡 -->
      <div class="pricing-card quarterly" :class="{ current: licenseStatus.tier === 'quarterly' }">
        <div class="pricing-header">
          <span class="pricing-name">季度会员</span>
          <span class="pricing-price">¥9.9<span class="per">/3个月</span></span>
        </div>
        <p class="pricing-note">立省 7.8 元，折合 3.3 元/月，不用每月续费</p>
        <ul class="pricing-features">
          <li>全部格式转换</li>
          <li>OCR 无限次使用</li>
          <li>批量无限制</li>
          <li>文件大小无限制</li>
          <li>无水印输出</li>
          <li>90 天有效</li>
        </ul>
        <button v-if="canBuyTier('quarterly')" class="buy-btn" @click="handleBuy('quarterly')">
          立即购买
        </button>
        <span v-else-if="licenseStatus.tier === 'quarterly'" class="current-tag">当前方案</span>
        <span v-else class="current-tag-placeholder"></span>
      </div>

      <!-- 4. 年卡 Pro（推荐） -->
      <div class="pricing-card pro" :class="{ current: licenseStatus.tier === 'pro' }">
        <div class="pricing-badge">推荐</div>
        <div class="pricing-header">
          <span class="pricing-name">年卡 Pro</span>
          <span class="pricing-price">¥39<span class="per">/年</span></span>
        </div>
        <p class="pricing-note">年度性价比之王，折合 3.25 元/月</p>
        <ul class="pricing-features">
          <li>全部格式转换</li>
          <li>OCR 无限次使用</li>
          <li>批量无限制</li>
          <li>文件大小无限制</li>
          <li>无水印输出</li>
          <li>优先技术支持</li>
        </ul>
        <button v-if="canBuyTier('pro')" class="buy-btn" @click="handleBuy('pro')">
          立即购买
        </button>
        <span v-else-if="licenseStatus.tier === 'pro'" class="current-tag">当前方案</span>
        <span v-else class="current-tag-placeholder"></span>
      </div>

      <!-- 5. 终身买断 -->
      <div class="pricing-card lifetime" :class="{ current: licenseStatus.tier === 'lifetime' }">
        <div class="pricing-header">
          <span class="pricing-name">终身会员</span>
          <span class="pricing-price">¥69<span class="per">一次性</span></span>
        </div>
        <p class="pricing-note">仅 69 元，不到 1.8 年年费，永久免续费</p>
        <ul class="pricing-features">
          <li>Pro 全部功能</li>
          <li>永久免费更新</li>
          <li>终身使用权益</li>
          <li>专属客服支持</li>
        </ul>
        <button v-if="canBuyTier('lifetime')" class="buy-btn" @click="handleBuy('lifetime')">
          立即购买
        </button>
        <span v-else-if="licenseStatus.tier === 'lifetime'" class="current-tag">当前方案</span>
        <span v-else class="current-tag-placeholder"></span>
      </div>
    </div>

    <!-- 支付弹窗 -->
    <PaymentDialog />
  </section>
</template>

<style scoped>
.membership-section {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* 状态卡片 */
.status-card {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 20px;
  background: var(--surface);
  border: 2px solid;
  border-radius: var(--radius);
}

.status-badge {
  padding: 8px 20px;
  border-radius: 20px;
  color: white;
  font-size: 15px;
  font-weight: 700;
  white-space: nowrap;
}

.status-info {
  flex: 1;
}

.status-detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.detail-row {
  display: flex;
  gap: 12px;
  font-size: 13px;
}

.detail-label {
  color: var(--muted);
  min-width: 70px;
}

.detail-value {
  color: var(--ink);
  font-weight: 500;
}

.detail-value.urgent {
  color: var(--danger);
}

.free-desc {
  font-size: 14px;
  color: var(--muted);
  margin-bottom: 4px;
}

.usage-row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
}

.usage-value {
  font-weight: 600;
  color: var(--primary);
}

/* 邀请好友卡片 */
.referral-card {
  padding: 20px;
  background: linear-gradient(135deg, rgba(139, 92, 246, 0.08), rgba(79, 70, 229, 0.06));
  border: 2px solid rgba(139, 92, 246, 0.3);
  border-radius: var(--radius);
}

.referral-icon {
  margin-right: 6px;
}

.my-referral-section {
  margin-top: 12px;
}

.referral-label {
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 6px;
}

.referral-code-box {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.referral-code {
  flex: 1;
  padding: 10px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 18px;
  font-family: 'Courier New', monospace;
  font-weight: 700;
  color: #8b5cf6;
  letter-spacing: 3px;
  text-align: center;
}

.copy-btn {
  padding: 8px 16px;
  background: var(--primary);
  color: white;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.copy-btn:hover {
  background: var(--primary-light);
}

.share-btn {
  width: 100%;
  padding: 10px;
  background: linear-gradient(90deg, #8b5cf6, #4f46e5);
  color: white;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.share-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);
}

.referral-divider {
  display: flex;
  align-items: center;
  margin: 16px 0 12px 0;
  color: var(--muted);
  font-size: 12px;
}

.referral-divider::before,
.referral-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}

.referral-divider span {
  padding: 0 12px;
}

.referral-input-section {
  margin-top: 8px;
}

.referral-input {
  font-size: 18px !important;
  letter-spacing: 3px !important;
  text-align: center;
}

.referral-activate-btn {
  background: linear-gradient(90deg, #8b5cf6, #4f46e5) !important;
}

.referral-activate-btn:hover:not(:disabled) {
  box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3) !important;
}

.referral-hint {
  font-size: 12px;
  color: var(--muted);
  margin-top: 8px;
  text-align: center;
}

/* 激活码输入 */
.activate-card {
  padding: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.card-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 4px;
}

.card-desc {
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 16px;
}

.input-group {
  display: flex;
  gap: 10px;
}

.code-input {
  flex: 1;
  padding: 10px 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 16px;
  font-family: 'Courier New', monospace;
  letter-spacing: 2px;
  color: var(--ink);
  outline: none;
  transition: all 0.2s;
}

.code-input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
}

.activate-btn {
  padding: 10px 24px;
  background: var(--primary);
  color: white;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.activate-btn:hover:not(:disabled) {
  background: var(--primary-light);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(79, 70, 229, 0.25);
}

.activate-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 已激活管理 */
.activated-card {
  display: flex;
  justify-content: flex-end;
}

.deactivate-btn {
  padding: 6px 16px;
  font-size: 13px;
  color: var(--danger);
  background: rgba(239, 68, 68, 0.06);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.2s;
}

.deactivate-btn:hover {
  background: rgba(239, 68, 68, 0.1);
}

/* 功能对比表 */
.comparison-card {
  padding: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.comparison-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;
}

.comparison-table th {
  text-align: left;
  padding: 10px 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
  border-bottom: 2px solid var(--border);
}

.comparison-table th.col-pro {
  color: var(--primary);
}

.comparison-table td {
  padding: 10px 12px;
  font-size: 14px;
  border-bottom: 1px solid var(--border);
}

.feat-name {
  color: var(--ink);
}

.feat-val {
  text-align: center;
}

.check {
  color: var(--success);
  font-weight: 700;
  font-size: 16px;
}

.check.pro {
  color: var(--primary);
}

.cross {
  color: var(--muted);
}

.text-val {
  font-size: 13px;
  color: var(--muted);
}

.text-val.pro {
  color: var(--primary);
  font-weight: 500;
}

/* 定价卡片 */
.pricing-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.pricing-card {
  position: relative;
  padding: 20px 16px;
  background: var(--surface);
  border: 2px solid var(--border);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  transition: all 0.25s;
}

.pricing-card.pro {
  border-color: var(--primary);
  background: linear-gradient(135deg, rgba(79, 70, 229, 0.03), rgba(6, 182, 212, 0.03));
}

.pricing-card.monthly {
  border-color: #06b6d4;
}

.pricing-card.quarterly {
  border-color: #10b981;
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.04), rgba(6, 182, 212, 0.02));
}

.pricing-card.lifetime {
  border-color: #8b5cf6;
}

.pricing-card.current {
  border-style: dashed;
}

.pricing-badge {
  position: absolute;
  top: -10px;
  left: 50%;
  transform: translateX(-50%);
  padding: 3px 14px;
  background: var(--primary);
  color: white;
  font-size: 11px;
  font-weight: 600;
  border-radius: 10px;
  white-space: nowrap;
}

.pricing-note {
  font-size: 12px;
  color: var(--muted);
  margin: -8px 0 12px 0;
  padding: 4px 8px;
  background: rgba(245, 158, 11, 0.08);
  border-radius: 4px;
  line-height: 1.4;
}

.pricing-card.quarterly .pricing-note {
  background: rgba(16, 185, 129, 0.08);
}

.pricing-card.pro .pricing-note {
  background: rgba(79, 70, 229, 0.08);
}

.pricing-card.lifetime .pricing-note {
  background: rgba(139, 92, 246, 0.08);
}

.pricing-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 16px;
}

.pricing-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--ink);
}

.pricing-price {
  font-size: 24px;
  font-weight: 700;
  color: var(--ink);
}

.pricing-price .per {
  font-size: 13px;
  font-weight: 400;
  color: var(--muted);
}

.pricing-features {
  list-style: none;
  padding: 0;
  margin: 0 0 20px 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pricing-features li {
  font-size: 13px;
  color: var(--muted);
  padding-left: 20px;
  position: relative;
}

.pricing-features li::before {
  content: '✓';
  position: absolute;
  left: 0;
  color: var(--success);
  font-weight: 700;
}

.buy-btn {
  margin-top: auto;
  padding: 10px;
  background: var(--primary);
  color: white;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.buy-btn:hover {
  background: var(--primary-light);
}

.current-tag {
  margin-top: auto;
  text-align: center;
  padding: 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--success);
  background: rgba(16, 185, 129, 0.08);
  border-radius: var(--radius-sm);
}

.current-tag-placeholder {
  margin-top: auto;
}
</style>
