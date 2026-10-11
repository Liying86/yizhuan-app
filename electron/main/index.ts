import './polyfills' // 必须在所有使用 DOMMatrix 的模块之前导入
import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Tray, Menu, nativeImage, globalShortcut, Notification, screen } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn, spawnSync, ChildProcess, exec } from 'child_process'
import fs from 'fs'
import os from 'os'
import { PDFDocument } from 'pdf-lib'
import { performOcr, saveOcrResult, saveOcrMultiFormat, type OcrOutputFormat } from './ocr'
import { convertImage, batchConvertImages, compressImage, batchCompressImages, imageToHtml, applyWatermarkToFile, generateVideoWatermarkPng } from './imageConverter'
import { mergePdfs, splitPdf, pdfToImages, getPdfInfo, getPdfPageCount, htmlToPdf, markdownToPdf, createHiddenWindow, encryptPdf, decryptPdf, compressPdf } from './pdfTools'
import { registerContextMenu, unregisterContextMenu, isContextMenuRegistered, parseContextMenuArgs } from './contextMenu'
import { scanFolder, buildBatchItems, buildBatchItemsWithDiagnostics, executeBatchConversion, cancelBatchTask, type BatchConversionType, type BatchFileItem, type BatchOptions } from './batchConverter'
import { loadHistory, saveHistory, clearHistory, deleteHistoryItem, loadSettings, saveSettings, loadUsageStats, recordConversion, type HistoryRecord, type AppSettings, type UsageStats } from './storage'
import { convertVideo, getVideoInfo, addVideoWatermark, type VideoTargetFormat } from './videoConverter'
import { activateLicense, deactivateLicense, getLicenseStatus, getUsageLimits, checkOcrUsage, incrementOcrUsage, getMyReferralCode, activateWithReferralCode, getReferralStats, type LicenseStatus, type UsageLimits } from './license'
import { createOrder, queryOrder, type PaymentTier, type PaymentOrderResult, type PaymentQueryResult } from './payment'
import { checkRuntimeStatus, getEmbeddedPythonExe, installPythonRuntime, installPdf2docxOnly, verifyPdf2docx, ensurePyMuPDFReady, cancelInstall as cancelPythonInstall, type PythonRuntimeStatus } from './pythonRuntime'
import { checkCajRuntime, checkCaj2pdfInstalled, installCajRuntime, getMutoolExe, cancelCajInstall, type CajRuntimeStatus, type CajProgressCallback } from './cajRuntime'
import { createPptxFromImages, extractTablesFromDocx, extractTextFromDocx, createXlsxFromTables } from './officeBuilder'

// ESM 兼容：在 ES module 中 __dirname 不可用，定义为全局变量供所有模块使用
;(globalThis as any).__dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.DIST_ELECTRON = path.join(__dirname, '../..')
process.env.DIST = path.join(process.env.DIST_ELECTRON, 'dist')
process.env.VITE_PUBLIC = process.env.VITE_DEV_SERVER_URL
  ? path.join(process.env.DIST_ELECTRON, 'public')
  : process.env.DIST

let win: BrowserWindow | null = null
let tray: Tray | null = null
let isQuiting = false
const preload = path.join(__dirname, '../preload/index.js')
const url = process.env.VITE_DEV_SERVER_URL
const indexHtml = path.join(process.env.DIST, 'index.html')

// 活跃的子进程映射（用于取消任务）
const activeProcesses = new Map<string, ChildProcess>()

/**
 * 水印调用日志（写入临时文件，用于排查水印不生效问题）
 */
function watermarkCallLog(message: string): void {
  try {
    const logPath = path.join(os.tmpdir(), 'yizhuan-watermark.log')
    const timestamp = new Date().toISOString()
    fs.appendFileSync(logPath, `[${timestamp}] [IPC] ${message}\n`, 'utf-8')
  } catch { /* ignore */ }
}

/**
 * 转换日志（记录所有转换操作的输入/输出路径和文件验证结果）
 */
function conversionLog(message: string): void {
  try {
    const logPath = path.join(os.tmpdir(), 'yizhuan-conversion.log')
    const timestamp = new Date().toISOString()
    fs.appendFileSync(logPath, `[${timestamp}] ${message}\n`, 'utf-8')
  } catch { /* ignore */ }
}

/**
 * 通知 Windows Explorer 刷新指定目录的文件列表
 * 方式1: VBScript + Shell.Application COM 刷新所有 Explorer 窗口
 * 方式2: SHChangeNotify (带 FLUSHNOWAIT) 立即传递文件变更通知
 * 方式3: PowerShell + FindWindowEx + PostMessage 发送 F5 到 Explorer 窗口
 * 方式4: 创建并删除临时文件，触发文件系统变更通知
 */
function refreshExplorerFolder(filePath: string): void {
  try {
        const dir = path.dirname(filePath)

    conversionLog(`[refreshExplorer] 开始: dir=${dir}, file=${path.basename(filePath)}`)

    // 方式1: VBScript + Shell.Application COM 刷新所有 Explorer 窗口
    try {
      const vbsPath = path.join(os.tmpdir(), `yizhuan_refresh_${Date.now()}.vbs`)
      const vbsLines = [
        'On Error Resume Next',
        'Dim shell, windows, i',
        'Set shell = CreateObject("Shell.Application")',
        'Set windows = shell.Windows()',
        'For i = 0 To windows.Count - 1',
        '  windows.Item(i).Refresh',
        'Next',
        'Set windows = Nothing',
        'Set shell = Nothing'
      ]
      fs.writeFileSync(vbsPath, vbsLines.join('\r\n'), { encoding: 'ascii' })
            const result = spawnSync('C:\\Windows\\System32\\cscript.exe', [
        '//Nologo', '//B', vbsPath
      ], { shell: false, windowsHide: true, stdio: 'ignore', timeout: 5000 })
      try { fs.unlinkSync(vbsPath) } catch { /* ignore */ }
      conversionLog(`[refreshExplorer] VBS完成: status=${result.status}`)
    } catch (err) {
      conversionLog(`[refreshExplorer] VBS异常: ${(err as Error).message}`)
    }

    // 方式2: SHChangeNotify 同步发送通知，带 FLUSHNOWAIT 立即传递
    try {
      const safeFile = filePath.replace(/'/g, "''")
      const safeDir = dir.replace(/'/g, "''")
      const psScript = [
        'Add-Type -MemberDefinition \'[DllImport("shell32.dll")] public static extern void SHChangeNotify(uint wEventId, uint uFlags, System.IntPtr dwItem1, System.IntPtr dwItem2);\' -Name \'SN\' -Namespace \'W32\'',
        `[W32.SN]::SHChangeNotify(0x2, 0x3005, [System.Runtime.InteropServices.Marshal]::StringToHGlobalUni('${safeFile}'), [System.IntPtr]::Zero)`,
        `[W32.SN]::SHChangeNotify(0x2000, 0x3005, [System.Runtime.InteropServices.Marshal]::StringToHGlobalUni('${safeFile}'), [System.IntPtr]::Zero)`,
        `[W32.SN]::SHChangeNotify(0x1000, 0x3005, [System.Runtime.InteropServices.Marshal]::StringToHGlobalUni('${safeDir}'), [System.IntPtr]::Zero)`,
        `[W32.SN]::SHChangeNotify(0x08000000, 0x0, [System.IntPtr]::Zero, [System.IntPtr]::Zero)`
      ].join('; ')
            spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', psScript
      ], { shell: false, windowsHide: true, stdio: 'ignore', timeout: 8000 })
      conversionLog(`[refreshExplorer] SHChangeNotify完成`)
    } catch (err) {
      conversionLog(`[refreshExplorer] SHChangeNotify异常: ${(err as Error).message}`)
    }

    // 方式3: PowerShell + FindWindowEx + PostMessage 发送 F5 到所有 Explorer 窗口
    // CabinetWClass 是 Windows Explorer 主窗口的类名
    // WM_KEYDOWN=0x0100, VK_F5=0x74
    try {
      const psScript3 = [
        'Add-Type @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class Win32R {',
        '  [DllImport("user32.dll", SetLastError = true)]',
        '  public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);',
        '  [DllImport("user32.dll", SetLastError = true)]',
        '  public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);',
        '}',
        '"@',
        '$hwnd = [IntPtr]::Zero',
        '$count = 0',
        'do {',
        '  $hwnd = [Win32R]::FindWindowEx([IntPtr]::Zero, $hwnd, "CabinetWClass", $null)',
        '  if ($hwnd -ne [IntPtr]::Zero) {',
        '    [Win32R]::PostMessage($hwnd, 0x0100, [IntPtr]0x74, [IntPtr]::Zero) | Out-Null',
        '    $count++',
        '  }',
        '} while ($hwnd -ne [IntPtr]::Zero)',
        'Write-Output "F5 sent to $count windows"'
      ].join('\r\n')
            const result3 = spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', psScript3
      ], { shell: false, windowsHide: true, stdio: 'pipe', timeout: 8000 })
      const output3 = result3.stdout ? result3.stdout.toString().trim() : ''
      conversionLog(`[refreshExplorer] PostMessage F5完成: ${output3}`)
    } catch (err) {
      conversionLog(`[refreshExplorer] PostMessage异常: ${(err as Error).message}`)
    }

    // 方式4: 创建并删除临时文件，触发文件系统变更通知
    try {
      const tempFile = path.join(dir, `~yizhuan_refresh_${Date.now()}.tmp`)
      fs.writeFileSync(tempFile, '')
      fs.unlinkSync(tempFile)
    } catch { /* ignore */ }
  } catch (err) {
    conversionLog(`[refreshExplorer] 整体异常: ${(err as Error).message}`)
  }
}

/**
 * 验证输出文件是否存在，并记录详细日志
 * 1. 检查文件是否存在 (fs.existsSync)
 * 2. 列出目录内容，验证文件在目录列表中
 * 3. 强制清除隐藏/系统属性 (attrib -H -S +A)
 * 4. 通知 Explorer 刷新目录缓存
 * 返回文件是否存在
 */
function verifyOutputFile(outputPath: string, context: string): boolean {
    const exists = fs.existsSync(outputPath)
  let size = 0
  let inDirListing = false
  let dirContents: string[] = []

  if (exists) {
    try {
      size = fs.statSync(outputPath).size

      // 列出目录内容，验证文件确实在目录列表中（排查 UAC 虚拟化等问题）
      const dir = path.dirname(outputPath)
      const fileName = path.basename(outputPath)
      try {
        dirContents = fs.readdirSync(dir)
        inDirListing = dirContents.includes(fileName)
        if (!inDirListing) {
          // 文件存在但不在目录列表中 — 可能是 UAC 虚拟化或路径编码问题
          conversionLog('[' + context + '] 警告: fs.existsSync=true 但文件不在目录列表中!')
          conversionLog('[' + context + '] 期望文件名: ' + fileName)
          conversionLog('[' + context + '] 目录内容: ' + dirContents.join(', '))
        }
      } catch (e) {
        conversionLog('[' + context + '] 目录列表读取失败: ' + (e as Error).message)
      }

      // 强制清除隐藏/系统属性，确保 Explorer 可见
      try {
                spawnSync('C:\\Windows\\System32\\attrib.exe', ['-H', '-S', '+A', outputPath], { stdio: 'ignore', timeout: 3000 })
      } catch { /* attrib 失败不影响流程 */ }

      // 通知 Explorer 刷新目录，确保新文件立即可见
      refreshExplorerFolder(outputPath)
    } catch {}
  }

  conversionLog('[' + context + '] 输出文件验证: path=' + outputPath + ', exists=' + exists + ', size=' + size + ', inDirListing=' + inDirListing)
  return exists
}

/**
 * 水印应用后的二次验证
 * 检查文件是否仍然存在（水印操作可能因 adm-zip 异常导致文件损坏或丢失）
 * 关键：水印写入后必须重新清除隐藏属性、touch 目录、并多轮刷新 Explorer
 */
function verifyAfterWatermark(outputPath: string, context: string): void {
    const exists = fs.existsSync(outputPath)
  let size = 0
  if (exists) {
    try { size = fs.statSync(outputPath).size } catch {}
  }
  conversionLog('[' + context + '] 水印后验证: path=' + outputPath + ', exists=' + exists + ', size=' + size)
  if (!exists) {
    conversionLog('[' + context + '] 严重: 水印操作后文件消失!')
  } else if (size === 0) {
    conversionLog('[' + context + '] 严重: 水印操作后文件大小为0!')
  } else {
    // 水印写入后重新清除隐藏/系统属性（写入操作可能重置属性）
    try {
            spawnSync('C:\\Windows\\System32\\attrib.exe', ['-H', '-S', '+A', outputPath], { stdio: 'ignore', timeout: 3000 })
    } catch { /* ignore */ }

    // Touch 父目录修改时间，强制 Explorer 重新读取目录内容
    try {
      const dir = path.dirname(outputPath)
      const now = new Date()
      fs.utimesSync(dir, now, now)
      conversionLog('[' + context + '] 目录 touch 完成: ' + dir)
    } catch { /* ignore */ }

    // 立即刷新一次
    refreshExplorerFolder(outputPath)

    // 延迟 2 秒再次刷新（给文件系统通知传播时间）
    setTimeout(() => {
      try {
        refreshExplorerFolder(outputPath)
        conversionLog('[' + context + '] 2秒延迟刷新完成')
      } catch { /* ignore */ }
    }, 2000)

    // 延迟 5 秒最后刷新（确保一切稳定后 Explorer 能看到文件）
    setTimeout(() => {
      try {
        refreshExplorerFolder(outputPath)
        conversionLog('[' + context + '] 5秒延迟刷新完成')
      } catch { /* ignore */ }
    }, 5000)
  }
}

/**
 * 转换前准备输出路径
 * 如果输出文件已存在，尝试删除；如果删除失败（文件被占用），自动生成带序号的新文件名
 * 避免 Python 转换时因 Permission denied 而失败
 * @returns 实际可用的输出路径
 */
function prepareOutputPath(outputPath: string, context: string): string {
  if (!fs.existsSync(outputPath)) {
    return outputPath
  }

  // 关键：不删除旧文件！让转换工具直接覆盖。
  // 删除+重新创建会改变 File ID，导致 Explorer 缓存失效后无法显示文件。
  // 覆盖写入保持 File ID 不变，Explorer 可以正常跟踪文件变更。
  // 先清除只读属性，确保可写入
  try {
        spawnSync('C:\\Windows\\System32\\attrib.exe', ['-R', outputPath], { stdio: 'ignore', timeout: 3000 })
  } catch { /* ignore */ }

  // 检测文件是否可写入（未被其他程序锁定）
  try {
    const fd = fs.openSync(outputPath, 'r+')
    fs.closeSync(fd)
    conversionLog(`[${context}] 输出文件已存在，将直接覆盖（保持 File ID）: ${outputPath}`)
    return outputPath
  } catch (err) {
    // 文件被占用，无法覆盖，生成新文件名
    conversionLog(`[${context}] 旧文件被占用，使用新文件名: ${outputPath} - ${(err as Error).message}`)
        const dir = path.dirname(outputPath)
    const ext = path.extname(outputPath)
    const base = path.basename(outputPath, ext)
    const cleanBase = base.replace(/_易转$/, '')

    // 尝试 _易转(1), _易转(2), ...
    for (let i = 1; i <= 99; i++) {
      const candidate = path.join(dir, `${cleanBase}_易转(${i})${ext}`)
      if (!fs.existsSync(candidate)) {
        conversionLog(`[${context}] 使用替代输出路径: ${candidate}`)
        return candidate
      }
    }
  }

  // 所有尝试都失败，返回原路径（让 Python 自行处理错误）
  conversionLog(`[${context}] 警告: 无法找到可用的输出路径，使用原路径`)
  return outputPath
}

// 右键菜单触发的待处理任务
let pendingContextMenuTask: { action: string, filePath: string } | null = parseContextMenuArgs(process.argv)

// 文件关联触发的待处理任务（首次启动时通过命令行参数传入文件路径）
let pendingFileAssociationTask: { action: string, filePath: string } | null = parseFileAssociationArgs(process.argv)

// 如果同时有右键菜单任务和文件关联任务，优先使用右键菜单任务
if (pendingContextMenuTask) {
  pendingFileAssociationTask = null
}

/**
 * 从命令行参数中解析文件关联打开的文件
 * 当用户双击关联文件时，文件路径作为普通参数传入
 * 根据文件扩展名推断转换类型
 */
function parseFileAssociationArgs(argv: string[]): { action: string, filePath: string } | null {
  // 跳过前两个参数（electron.exe 和 app.js）
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    // 跳过以 -- 开头的参数（如 --to=xxx）
    if (arg.startsWith('--') || arg.startsWith('-')) continue
    // 跳过 electron 本身和脚本路径
    if (arg.endsWith('.js') || arg.endsWith('electron') || arg.includes('electron.exe')) continue

    // 检查是否是文件路径
    if (fs.existsSync(arg)) {
      const ext = arg.split('.').pop()?.toLowerCase()
      if (!ext) continue

      // 根据扩展名推断操作类型
      const extActionMap: Record<string, string> = {
        'pdf': 'pdf2docx',
        'docx': 'docx2pdf',
        'doc': 'docx2pdf',
        'ppt': 'docx2pdf',
        'pptx': 'docx2pdf',
        'xls': 'docx2pdf',
        'xlsx': 'docx2pdf',
        'png': 'img2jpg',
        'jpg': 'img2png',
        'jpeg': 'img2png',
        'bmp': 'img2png',
        'webp': 'img2jpg',
        'heic': 'heic2jpg',
        'heif': 'heic2jpg',
        'caj': 'caj2pdf',
        'nh': 'caj2pdf',
        'mp4': 'video',
        'avi': 'video',
        'mkv': 'video',
        'mov': 'video',
        'webm': 'video',
        'flv': 'video',
        'wmv': 'video',
      }

      const action = extActionMap[ext]
      if (action) {
        return { action, filePath: arg }
      }
    }
  }
  return null
}

// 单实例锁：确保右键菜单启动的第二个实例被转发到主实例
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  // 第二个实例：直接退出，second-instance 事件已在主实例中处理
  app.quit()
}

// 启动优化：在窗口创建前预设主题，避免主题闪烁
try {
  const savedSettings = loadSettings()
  nativeTheme.themeSource = savedSettings.theme || 'light'
} catch {
  nativeTheme.themeSource = 'light'
}

async function createWindow() {
  win = new BrowserWindow({
    title: '易转 - 办公格式转换',
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(__dirname, '../../build/icon.ico'),
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      backgroundThrottling: false
    },
    titleBarStyle: 'hidden',
    frame: process.platform === 'darwin',
    show: false,
    backgroundColor: nativeTheme.themeSource === 'dark' ? '#0f172a' : '#f8fafc'
  })

  if (url) {
    win.loadURL(url)
    win.webContents.openDevTools()
  } else {
    win.loadFile(indexHtml)
  }

  win.once('ready-to-show', () => {
    win?.show()

    // 处理右键菜单或文件关联触发的任务
    const task = pendingContextMenuTask || pendingFileAssociationTask
    if (task) {
      pendingContextMenuTask = null
      pendingFileAssociationTask = null
      // 等待渲染进程加载完成后发送
      setTimeout(() => {
        win?.webContents.send('context-menu-action', task)
      }, 1500)
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })

  // 窗口最大化状态变化通知
  win.on('maximize', () => {
    win?.webContents.send('window-maximize-changed', true)
  })
  win.on('unmaximize', () => {
    win?.webContents.send('window-maximize-changed', false)
  })

  // 窗口关闭时最小化到托盘（而非退出），除非用户从托盘菜单退出
  win.on('close', (e) => {
    if (!isQuiting) {
      e.preventDefault()
      win?.hide()
    }
  })
}

// ============================================================
// 系统托盘
// ============================================================
function createTray() {
  // 使用应用图标作为托盘图标
  let icon: Electron.NativeImage
  const iconPath = path.join(__dirname, '../../build/icon.ico')
  try {
    icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) {
      // 如果图标加载失败，使用 16x16 空白图标
      icon = nativeImage.createEmpty()
    }
  } catch {
    icon = nativeImage.createEmpty()
  }

  tray = new Tray(icon)
  tray.setToolTip('易转 - 办公格式转换')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        win?.show()
        win?.focus()
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuiting = true
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)

  // 单击托盘图标显示窗口
  tray.on('click', () => {
    if (win) {
      if (win.isVisible()) {
        win.focus()
      } else {
        win.show()
        win.focus()
      }
    }
  })
}

// 处理第二个实例（通过右键菜单或文件关联启动时，应用已在运行）
app.on('second-instance', (_event, commandLine) => {
  const task = parseContextMenuArgs(commandLine)
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (task) {
      win.webContents.send('context-menu-action', task)
    } else {
      // 检查是否是文件关联打开
      const fileTask = parseFileAssociationArgs(commandLine)
      if (fileTask) {
        win.webContents.send('context-menu-action', fileTask)
      }
    }
  }
})

// 优化启动：ready 后立即创建窗口和托盘
app.whenReady().then(async () => {
  createWindow()
  createTray()
  // 注册全局快捷键（默认启用）
  const savedSettings = loadSettings()
  if (savedSettings.enableGlobalShortcuts !== false) {
    registerGlobalShortcuts()
  }

  // 自动注册右键菜单（每次启动都检查，确保注册表项完整）
  // 异步执行，不阻塞窗口显示
  setTimeout(async () => {
    try {
      const result = await registerContextMenu()
      conversionLog(`[auto-register] 右键菜单注册结果: success=${result.success}, registered=${result.registered.length}, errors=${result.errors.length}`)
    } catch (err) {
      conversionLog(`[auto-register] 右键菜单注册异常: ${err}`)
    }
  }, 2000)
})

app.on('window-all-closed', () => {
  // 有托盘时不退出，仅清理窗口引用
  if (tray) {
    win = null
    return
  }
  win = null
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// ============================================================
// 全局快捷键
// ============================================================
function registerGlobalShortcuts() {
  // Ctrl+Shift+Y：显示/聚焦主窗口
  const showAccel = 'CommandOrControl+Shift+Y'
  try {
    globalShortcut.register(showAccel, () => {
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      } else {
        createWindow()
      }
    })
  } catch { /* ignore */ }

  // Ctrl+Shift+S：截图 OCR
  const ocrAccel = 'CommandOrControl+Shift+S'
  try {
    globalShortcut.register(ocrAccel, () => {
      captureScreenForOcr()
    })
  } catch { /* ignore */ }
}

function unregisterGlobalShortcuts() {
  try {
    globalShortcut.unregister('CommandOrControl+Shift+Y')
    globalShortcut.unregister('CommandOrControl+Shift+S')
  } catch { /* ignore */ }
}

// ============================================================
// 截图 OCR
// ============================================================
let screenshotProcess: ChildProcess | null = null

function captureScreenForOcr() {
  // 显示窗口以便用户看到截图 OCR 状态
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  // 使用 Windows 自带 Snipping Tool 截图（Win+Shift+S 模式）
  // 通过 PowerShell 调用 Snipping Tool 的截图模式
  const tmpDir = os.tmpdir()
  const screenshotPath = path.join(tmpDir, `yizhuan_screenshot_${Date.now()}.png`)

  // 使用 .NET API 通过 PowerShell 进行区域截图
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Opacity = 0.3
$form.BackColor = [System.Drawing.Color]::Black
$form.FormBorderStyle = 'None'
$form.TopMost = $true
$form.WindowState = 'Maximized'
$form.Show()

$start = $null
$end = $null
$form.Add_MouseDown({ $script:start = $_.Location; $script:end = $_.Location })
$form.Add_MouseMove({ if ($script:start) { $script:end = $_.Location } })
$form.Add_MouseUp({ $script:end = $_.Location; $form.Close() })
$form.ShowDialog() | Out-Null

if ($script:start -and $script:end) {
  $x = [Math]::Min($script:start.X, $script:end.X)
  $y = [Math]::Min($script:start.Y, $script.end.Y)
  $w = [Math]::Abs($script.end.X - $script.start.X)
  $h = [Math]::Abs($script.end.Y - $script.start.Y)
  if ($w -gt 5 -and $h -gt 5) {
    $bounds = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $gfx.CopyFromScreen($x, $y, 0, 0, $bounds.Size)
    $bmp.Save('${screenshotPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
    $gfx.Dispose()
    $bmp.Dispose()
    Write-Output 'OK'
  }
}
`

  const tmpScriptPath = path.join(tmpDir, `yizhuan_screenshot_${Date.now()}.ps1`)
  fs.writeFileSync(tmpScriptPath, psScript, 'utf-8')

  screenshotProcess = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', tmpScriptPath
  ], { shell: false, windowsHide: true })

  let psOutput = ''
  screenshotProcess.stdout?.on('data', (data) => {
    psOutput += data.toString('utf-8')
  })

  screenshotProcess.on('close', () => {
    // 清理临时脚本
    try { fs.unlinkSync(tmpScriptPath) } catch { /* ignore */ }

    if (psOutput.includes('OK') && fs.existsSync(screenshotPath)) {
      // 通知渲染进程执行 OCR
      if (win) {
        win.webContents.send('screenshot-ocr-ready', { screenshotPath })
      }
    } else {
      // 截图取消或失败
      if (win) {
        win.webContents.send('screenshot-ocr-ready', { screenshotPath: null })
      }
    }
  })

  screenshotProcess.on('error', () => {
    try { fs.unlinkSync(tmpScriptPath) } catch { /* ignore */ }
    if (win) {
      win.webContents.send('screenshot-ocr-ready', { screenshotPath: null })
    }
  })
}

// 应用退出时注销快捷键
app.on('will-quit', () => {
  unregisterGlobalShortcuts()
})

// ============================================================
// Python 环境探测
// ============================================================
function getPythonExe(): string {
  // 优先使用内嵌 Python 运行时（自动下载的）
  const embeddedPython = getEmbeddedPythonExe()
  if (embeddedPython !== 'python') return embeddedPython
  // 其次尝试打包在 extraResources 中的 Python（向后兼容）
  const bundledPython = path.join(__dirname, '../../python/python.exe')
  if (fs.existsSync(bundledPython)) return bundledPython
  // 最后回退到系统 Python
  return 'python'
}

function getPythonScript(scriptName: string): string {
  // 打包后：extraResources 中的脚本
  const bundledScript = path.join(process.resourcesPath || '', 'python', scriptName)
  if (fs.existsSync(bundledScript)) return bundledScript
  // 开发环境：项目根目录 python 文件夹
  const devScript = path.join(__dirname, '../../python', scriptName)
  return devScript
}

/**
 * 确保 pdf2docx 已安装（转换前自动检查并安装）
 * 如果 Python 运行时未安装，先安装运行时；如果 pdf2docx 未安装，安装 pdf2docx
 * @param taskId 任务 ID（用于进度推送）
 * @returns { ready: boolean, error?: string }
 */
async function ensurePdf2docxReady(taskId: string): Promise<{ ready: boolean, error?: string }> {
  const status = checkRuntimeStatus()

  // 如果状态文件显示就绪，再做一次实际导入验证（防止环境变量等问题导致假就绪）
  if (status.pythonReady && status.pdf2docxReady) {
    conversionLog('[ensurePdf2docxReady] 状态文件显示就绪，进行实际导入验证...')
    const realCheck = await verifyPdf2docx()
    if (realCheck) {
      conversionLog('[ensurePdf2docxReady] 实际导入验证通过')
      return { ready: true }
    }
    conversionLog('[ensurePdf2docxReady] 实际导入验证失败！强制重新安装 pdf2docx...')
    // 直接安装 pdf2docx（Python 运行时已存在）
    try {
      const installResult = await installPdf2docxOnly((progress) => {
        if (win) {
          win.webContents.send('conversion-progress', {
            taskId,
            progress: Math.round((progress.progress || 0) * 0.5),
            status: '正在重新安装 pdf2docx 转换组件...'
          })
        }
      })
      if (!installResult.success) {
        return { ready: false, error: `pdf2docx 重新安装失败: ${installResult.error || '未知错误'}` }
      }
      // 再次验证
      const recheck = await verifyPdf2docx()
      if (recheck) {
        conversionLog('[ensurePdf2docxReady] 重新安装后验证通过')
        return { ready: true }
      }
      conversionLog('[ensurePdf2docxReady] 重新安装后验证仍然失败！')
      return { ready: false, error: 'pdf2docx 重新安装后仍无法导入，请检查 Python 环境配置' }
    } catch (err: any) {
      conversionLog('[ensurePdf2docxReady] 重新安装异常: ' + (err?.message || String(err)))
      return { ready: false, error: `重新安装 pdf2docx 时出错: ${err?.message || String(err)}` }
    }
  }

  conversionLog(`[ensurePdf2docxReady] Python ready=${status.pythonReady}, pdf2docx ready=${status.pdf2docxReady}, 开始自动安装...`)

  // 发送安装进度到前端
  if (win) {
    win.webContents.send('conversion-progress', { taskId, progress: 5, status: '正在安装转换组件...' })
  }

  try {
    if (!status.pythonReady) {
      // Python 运行时未安装，需要完整安装（运行时 + pdf2docx）
      conversionLog('[ensurePdf2docxReady] Python 运行时未安装，正在下载并安装...')
      const installResult = await installPythonRuntime((progress) => {
        if (win) {
          win.webContents.send('conversion-progress', {
            taskId,
            progress: Math.round((progress.progress || 0) * 0.5),
            status: progress.phase || '正在安装 Python 运行时...'
          })
        }
      })

      if (!installResult.success) {
        return { ready: false, error: `Python 运行时安装失败: ${installResult.error || '未知错误'}` }
      }
      conversionLog('[ensurePdf2docxReady] Python 运行时安装成功')
    } else if (!status.pdf2docxReady) {
      // Python 已安装但 pdf2docx 未安装
      conversionLog('[ensurePdf2docxReady] pdf2docx 未安装，正在安装...')
      const installResult = await installPdf2docxOnly((progress) => {
        if (win) {
          win.webContents.send('conversion-progress', {
            taskId,
            progress: Math.round((progress.progress || 0) * 0.5),
            status: '正在安装 pdf2docx 转换组件...'
          })
        }
      })

      if (!installResult.success) {
        return { ready: false, error: `pdf2docx 安装失败: ${installResult.error || '未知错误'}` }
      }
      conversionLog('[ensurePdf2docxReady] pdf2docx 安装成功')
    }

    // 使用实际导入验证安装结果（不依赖状态文件）
    const realCheck = await verifyPdf2docx()
    if (realCheck) {
      conversionLog('[ensurePdf2docxReady] 安装后实际验证通过')
      return { ready: true }
    } else {
      return { ready: false, error: '安装完成但实际导入验证未通过，请重试' }
    }
  } catch (err: any) {
    conversionLog('[ensurePdf2docxReady] 安装异常: ' + (err?.message || String(err)))
    return { ready: false, error: `安装转换组件时出错: ${err?.message || String(err)}` }
  }
}

/**
 * 获取 Python 子进程的环境变量
 *
 * 关键：python-build-standalone 使用 python._pth 文件配置模块搜索路径，
 * 设置 PYTHONHOME 会覆盖这一机制，导致 Python 无法找到标准库和 site-packages。
 * 正确做法是：清除 PYTHONHOME/PYTHONPATH，将 Python 目录加入 PATH。
 */
function getPythonEnv(): Record<string, string> {
  const pythonExe = getPythonExe()
  // 使用顶部导入的 path as typeof import('path')
  const env: Record<string, string> = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
  }

  // 删除可能残留的 PYTHONHOME 和 PYTHONPATH，防止干扰独立 Python 的路径配置
  delete env.PYTHONHOME
  delete env.PYTHONPATH

  // 如果使用的是内嵌 Python，将其目录和 Scripts 加入 PATH
  if (pythonExe !== 'python' && fs.existsSync(pythonExe)) {
    const pythonDir = path.dirname(pythonExe)
    const scriptsDir = path.join(pythonDir, 'Scripts')
    // 将 Python 目录和 Scripts 目录前置到 PATH
    const pathSep = process.platform === 'win32' ? ';' : ':'
    const extraPaths = [pythonDir, scriptsDir].filter(p => fs.existsSync(p))
    if (extraPaths.length > 0) {
      env.PATH = extraPaths.join(pathSep) + pathSep + (env.PATH || '')
    }
  }

  return env
}

// ============================================================
// 文件选择对话框
// ============================================================
ipcMain.handle('select-files', async (_event, options: { filters?: any[], multi?: boolean }) => {
  if (!win) return []
  const result = await dialog.showOpenDialog(win, {
    properties: options.multi !== false ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: options.filters || [{ name: 'All Files', extensions: ['*'] }]
  })
  return result.filePaths || []
})

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(win!, {
    properties: ['openDirectory']
  })
  return result.filePaths[0] || null
})

ipcMain.handle('show-save-dialog', async (_event, options: { defaultPath?: string, filters?: any[] }) => {
  const result = await dialog.showSaveDialog(win!, {
    defaultPath: options.defaultPath,
    filters: options.filters
  })
  return result.filePath || null
})

// ============================================================
// PDF 转 Word
// ============================================================
ipcMain.handle('convert-pdf-to-docx', async (_event, { inputPath, outputPath, taskId }: { inputPath: string, outputPath: string, taskId: string }) => {
  conversionLog('[convert-pdf-to-docx] 开始: input=' + inputPath + ', output=' + outputPath)

  // 转换前清理旧输出文件，避免文件被占用导致 Permission denied
  const actualOutputPath = prepareOutputPath(outputPath, 'convert-pdf-to-docx')

  // 自动检查并安装 pdf2docx
  const readyCheck = await ensurePdf2docxReady(taskId)
  if (!readyCheck.ready) {
    conversionLog('[convert-pdf-to-docx] pdf2docx 安装失败: ' + (readyCheck.error || ''))
    return { status: 'error', message: readyCheck.error || '转换组件安装失败，请稍后重试' }
  }

  const result: any = await new Promise((resolve) => {
    const pythonExe = getPythonExe()
    const scriptPath = getPythonScript('convert_pdf.py')

    const args = [scriptPath, 'pdf2docx', inputPath, actualOutputPath]
    const proc = spawn(pythonExe, args, {
      shell: false,
      cwd: process.cwd(),
      env: getPythonEnv(),
      windowsHide: true,
    })

    activeProcesses.set(taskId, proc)

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => {
      stdout += data.toString('utf-8')
      // 解析进度信息（pdf2docx 输出格式）
      const text = data.toString('utf-8')
      if (text.includes('Processing')) {
        const match = text.match(/(\d+)%/)
        if (match && win) {
          win.webContents.send('conversion-progress', {
            taskId,
            progress: parseInt(match[1])
          })
        }
      }
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString('utf-8')
    })

    proc.on('close', (code) => {
      activeProcesses.delete(taskId)

      if (code === 0) {
        // 尝试解析 JSON 输出
        try {
          const lines = stdout.trim().split('\n')
          const jsonLine = lines.find(l => {
            try { JSON.parse(l); return true } catch { return false }
          })
          if (jsonLine) {
            const result = JSON.parse(jsonLine)
            // 始终使用已知的 actualOutputPath，不依赖 Python stdout 中的路径（避免编码问题）
            result.output = actualOutputPath
            resolve(result)
          } else {
            resolve({ status: 'success', output: actualOutputPath, message: stdout })
          }
        } catch {
          resolve({ status: 'success', output: actualOutputPath, message: stdout })
        }
      } else {
        resolve({
          status: 'error',
          message: stderr || stdout || `进程退出码: ${code}`
        })
      }
    })

    proc.on('error', (err) => {
      activeProcesses.delete(taskId)
      resolve({ status: 'error', message: err.message })
    })
  })

  // 验证输出文件
  if (result && result.status === 'success' && result.output) {
    const fileExists = verifyOutputFile(result.output, 'convert-pdf-to-docx')
    if (!fileExists) {
      conversionLog('[convert-pdf-to-docx] 警告: 转换报告成功但文件不存在!')
      result.status = 'error'
      result.message = '转换报告成功，但输出文件未找到。请检查磁盘空间和写入权限。'
    }
  } else {
    conversionLog('[convert-pdf-to-docx] 转换失败: ' + ((result && result.message) ? result.message : '未知错误'))
  }

  // 非会员输出自动添加品牌水印
  if (result && result.status === 'success' && result.output) {
    const limits = getUsageLimits()
    watermarkCallLog(`convert-pdf-to-docx: status=${result.status}, hasWatermark=${limits.hasWatermark}, output=${result.output}`)
    if (limits.hasWatermark) {
      await applyWatermarkToFile(result.output)
    }
    // 水印后二次验证，确保文件仍然存在且可见
    verifyAfterWatermark(result.output, 'convert-pdf-to-docx')
  }

  return result
})

// ============================================================
// PDF 转 Excel（PDF→DOCX→解析表格→XLSX）
// ============================================================
ipcMain.handle('convert-pdf-to-xlsx', async (_event, { inputPath, outputPath, taskId }: { inputPath: string, outputPath: string, taskId: string }) => {
  conversionLog('[convert-pdf-to-xlsx] 开始: input=' + inputPath + ', output=' + outputPath)
  try {
    // 转换前清理旧输出文件，避免文件被占用导致 Permission denied
    const actualOutputPath = prepareOutputPath(outputPath, 'convert-pdf-to-xlsx')

    // 自动检查并安装 pdf2docx
    const readyCheck = await ensurePdf2docxReady(taskId)
    if (!readyCheck.ready) {
      conversionLog('[convert-pdf-to-xlsx] pdf2docx 安装失败: ' + (readyCheck.error || ''))
      return { status: 'error', message: readyCheck.error || '转换组件安装失败，请稍后重试' }
    }

    const pythonExe = getPythonExe()
    const scriptPath = getPythonScript('convert_pdf.py')

    if (!fs.existsSync(pythonExe)) {
      return { status: 'error', message: 'Python 运行时未找到，请先安装' }
    }
    if (!fs.existsSync(scriptPath)) {
      return { status: 'error', message: '转换脚本未找到，请重新安装应用' }
    }

    // 第一步：PDF → DOCX（通过 pdf2docx，保留表格结构）
    const result: any = await new Promise((resolve) => {
      const args = [scriptPath, 'pdf2xlsx', inputPath, actualOutputPath]
      const proc = spawn(pythonExe, args, {
        shell: false,
        cwd: process.cwd(),
        env: getPythonEnv(),
        windowsHide: true,
      })

      activeProcesses.set(taskId, proc)

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data) => {
        stdout += data.toString('utf-8')
        const text = data.toString('utf-8')
        if (text.includes('Processing')) {
          const match = text.match(/(\d+)%/)
          if (match && win) {
            win.webContents.send('conversion-progress', {
              taskId,
              progress: Math.round(parseInt(match[1]) * 0.6)
            })
          }
        }
      })

      proc.stderr?.on('data', (data) => {
        stderr += data.toString('utf-8')
      })

      proc.on('close', (code) => {
        activeProcesses.delete(taskId)

        if (code === 0) {
          try {
            const lines = stdout.trim().split('\n')
            const jsonLine = lines.find(l => {
              try { JSON.parse(l); return true } catch { return false }
            })
            if (jsonLine) {
              resolve(JSON.parse(jsonLine))
            } else {
              resolve({ status: 'error', message: '转换完成但未获取到结果，请检查 pdf2docx 是否已安装' })
            }
          } catch {
            resolve({ status: 'error', message: '解析转换结果失败' })
          }
        } else {
          resolve({ status: 'error', message: stderr || `转换进程异常退出（退出码: ${code}）` })
        }
      })

      proc.on('error', (err) => {
        activeProcesses.delete(taskId)
        resolve({ status: 'error', message: `启动转换进程失败: ${err.message}` })
      })
    })

    // 检查 PDF → DOCX 是否成功
    if (!result || result.status !== 'success') {
      conversionLog('[convert-pdf-to-xlsx] PDF 转 DOCX 失败: ' + ((result && result.message) ? result.message : '未知错误'))
      return result || { status: 'error', message: 'PDF 转 DOCX 失败' }
    }

    // 获取中间 DOCX 路径
    const intermediateDocx = result.intermediate_docx || result.output
    if (!intermediateDocx || !fs.existsSync(intermediateDocx)) {
      conversionLog('[convert-pdf-to-xlsx] 中间 DOCX 文件不存在: ' + intermediateDocx)
      return { status: 'error', message: 'PDF 转 DOCX 成功但中间文件未找到' }
    }

    conversionLog('[convert-pdf-to-xlsx] PDF 转 DOCX 成功，正在解析表格数据...')
    if (win) {
      win.webContents.send('conversion-progress', { taskId, progress: 70, status: 'processing' })
    }

    // 第二步：从 DOCX 提取表格数据
    const tables = extractTablesFromDocx(intermediateDocx)
    // 回退：如果没有表格，提取文本
    const fallbackRows = tables.length === 0 ? extractTextFromDocx(intermediateDocx) : []

    conversionLog(`[convert-pdf-to-xlsx] 提取到 ${tables.length} 个表格，${fallbackRows.length} 行回退文本`)

    if (win) {
      win.webContents.send('conversion-progress', { taskId, progress: 85, status: 'processing' })
    }

    // 第三步：从表格数据创建 XLSX
    const xlsxResult = createXlsxFromTables(tables, fallbackRows, actualOutputPath)

    // 清理临时 DOCX
    try {
      if (fs.existsSync(intermediateDocx)) {
        fs.unlinkSync(intermediateDocx)
      }
    } catch {}

    // 验证输出文件
    if (xlsxResult.status === 'success' && xlsxResult.output) {
      const fileExists = verifyOutputFile(xlsxResult.output, 'convert-pdf-to-xlsx')
      if (!fileExists) {
        conversionLog('[convert-pdf-to-xlsx] 警告: 转换报告成功但文件不存在!')
        xlsxResult.status = 'error'
        xlsxResult.message = '转换报告成功，但输出文件未找到。请检查磁盘空间和写入权限。'
      }
    }

    // 非会员输出自动添加品牌水印
    if (xlsxResult.status === 'success' && xlsxResult.output) {
      const limits = getUsageLimits()
      watermarkCallLog(`convert-pdf-to-xlsx: status=${xlsxResult.status}, hasWatermark=${limits.hasWatermark}, output=${xlsxResult.output}`)
      if (limits.hasWatermark) {
        await applyWatermarkToFile(xlsxResult.output)
      }
      // 水印后二次验证
      verifyAfterWatermark(xlsxResult.output, 'convert-pdf-to-xlsx')
    }

    if (win) {
      win.webContents.send('conversion-progress', { taskId, progress: 100, status: 'done' })
    }

    return xlsxResult
  } catch (err: any) {
    conversionLog('[convert-pdf-to-xlsx] 异常: ' + (err?.message || String(err)))
    return { status: 'error', message: 'PDF 转 Excel 失败: ' + (err?.message || '未知错误，请检查是否已安装 pdf2docx') }
  }
})

// ============================================================
// PDF 转 PPT（通过图片转 PPTX，不依赖 LibreOffice）
// ============================================================
ipcMain.handle('convert-pdf-to-ppt', async (_event, { inputPath, outputPath, taskId }: { inputPath: string, outputPath: string, taskId: string }) => {
  conversionLog('[convert-pdf-to-ppt] 开始: input=' + inputPath + ', output=' + outputPath)
  try {
    if (!fs.existsSync(inputPath)) {
      return { status: 'error', message: '输入文件不存在' }
    }

    // 转换前清理旧输出文件，避免文件被占用导致 Permission denied
    const actualOutputPath = prepareOutputPath(outputPath, 'convert-pdf-to-ppt')

    // 确保输出目录存在
    const outputDir = path.dirname(actualOutputPath)
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    // 第一步：将 PDF 每页渲染为图片
    const tempImgDir = path.join(os.tmpdir(), `yizhuan-ppt-${Date.now()}`)
    if (!fs.existsSync(tempImgDir)) {
      fs.mkdirSync(tempImgDir, { recursive: true })
    }

    conversionLog('[convert-pdf-to-ppt] 正在渲染 PDF 页面为图片...')
    if (win) {
      win.webContents.send('conversion-progress', { taskId, progress: 10, status: 'processing' })
    }

    const imgResult = await pdfToImages(
      inputPath,
      tempImgDir,
      taskId,
      { format: 'png', dpi: 200 },
      (current, total) => {
        const progress = Math.round((current / total) * 70) + 10
        if (win) {
          win.webContents.send('conversion-progress', { taskId, progress, status: 'processing' })
        }
      },
      createHiddenWindow
    )

    if (imgResult.status !== 'success' || imgResult.items.length === 0) {
      conversionLog('[convert-pdf-to-ppt] PDF 转图片失败: ' + (imgResult.message || '无页面输出'))
      return { status: 'error', message: 'PDF 转图片失败: ' + (imgResult.message || '未知错误') }
    }

    conversionLog(`[convert-pdf-to-ppt] 成功渲染 ${imgResult.items.length} 页，正在生成 PPTX...`)
    if (win) {
      win.webContents.send('conversion-progress', { taskId, progress: 80, status: 'processing' })
    }

    // 获取每张图片的尺寸，跳过空白或损坏的图片
    const sharp = await import('sharp')
    const slideImages = []
    for (const item of imgResult.items) {
      try {
        const imgBuffer = fs.readFileSync(item.output)
        // 跳过过小的文件（可能是空白或渲染失败的页面）
        if (imgBuffer.length < 1000) {
          conversionLog(`[convert-pdf-to-ppt] 跳过空白/损坏的图片: ${item.output} (${imgBuffer.length} bytes)`)
          continue
        }
        const metadata = await sharp.default(item.output).metadata()
        slideImages.push({
          imagePath: item.output,
          width: metadata.width || 1920,
          height: metadata.height || 1080,
        })
      } catch (err) {
        conversionLog(`[convert-pdf-to-ppt] 图片读取失败，跳过: ${item.output} - ${err}`)
        // 跳过无法读取的图片，而不是使用默认尺寸（避免空白页）
        continue
      }
    }

    if (slideImages.length === 0) {
      conversionLog('[convert-pdf-to-ppt] 所有图片均无效')
      return { status: 'error', message: 'PDF 渲染失败：所有页面均为空白' }
    }

    // 第二步：从图片创建 PPTX
    const pptxResult = await createPptxFromImages(slideImages, actualOutputPath)

    // 清理临时图片
    for (const item of imgResult.items) {
      try { fs.unlinkSync(item.output) } catch {}
    }
    try { fs.rmdirSync(tempImgDir) } catch {}

    if (pptxResult.status === 'success' && pptxResult.output) {
      const fileExists = verifyOutputFile(pptxResult.output, 'convert-pdf-to-ppt')
      if (!fileExists) {
        conversionLog('[convert-pdf-to-ppt] 警告: 转换报告成功但文件不存在!')
        return { status: 'error', message: '转换报告成功，但输出文件未找到。' }
      }
      if (win) {
        win.webContents.send('conversion-progress', { taskId, progress: 100, status: 'done' })
      }
      conversionLog('[convert-pdf-to-ppt] 转换成功: ' + pptxResult.output)

      // 非会员输出自动添加品牌水印
      const limits = getUsageLimits()
      watermarkCallLog(`convert-pdf-to-ppt: status=success, hasWatermark=${limits.hasWatermark}, output=${pptxResult.output}`)
      if (limits.hasWatermark) {
        await applyWatermarkToFile(pptxResult.output)
        verifyAfterWatermark(pptxResult.output, 'convert-pdf-to-ppt')
      }
    } else {
      conversionLog('[convert-pdf-to-ppt] 转换失败: ' + (pptxResult.message || '未知错误'))
    }

    return pptxResult
  } catch (err: any) {
    conversionLog('[convert-pdf-to-ppt] 异常: ' + (err?.message || String(err)))
    return { status: 'error', message: 'PDF 转 PPT 失败: ' + (err?.message || '未知错误') }
  }
})

// ============================================================
// 取消转换任务
// ============================================================
ipcMain.handle('cancel-conversion', async (_event, { taskId }: { taskId: string }) => {
  const proc = activeProcesses.get(taskId)
  if (proc) {
    proc.kill('SIGTERM')
    activeProcesses.delete(taskId)
    return { success: true }
  }
  return { success: false, message: '任务不存在或已完成' }
})

// ============================================================
// Word 转 PDF（通过 LibreOffice）
// ============================================================
ipcMain.handle('convert-docx-to-pdf', async (_event, { inputPath, outputPath, taskId }: { inputPath: string, outputPath: string, taskId: string }) => {
  conversionLog('[convert-docx-to-pdf] 开始: input=' + inputPath + ', output=' + outputPath)
  // 转换前清理旧输出文件，避免文件被占用导致 Permission denied
  const actualOutputPath = prepareOutputPath(outputPath, 'convert-docx-to-pdf')
  const result: any = await new Promise((resolve) => {
    const pythonExe = getPythonExe()
    const scriptPath = getPythonScript('convert_pdf.py')

    const args = [scriptPath, 'docx2pdf', inputPath, actualOutputPath]
    const proc = spawn(pythonExe, args, {
      shell: false,
      cwd: process.cwd(),
      env: getPythonEnv(),
      windowsHide: true,
    })

    activeProcesses.set(taskId, proc)

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => {
      stdout += data.toString('utf-8')
      if (win) {
        win.webContents.send('conversion-progress', { taskId, progress: 50, status: 'processing' })
      }
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString('utf-8')
    })

    proc.on('close', (code) => {
      activeProcesses.delete(taskId)

      if (code === 0) {
        try {
          const lines = stdout.trim().split('\n')
          const jsonLine = lines.find(l => {
            try { JSON.parse(l); return true } catch { return false }
          })
          if (jsonLine) {
            const result = JSON.parse(jsonLine)
            // 始终使用已知的 actualOutputPath，不依赖 Python stdout 中的路径（避免编码问题）
            result.output = actualOutputPath
            if (win) {
              win.webContents.send('conversion-progress', { taskId, progress: 100, status: 'done' })
            }
            resolve(result)
          } else {
            resolve({ status: 'success', output: actualOutputPath, message: stdout })
          }
        } catch {
          resolve({ status: 'success', output: actualOutputPath, message: stdout })
        }
      } else {
        resolve({
          status: 'error',
          message: stderr || stdout || `进程退出码: ${code}`
        })
      }
    })

    proc.on('error', (err) => {
      activeProcesses.delete(taskId)
      resolve({ status: 'error', message: err.message })
    })
  })

  // 验证输出文件
  if (result && result.status === 'success' && result.output) {
    const fileExists = verifyOutputFile(result.output, 'convert-docx-to-pdf')
    if (!fileExists) {
      conversionLog('[convert-docx-to-pdf] 警告: 转换报告成功但文件不存在!')
      result.status = 'error'
      result.message = '转换报告成功，但输出文件未找到。请检查磁盘空间和写入权限。'
    }
  } else {
    conversionLog('[convert-docx-to-pdf] 转换失败: ' + ((result && result.message) ? result.message : '未知错误'))
  }

  // 非会员输出自动添加品牌水印
  if (result && result.status === 'success' && result.output) {
    const limits = getUsageLimits()
    if (limits.hasWatermark) {
      await applyWatermarkToFile(result.output)
    }
    // 水印后二次验证
    verifyAfterWatermark(result.output, 'convert-docx-to-pdf')
  }

  return result
})

// ============================================================
// 打开文件 / 文件夹
// ============================================================
ipcMain.handle('open-file', async (_event, { path }: { path: string }) => {
  try {
    conversionLog(`[open-file] 请求打开: ${path}`)
    if (!path) {
      return { success: false, error: '路径为空' }
    }
    if (!fs.existsSync(path)) {
      conversionLog(`[open-file] 文件不存在: ${path}`)
      return { success: false, error: '文件不存在' }
    }
    const result = await shell.openPath(path)
    if (result) {
      conversionLog(`[open-file] 打开失败: ${result}`)
      return { success: false, error: result }
    }
    conversionLog(`[open-file] 打开成功: ${path}`)
    return { success: true }
  } catch (err: any) {
    conversionLog(`[open-file] 异常: ${err?.message || String(err)}`)
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('open-folder', async (_event, { path: filePath }: { path: string }) => {
  try {
    conversionLog(`[open-folder] 开始: path=${filePath}`)
    if (!filePath) {
      conversionLog(`[open-folder]: path 为空`)
      return { success: false, error: '路径为空' }
    }

    const exists = fs.existsSync(filePath)
    conversionLog(`[open-folder]: 路径存在=${exists}, path=${filePath}`)

    // 获取父目录
    const stat = exists ? fs.statSync(filePath) : null
    const isDir = stat?.isDirectory() ?? false
    const dir = isDir ? filePath : path.dirname(filePath)

    if (!exists) {
      conversionLog(`[open-folder]: 路径不存在, 尝试打开父目录: ${dir}`)
      if (dir && fs.existsSync(dir)) {
        const err = await shell.openPath(dir)
        conversionLog(`[open-folder]: openPath 返回: "${err}"`)
        return { success: true, warning: '文件不存在，已打开所在目录' }
      }
      return { success: false, error: '目录不存在' }
    }

    if (isDir) {
      conversionLog(`[open-folder]: 目标是目录，使用 openPath: ${filePath}`)
      const err = await shell.openPath(filePath)
      conversionLog(`[open-folder]: openPath 返回: "${err}"`)
      return { success: true }
    }

    // === 是文件 ===
    // 根因分析：
    // 1. exec 通过 cmd.exe 执行，cmd.exe 使用 GBK 编码，中文路径会乱码
    // 2. spawn 不加 windowsVerbatimArguments 时，Node.js 自动给参数加引号
    //    导致 /select,path 变成 "/select,path"，explorer 无法解析
    // 解决：用 spawn 直接调用 explorer.exe（不经 cmd.exe），加 windowsVerbatimArguments
    const winPath = filePath.replace(/\//g, '\\')

    // 方法1: spawn 直接调用 explorer.exe，windowsVerbatimArguments 控制参数格式
    // 命令行最终为: explorer.exe /select,"D:\测试\文件.xlsx"
    let opened = false
    try {
      conversionLog(`[open-folder]: 方法1 spawn explorer.exe /select`)
      const child = spawn('C:\\Windows\\explorer.exe', [`/select,"${winPath}"`], {
        shell: false,
        windowsVerbatimArguments: true,
        windowsHide: false,
      })
      child.on('error', (err) => {
        conversionLog(`[open-folder]: 方法1 spawn 失败: ${err.message}, 回退到 showItemInFolder`)
        try {
          shell.showItemInFolder(filePath)
          conversionLog(`[open-folder]: 已通过 showItemInFolder 回退`)
        } catch {
          shell.openPath(dir).catch(() => {})
        }
      })
      child.on('exit', (code) => {
        conversionLog(`[open-folder]: 方法1 explorer.exe 退出, code=${code}`)
      })
      opened = true
      conversionLog(`[open-folder]: 方法1 spawn 已启动`)
    } catch (e1: any) {
      conversionLog(`[open-folder]: 方法1 异常: ${e1?.message}`)
    }

    // 方法2: 如果方法1启动失败，用 Electron 原生 API
    if (!opened) {
      try {
        conversionLog(`[open-folder]: 方法2 shell.showItemInFolder`)
        shell.showItemInFolder(filePath)
        conversionLog(`[open-folder]: 方法2 已调用`)
      } catch (e2: any) {
        conversionLog(`[open-folder]: 方法2 失败: ${e2?.message}, 打开父目录`)
        const openErr = await shell.openPath(dir)
        conversionLog(`[open-folder]: openPath 返回: "${openErr}"`)
      }
    }

    conversionLog(`[open-folder]: 完成, dir=${dir}`)
    return { success: true, dir, fileName: filePath.replace(/^.*[/\\]/, '') }
  } catch (err: any) {
    console.error('[open-folder] Error:', err)
    try {
      const dir = path.dirname(filePath)
      if (dir) await shell.openPath(dir)
    } catch {}
    return { success: false, error: String(err) }
  }
})

// 获取文件大小
ipcMain.handle('get-file-size', async (_event, { path }: { path: string }) => {
  try {
    const stats = fs.statSync(path)
    return stats.size
  } catch {
    return 0
  }
})

// ============================================================
// 窗口控制
// ============================================================
ipcMain.handle('window-minimize', () => {
  win?.minimize()
})

ipcMain.handle('window-maximize', () => {
  if (win) {
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  }
})

ipcMain.handle('window-close', () => {
  win?.close()
})

ipcMain.handle('window-is-maximized', () => {
  return win?.isMaximized() || false
})

// ============================================================
// 主题切换 - 同步原生窗口主题
// ============================================================
ipcMain.handle('set-native-theme', (_event, theme: 'light' | 'dark') => {
  nativeTheme.themeSource = theme
  if (win) {
    win.setBackgroundColor(theme === 'dark' ? '#0f172a' : '#f8fafc')
  }
  return { success: true }
})

// ============================================================
// 获取应用信息
// ============================================================
ipcMain.handle('get-app-version', () => {
  return app.getVersion()
})

ipcMain.handle('check-python-env', async () => {
  // 使用内嵌运行时管理模块检查状态
  const runtimeStatus = checkRuntimeStatus()

  // 如果内嵌运行时不可用，回退检测系统 Python
  if (!runtimeStatus.pythonReady) {
    return new Promise((resolve) => {
      const pythonExe = 'python'
      const proc = spawn(pythonExe, ['-c', 'import pdf2docx; print("ok")'], { shell: false })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data) => { stdout += data.toString() })
      proc.stderr.on('data', (data) => { stderr += data.toString() })

      proc.on('close', (code) => {
        resolve({
          pythonPath: code === 0 ? pythonExe : null,
          pdf2docxReady: code === 0 && stdout.includes('ok'),
          embeddedReady: false,
          needsInstall: code !== 0,
          error: code !== 0 ? (stderr || '系统 Python 不可用') : null
        })
      })

      proc.on('error', (err) => {
        resolve({
          pythonPath: null,
          pdf2docxReady: false,
          embeddedReady: false,
          needsInstall: true,
          error: err.message
        })
      })
    })
  }

  return {
    pythonPath: runtimeStatus.pythonPath,
    pdf2docxReady: runtimeStatus.pdf2docxReady,
    embeddedReady: true,
    needsInstall: !runtimeStatus.pdf2docxReady,
    busy: runtimeStatus.busy,
    phase: runtimeStatus.phase,
    progress: runtimeStatus.progress,
  }
})

// ============================================================
// LibreOffice 环境检测
// ============================================================
ipcMain.handle('check-libreoffice', async () => {
  // 检查常见安装路径
  const candidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ]

  for (const path of candidates) {
    if (fs.existsSync(path)) {
      return { installed: true, path }
    }
  }

  // 检查 PATH
  return new Promise((resolve) => {
    const proc = spawn('where', ['soffice'], { shell: true })
    let stdout = ''

    proc.stdout.on('data', (data) => { stdout += data.toString() })
    proc.on('close', () => {
      const found = stdout.trim().length > 0
      resolve({ installed: found, path: found ? stdout.trim().split('\n')[0] : null })
    })
    proc.on('error', () => {
      resolve({ installed: false, path: null })
    })
  })
})

// ============================================================
// OCR 文字识别
// ============================================================
ipcMain.handle('ocr-recognize', async (_event, { imagePath, taskId, lang }: { imagePath: string, taskId: string, lang?: string }) => {
  const result = await performOcr(
    imagePath,
    { lang: lang || 'chi_sim+eng', psm: 3, taskId },
    (progress, status) => {
      if (win) {
        win.webContents.send('conversion-progress', { taskId, progress, status })
      }
    }
  )
  return result
})

ipcMain.handle('ocr-save', async (_event, { text, outputPath }: { text: string, outputPath: string }) => {
  return saveOcrResult(text, outputPath)
})

// OCR 多格式保存（TXT / DOCX / XLSX / 可搜索 PDF）
ipcMain.handle('ocr-save-multiformat', async (_event, { text, imagePath, outputPath, format }: {
  text: string, imagePath: string, outputPath: string, format: OcrOutputFormat
}) => {
  const result = await saveOcrMultiFormat(text, imagePath, outputPath, format)

  // 非会员输出自动添加品牌水印（所有格式：DOCX、PDF、XLSX、TXT 等）
  if (result.success && result.path) {
    const limits = getUsageLimits()
    if (limits.hasWatermark) {
      watermarkCallLog(`ocr-save-multiformat: adding watermark to ${result.path} (format=${format})`)
      await applyWatermarkToFile(result.path)
      verifyAfterWatermark(result.path, 'ocr-save-multiformat')
    }
  }

  return result
})

// ============================================================
// 图片格式转换
// ============================================================
ipcMain.handle('convert-image', async (_event, {
  inputPath,
  outputPath,
  targetFormat,
  taskId,
  quality,
  width,
  height
}: {
  inputPath: string
  outputPath: string
  targetFormat: 'png' | 'jpg' | 'webp' | 'heic'
  taskId: string
  quality?: number
  width?: number
  height?: number
}) => {
  conversionLog('[convert-image] 开始: input=' + inputPath + ', output=' + outputPath + ', format=' + targetFormat)
  if (win) {
    win.webContents.send('conversion-progress', { taskId, progress: 10, status: 'processing' })
  }

  // 提前检查是否需要水印，将水印集成到转换管道中（避免二次读写导致文件锁定）
  const limits = getUsageLimits()
  const result = await convertImage(inputPath, outputPath, targetFormat, {
    quality, width, height,
    addWatermark: limits.hasWatermark
  })

  // 验证输出文件
  if (result.status === 'success' && result.output) {
    verifyOutputFile(result.output, 'convert-image')
  } else {
    conversionLog('[convert-image] 转换失败: ' + result.message)
  }

  // 如果水印已在转换管道中添加，跳过后置水印；否则补充添加
  if (result.status === 'success' && result.output && limits.hasWatermark && !result.watermarkApplied) {
    watermarkCallLog(`convert-image: 水印未在管道中添加，后置补充: ${result.output}`)
    await applyWatermarkToFile(result.output)
  } else if (result.watermarkApplied) {
    watermarkCallLog(`convert-image: 水印已在转换管道中添加，跳过后置水印`)
  }

  if (win) {
    win.webContents.send('conversion-progress', { taskId, progress: 100, status: 'done' })
  }

  return result
})

ipcMain.handle('batch-convert-images', async (_event, {
  items,
  taskId,
  quality,
  width,
  height
}: {
  items: Array<{ inputPath: string, outputPath: string, targetFormat: 'png' | 'jpg' | 'webp' | 'heic' }>
  taskId: string
  quality?: number
  width?: number
  height?: number
}) => {
  // 提前检查是否需要水印，将水印集成到转换管道中
  const limits = getUsageLimits()
  const results = await batchConvertImages(
    items,
    { quality, width, height, addWatermark: limits.hasWatermark },
    (current, total, filename) => {
      if (win) {
        win.webContents.send('conversion-progress', {
          taskId,
          progress: Math.round((current / total) * 100),
          status: `正在处理 ${current}/${total}: ${filename}`
        })
      }
    }
  )

  // 对未在管道中添加水印的成功结果补充添加
  if (limits.hasWatermark) {
    for (const result of results) {
      if (result.status === 'success' && result.output && !result.watermarkApplied) {
        watermarkCallLog(`batch-convert-images: 水印未在管道中添加，后置补充: ${result.output}`)
        await applyWatermarkToFile(result.output)
      }
    }
  }

  return results
})

// ============================================================
// 视频转换
// ============================================================
ipcMain.handle('convert-video', async (_event, { inputPath, outputPath, targetFormat, taskId, options }: {
  inputPath: string, outputPath: string, targetFormat: VideoTargetFormat, taskId: string, options?: {
    videoCodec?: string, videoBitrate?: string, resolution?: string, fps?: number, qualityPreset?: string
  }
}) => {
  const result = await convertVideo(
    { inputPath, outputPath, targetFormat, taskId, ...options } as any,
    (progress, status) => {
      if (win) {
        win.webContents.send('conversion-progress', { taskId, progress, status })
      }
    }
  )

  // 非会员输出自动添加视频水印（通过 ffmpeg overlay）
  // 注意：GIF 格式不支持 libx264 编码，跳过水印
  if (result.status === 'success' && result.output) {
    const limits = getUsageLimits()
    const outputExt = result.output.toLowerCase().split('.').pop() || ''
    if (limits.hasWatermark && outputExt !== 'gif') {
      watermarkCallLog(`convert-video: adding watermark to ${result.output} (ext=${outputExt})`)
      try {
        const wmPngPath = await generateVideoWatermarkPng()
        if (wmPngPath) {
          const wmSuccess = await addVideoWatermark(result.output, wmPngPath)
          watermarkCallLog(`convert-video: watermark result=${wmSuccess}`)
          // 清理临时水印图片
          try { fs.unlinkSync(wmPngPath) } catch {}
          // 水印后验证文件
          verifyAfterWatermark(result.output, 'convert-video')
        }
      } catch (err) {
        watermarkCallLog(`convert-video: watermark error=${err}`)
      }
    } else if (outputExt === 'gif') {
      watermarkCallLog(`convert-video: skipping watermark for GIF output`)
    }
  }

  return result
})

ipcMain.handle('get-video-info', async (_event, { videoPath }: { videoPath: string }) => {
  return getVideoInfo(videoPath)
})

// ============================================================
// CAJ 转 PDF
// ============================================================
ipcMain.handle('convert-caj-to-pdf', async (_event, { inputPath, outputPath, taskId }: { inputPath: string, outputPath: string, taskId: string }) => {
  conversionLog('[convert-caj-to-pdf] 开始: input=' + inputPath + ', output=' + outputPath)
  const result: any = await new Promise((resolve) => {
    const pythonExe = getPythonExe()
    const scriptPath = getPythonScript('convert_caj.py')
    const mutoolExe = getMutoolExe()

    const args = [scriptPath, 'convert', inputPath, outputPath]
    if (mutoolExe && mutoolExe !== 'mutool') {
      args.push('--mutool', mutoolExe)
    }

    const proc = spawn(pythonExe, args, {
      shell: false,
      cwd: process.cwd(),
      env: getPythonEnv(),
      windowsHide: true,
    })

    activeProcesses.set(taskId, proc)

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => {
      stdout += data.toString('utf-8')
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString('utf-8')
    })

    proc.on('close', (code) => {
      activeProcesses.delete(taskId)

      if (code === 0) {
        try {
          const lines = stdout.trim().split('\n')
          const jsonLine = lines.find(l => {
            try { JSON.parse(l); return true } catch { return false }
          })
          if (jsonLine) {
            const result = JSON.parse(jsonLine)
            // 始终使用已知的 outputPath，不依赖 Python stdout 中的路径（避免编码问题）
            result.output = outputPath
            resolve(result)
          } else {
            resolve({ status: 'success', output: outputPath, message: stdout })
          }
        } catch {
          resolve({ status: 'success', output: outputPath, message: stdout })
        }
      } else {
        resolve({
          status: 'error',
          message: stderr || stdout || `进程退出码: ${code}`
        })
      }
    })

    proc.on('error', (err) => {
      activeProcesses.delete(taskId)
      resolve({ status: 'error', message: err.message })
    })
  })

  // 验证输出文件
  if (result && result.status === 'success' && result.output) {
    const fileExists = verifyOutputFile(result.output, 'convert-caj-to-pdf')
    if (!fileExists) {
      conversionLog('[convert-caj-to-pdf] 警告: 转换报告成功但文件不存在!')
      result.status = 'error'
      result.message = '转换报告成功，但输出文件未找到。'
    }
  } else {
    conversionLog('[convert-caj-to-pdf] 转换失败: ' + ((result && result.message) ? result.message : '未知错误'))
  }

  // 非会员输出自动添加品牌水印
  if (result && result.status === 'success' && result.output) {
    const limits = getUsageLimits()
    if (limits.hasWatermark) {
      await applyWatermarkToFile(result.output)
    }
  }

  return result
})

ipcMain.handle('check-caj-env', async () => {
  // 先做同步检测
  const syncStatus = checkCajRuntime()
  // 再做异步 caj2pdf 精确检测
  const caj2pdfInstalled = await checkCaj2pdfInstalled()
  return {
    ...syncStatus,
    caj2pdfInstalled,
    cajReady: caj2pdfInstalled && syncStatus.mutoolReady,
  }
})

// CAJ 运行时自动安装
ipcMain.handle('install-caj-runtime', async (_event) => {
  const onProgress: CajProgressCallback = (status) => {
    if (win) {
      win.webContents.send('caj-install-progress', status)
    }
  }
  const result = await installCajRuntime(onProgress)
  return result
})

// 取消 CAJ 安装
ipcMain.handle('cancel-caj-install', async () => {
  cancelCajInstall()
  return { success: true }
})

// ============================================================
// 右键菜单管理
// ============================================================
ipcMain.handle('register-context-menu', async () => {
  return await registerContextMenu()
})

ipcMain.handle('unregister-context-menu', async () => {
  return await unregisterContextMenu()
})

ipcMain.handle('check-context-menu', async () => {
  return { registered: isContextMenuRegistered() }
})

// ============================================================
// 批量转换
// ============================================================

// 扫描文件夹
ipcMain.handle('scan-folder', async (_event, { folderPath, type, recursive }: { folderPath: string, type: BatchConversionType, recursive?: boolean }) => {
  try {
    const items = scanFolder(folderPath, type, recursive !== false)
    return { success: true, items }
  } catch (err: any) {
    return { success: false, items: [], error: err.message }
  }
})

// 从文件路径列表构建批量任务
ipcMain.handle('build-batch-items', async (_event, { filePaths, type, outputDir }: { filePaths: string[], type: BatchConversionType, outputDir?: string }) => {
  try {
    console.log(`[build-batch-items] 收到 ${filePaths.length} 个路径, type=${type}`)
    filePaths.forEach((p, i) => console.log(`  [${i}] "${p}" (len=${p.length})`))
    const { items, rejected } = buildBatchItemsWithDiagnostics(filePaths, type, outputDir)
    console.log(`[build-batch-items] 结果: ${items.length} 个有效, ${rejected.length} 个被拒`)
    rejected.forEach(r => console.log(`  拒绝: "${r.path}" -> ${r.reason}`))
    return { success: true, items, rejected }
  } catch (err: any) {
    console.error('[build-batch-items] 异常:', err)
    return { success: false, items: [], error: err.message }
  }
})

// 执行批量转换
ipcMain.handle('batch-convert', async (_event, { taskId, items, options }: { taskId: string, items: BatchFileItem[], options: BatchOptions }) => {
  conversionLog('[batch-convert] 开始: items=' + items.length + ', type=' + options.type + ', outputDir=' + (options.outputDir || '同源目录'))
  for (const item of items) {
    conversionLog('[batch-convert] 项目: input=' + item.inputPath + ', output=' + item.outputPath)
  }

  // 提前检查是否需要水印，将水印集成到图片转换管道中
  const limits = getUsageLimits()
  const batchOptions = { ...options, addWatermark: limits.hasWatermark }

  const result = await executeBatchConversion(
    taskId,
    items,
    batchOptions,
    (progress) => {
      if (win) {
        win.webContents.send('batch-progress', progress)
      }
    }
  )

  // 验证所有成功项的输出文件
  for (const item of result.items) {
    if (item.status === 'success') {
      verifyOutputFile(item.outputPath, `batch-convert[${item.filename}]`)
    } else {
      conversionLog('[batch-convert] 项目失败: ' + item.filename + ', status=' + item.status + ', message=' + item.message)
    }
  }

  // 非会员输出自动添加品牌水印
  watermarkCallLog(`batch-convert: success=${result.success}, hasWatermark=${limits.hasWatermark}`)
  if (limits.hasWatermark) {
    // 生成视频水印 PNG（如果批处理中有视频文件）
    let videoWmPng: string | null = null
    for (const item of result.items) {
      if (item.status === 'success' && item.outputPath) {
        const ext = item.outputPath.toLowerCase().split('.').pop() || ''
        if (['mp4', 'avi', 'mkv', 'mov', 'webm', 'flv', 'wmv', 'm4v'].includes(ext)) {
          if (!videoWmPng) {
            videoWmPng = await generateVideoWatermarkPng()
          }
          if (videoWmPng) {
            watermarkCallLog(`batch-convert: adding video watermark to ${item.outputPath}`)
            await addVideoWatermark(item.outputPath, videoWmPng)
            verifyAfterWatermark(item.outputPath, 'batch-convert-video')
          }
        } else {
          // 图片文件如果已在管道中添加水印，跳过后置水印
          if ((item as any).watermarkApplied) {
            watermarkCallLog(`batch-convert: 水印已在管道中添加，跳过: ${item.outputPath}`)
          } else {
            watermarkCallLog(`batch-convert: applying watermark to ${item.outputPath}`)
            await applyWatermarkToFile(item.outputPath)
          }
        }
      }
    }
    // 清理临时水印图片
    if (videoWmPng) {
      try { fs.unlinkSync(videoWmPng) } catch {}
    }
  }

  return result
})

// 取消批量转换
ipcMain.handle('batch-cancel', async (_event, { taskId }: { taskId: string }) => {
  const success = cancelBatchTask(taskId)
  return { success }
})

// ============================================================
// 历史记录持久化
// ============================================================
ipcMain.handle('history-load', async () => {
  return loadHistory()
})

ipcMain.handle('history-save', async (_event, { records }: { records: HistoryRecord[] }) => {
  saveHistory(records)
  return { success: true }
})

ipcMain.handle('history-clear', async () => {
  clearHistory()
  return { success: true }
})

ipcMain.handle('history-delete-item', async (_event, { id }: { id: string }) => {
  const remaining = deleteHistoryItem(id)
  return { success: true, remaining }
})

// ============================================================
// 应用设置持久化
// ============================================================
ipcMain.handle('settings-load', async () => {
  return loadSettings()
})

ipcMain.handle('settings-save', async (_event, { settings }: { settings: Partial<AppSettings> }) => {
  const updated = saveSettings(settings)
  return { success: true, settings: updated }
})

// ============================================================
// 使用统计
// ============================================================
ipcMain.handle('usage-stats-load', async () => {
  return loadUsageStats()
})

ipcMain.handle('usage-stats-record', async (_event, { type, success, bytesSaved }: { type: string, success: boolean, bytesSaved?: number }) => {
  const stats = recordConversion(type, success, bytesSaved || 0)
  return { success: true, stats }
})

// ============================================================
// 会员系统
// ============================================================
ipcMain.handle('license-activate', async (_event, { code }: { code: string }) => {
  return activateLicense(code)
})

ipcMain.handle('license-deactivate', async () => {
  return deactivateLicense()
})

ipcMain.handle('license-status', async () => {
  return getLicenseStatus()
})

ipcMain.handle('license-limits', async () => {
  return getUsageLimits()
})

ipcMain.handle('license-ocr-check', async () => {
  return checkOcrUsage()
})

ipcMain.handle('license-ocr-increment', async () => {
  incrementOcrUsage()
  return { success: true }
})

// 邀请码系统
ipcMain.handle('referral-get-code', async () => {
  return { code: getMyReferralCode() }
})

ipcMain.handle('referral-activate', async (_event, { code }: { code: string }) => {
  const result = activateWithReferralCode(code)
  // 刷新状态
  return result
})

ipcMain.handle('referral-stats', async () => {
  return getReferralStats()
})

// ============================================================
// 虎皮椒支付
// ============================================================
ipcMain.handle('payment-create-order', async (_event, { tier }: { tier: PaymentTier }) => {
  return createOrder(tier)
})

ipcMain.handle('payment-query-order', async (_event, { tradeOrderId }: { tradeOrderId: string }) => {
  return queryOrder(tradeOrderId)
})

// ============================================================
// 内嵌 Python 运行时管理
// ============================================================

// 检查运行时状态（不含系统 Python 回退，仅内嵌运行时）
ipcMain.handle('check-embedded-python', async () => {
  return checkRuntimeStatus()
})

// 一键安装：下载运行时 + pip install pdf2docx
ipcMain.handle('install-embedded-python', async (_event) => {
  return installPythonRuntime((status) => {
    if (win) {
      win.webContents.send('python-install-progress', status)
    }
  })
})

// 仅安装 pdf2docx（运行时已就绪时）
ipcMain.handle('install-pdf2docx', async (_event) => {
  return installPdf2docxOnly((status) => {
    if (win) {
      win.webContents.send('python-install-progress', status)
    }
  })
})

// 取消安装
ipcMain.handle('cancel-python-install', async () => {
  cancelPythonInstall()
  return { success: true }
})

// ============================================================
// PDF 工具（V0.6）
// ============================================================

// 获取 PDF 信息（页数、文件大小）
ipcMain.handle('get-pdf-info', async (_event, { inputPath }: { inputPath: string }) => {
  try {
    const info = await getPdfInfo(inputPath)
    // 确保返回包含 status 字段的统一格式，与 preload 类型声明一致
    return { status: 'success' as const, pages: info.pages, size: info.size }
  } catch (err: any) {
    return { status: 'error' as const, pages: 0, size: 0, message: err.message || '获取 PDF 信息失败' }
  }
})

// PDF 合并
ipcMain.handle('merge-pdfs', async (_event, { filePaths, outputPath, taskId }: { filePaths: string[], outputPath: string, taskId: string }) => {
  // 如果未指定输出路径，使用第一个文件所在目录
  let finalOutputPath = outputPath
  if (!finalOutputPath && filePaths.length > 0) {
    const firstFile = filePaths[0]
    const dir = firstFile.includes('\\') ? firstFile.slice(0, firstFile.lastIndexOf('\\')) : firstFile.slice(0, firstFile.lastIndexOf('/'))
    finalOutputPath = path.join(dir, '合并文档.pdf')
  }
  conversionLog('[merge-pdfs] 开始: files=' + filePaths.length + ', output=' + finalOutputPath)
  const result = await mergePdfs(filePaths, finalOutputPath, taskId, (current, total, status) => {
    if (win) win.webContents.send('conversion-progress', { taskId, progress: Math.round((current / total) * 100) })
  })

  if (result.status === 'success' && result.output) {
    verifyOutputFile(result.output, 'merge-pdfs')
  } else {
    conversionLog('[merge-pdfs] 失败: ' + result.message)
  }

  // 非会员输出自动添加品牌水印
  if (result.status === 'success' && result.output) {
    const limits = getUsageLimits()
    if (limits.hasWatermark) {
      await applyWatermarkToFile(result.output)
    }
  }

  return result
})

// PDF 拆分
ipcMain.handle('split-pdf', async (_event, { inputPath, outputDir, taskId, mode, options }: { inputPath: string, outputDir: string, taskId: string, mode: string, options?: any }) => {
  // 如果未指定输出目录，使用源文件所在目录
  let finalOutputDir = outputDir
  if (!finalOutputDir && inputPath) {
    finalOutputDir = inputPath.includes('\\') ? inputPath.slice(0, inputPath.lastIndexOf('\\')) : inputPath.slice(0, inputPath.lastIndexOf('/'))
  }
  conversionLog('[split-pdf] 开始: input=' + inputPath + ', outputDir=' + finalOutputDir + ', mode=' + mode)
  const result = await splitPdf(inputPath, finalOutputDir, taskId, mode as any, options, (current, total) => {
    if (win) win.webContents.send('conversion-progress', { taskId, progress: Math.round((current / total) * 100) })
  })

  if (result.status === 'success' && result.items) {
    for (const item of result.items) {
      verifyOutputFile(item.output, `split-pdf[${item.output}]`)
    }
  } else {
    conversionLog('[split-pdf] 失败: ' + result.message)
  }

  // 非会员输出自动添加品牌水印
  if (result.status === 'success' && result.items) {
    const limits = getUsageLimits()
    if (limits.hasWatermark) {
      for (const item of result.items) {
        if (item.output) {
          await applyWatermarkToFile(item.output)
        }
      }
    }
  }

  return result
})

// PDF 转图片
ipcMain.handle('pdf-to-images', async (_event, { inputPath, outputDir, taskId, options }: { inputPath: string, outputDir: string, taskId: string, options?: any }) => {
  conversionLog('[pdf-to-images] 开始: input=' + inputPath + ', outputDir=' + outputDir)
  const result = await pdfToImages(inputPath, outputDir, taskId, options, (current, total) => {
    if (win) win.webContents.send('conversion-progress', { taskId, progress: Math.round((current / total) * 100) })
  }, createHiddenWindow)

  if (result.status === 'success' && result.items) {
    for (const item of result.items) {
      verifyOutputFile(item.output, `pdf-to-images[page ${item.page}]`)
    }
  } else {
    conversionLog('[pdf-to-images] 失败: ' + result.message)
  }

  // 非会员输出自动添加品牌水印
  if (result.status === 'success' && result.items) {
    const limits = getUsageLimits()
    if (limits.hasWatermark) {
      for (const item of result.items) {
        if (item.output) {
          await applyWatermarkToFile(item.output)
        }
      }
    }
  }

  return result
})

// PDF 加密
ipcMain.handle('encrypt-pdf', async (_event, { inputPath, outputPath, password, ownerPassword }: { inputPath: string, outputPath: string, password: string, ownerPassword?: string }) => {
  conversionLog('[encrypt-pdf] 开始: input=' + inputPath + ', output=' + outputPath)

  // 非会员：先添加水印再加密（加密后无法修改 PDF 内容）
  const limits = getUsageLimits()
  let encryptInput = inputPath
  if (limits.hasWatermark) {
    const tempWmPath = path.join(os.tmpdir(), `yizhuan-encrypt-wm-${Date.now()}.pdf`)
    fs.copyFileSync(inputPath, tempWmPath)
    await applyWatermarkToFile(tempWmPath)
    encryptInput = tempWmPath
  }

  let result: { status: string; output?: string; size?: number; message?: string } = { status: 'error', message: '' }

  // === 阶段 1：确保 PyMuPDF 已安装 ===
  conversionLog('[encrypt-pdf] 检查 PyMuPDF 环境...')
  const pymupdfStatus = await ensurePyMuPDFReady()
  if (pymupdfStatus.ready) {
    // === 阶段 2：使用 Python (PyMuPDF) 作为首选加密方案 ===
    conversionLog('[encrypt-pdf] 使用 Python (PyMuPDF) 加密')
    try {
      const pythonExe = getPythonExe()
      const scriptPath = getPythonScript('convert_pdf.py')
      const ownerPwd = ownerPassword || password
      const args = [scriptPath, 'encrypt', encryptInput, outputPath, password, ownerPwd]

      const pyResult = await new Promise<{ status: string; output?: string; message?: string }>((resolve) => {
        const proc = spawn(pythonExe, args, {
          shell: false,
          cwd: process.cwd(),
          env: getPythonEnv(),
          windowsHide: true,
        })
        let stdout = ''
        let stderr = ''
        proc.stdout.on('data', (data) => { stdout += data.toString('utf-8') })
        proc.stderr.on('data', (data) => { stderr += data.toString('utf-8') })
        proc.on('close', (code) => {
          if (code === 0) {
            try {
              const lines = stdout.trim().split('\n')
              const jsonLine = lines.find(l => { try { JSON.parse(l); return true } catch { return false } })
              if (jsonLine) {
                const parsed = JSON.parse(jsonLine)
                parsed.output = outputPath
                resolve(parsed)
              } else {
                resolve({ status: 'success', output: outputPath, message: 'PDF 加密成功（PyMuPDF）' })
              }
            } catch {
              resolve({ status: 'success', output: outputPath, message: 'PDF 加密成功（PyMuPDF）' })
            }
          } else {
            resolve({ status: 'error', message: `Python 加密失败: ${stderr || stdout || '进程退出码 ' + code}` })
          }
        })
        proc.on('error', (err) => {
          resolve({ status: 'error', message: `Python 加密异常: ${err.message}` })
        })
      })

      if (pyResult.status === 'success' && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        result = {
          status: 'success',
          output: outputPath,
          size: fs.statSync(outputPath).size,
          message: pyResult.message || 'PDF 加密成功（PyMuPDF）'
        }
        conversionLog('[encrypt-pdf] Python (PyMuPDF) 加密成功')
      } else {
        conversionLog('[encrypt-pdf] Python 加密失败: ' + (pyResult.message || '未知错误'))
        result = { status: 'error', message: pyResult.message || 'Python 加密失败' }
      }
    } catch (err: any) {
      conversionLog('[encrypt-pdf] Python 加密异常: ' + err.message)
      result = { status: 'error', message: err.message }
    }
  } else {
    conversionLog('[encrypt-pdf] PyMuPDF 不可用: ' + (pymupdfStatus.error || ''))
  }

  // === 阶段 3：Python 失败时，回退到 mutool ===
  if (result.status !== 'success') {
    conversionLog('[encrypt-pdf] 尝试 mutool 回退方案...')
    try {
      const mutoolResult = await encryptPdf(encryptInput, outputPath, password, ownerPassword)
      if (mutoolResult.status === 'success') {
        result = mutoolResult
        conversionLog('[encrypt-pdf] mutool 加密成功')
      } else {
        conversionLog('[encrypt-pdf] mutool 加密也失败: ' + mutoolResult.message)
      }
    } catch (err: any) {
      conversionLog('[encrypt-pdf] mutool 回退异常: ' + err.message)
    }
  }

  // 清理临时水印文件
  if (encryptInput !== inputPath) {
    try { fs.unlinkSync(encryptInput) } catch {}
  }

  // === 阶段 4：最终验证 ===
  // 即使加密函数报告失败，检查输出文件是否实际已生成且有效
  if (result.status !== 'success' && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100) {
    try {
      const verifyBytes = fs.readFileSync(outputPath)
      await PDFDocument.load(verifyBytes, { ignoreEncryption: false })
      // 如果能无密码加载，说明文件未加密，不覆盖成功状态
    } catch (loadErr: any) {
      const errMsg = String(loadErr?.message || '')
      if (errMsg.includes('encrypt') || errMsg.includes('password') || errMsg.includes('Password') || errMsg.includes('Encrypt')) {
        conversionLog('[encrypt-pdf] 最终验证通过：文件已加密（需要密码才能打开）')
        result = {
          status: 'success',
          output: outputPath,
          size: fs.statSync(outputPath).size,
          message: 'PDF 加密成功'
        }
      }
    }
  }

  if (result.status === 'success') {
    verifyOutputFile(result.output!, 'encrypt-pdf')
  } else {
    const errMsg = result.message || '未知错误'
    conversionLog('[encrypt-pdf] 失败: ' + errMsg)
    result.message = errMsg.includes('PyMuPDF') || errMsg.includes('mutool')
      ? `加密失败：${pymupdfStatus.ready ? 'PyMuPDF 和 mutool 均无法完成加密' : '加密组件未就绪，请稍后重试'}`
      : errMsg
  }
  return result
})

// PDF 解密
ipcMain.handle('decrypt-pdf', async (_event, { inputPath, outputPath, password }: { inputPath: string, outputPath: string, password: string }) => {
  conversionLog('[decrypt-pdf] 开始: input=' + inputPath + ', output=' + outputPath)
  let result: { status: string; output?: string; size?: number; message?: string } = { status: 'error', message: '' }

  // === 阶段 1：确保 PyMuPDF 已安装 ===
  conversionLog('[decrypt-pdf] 检查 PyMuPDF 环境...')
  const pymupdfStatus = await ensurePyMuPDFReady()
  if (pymupdfStatus.ready) {
    // === 阶段 2：使用 Python (PyMuPDF) 作为首选解密方案 ===
    conversionLog('[decrypt-pdf] 使用 Python (PyMuPDF) 解密')
    try {
      const pythonExe = getPythonExe()
      const scriptPath = getPythonScript('convert_pdf.py')
      const args = [scriptPath, 'decrypt', inputPath, outputPath, password]

      const pyResult = await new Promise<{ status: string; output?: string; message?: string }>((resolve) => {
        const proc = spawn(pythonExe, args, {
          shell: false,
          cwd: process.cwd(),
          env: getPythonEnv(),
          windowsHide: true,
        })
        let stdout = ''
        let stderr = ''
        proc.stdout.on('data', (data) => { stdout += data.toString('utf-8') })
        proc.stderr.on('data', (data) => { stderr += data.toString('utf-8') })
        proc.on('close', (code) => {
          if (code === 0) {
            try {
              const lines = stdout.trim().split('\n')
              const jsonLine = lines.find(l => { try { JSON.parse(l); return true } catch { return false } })
              if (jsonLine) {
                const parsed = JSON.parse(jsonLine)
                parsed.output = outputPath
                resolve(parsed)
              } else {
                resolve({ status: 'success', output: outputPath, message: 'PDF 解密成功（PyMuPDF）' })
              }
            } catch {
              resolve({ status: 'success', output: outputPath, message: 'PDF 解密成功（PyMuPDF）' })
            }
          } else {
            resolve({ status: 'error', message: `Python 解密失败: ${stderr || stdout || '进程退出码 ' + code}` })
          }
        })
        proc.on('error', (err) => {
          resolve({ status: 'error', message: `Python 解密异常: ${err.message}` })
        })
      })

      if (pyResult.status === 'success' && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        result = {
          status: 'success',
          output: outputPath,
          size: fs.statSync(outputPath).size,
          message: pyResult.message || 'PDF 解密成功（PyMuPDF）'
        }
        conversionLog('[decrypt-pdf] Python (PyMuPDF) 解密成功')
      } else {
        conversionLog('[decrypt-pdf] Python 解密失败: ' + (pyResult.message || '未知错误'))
        result = { status: 'error', message: pyResult.message || 'Python 解密失败' }
      }
    } catch (err: any) {
      conversionLog('[decrypt-pdf] Python 解密异常: ' + err.message)
      result = { status: 'error', message: err.message }
    }
  } else {
    conversionLog('[decrypt-pdf] PyMuPDF 不可用: ' + (pymupdfStatus.error || ''))
  }

  // === 阶段 3：Python 失败时，回退到 pdf-lib/mutool ===
  if (result.status !== 'success') {
    conversionLog('[decrypt-pdf] 尝试 pdf-lib/mutool 回退方案...')
    try {
      const fallbackResult = await decryptPdf(inputPath, outputPath, password)
      if (fallbackResult.status === 'success') {
        result = fallbackResult
        conversionLog('[decrypt-pdf] pdf-lib/mutool 解密成功')
      } else {
        conversionLog('[decrypt-pdf] pdf-lib/mutool 解密也失败: ' + fallbackResult.message)
      }
    } catch (err: any) {
      conversionLog('[decrypt-pdf] pdf-lib/mutool 回退异常: ' + err.message)
    }
  }

  // === 阶段 4：最终验证 ===
  // 即使解密函数报告失败，检查输出文件是否实际已生成且可无密码打开
  if (result.status !== 'success' && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100) {
    try {
      const verifyBytes = fs.readFileSync(outputPath)
      await PDFDocument.load(verifyBytes, { ignoreEncryption: false })
      // 能无密码加载说明文件已解密成功
      conversionLog('[decrypt-pdf] 最终验证通过：文件已解密（可无密码打开）')
      result = {
        status: 'success',
        output: outputPath,
        size: fs.statSync(outputPath).size,
        message: 'PDF 解密成功'
      }
    } catch {
      // 文件仍然加密，说明解密确实失败
    }
  }

  if (result.status === 'success') {
    verifyOutputFile(result.output!, 'decrypt-pdf')
  } else {
    const errMsg = result.message || '未知错误'
    conversionLog('[decrypt-pdf] 失败: ' + errMsg)
    result.message = errMsg.includes('密码错误')
      ? errMsg
      : `解密失败：${pymupdfStatus.ready ? '请检查密码是否正确' : '解密组件未就绪，请稍后重试'}`
  }
  return result
})

// PDF 压缩
ipcMain.handle('compress-pdf', async (_event, { inputPath, outputPath, level }: { inputPath: string, outputPath: string, level?: 'low' | 'medium' | 'high' }) => {
  conversionLog('[compress-pdf] 开始: input=' + inputPath + ', output=' + outputPath + ', level=' + (level || 'medium'))
  const result = await compressPdf(inputPath, outputPath, level || 'medium')
  if (result.status === 'success') {
    verifyOutputFile(result.output!, 'compress-pdf')

    // 非会员输出自动添加品牌水印
    const limits = getUsageLimits()
    if (limits.hasWatermark) {
      watermarkCallLog(`compress-pdf: adding watermark to ${result.output}`)
      await applyWatermarkToFile(result.output!)
      verifyAfterWatermark(result.output!, 'compress-pdf')
    }
  } else {
    conversionLog('[compress-pdf] 失败: ' + result.message)
  }
  return result
})

// HTML 转 PDF
ipcMain.handle('html-to-pdf', async (_event, { htmlContent, outputPath, taskId }: { htmlContent: string, outputPath: string, taskId: string }) => {
  // 处理相对路径：如果 outputPath 是相对路径，保存到下载目录
  let finalOutputPath = outputPath
  if (!path.isAbsolute(outputPath)) {
    const downloadDir = app.getPath('downloads')
    finalOutputPath = path.join(downloadDir, outputPath)
    conversionLog('[html-to-pdf] 相对路径转为绝对路径: ' + finalOutputPath)
  }
  conversionLog('[html-to-pdf] 开始: outputPath=' + finalOutputPath + ', contentLength=' + htmlContent.length)
  const result = await htmlToPdf(htmlContent, finalOutputPath, taskId, createHiddenWindow)

  // 将实际保存的绝对路径返回给前端
  if (result.status === 'success' && result.output) {
    result.output = finalOutputPath
    verifyOutputFile(finalOutputPath, 'html-to-pdf')
  } else {
    conversionLog('[html-to-pdf] 失败: ' + result.message)
  }

  // 非会员输出自动添加品牌水印
  if (result.status === 'success' && result.output) {
    const limits = getUsageLimits()
    if (limits.hasWatermark) {
      await applyWatermarkToFile(finalOutputPath)
    }
  }

  return result
})

// Markdown 转 PDF
ipcMain.handle('markdown-to-pdf', async (_event, { content, outputPath, taskId }: { content: string, outputPath: string, taskId: string }) => {
  // 处理相对路径：如果 outputPath 是相对路径，保存到下载目录
  let finalOutputPath = outputPath
  if (!path.isAbsolute(outputPath)) {
    const downloadDir = app.getPath('downloads')
    finalOutputPath = path.join(downloadDir, outputPath)
    conversionLog('[markdown-to-pdf] 相对路径转为绝对路径: ' + finalOutputPath)
  }
  conversionLog('[markdown-to-pdf] 开始: outputPath=' + finalOutputPath + ', contentLength=' + content.length)
  const result = await markdownToPdf(content, finalOutputPath, taskId, createHiddenWindow)

  // 将实际保存的绝对路径返回给前端
  if (result.status === 'success' && result.output) {
    result.output = finalOutputPath
    verifyOutputFile(finalOutputPath, 'markdown-to-pdf')
  } else {
    conversionLog('[markdown-to-pdf] 失败: ' + result.message)
  }

  // 非会员输出自动添加品牌水印
  if (result.status === 'success' && result.output) {
    const limits = getUsageLimits()
    if (limits.hasWatermark) {
      await applyWatermarkToFile(finalOutputPath)
    }
  }

  return result
})

// ============================================================
// 图片压缩（V0.6）
// ============================================================

// 单张图片压缩
ipcMain.handle('compress-image', async (_event, { inputPath, outputPath, taskId, options }: { inputPath: string, outputPath: string, taskId: string, options: any }) => {
  // 非会员在压缩时同时添加水印（集成到压缩管道中，避免 PNG 加水印后变大）
  const limits = getUsageLimits()
  if (limits.hasWatermark) {
    options = { ...options, addWatermark: true }
  }
  const result = await compressImage(inputPath, outputPath, taskId, options)
  return result
})

// 批量图片压缩
ipcMain.handle('batch-compress-images', async (_event, { items, taskId, options }: { items: Array<{ inputPath: string, outputPath: string }>, taskId: string, options: any }) => {
  // 非会员在压缩时同时添加水印
  const limits = getUsageLimits()
  if (limits.hasWatermark) {
    options = { ...options, addWatermark: true }
  }
  const results = await batchCompressImages(items, taskId, options, (current, total) => {
    if (win) win.webContents.send('conversion-progress', { taskId, progress: Math.round((current / total) * 100) })
  })
  return results
})

// 图片转 HTML/MD
ipcMain.handle('image-to-html', async (_event, { inputPath, outputPath, taskId, options }) => {
  // 非会员：先给图片添加水印，再转为 HTML/MD
  const limits = getUsageLimits()
  if (limits.hasWatermark) {
    // 创建临时水印图片副本
    const tempWmPath = inputPath + '.wm_tmp_' + Date.now()
    try {
      fs.copyFileSync(inputPath, tempWmPath)
      await applyWatermarkToFile(tempWmPath)
      const result = await imageToHtml(tempWmPath, outputPath, taskId, options)
      // 清理临时文件
      try { fs.unlinkSync(tempWmPath) } catch {}
      // 同时给输出的 HTML/MD 文件添加 CSS/文字水印
      if (result.status === 'success' && result.output) {
        await applyWatermarkToFile(result.output)
      }
      return result
    } catch (err) {
      // 水印添加失败，回退到无水印转换
      try { if (fs.existsSync(tempWmPath)) fs.unlinkSync(tempWmPath) } catch {}
      const result = await imageToHtml(inputPath, outputPath, taskId, options)
      // 即使图片水印失败，也给输出文件加水印
      if (result.status === 'success' && result.output) {
        await applyWatermarkToFile(result.output)
      }
      return result
    }
  }
  return imageToHtml(inputPath, outputPath, taskId, options)
})

// ============================================================
// 自动更新检查
// ============================================================

// 版本信息 JSON 地址（用户后期在此 URL 放置一个 JSON 文件即可实现更新提示）
// JSON 格式：{ "latestVersion": "0.7.0", "downloadUrl": "https://xxx/YiZhuan-Setup-0.7.0.exe", "releaseNotes": "更新内容" }
const UPDATE_CHECK_URL = 'https://raw.githubusercontent.com/yizhuan/yizhuan-app/main/update.json'

interface UpdateCheckResult {
  hasUpdate: boolean
  latestVersion: string
  currentVersion: string
  downloadUrl: string
  releaseNotes: string
  releasePage: string
}

ipcMain.handle('check-for-updates', async (): Promise<UpdateCheckResult> => {
  const currentVersion = app.getVersion()

  try {
    // 方式1：从 JSON URL 获取版本信息（简单灵活，支持任意静态文件托管）
    const response = await fetch(UPDATE_CHECK_URL, {
      headers: { 'User-Agent': 'YiZhuan-App' },
      signal: AbortSignal.timeout(8000),
    })

    if (!response.ok) {
      throw new Error(`版本检查服务返回 ${response.status}`)
    }

    const data = await response.json() as any

    const latestVersion = (data.latestVersion || data.version || '').replace(/^v/, '')
    const downloadUrl = data.downloadUrl || data.downloadUrl || ''
    const releaseNotes = data.releaseNotes || data.notes || ''
    const releasePage = data.releasePage || data.url || downloadUrl

    if (!latestVersion) {
      throw new Error('版本信息格式错误')
    }

    // 比较版本号
    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0

    return {
      hasUpdate,
      latestVersion,
      currentVersion,
      downloadUrl,
      releaseNotes,
      releasePage,
    }
  } catch {
    // 如果 JSON URL 不可用，返回无更新（静默失败）
    return {
      hasUpdate: false,
      latestVersion: currentVersion,
      currentVersion,
      downloadUrl: '',
      releaseNotes: '',
      releasePage: '',
    }
  }
})

ipcMain.handle('open-download-page', async (_event, { url }: { url: string }) => {
  if (url) {
    shell.openExternal(url)
  }
  return { success: true }
})

/**
 * 比较语义化版本号
 * @returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number)
  const parts2 = v2.split('.').map(Number)
  const maxLen = Math.max(parts1.length, parts2.length)

  for (let i = 0; i < maxLen; i++) {
    const p1 = parts1[i] || 0
    const p2 = parts2[i] || 0
    if (p1 > p2) return 1
    if (p1 < p2) return -1
  }
  return 0
}

// ============================================================
// 系统通知
// ============================================================
ipcMain.handle('show-notification', async (_event, { title, body, silent }: { title: string, body?: string, silent?: boolean }) => {
  try {
    if (!Notification.isSupported()) {
      return { success: false, error: '系统不支持通知' }
    }

    const notification = new Notification({
      title: title || '易转',
      body: body || '',
      silent: silent || false,
      icon: path.join(__dirname, '../../build/icon.ico'),
    })

    // 点击通知时显示窗口
    notification.on('click', () => {
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    })

    notification.show()
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// ============================================================
// 全局快捷键管理
// ============================================================
ipcMain.handle('register-shortcuts', async () => {
  try {
    unregisterGlobalShortcuts()
    registerGlobalShortcuts()
    const yRegistered = globalShortcut.isRegistered('CommandOrControl+Shift+Y')
    const sRegistered = globalShortcut.isRegistered('CommandOrControl+Shift+S')
    return { success: true, yRegistered, sRegistered }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('unregister-shortcuts', async () => {
  try {
    unregisterGlobalShortcuts()
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('check-shortcuts-registered', async () => {
  try {
    return {
      yRegistered: globalShortcut.isRegistered('CommandOrControl+Shift+Y'),
      sRegistered: globalShortcut.isRegistered('CommandOrControl+Shift+S'),
    }
  } catch {
    return { yRegistered: false, sRegistered: false }
  }
})
