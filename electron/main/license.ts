/**
 * 会员系统 - 激活码生成与验证
 * 
 * 激活码格式：XXXX-XXXX-XXXX-XXXX（16位，含分隔符）
 * 编码规则：base32 变体，仅使用大写字母和数字（去除易混淆字符 0/O/1/I）
 * 校验位：末 4 位为前 12 位的 CRC8 校验
 */
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { app } from 'electron'

// ============================================================
// 常量
// ============================================================

// base32 字符集（去除易混淆字符）
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const ACTIVATION_CODE_LENGTH = 16 // 不含分隔符
const SEGMENT_LENGTH = 4
const CRC8_POLY = 0x07

// 会员类型
export type MemberTier = 'free' | 'monthly' | 'quarterly' | 'pro' | 'lifetime' | 'referral'

export interface License {
  code: string
  tier: MemberTier
  activatedAt: string      // ISO 时间
  expiresAt: string | null  // ISO 时间，lifetime 为 null
  machineId: string        // 绑定的机器 ID
  referralCode?: string    // 使用的邀请码（如果是通过邀请码激活的）
}

export interface LicenseStatus {
  tier: MemberTier
  isActive: boolean
  activatedAt: string | null
  expiresAt: string | null
  daysRemaining: number | null  // 剩余天数，lifetime 为 null
  machineId: string
  referralCode?: string
}

// ============================================================
// CRC8 计算
// ============================================================

function crc8(data: Buffer): number {
  let crc = 0
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) {
      if (crc & 0x80) {
        crc = ((crc << 1) ^ CRC8_POLY) & 0xFF
      } else {
        crc = (crc << 1) & 0xFF
      }
    }
  }
  return crc
}

// ============================================================
// 激活码生成
// ============================================================

/**
 * 生成单个激活码
 * @param tier 会员类型
 */
export function generateActivationCode(tier: MemberTier = 'pro'): string {
  // 生成 12 位随机数据
  const randomBytes = crypto.randomBytes(9) // 9 bytes -> base32 编码约 14 字符，取前 12 位

  let code = ''
  for (let i = 0; i < 12; i++) {
    const index = randomBytes[i % randomBytes.length] % CHARSET.length
    code += CHARSET[index]
    // 重新混合以增加随机性
    if (i < 12) {
      randomBytes[i % randomBytes.length] = (randomBytes[i % randomBytes.length] + crypto.randomBytes(1)[0]) % 256
    }
  }

  // 终身版：替换前2位为 LF（L 和 F 均在字符集中）
  if (tier === 'lifetime') {
    code = 'LF' + code.substring(2)
  }

  // 月度版：替换前2位为 MP（M 和 P 均在字符集中，30天有效）
  if (tier === 'monthly') {
    code = 'MP' + code.substring(2)
  }

  // 季度版：替换前2位为 QT（Q 和 T 均在字符集中，90天有效）
  if (tier === 'quarterly') {
    code = 'QT' + code.substring(2)
  }

  // 邀请赠送月卡：替换前2位为 RF（R 和 F 均在字符集中，30天有效）
  if (tier === 'referral') {
    code = 'RF' + code.substring(2)
  }

  // 计算 CRC8 校验
  const crc = crc8(Buffer.from(code, 'utf-8'))
  // 校验位编码为 4 个字符
  let checksum = ''
  let crcVal = crc
  for (let i = 0; i < 4; i++) {
    checksum += CHARSET[crcVal % CHARSET.length]
    crcVal = Math.floor(crcVal / CHARSET.length)
  }

  const fullCode = code + checksum

  // 格式化：XXXX-XXXX-XXXX-XXXX
  let formatted = ''
  for (let i = 0; i < fullCode.length; i++) {
    if (i > 0 && i % SEGMENT_LENGTH === 0) {
      formatted += '-'
    }
    formatted += fullCode[i]
  }

  return formatted
}

/**
 * 批量生成激活码
 */
export function generateActivationCodes(count: number, tier: MemberTier = 'pro'): string[] {
  const codes: string[] = []
  const seen = new Set<string>()
  
  while (codes.length < count) {
    const code = generateActivationCode(tier)
    if (!seen.has(code)) {
      seen.add(code)
      codes.push(code)
    }
  }
  
  return codes
}

// ============================================================
// 激活码验证
// ============================================================

/**
 * 验证激活码格式和校验位是否正确
 */
export function validateActivationCode(code: string): boolean {
  // 去除分隔符和空格，转大写
  const clean = code.replace(/[\s-]/g, '').toUpperCase()
  
  if (clean.length !== ACTIVATION_CODE_LENGTH) {
    return false
  }
  
  // 检查字符集
  for (const ch of clean) {
    if (!CHARSET.includes(ch)) {
      return false
    }
  }
  
  // 分离数据部分和校验位
  const dataPart = clean.substring(0, 12)
  const checksumPart = clean.substring(12, 16)
  
  // 计算期望的校验位
  const crc = crc8(Buffer.from(dataPart, 'utf-8'))
  let expectedChecksum = ''
  let crcVal = crc
  for (let i = 0; i < 4; i++) {
    expectedChecksum += CHARSET[crcVal % CHARSET.length]
    crcVal = Math.floor(crcVal / CHARSET.length)
  }
  
  return checksumPart === expectedChecksum
}

// ============================================================
// 机器 ID 生成（用于绑定）
// ============================================================

function getMachineId(): string {
  // 使用 Node.js 内置信息生成机器标识
  const networkInterfaces: any[] = Object.values(os.networkInterfaces()).flat()
  const macAddress = networkInterfaces
    .find((iface: any) => iface && !iface.internal && iface.mac !== '00:00:00:00:00:00')
    ?.mac || 'unknown'
  
  const hostname = os.hostname()
  const platform = os.platform()
  const arch = os.arch()
  
  return crypto
    .createHash('sha256')
    .update(`${macAddress}-${hostname}-${platform}-${arch}`)
    .digest('hex')
    .substring(0, 32)
}

// ============================================================
// 许可证存储
// ============================================================

function getLicensePath(): string {
  return join(app.getPath('userData'), 'license.json')
}

/**
 * 加载已激活的许可证
 */
export function loadLicense(): License | null {
  try {
    const path = getLicensePath()
    if (!fs.existsSync(path)) return null
    const data = fs.readFileSync(path, 'utf-8')
    const license = JSON.parse(data) as License
    
    // 验证机器 ID
    const currentMachineId = getMachineId()
    if (license.machineId !== currentMachineId) {
      // 机器不匹配，许可证无效
      return null
    }
    
    return license
  } catch {
    return null
  }
}

/**
 * 保存许可证
 */
function saveLicense(license: License): void {
  const path = getLicensePath()
  const data = JSON.stringify(license, null, 2)
  fs.writeFileSync(path, data, 'utf-8')
}

/**
 * 删除许可证（取消激活）
 */
function deleteLicense(): void {
  try {
    const path = getLicensePath()
    if (fs.existsSync(path)) {
      fs.unlinkSync(path)
    }
  } catch {
    // 忽略删除错误
  }
}

// ============================================================
// 激活码类型识别
// ============================================================

/**
 * 根据激活码推断会员类型
 * 实际应用中，激活码类型应存储在服务器端
 * 这里使用简化方案：通过特定前缀区分
 * - LF 开头：终身版
 * - MP 开头：月度版（30天有效）
 * - QT 开头：季度版（90天有效）
 * - RF 开头：邀请赠送月卡（30天有效，通过邀请码获得）
 * - 其他：Pro 版（1年）
 */
function inferTierFromCode(code: string): MemberTier {
  const clean = code.replace(/[\s-]/g, '').toUpperCase()
  if (clean.startsWith('LF')) {
    return 'lifetime'
  }
  if (clean.startsWith('MP')) {
    return 'monthly'
  }
  if (clean.startsWith('QT')) {
    return 'quarterly'
  }
  if (clean.startsWith('RF')) {
    return 'referral'
  }
  return 'pro'
}

// ============================================================
// 激活 / 停用
// ============================================================

export interface ActivationResult {
  success: boolean
  message: string
  license?: License
}

/**
 * 激活会员
 */
export function activateLicense(code: string): ActivationResult {
  // 验证格式
  if (!validateActivationCode(code)) {
    return {
      success: false,
      message: '激活码格式错误或无效，请检查后重试',
    }
  }
  
  // 检查是否已激活
  const existing = loadLicense()
  if (existing && existing.code === code.replace(/[\s-]/g, '').toUpperCase()) {
    return {
      success: false,
      message: '该激活码已在此设备上激活',
      license: existing,
    }
  }
  
  const tier = inferTierFromCode(code)
  const now = new Date()
  const machineId = getMachineId()
  
  let expiresAt: string | null
  if (tier === 'lifetime') {
    expiresAt = null
  } else if (tier === 'monthly' || tier === 'referral') {
    // 月度版/邀请赠送月卡有效期 30 天
    const expiry = new Date(now)
    expiry.setDate(expiry.getDate() + 30)
    expiresAt = expiry.toISOString()
  } else if (tier === 'quarterly') {
    // 季度版有效期 90 天
    const expiry = new Date(now)
    expiry.setDate(expiry.getDate() + 90)
    expiresAt = expiry.toISOString()
  } else {
    // Pro 版有效期 365 天
    const expiry = new Date(now)
    expiry.setDate(expiry.getDate() + 365)
    expiresAt = expiry.toISOString()
  }
  
  const license: License = {
    code: code.replace(/[\s-]/g, '').toUpperCase(),
    tier,
    activatedAt: now.toISOString(),
    expiresAt,
    machineId,
  }
  
  saveLicense(license)
  
  return {
    success: true,
    message: tier === 'lifetime' ? '终身会员激活成功' 
      : tier === 'monthly' ? '月度会员激活成功，有效期 30 天'
      : tier === 'referral' ? '邀请会员激活成功，有效期 30 天'
      : tier === 'quarterly' ? '季度会员激活成功，有效期 90 天'
      : 'Pro 会员激活成功，有效期 365 天',
    license,
  }
}

/**
 * 停用会员
 */
export function deactivateLicense(): { success: boolean, message: string } {
  deleteLicense()
  return {
    success: true,
    message: '已取消会员激活',
  }
}

// ============================================================
// 许可证状态查询
// ============================================================

export function getLicenseStatus(): LicenseStatus {
  const license = loadLicense()
  
  if (!license) {
    return {
      tier: 'free',
      isActive: false,
      activatedAt: null,
      expiresAt: null,
      daysRemaining: null,
      machineId: getMachineId(),
    }
  }
  
  // 检查是否过期
  if (license.expiresAt) {
    const expiry = new Date(license.expiresAt)
    const now = new Date()
    
    if (now > expiry) {
      // 已过期
      return {
        tier: 'free',
        isActive: false,
        activatedAt: license.activatedAt,
        expiresAt: license.expiresAt,
        daysRemaining: 0,
        machineId: license.machineId,
        referralCode: license.referralCode,
      }
    }
    
    const daysRemaining = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    
    return {
      tier: license.tier,
      isActive: true,
      activatedAt: license.activatedAt,
      expiresAt: license.expiresAt,
      daysRemaining,
      machineId: license.machineId,
      referralCode: license.referralCode,
    }
  }
  
  // 终身会员
  return {
    tier: license.tier,
    isActive: true,
    activatedAt: license.activatedAt,
    expiresAt: null,
    daysRemaining: null,
    machineId: license.machineId,
    referralCode: license.referralCode,
  }
}

// ============================================================
// 限制规则
// ============================================================

export interface UsageLimits {
  maxFileSize: number        // 最大文件大小（字节），0 表示无限制
  maxBatchCount: number      // 最大批量转换数量，0 表示无限制
  ocrDailyLimit: number      // OCR 每日次数，0 表示无限制
  hasWatermark: boolean      // 是否添加水印
  supportedFormats: string[] // 支持的格式列表
  canUseBatch: boolean       // 是否可使用批量转换
  canUseOcr: boolean         // 是否可使用 OCR
}

const FREE_LIMITS: UsageLimits = {
  maxFileSize: 50 * 1024 * 1024,  // 50MB（支持短视频和音频提取）
  maxBatchCount: 5,
  ocrDailyLimit: 3,
  hasWatermark: true,  // 免费版输出带"易转"品牌水印
  supportedFormats: ['pdf', 'docx', 'doc', 'ppt', 'pptx', 'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'bmp', 'webp', 'heic', 'heif', 'mp4', 'avi', 'mkv', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts', 'caj', 'nh'],
  canUseBatch: true,
  canUseOcr: true,
}

const PRO_LIMITS: UsageLimits = {
  maxFileSize: 0,  // 无限制
  maxBatchCount: 0,  // 无限制
  ocrDailyLimit: 0,  // 无限制
  hasWatermark: false,
  supportedFormats: ['pdf', 'docx', 'doc', 'ppt', 'pptx', 'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'bmp', 'webp', 'heic', 'heif', 'tiff', 'gif', 'mp4', 'avi', 'mkv', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts', 'caj', 'nh'],
  canUseBatch: true,
  canUseOcr: true,
}

const MONTHLY_LIMITS: UsageLimits = {
  ...PRO_LIMITS,
}

const QUARTERLY_LIMITS: UsageLimits = {
  ...PRO_LIMITS,
}

const LIFETIME_LIMITS: UsageLimits = {
  ...PRO_LIMITS,
}

// 邀请赠送月卡：同 Pro 权限
const REFERRAL_LIMITS: UsageLimits = {
  ...PRO_LIMITS,
}

/**
 * 获取当前用户的使用限制
 */
export function getUsageLimits(): UsageLimits {
  const status = getLicenseStatus()
  
  switch (status.tier) {
    case 'referral':
      return REFERRAL_LIMITS
    case 'monthly':
      return MONTHLY_LIMITS
    case 'quarterly':
      return QUARTERLY_LIMITS
    case 'pro':
      return PRO_LIMITS
    case 'lifetime':
      return LIFETIME_LIMITS
    default:
      return FREE_LIMITS
  }
}

// ============================================================
// 邀请码系统
// ============================================================

// 邀请码长度（不含分隔符）
const REFERRAL_CODE_LENGTH = 8

/**
 * 生成用户专属邀请码（基于机器ID）
 * 每个用户只有一个邀请码
 */
export function getMyReferralCode(): string {
  const machineId = getMachineId()
  // 用机器ID生成固定的邀请码前缀
  const hash = crypto.createHash('sha256').update(machineId + 'yizhuan-referral').digest('hex')
  
  // 从 hash 中提取字符，映射到 CHARSET
  let code = ''
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    const byteValue = parseInt(hash.substring(i * 2, i * 2 + 2), 16)
    code += CHARSET[byteValue % CHARSET.length]
  }
  
  // 格式化为 XXXX-XXXX
  return code.substring(0, 4) + '-' + code.substring(4, 8)
}

/**
 * 验证邀请码格式
 */
export function validateReferralCode(code: string): boolean {
  const clean = code.replace(/[\s-]/g, '').toUpperCase()
  if (clean.length !== REFERRAL_CODE_LENGTH) return false
  for (const ch of clean) {
    if (!CHARSET.includes(ch)) return false
  }
  return true
}

/**
 * 检查用户是否已经使用过邀请码
 */
export function hasUsedReferralCode(): boolean {
  const license = loadLicense()
  return !!(license && license.referralCode)
}

/**
 * 使用邀请码激活免费月卡（30天）
 * 新用户输入邀请码即可获得30天免费会员
 */
export function activateWithReferralCode(referralCode: string): ActivationResult {
  const cleanCode = referralCode.replace(/[\s-]/g, '').toUpperCase()
  
  // 验证格式
  if (!validateReferralCode(cleanCode)) {
    return {
      success: false,
      message: '邀请码格式错误，请检查后重试',
    }
  }
  
  // 检查是否已经是会员
  const existing = loadLicense()
  if (existing && existing.tier !== 'free') {
    return {
      success: false,
      message: '您已经是会员，无需使用邀请码',
      license: existing,
    }
  }
  
  // 检查是否已经使用过邀请码
  if (hasUsedReferralCode()) {
    return {
      success: false,
      message: '您已经使用过邀请码，每位用户仅限一次',
    }
  }
  
  // 检查邀请码是否是自己的（不能用自己的邀请码）
  const myCode = getMyReferralCode().replace(/-/g, '')
  if (myCode === cleanCode) {
    return {
      success: false,
      message: '不能使用自己的邀请码哦，请分享给好友使用',
    }
  }
  
  // 生成一个 RF 前缀的激活码并激活
  const activationCode = generateActivationCode('referral')
  const result = activateLicense(activationCode)
  
  if (result.success && result.license) {
    // 保存邀请码信息到许可证
    const license = loadLicense()
    if (license) {
      license.referralCode = cleanCode
      saveLicense(license)
    }
    
    return {
      success: true,
      message: '恭喜！邀请码激活成功，获得30天免费会员',
      license: result.license,
    }
  }
  
  return result
}

/**
 * 获取邀请数据（本地记录的被邀请人数）
 */
export function getReferralStats(): { myCode: string, invitedCount: number } {
  const myCode = getMyReferralCode()
  const statsPath = join(app.getPath('userData'), 'referral_stats.json')
  
  let invitedCount = 0
  try {
    if (fs.existsSync(statsPath)) {
      const data = JSON.parse(fs.readFileSync(statsPath, 'utf-8'))
      invitedCount = data.invitedCount || 0
    }
  } catch {
    // ignore
  }
  
  return { myCode, invitedCount }
}

// ============================================================
// OCR 每日使用计数
// ============================================================

function getOcrUsagePath(): string {
  return join(app.getPath('userData'), 'ocr_usage.json')
}

interface OcrUsage {
  date: string    // YYYY-MM-DD
  count: number
}

function loadOcrUsage(): OcrUsage {
  try {
    const path = getOcrUsagePath()
    if (!fs.existsSync(path)) return { date: todayStr(), count: 0 }
    const data = JSON.parse(fs.readFileSync(path, 'utf-8'))
    const today = todayStr()
    // 如果日期不是今天，重置计数
    if (data.date !== today) {
      return { date: today, count: 0 }
    }
    return data
  } catch {
    return { date: todayStr(), count: 0 }
  }
}

function saveOcrUsage(usage: OcrUsage): void {
  try {
    const path = getOcrUsagePath()
    fs.writeFileSync(path, JSON.stringify(usage, null, 2), 'utf-8')
  } catch {
    // 忽略写入错误
  }
}

function todayStr(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/**
 * 检查是否可以使用 OCR
 */
export function checkOcrUsage(): { allowed: boolean, remaining: number, limit: number } {
  const limits = getUsageLimits()
  
  if (limits.ocrDailyLimit === 0) {
    return { allowed: true, remaining: -1, limit: 0 }  // -1 表示无限制
  }
  
  const usage = loadOcrUsage()
  const remaining = Math.max(0, limits.ocrDailyLimit - usage.count)
  
  return {
    allowed: remaining > 0,
    remaining,
    limit: limits.ocrDailyLimit,
  }
}

/**
 * 增加 OCR 使用计数
 */
export function incrementOcrUsage(): void {
  const usage = loadOcrUsage()
  usage.count++
  saveOcrUsage(usage)
}
