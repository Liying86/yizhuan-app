/**
 * 会员服务 - 前端组合式函数
 * 封装会员状态查询、限制检查、激活码输入等逻辑
 */
import { ref, readonly } from 'vue'
import type { LicenseStatus, UsageLimits, MemberTier, ActivationResult } from '../types/electron'

// ============================================================
// 全局状态（单例）
// ============================================================
const licenseStatus = ref<LicenseStatus>({
  tier: 'free',
  isActive: false,
  activatedAt: null,
  expiresAt: null,
  daysRemaining: null,
  machineId: '',
})

const usageLimits = ref<UsageLimits>({
  maxFileSize: 20 * 1024 * 1024,
  maxBatchCount: 5,
  ocrDailyLimit: 3,
  hasWatermark: false,
  // 免费版支持的格式（加载 license 信息前默认使用此列表，避免异步延迟导致所有格式被拒）
  supportedFormats: ['pdf', 'docx', 'doc', 'ppt', 'pptx', 'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'bmp', 'webp', 'heic', 'heif', 'mp4', 'avi', 'mkv', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts', 'caj', 'nh'],
  canUseBatch: true,
  canUseOcr: true,
})

const ocrUsage = ref<{ allowed: boolean, remaining: number, limit: number }>({
  allowed: true,
  remaining: 3,
  limit: 3,
})

// 邀请码
const myReferralCode = ref('')
const referralStats = ref<{ myCode: string, invitedCount: number }>({
  myCode: '',
  invitedCount: 0,
})

// 邀请弹窗可见性
const referralPopupVisible = ref(false)

let initialized = false

// ============================================================
// 初始化
// ============================================================
async function loadLicenseInfo() {
  if (!window.electronAPI) return

  const [status, limits, ocr, referral, stats] = await Promise.all([
    window.electronAPI.licenseStatus(),
    window.electronAPI.licenseLimits(),
    window.electronAPI.licenseOcrCheck(),
    window.electronAPI.referralGetCode(),
    window.electronAPI.referralStats(),
  ])

  licenseStatus.value = status
  usageLimits.value = limits
  ocrUsage.value = ocr
  myReferralCode.value = referral.code
  referralStats.value = stats
}

// ============================================================
// 限制检查
// ============================================================

/**
 * 检查文件大小是否超出限制
 */
export function checkFileSize(fileSize: number): { allowed: boolean, message?: string } {
  const limits = usageLimits.value
  if (limits.maxFileSize > 0 && fileSize > limits.maxFileSize) {
    const limitMB = Math.round(limits.maxFileSize / 1024 / 1024)
    const fileMB = (fileSize / 1024 / 1024).toFixed(1)
    return {
      allowed: false,
      message: `文件大小 ${fileMB}MB 超出免费版限制（${limitMB}MB），升级 Pro 会员可转换无限大小文件`,
    }
  }
  return { allowed: true }
}

/**
 * 检查批量转换数量是否超出限制
 */
export function checkBatchCount(count: number): { allowed: boolean, message?: string } {
  const limits = usageLimits.value
  if (limits.maxBatchCount > 0 && count > limits.maxBatchCount) {
    return {
      allowed: false,
      message: `批量转换数量 ${count} 超出免费版限制（${limits.maxBatchCount} 个），升级 Pro 会员可批量转换无限文件`,
    }
  }
  return { allowed: true }
}

/**
 * 检查是否可以使用 OCR，如可用则增加计数
 */
export async function checkAndConsumeOcr(): Promise<{ allowed: boolean, message?: string, remaining?: number }> {
  if (!window.electronAPI) return { allowed: true }

  const check = await window.electronAPI.licenseOcrCheck()
  ocrUsage.value = check

  if (!check.allowed) {
    return {
      allowed: false,
      message: `今日 OCR 识别次数已用完（免费版每日 ${check.limit} 次），升级 Pro 会员可无限使用`,
    }
  }

  // 增加使用计数
  await window.electronAPI.licenseOcrIncrement()

  // 刷新剩余次数
  const updated = await window.electronAPI.licenseOcrCheck()
  ocrUsage.value = updated

  return {
    allowed: true,
    remaining: updated.remaining,
  }
}

/**
 * 检查文件格式是否支持
 */
export function checkFormatSupported(ext: string): boolean {
  return usageLimits.value.supportedFormats.includes(ext.toLowerCase())
}

// ============================================================
// 邀请码系统
// ============================================================

/**
 * 获取我的邀请码
 */
export function getReferralCode(): string {
  return myReferralCode.value
}

/**
 * 使用邀请码激活
 */
export async function activateWithReferralCode(code: string): Promise<ActivationResult> {
  if (!window.electronAPI) return { success: false, message: '不可用' }

  const result = await window.electronAPI.referralActivate(code)

  if (result.success) {
    await loadLicenseInfo()
  }

  return result
}

/**
 * 显示邀请弹窗（仅对免费用户显示）
 * @returns 是否实际显示了弹窗
 */
export function showReferralIfEligible(): boolean {
  if (licenseStatus.value.tier === 'free' && !licenseStatus.value.isActive) {
    referralPopupVisible.value = true
    return true
  }
  return false
}

/**
 * 关闭邀请弹窗
 */
export function closeReferralPopup(): void {
  referralPopupVisible.value = false
}

// ============================================================
// 激活 / 停用
// ============================================================

export async function activateLicense(code: string): Promise<{ success: boolean, message: string }> {
  if (!window.electronAPI) return { success: false, message: '不可用' }

  const result = await window.electronAPI.licenseActivate(code)

  if (result.success) {
    await loadLicenseInfo()
  }

  return result
}

export async function deactivateLicense(): Promise<{ success: boolean, message: string }> {
  if (!window.electronAPI) return { success: false, message: '不可用' }

  const result = await window.electronAPI.licenseDeactivate()

  if (result.success) {
    await loadLicenseInfo()
  }

  return result
}

// ============================================================
// 导出 API
// ============================================================
export function useLicense() {
  // 首次调用时初始化
  if (!initialized) {
    initialized = true
    loadLicenseInfo()
  }

  return {
    licenseStatus: readonly(licenseStatus),
    usageLimits: readonly(usageLimits),
    ocrUsage: readonly(ocrUsage),
    myReferralCode: readonly(myReferralCode),
    referralStats: readonly(referralStats),
    referralPopupVisible: readonly(referralPopupVisible),
    isPro: () => licenseStatus.value.tier !== 'free',
    isPaid: () => licenseStatus.value.tier !== 'free',
    tier: () => licenseStatus.value.tier as MemberTier,
    loadLicenseInfo,
    checkFileSize,
    checkBatchCount,
    checkAndConsumeOcr,
    checkFormatSupported,
    getReferralCode,
    activateWithReferralCode,
    showReferralIfEligible,
    closeReferralPopup,
    activateLicense,
    deactivateLicense,
  }
}
