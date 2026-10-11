/**
 * 本地持久化存储服务
 * 使用 Electron 的 userData 目录存储 JSON 文件
 */
import { app } from 'electron'
import fs from 'fs'
import { join } from 'path'

// ============================================================
// 存储路径
// ============================================================

function getStorageDir(): string {
  return app.getPath('userData')
}

function getHistoryPath(): string {
  return join(getStorageDir(), 'history.json')
}

function getSettingsPath(): string {
  return join(getStorageDir(), 'settings.json')
}

// ============================================================
// 历史记录
// ============================================================

export interface HistoryRecord {
  id: string
  filename: string
  fromFormat: string
  toFormat: string
  status: 'success' | 'error'
  message?: string
  outputPath?: string
  createdAt: string
}

export function loadHistory(): HistoryRecord[] {
  try {
    const path = getHistoryPath()
    if (!fs.existsSync(path)) return []
    const data = fs.readFileSync(path, 'utf-8')
    const records = JSON.parse(data)
    if (Array.isArray(records)) {
      // 最多保留 100 条
      return records.slice(0, 100)
    }
    return []
  } catch {
    return []
  }
}

export function saveHistory(records: HistoryRecord[]): void {
  try {
    const path = getHistoryPath()
    const data = JSON.stringify(records.slice(0, 100), null, 2)
    fs.writeFileSync(path, data, 'utf-8')
  } catch (err) {
    console.error('保存历史记录失败:', err)
  }
}

export function clearHistory(): void {
  try {
    const path = getHistoryPath()
    if (fs.existsSync(path)) {
      fs.unlinkSync(path)
    }
  } catch (err) {
    console.error('清除历史记录失败:', err)
  }
}

export function deleteHistoryItem(id: string): HistoryRecord[] {
  try {
    const records = loadHistory()
    const filtered = records.filter(r => r.id !== id)
    saveHistory(filtered)
    return filtered
  } catch (err) {
    console.error('删除历史记录项失败:', err)
    return loadHistory()
  }
}

// ============================================================
// 应用设置
// ============================================================

export interface AppSettings {
  outputDir: string           // 自定义输出目录，空字符串表示同源目录
  autoOpenFolder: boolean     // 转换完成后自动打开文件夹
  defaultImageQuality: number // 默认图片质量 1-100
  ocrLang: string             // OCR 默认语言
  concurrency: number         // 默认并发数
  theme: 'light' | 'dark'     // 主题
  enableNotifications: boolean // 转换完成后显示系统通知
  enableGlobalShortcuts: boolean // 启用全局快捷键
  contextMenuAutoRegistered?: boolean  // 右键菜单是否已尝试自动注册
}

const DEFAULT_SETTINGS: AppSettings = {
  outputDir: '',
  autoOpenFolder: false,
  defaultImageQuality: 90,
  ocrLang: 'chi_sim+eng',
  concurrency: 3,
  theme: 'light',
  enableNotifications: true,
  enableGlobalShortcuts: true,
}

export function loadSettings(): AppSettings {
  try {
    const path = getSettingsPath()
    if (!fs.existsSync(path)) return { ...DEFAULT_SETTINGS }
    const data = fs.readFileSync(path, 'utf-8')
    const settings = JSON.parse(data)
    // 合并默认值，防止新字段缺失
    return { ...DEFAULT_SETTINGS, ...settings }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: Partial<AppSettings>): AppSettings {
  try {
    const current = loadSettings()
    const updated = { ...current, ...settings }
    const path = getSettingsPath()
    const data = JSON.stringify(updated, null, 2)
    fs.writeFileSync(path, data, 'utf-8')
    return updated
  } catch (err) {
    console.error('保存设置失败:', err)
    return loadSettings()
  }
}

// ============================================================
// 使用统计
// ============================================================

export interface UsageStats {
  totalConversions: number
  totalSuccess: number
  totalFailed: number
  totalBytesSaved: number  // 压缩等功能节省的字节数
  formatBreakdown: Record<string, number>
  firstUsedAt: string
  lastUsedAt: string
}

function getStatsPath(): string {
  return join(getStorageDir(), 'usage-stats.json')
}

const DEFAULT_STATS: UsageStats = {
  totalConversions: 0,
  totalSuccess: 0,
  totalFailed: 0,
  totalBytesSaved: 0,
  formatBreakdown: {},
  firstUsedAt: new Date().toISOString(),
  lastUsedAt: new Date().toISOString(),
}

export function loadUsageStats(): UsageStats {
  try {
    const path = getStatsPath()
    if (!fs.existsSync(path)) return { ...DEFAULT_STATS }
    const data = fs.readFileSync(path, 'utf-8')
    return { ...DEFAULT_STATS, ...JSON.parse(data) }
  } catch {
    return { ...DEFAULT_STATS }
  }
}

export function saveUsageStats(stats: Partial<UsageStats>): UsageStats {
  try {
    const current = loadUsageStats()
    const updated: UsageStats = { ...current, ...stats, lastUsedAt: new Date().toISOString() }
    const path = getStatsPath()
    const data = JSON.stringify(updated, null, 2)
    fs.writeFileSync(path, data, 'utf-8')
    return updated
  } catch (err) {
    console.error('保存使用统计失败:', err)
    return loadUsageStats()
  }
}

/**
 * 记录一次转换操作到使用统计
 */
export function recordConversion(type: string, success: boolean, bytesSaved: number = 0): UsageStats {
  const stats = loadUsageStats()
  stats.totalConversions++
  if (success) stats.totalSuccess++
  else stats.totalFailed++
  stats.totalBytesSaved += Math.max(0, bytesSaved)
  stats.formatBreakdown[type] = (stats.formatBreakdown[type] || 0) + 1
  stats.lastUsedAt = new Date().toISOString()
  return saveUsageStats(stats)
}
