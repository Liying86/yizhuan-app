/**
 * Windows 右键菜单集成
 * 通过注册表 HKCU\Software\Classes\<ext>\shell\YiZhuan 注册右键菜单项
 * 用户级注册（无需管理员权限），卸载时自动清理
 */
import { spawnSync } from 'child_process'

import { app } from 'electron'
import { join } from 'path'
import fs from 'fs'
import os from 'os'

interface MenuConfig {
  label: string
  args: string
}

// 支持的文件格式及对应的右键菜单配置
const FORMAT_MENUS: Record<string, MenuConfig> = {
  '.pdf':  { label: '易转：转为 Word',   args: '--to=docx' },
  '.docx': { label: '易转：转为 PDF',   args: '--to=pdf' },
  '.doc':  { label: '易转：转为 PDF',   args: '--to=pdf' },
  '.ppt':  { label: '易转：转为 PDF',   args: '--to=pdf' },
  '.pptx': { label: '易转：转为 PDF',   args: '--to=pdf' },
  '.xls':  { label: '易转：转为 PDF',   args: '--to=pdf' },
  '.xlsx': { label: '易转：转为 PDF',   args: '--to=pdf' },
  '.jpg':  { label: '易转：转为 PNG',   args: '--to=png' },
  '.jpeg': { label: '易转：转为 PNG',   args: '--to=png' },
  '.png':  { label: '易转：转为 JPG',   args: '--to=jpg' },
  '.heic': { label: '易转：转为 JPG',   args: '--to=jpg' },
  '.bmp':  { label: '易转：转为 PNG',   args: '--to=png' },
  '.webp': { label: '易转：转为 PNG',   args: '--to=png' },
  '.tiff': { label: '易转：转为 PNG',   args: '--to=png' },
  '.gif':  { label: '易转：转为 PNG',   args: '--to=png' },
  // 视频格式
  '.mp4':  { label: '易转：视频格式转换', args: '--to=video' },
  '.avi':  { label: '易转：视频格式转换', args: '--to=video' },
  '.mkv':  { label: '易转：视频格式转换', args: '--to=video' },
  '.mov':  { label: '易转：视频格式转换', args: '--to=video' },
  '.webm': { label: '易转：视频格式转换', args: '--to=video' },
  '.flv':  { label: '易转：视频格式转换', args: '--to=video' },
  '.wmv':  { label: '易转：视频格式转换', args: '--to=video' },
  '.m4v':  { label: '易转：视频格式转换', args: '--to=video' },
  '.mpg':  { label: '易转：视频格式转换', args: '--to=video' },
  '.mpeg': { label: '易转：视频格式转换', args: '--to=video' },
  '.ts':   { label: '易转：视频格式转换', args: '--to=video' },
  // CAJ 格式
  '.caj':  { label: '易转：CAJ 转 PDF',  args: '--to=caj2pdf' },
  '.nh':   { label: '易转：CAJ 转 PDF',  args: '--to=caj2pdf' },
}

// 图片格式列表（用于在 SystemFileAssociations 下注册右键菜单）
const IMAGE_FORMATS: string[] = [
  '.jpg', '.jpeg', '.png', '.heic', '.bmp', '.webp', '.tiff', '.gif'
]

const REG_BASE = 'HKCU\\Software\\Classes'
const SYSTEM_ASSOC_BASE = `${REG_BASE}\\SystemFileAssociations`
const APP_KEY = 'YiZhuan'

/**
 * 获取应用可执行文件路径
 */
function getAppExePath(): string {
  if (app.isPackaged) {
    return process.execPath
  }
  // 开发环境：使用 electron 可执行文件 + 主脚本路径
  return process.execPath
}

/**
 * 获取应用图标路径
 */
function getAppIconPath(): string | null {
  // 打包后：应用同目录下的图标
  if (app.isPackaged) {
    const iconPath = join(app.getAppPath(), 'resources', 'icon.ico')
    if (fs.existsSync(iconPath)) return iconPath
    return process.execPath
  }
  // 开发环境：使用项目 public 目录
  const devIcon = join(__dirname, '../../public/favicon.svg')
  return fs.existsSync(devIcon) ? devIcon : null
}

/**
 * 右键菜单注册日志（写入临时文件，用于排查注册失败问题）
 */
function contextMenuLog(message: string): void {
  try {
    const logPath = join(os.tmpdir(), 'yizhuan-context-menu.log')
    const timestamp = new Date().toISOString()
    fs.appendFileSync(logPath, `[${timestamp}] ${message}\n`, 'utf-8')
  } catch { /* ignore */ }
}

// reg.exe 全路径，避免 PATH 问题
const REG_EXE = 'C:\\Windows\\System32\\reg.exe'

/**
 * 执行单条 reg add 命令（同步）
 * @returns 成功返回 true，失败返回 false
 */
function regAdd(key: string, valueName: string | undefined, data: string): boolean {
  try {
    const args = ['add', key, '/f']
    if (valueName) {
      args.push('/v', valueName)
    } else {
      args.push('/ve')
    }
    args.push('/d', data)
    const result = spawnSync(REG_EXE, args, {
      stdio: 'pipe',
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 5000,
    })
    return result.status === 0
  } catch {
    return false
  }
}

/**
 * 注册右键菜单（Windows）
 * 直接使用 reg.exe 逐条同步执行，彻底避免 PowerShell 脚本编码和超时问题
 */
export function registerContextMenu(): Promise<{ success: boolean, registered: string[], errors: string[] }> {
  return new Promise((resolve) => {
    const appPath = getAppExePath()
    const iconPath = getAppIconPath()
    const registered: string[] = []
    const errors: string[] = []

    contextMenuLog(`开始注册右键菜单, appPath=${appPath}, iconPath=${iconPath}, isPackaged=${app.isPackaged}`)

    // 主格式菜单
    for (const [ext, config] of Object.entries(FORMAT_MENUS)) {
      const key = `${REG_BASE}\\${ext}\\shell\\${APP_KEY}`
      const cmdKey = `${key}\\command`
      const cmdValue = `"${appPath}" ${config.args} "%1"`

      // 注册菜单项
      if (regAdd(key, undefined, config.label)) {
        contextMenuLog(`OK: ${ext} 菜单项注册成功`)
      } else {
        contextMenuLog(`FAIL: ${ext} 菜单项注册失败`)
        errors.push(`${ext}:menu`)
      }

      // 注册图标
      if (iconPath) {
        regAdd(key, 'Icon', iconPath)
      }

      // 注册命令
      if (regAdd(cmdKey, undefined, cmdValue)) {
        contextMenuLog(`OK: ${ext} 命令注册成功`)
      } else {
        contextMenuLog(`FAIL: ${ext} 命令注册失败`)
        errors.push(`${ext}:cmd`)
      }

      registered.push(ext)
    }

    // SystemFileAssociations 下的图片格式菜单注册
    // Windows 上其他软件（如 WPS、Windows 照片）可能覆盖具体扩展名下的注册表项，
    // 在 SystemFileAssociations 下注册可确保图片右键菜单正常显示
    for (const ext of IMAGE_FORMATS) {
      const config = FORMAT_MENUS[ext]
      if (!config) continue
      const key = `${SYSTEM_ASSOC_BASE}\\${ext}\\shell\\${APP_KEY}`
      const cmdKey = `${key}\\command`
      const cmdValue = `"${appPath}" ${config.args} "%1"`

      // 注册菜单项
      if (regAdd(key, undefined, config.label)) {
        contextMenuLog(`OK: SystemFileAssociations\\${ext} 菜单项注册成功`)
      } else {
        contextMenuLog(`FAIL: SystemFileAssociations\\${ext} 菜单项注册失败`)
        errors.push(`SystemFileAssociations\\${ext}:menu`)
      }

      // 注册图标
      if (iconPath) {
        regAdd(key, 'Icon', iconPath)
      }

      // 注册命令
      if (regAdd(cmdKey, undefined, cmdValue)) {
        contextMenuLog(`OK: SystemFileAssociations\\${ext} 命令注册成功`)
      } else {
        contextMenuLog(`FAIL: SystemFileAssociations\\${ext} 命令注册失败`)
        errors.push(`SystemFileAssociations\\${ext}:cmd`)
      }

      registered.push(`SystemFileAssociations\\${ext}`)
    }

    // 通用图片右键菜单（SystemFileAssociations\image）
    // 注册在 image 通用图片类型下，所有被系统识别为图片的文件都能看到易转选项
    {
      const key = `${SYSTEM_ASSOC_BASE}\\image\\shell\\${APP_KEY}`
      const cmdKey = `${key}\\command`
      const cmdValue = `"${appPath}" --to=png "%1"`

      // 注册菜单项
      if (regAdd(key, undefined, '易转：图片格式转换')) {
        contextMenuLog('OK: SystemFileAssociations\\image 通用图片菜单项注册成功')
      } else {
        contextMenuLog('FAIL: SystemFileAssociations\\image 通用图片菜单项注册失败')
        errors.push('SystemFileAssociations\\image:menu')
      }

      // 注册图标
      if (iconPath) {
        regAdd(key, 'Icon', iconPath)
      }

      // 注册命令
      if (regAdd(cmdKey, undefined, cmdValue)) {
        contextMenuLog('OK: SystemFileAssociations\\image 通用图片命令注册成功')
      } else {
        contextMenuLog('FAIL: SystemFileAssociations\\image 通用图片命令注册失败')
        errors.push('SystemFileAssociations\\image:cmd')
      }

      registered.push('SystemFileAssociations\\image')
    }

    // OCR 菜单项（对图片文件）
    const ocrFormats = ['.png', '.jpg', '.jpeg', '.bmp', '.webp']
    for (const ext of ocrFormats) {
      const key = `${REG_BASE}\\${ext}\\shell\\${APP_KEY}_OCR`
      const cmdKey = `${key}\\command`
      const cmdValue = `"${appPath}" --ocr "%1"`

      regAdd(key, undefined, '易转：OCR 识别文字')
      if (iconPath) {
        regAdd(key, 'Icon', iconPath)
      }
      regAdd(cmdKey, undefined, cmdValue)
      registered.push(`${ext}(OCR)`)
    }

    const success = errors.length === 0
    contextMenuLog(`注册结果: success=${success}, registered=${registered.length}, errors=${errors.length}`)

    resolve({
      success,
      registered,
      errors
    })
  })
}

/**
 * 移除右键菜单
 * 使用 spawnSync 直接调用 reg.exe，不经过 cmd.exe
 */
export function unregisterContextMenu(): Promise<{ success: boolean, removed: string[], errors: string[] }> {
  return new Promise((resolve) => {
    const removed: string[] = []
    const errors: string[] = []

    const allExts = [...Object.keys(FORMAT_MENUS), '.png', '.jpg', '.jpeg', '.bmp', '.webp']
    const uniqueExts = [...new Set(allExts)]

    for (const ext of uniqueExts) {
      const key = `${REG_BASE}\\${ext}\\shell\\${APP_KEY}`
      const ocrKey = `${REG_BASE}\\${ext}\\shell\\${APP_KEY}_OCR`
      // reg delete 对不存在的键返回错误码，可以忽略
      try {
        spawnSync('C:\\Windows\\System32\\reg.exe', ['delete', key, '/f'], { stdio: 'ignore', windowsHide: true })
      } catch { /* ignore */ }
      try {
        spawnSync('C:\\Windows\\System32\\reg.exe', ['delete', ocrKey, '/f'], { stdio: 'ignore', windowsHide: true })
      } catch { /* ignore */ }
      removed.push(ext)
    }

    // 清理 SystemFileAssociations 下的图片格式注册项
    for (const ext of IMAGE_FORMATS) {
      const key = `${SYSTEM_ASSOC_BASE}\\${ext}\\shell\\${APP_KEY}`
      try {
        spawnSync('C:\\Windows\\System32\\reg.exe', ['delete', key, '/f'], { stdio: 'ignore', windowsHide: true })
      } catch { /* ignore */ }
      removed.push(`SystemFileAssociations\\${ext}`)
    }

    // 清理通用图片菜单
    {
      const key = `${SYSTEM_ASSOC_BASE}\\image\\shell\\${APP_KEY}`
      try {
        spawnSync('C:\\Windows\\System32\\reg.exe', ['delete', key, '/f'], { stdio: 'ignore', windowsHide: true })
      } catch { /* ignore */ }
      removed.push('SystemFileAssociations\\image')
    }

    resolve({ success: true, removed, errors })
  })
}

/**
 * 检查右键菜单是否已注册
 * 使用 spawnSync 直接调用 reg.exe，不经过 cmd.exe
 */
export function isContextMenuRegistered(): boolean {
  try {
    const result = spawnSync('C:\\Windows\\System32\\reg.exe', [
      'query', `${REG_BASE}\\.pdf\\shell\\${APP_KEY}`
    ], { stdio: 'pipe', windowsHide: true, encoding: 'utf-8' })
    const out: string = result.stdout as string
    return !!out && out.length > 0
  } catch {
    return false
  }
}

/**
 * 解析命令行参数，处理右键菜单触发的转换请求
 */
export function parseContextMenuArgs(argv: string[]): { action: string, filePath: string } | null {
  // Electron 应用通过右键菜单启动时，参数格式：
  // electron.exe --to=docx "C:\path\to\file.pdf"
  // 打包后：yizhuan.exe --to=docx "C:\path\to\file.pdf"

  const args = argv.slice(1) // 去掉第一个参数（应用路径）

  let action: string | null = null
  let filePath: string | null = null

  for (const arg of args) {
    if (arg.startsWith('--to=')) {
      action = arg.substring(5)
    } else if (arg.startsWith('--ocr')) {
      action = 'ocr'
    } else if (!arg.startsWith('-') && arg.length > 0) {
      // 非选项参数，视为文件路径
      filePath = arg
    }
  }

  if (action && filePath) {
    return { action, filePath }
  }

  return null
}
