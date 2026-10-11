/**
 * Python 运行时管理模块
 * - 自动下载 python-build-standalone 运行时到 userData
 * - 自动 pip install pdf2docx 依赖
 * - 提供运行时状态查询和进度回调
 */
import { app } from 'electron'
import { join, dirname } from 'path'
import { spawn } from 'child_process'
import fs from 'fs'
import { createWriteStream } from 'fs'
import https from 'https'
import http from 'http'

// python-build-standalone 下载配置
// 使用 Python 3.10（稳定版），pdf2docx 兼容 3.9+
const PYTHON_VERSION = '3.10.20'
const PYTHON_BUILD_DATE = '20260728'
const PYTHON_ARCHIVE_NAME = `cpython-${PYTHON_VERSION}+${PYTHON_BUILD_DATE}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`
const PYTHON_GITHUB_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD_DATE}/${PYTHON_ARCHIVE_NAME}`
// 备用版本（使用更早的构建日期，以防最新版本下载失败）
const PYTHON_FALLBACK_VERSION = '3.10.20'
const PYTHON_FALLBACK_BUILD_DATE = '20260718'
const PYTHON_FALLBACK_ARCHIVE_NAME = `cpython-${PYTHON_FALLBACK_VERSION}+${PYTHON_FALLBACK_BUILD_DATE}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`
const PYTHON_FALLBACK_GITHUB_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_FALLBACK_BUILD_DATE}/${PYTHON_FALLBACK_ARCHIVE_NAME}`

// GitHub 代理镜像列表（国内加速，按优先级排序）
const GITHUB_MIRROR_PREFIXES = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
  '',  // 空字符串表示直连 GitHub
]

/**
 * 为给定的 GitHub 下载 URL 生成所有镜像 URL 列表
 * 注意：镜像代理可能将 URL 中的 + 解析为空格，需要编码为 %2B
 */
function getMirroredUrls(githubUrl: string): string[] {
  return GITHUB_MIRROR_PREFIXES.map(prefix => {
    if (prefix === '') return githubUrl  // 直连不编码
    // 镜像代理：将 + 编码为 %2B，防止被解析为空格
    return prefix + githubUrl.replace(/\+/g, '%2B')
  })
}

// 存储在 userData 中的路径
function getRuntimeDir(): string {
  return join(app.getPath('userData'), 'python-runtime')
}

/**
 * 获取内嵌 Python 运行时目录
 * 优先检查当前 userData 路径，如果不存在则检查可能的旧路径
 * （打包后 productName="易转" 但开发时 name="yizhuan-app"，两个 userData 目录可能不同）
 */
function findExistingRuntimeDir(): string | null {
  const currentDir = getRuntimeDir()
  if (fs.existsSync(join(currentDir, 'python.exe'))) {
    return currentDir
  }

  // 检查可能的旧 userData 路径（开发模式 vs 打包模式）
  const appData = app.getPath('appData')
  const possibleDirs = [
    join(appData, 'yizhuan-app', 'python-runtime'),  // 开发模式 name
    join(appData, '易转', 'python-runtime'),           // 打包模式 productName
  ]

  for (const dir of possibleDirs) {
    if (dir !== currentDir && fs.existsSync(join(dir, 'python.exe'))) {
      return dir
    }
  }

  return null
}

function getPythonExePath(): string {
  // 优先使用当前 userData 中的运行时
  const currentPath = join(getRuntimeDir(), 'python.exe')
  if (fs.existsSync(currentPath)) return currentPath

  // 检查旧路径中是否存在已安装的运行时
  const existingDir = findExistingRuntimeDir()
  if (existingDir) return join(existingDir, 'python.exe')

  return currentPath  // 返回默认路径（即使不存在，由调用方处理）
}

function getPipExePath(): string {
  // 优先检查当前 runtime 目录
  const currentPip = join(getRuntimeDir(), 'Scripts', 'pip.exe')
  if (fs.existsSync(currentPip)) return currentPip

  // 检查旧路径中的 pip（与 getPythonExePath 逻辑一致）
  const existingDir = findExistingRuntimeDir()
  if (existingDir) {
    const oldPip = join(existingDir, 'Scripts', 'pip.exe')
    if (fs.existsSync(oldPip)) return oldPip
  }

  return currentPip  // 返回默认路径（即使不存在，由调用方处理）
}

// 状态文件路径（记录安装进度）
function getStatusFilePath(): string {
  // 优先使用当前 runtime 目录，但如果运行时在旧路径中，使用旧路径的状态文件
  const existingDir = findExistingRuntimeDir()
  if (existingDir) return join(existingDir, '.install-status.json')
  return join(getRuntimeDir(), '.install-status.json')
}

export interface PythonRuntimeStatus {
  /** Python 可执行文件路径 */
  pythonPath: string | null
  /** Python 运行时是否已就绪 */
  pythonReady: boolean
  /** pdf2docx 是否已安装 */
  pdf2docxReady: boolean
  /** 是否正在下载/安装中 */
  busy: boolean
  /** 当前阶段描述 */
  phase: string | null
  /** 下载/安装进度 0-100 */
  progress: number
  /** 当前重试次数 */
  retryCount?: number
}

export type ProgressCallback = (status: Partial<PythonRuntimeStatus>) => void

interface InstallStatus {
  /** 运行时下载是否完成 */
  runtimeDownloaded: boolean
  /** pdf2docx 是否已安装 */
  pdf2docxInstalled: boolean
  /** 归档文件 SHA256（用于校验） */
  archiveHash: string | null
}

function readInstallStatus(): InstallStatus {
  try {
    const data = fs.readFileSync(getStatusFilePath(), 'utf-8')
    return JSON.parse(data)
  } catch {
    return { runtimeDownloaded: false, pdf2docxInstalled: false, archiveHash: null }
  }
}

function writeInstallStatus(status: InstallStatus): void {
  const dir = dirname(getStatusFilePath())
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(getStatusFilePath(), JSON.stringify(status, null, 2))
}

/**
 * 检查当前 Python 运行时状态（不触发安装）
 */
export function checkRuntimeStatus(): PythonRuntimeStatus {
  const pythonExe = getPythonExePath()
  const pythonReady = fs.existsSync(pythonExe)

  const installStatus = readInstallStatus()

  return {
    pythonPath: pythonReady ? pythonExe : null,
    pythonReady,
    pdf2docxReady: installStatus.pdf2docxInstalled && pythonReady,
    busy: false,
    phase: null,
    progress: pythonReady ? (installStatus.pdf2docxInstalled ? 100 : 50) : 0,
  }
}

/**
 * 获取 Python 可执行文件路径
 * 优先使用内嵌运行时，其次使用系统 Python
 */
export function getEmbeddedPythonExe(): string {
  const embedded = getPythonExePath()
  if (fs.existsSync(embedded)) return embedded
  return 'python'
}

/**
 * 安装 Python 运行时和依赖（带进度回调）
 * - 下载 python-build-standalone 压缩包
 * - 解压到 userData/python-runtime
 * - pip install pdf2docx
 */
export async function installPythonRuntime(onProgress?: ProgressCallback): Promise<{ success: boolean, error?: string }> {
  const runtimeDir = getRuntimeDir()
  const archivePath = join(runtimeDir, 'python-archive.tar.gz')

  // 确保运行时目录存在
  if (!fs.existsSync(runtimeDir)) {
    fs.mkdirSync(runtimeDir, { recursive: true })
  }

  const report = (partial: Partial<PythonRuntimeStatus>) => {
    onProgress?.({ busy: true, ...partial })
  }

  try {
    // === 阶段 1：下载 Python 运行时 ===
    report({ phase: 'download-runtime', progress: 0 })

    // 为每个版本生成镜像 URL 列表（国内代理优先，GitHub 直连兜底）
    const mirrorNames = ['ghfast镜像', 'gh-proxy镜像', 'ghproxy.net镜像', 'GitHub直连']
    const downloadUrls: Array<{ url: string; label: string }> = [
      ...getMirroredUrls(PYTHON_GITHUB_URL).map((url, i) => ({
        url,
        label: `Python ${PYTHON_VERSION} (${mirrorNames[i] || `源${i + 1}`})`,
      })),
      ...getMirroredUrls(PYTHON_FALLBACK_GITHUB_URL).map((url, i) => ({
        url,
        label: `Python ${PYTHON_FALLBACK_VERSION} (${mirrorNames[i] || `源${i + 1}`})`,
      })),
    ]

    let downloadSuccess = false
    let lastError = ''
    for (const { url, label } of downloadUrls) {
      try {
        console.log(`[python-runtime] 尝试下载: ${label}`)
        await downloadFile(url, archivePath, (downloaded, total, retryCount) => {
          const pct = total > 0 ? Math.round((downloaded / total) * 60) : 0
          report({ progress: pct, phase: 'download-runtime', retryCount })
        })
        downloadSuccess = true
        console.log(`[python-runtime] 下载成功: ${label}`)
        break
      } catch (err: any) {
        lastError = err.message || '下载失败'
        // 清理不完整的下载文件
        try { if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath) } catch { /* ignore */ }
        console.log(`[python-runtime] ${label} 失败: ${lastError}，尝试下一个源...`)
        report({ phase: 'download-runtime', progress: 0 })
      }
    }

    if (!downloadSuccess) {
      return { success: false, error: `Python 运行时下载失败（已尝试所有镜像源）: ${lastError}。请检查网络连接后重试` }
    }

    // === 阶段 2：解压 ===
    report({ phase: 'extracting', progress: 60 })

    await extractTarGz(archivePath, runtimeDir)

    // 清理压缩包
    try { fs.unlinkSync(archivePath) } catch { /* ignore */ }

    // 验证解压结果
    const pythonExe = getPythonExePath()
    if (!fs.existsSync(pythonExe)) {
      return { success: false, error: 'Python 运行时解压后未找到 python.exe' }
    }

    writeInstallStatus({ ...readInstallStatus(), runtimeDownloaded: true })

    // === 阶段 3：pip install pdf2docx ===
    report({ phase: 'installing-pdf2docx', progress: 65 })

    const pipResult = await pipInstall('pdf2docx', (output) => {
      // 解析 pip 输出提取进度
      const match = output.match(/(\d+)%/)
      if (match) {
        const pct = 65 + Math.round(parseInt(match[1]) * 0.3) // pip 占 30%
        report({ progress: Math.min(pct, 95), phase: 'installing-pdf2docx' })
      }
    })

    if (!pipResult.success) {
      return { success: false, error: `pdf2docx 安装失败: ${pipResult.error}` }
    }

    writeInstallStatus({ ...readInstallStatus(), pdf2docxInstalled: true })

    // === 阶段 4：验证 ===
    report({ phase: 'verifying', progress: 95 })

    const verifyResult = await verifyPdf2docx()
    if (!verifyResult) {
      return { success: false, error: 'pdf2docx 安装验证失败' }
    }

    report({ phase: null, progress: 100, pythonReady: true, pdf2docxReady: true, busy: false })

    return { success: true }
  } catch (err: any) {
    // 清理可能不完整的下载
    try { if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath) } catch { /* ignore */ }
    return { success: false, error: err.message || '未知错误' }
  }
}

/**
 * 仅安装 pdf2docx（当运行时已就绪但依赖缺失时）
 */
export async function installPdf2docxOnly(onProgress?: ProgressCallback): Promise<{ success: boolean, error?: string }> {
  const pythonExe = getPythonExePath()
  if (!fs.existsSync(pythonExe)) {
    return { success: false, error: 'Python 运行时未安装' }
  }

  onProgress?.({ busy: true, phase: 'installing-pdf2docx', progress: 0 })

  const pipResult = await pipInstall('pdf2docx', (output) => {
    const match = output.match(/(\d+)%/)
    if (match) {
      onProgress?.({ progress: Math.round(parseInt(match[1])) })
    }
  })

  if (!pipResult.success) {
    onProgress?.({ busy: false, phase: null, progress: 0 })
    return { success: false, error: `pdf2docx 安装失败: ${pipResult.error}` }
  }

  writeInstallStatus({ ...readInstallStatus(), pdf2docxInstalled: true })

  onProgress?.({ busy: false, phase: null, progress: 100, pdf2docxReady: true })

  return { success: true }
}

// ============================================================
// 内部工具函数
// ============================================================

/**
 * 下载文件（支持 HTTPS + 重定向 + 断点续传 + 自动重试），带进度回调
 *
 * 特性：
 * - 断点续传：通过 HTTP Range 请求从断点继续下载
 * - 自动重试：最多 2 次重试（每个镜像源），指数退避延迟
 * - 数据空闲超时：30秒无数据即重试，快速检测慢速镜像
 * - 连接超时：30秒无响应即重试
 */
async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (downloaded: number, total: number, retryCount: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const MAX_RETRIES = 2  // 每个镜像源最多重试2次（共3次尝试）
    const DATA_IDLE_TIMEOUT = 30000  // 30秒无数据即超时
    const CONNECT_TIMEOUT = 30000    // 30秒连接超时
    let retryCount = 0
    let lastProgress = 0

    const attemptDownload = () => {
      // 检查是否已有部分下载
      let startBytes = 0
      if (fs.existsSync(destPath)) {
        startBytes = fs.statSync(destPath).size
      }

      let dataIdleTimer: NodeJS.Timeout | null = null
      let currentRequest: any = null

      const clearDataIdleTimer = () => {
        if (dataIdleTimer) {
          clearTimeout(dataIdleTimer)
          dataIdleTimer = null
        }
      }

      const attemptSingle = (targetUrl: string, redirectCount = 0) => {
        if (installCancelled) {
          clearDataIdleTimer()
          reject(new Error('安装已取消'))
          return
        }
        if (redirectCount > 10) {
          tryNextRetry('重定向次数过多')
          return
        }

        const client = targetUrl.startsWith('https') ? https : http

        const options: https.RequestOptions = {
          headers: startBytes > 0 ? { 'Range': `bytes=${startBytes}-` } : {}
        }

        const request = client.get(targetUrl, options, (response) => {
          // 处理重定向
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            attemptSingle(response.headers.location, redirectCount + 1)
            return
          }

          // 断点续传：服务端返回 206 Partial Content
          if (response.statusCode === 206) {
            // Range 请求成功，继续下载
          } else if (response.statusCode === 200) {
            // 服务端不支持 Range，返回完整文件，只能从头下载
            if (startBytes > 0) {
              startBytes = 0
            }
          } else if (response.statusCode === 416) {
            // Range 超出范围，说明文件已经下载完成
            clearDataIdleTimer()
            resolve()
            return
          } else {
            tryNextRetry(`下载失败: HTTP ${response.statusCode}`)
            return
          }

          const contentLength = parseInt(response.headers['content-length'] || '0', 10)
          const total = contentLength + startBytes
          let downloaded = startBytes

          const fileStream = createWriteStream(destPath, { flags: startBytes > 0 ? 'a' : 'w' })

          // 启动数据空闲计时器
          const startDataIdleTimer = () => {
            clearDataIdleTimer()
            dataIdleTimer = setTimeout(() => {
              currentRequest?.destroy()
              tryNextRetry(`数据空闲超时（${DATA_IDLE_TIMEOUT / 1000}秒无数据），镜像源响应过慢`)
            }, DATA_IDLE_TIMEOUT)
          }
          startDataIdleTimer()

          response.on('data', (chunk: Buffer) => {
            // 收到数据，重置空闲计时器
            startDataIdleTimer()
            downloaded += chunk.length
            lastProgress = downloaded
            onProgress?.(downloaded, total, retryCount)
          })

          fileStream.on('finish', () => {
            clearDataIdleTimer()
            fileStream.close()
            // 验证完整性（允许 1 字节误差）
            if (total > 0 && downloaded < total - 1) {
              tryNextRetry('下载不完整')
              return
            }
            resolve()
          })

          fileStream.on('error', (err) => {
            clearDataIdleTimer()
            tryNextRetry(`文件写入错误: ${err.message}`)
          })

          response.pipe(fileStream)
        })

        currentRequest = request

        request.on('error', (err) => {
          clearDataIdleTimer()
          tryNextRetry(`网络错误: ${err.message}`)
        })

        // 连接超时：30秒无响应即触发重试
        request.setTimeout(CONNECT_TIMEOUT, () => {
          clearDataIdleTimer()
          request.destroy()
          tryNextRetry(`连接超时（${CONNECT_TIMEOUT / 1000}秒无响应）`)
        })
      }

      const tryNextRetry = (reason: string) => {
        clearDataIdleTimer()
        if (installCancelled) {
          reject(new Error('安装已取消'))
          return
        }
        if (retryCount >= MAX_RETRIES) {
          reject(new Error(`下载失败，已重试 ${MAX_RETRIES} 次 (${reason})`))
          return
        }

        retryCount++
        // 指数退避：1s, 2s
        const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 5000)
        onProgress?.(lastProgress, 0, retryCount)
        setTimeout(() => attemptSingle(url, 0), delay)
      }

      attemptSingle(url, 0)
    }

    attemptDownload()
  })
}

/**
 * 解压 .tar.gz 到目标目录
 * tar.gz 解压后结构: cpython-3.12.10+.../python.exe
 * 我们需要将内部目录内容提取到目标目录
 */
async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  // 使用内嵌 Python 自己解压，因为 Node.js 原生不支持 .tar.gz
  // 先尝试用系统 tar（Windows 10+ 自带）
  const systemTarAvailable = await checkSystemTar()

  if (systemTarAvailable) {
    // 用系统 tar 解压
    await extractWithSystemTar(archivePath, destDir)
  } else {
    // 用 Node.js tar 流式解压（只处理 .tar 部分，需要先 gunzip）
    // 由于 Node.js 没有原生 gunzip 流式支持，改用 spawn 调用 tar 命令
    await extractWithChildProcess(archivePath, destDir)
  }
}

async function checkSystemTar(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('tar', ['--version'], { shell: true, windowsHide: true })
    proc.on('close', (code) => resolve(code === 0))
    proc.on('error', () => resolve(false))
  })
}

async function extractWithSystemTar(archivePath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // 解压到临时子目录，然后移动内容
    const tempDir = join(destDir, '_temp_extract')
    // 确保临时目录存在，否则 tar 解压会失败
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }
    const proc = spawn('tar', ['-xzf', archivePath, '-C', tempDir], {
      shell: true,
      windowsHide: true
    })

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`tar 解压失败，退出码: ${code}`))
        return
      }

      try {
        // tar.gz 解压后有一个顶层目录 cpython-3.12.10+.../
        // 找到该目录，将其内容移到 destDir
        const entries = fs.readdirSync(tempDir)
        if (entries.length === 1) {
          const innerDir = join(tempDir, entries[0])
          if (fs.statSync(innerDir).isDirectory()) {
            // 将 innerDir 内容移到 destDir
            moveDirContents(innerDir, destDir)
            fs.rmSync(innerDir, { recursive: true, force: true })
          }
        }
        fs.rmSync(tempDir, { recursive: true, force: true })
        resolve()
      } catch (err: any) {
        reject(err)
      }
    })

    proc.on('error', (err) => {
      reject(err)
    })
  })
}

async function extractWithChildProcess(archivePath: string, destDir: string): Promise<void> {
  // Windows 上 tar 命令通常可用（Windows 10+），如果不可用则尝试 PowerShell
  return new Promise((resolve, reject) => {
    const tempDir = join(destDir, '_temp_extract')

    // 使用 PowerShell 解压
    const psScript = `
      $tempDir = '${tempDir.replace(/'/g, "''")}'
      New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
      tar -xzf '${archivePath.replace(/'/g, "''")}' -C $tempDir
    `

    const proc = spawn('powershell.exe', ['-NoProfile', '-Command', psScript], {
      windowsHide: true
    })

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`PowerShell 解压失败，退出码: ${code}`))
        return
      }

      try {
        const entries = fs.readdirSync(tempDir)
        if (entries.length === 1) {
          const innerDir = join(tempDir, entries[0])
          if (fs.statSync(innerDir).isDirectory()) {
            moveDirContents(innerDir, destDir)
            fs.rmSync(innerDir, { recursive: true, force: true })
          }
        }
        fs.rmSync(tempDir, { recursive: true, force: true })
        resolve()
      } catch (err: any) {
        reject(err)
      }
    })

    proc.on('error', (err) => reject(err))
  })
}

/**
 * 将目录内的所有文件/子目录移动到目标目录
 */
function moveDirContents(srcDir: string, destDir: string): void {
  const entries = fs.readdirSync(srcDir)
  for (const entry of entries) {
    const srcPath = join(srcDir, entry)
    const destPath = join(destDir, entry)

    // 如果目标已存在，先删除
    if (fs.existsSync(destPath)) {
      fs.rmSync(destPath, { recursive: true, force: true })
    }

    fs.renameSync(srcPath, destPath)
  }
}

/**
 * 使用内嵌 pip 安装 Python 包
 */
/**
 * 获取 Python 子进程的环境变量
 * python-build-standalone 使用 python._pth 配置模块搜索路径，
 * 不能设置 PYTHONHOME/PYTHONPATH，否则会覆盖其内部配置
 */
function getPythonEnvForSubprocess(): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
  }
  // 清除可能干扰 python-build-standalone 的环境变量
  delete env.PYTHONHOME
  delete env.PYTHONPATH

  // 将 Python 目录加入 PATH
  const pythonExe = getPythonExePath()
  if (fs.existsSync(pythonExe)) {
    const pythonDir = dirname(pythonExe)
    const scriptsDir = join(pythonDir, 'Scripts')
    const pathSep = process.platform === 'win32' ? ';' : ':'
    const extraPaths = [pythonDir, scriptsDir].filter(p => fs.existsSync(p))
    if (extraPaths.length > 0) {
      env.PATH = extraPaths.join(pathSep) + pathSep + (env.PATH || '')
    }
  }
  return env
}

async function pipInstall(
  packageName: string,
  onOutput?: (output: string) => void
): Promise<{ success: boolean, error?: string }> {
  const pipExe = getPipExePath()
  const pythonExe = getPythonExePath()

  // 优先用 pip.exe，如果不存在则用 python -m pip
  const pipCommand = fs.existsSync(pipExe)
    ? [pipExe, 'install', '--no-cache-dir', '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple', '--trusted-host', 'pypi.tuna.tsinghua.edu.cn', packageName]
    : [pythonExe, '-m', 'pip', 'install', '--no-cache-dir', '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple', '--trusted-host', 'pypi.tuna.tsinghua.edu.cn', packageName]

  return new Promise((resolve) => {
    const cmd = pipCommand[0]
    const args = pipCommand.slice(1)

    const proc = spawn(cmd, args, {
      shell: false,
      windowsHide: true,
      env: {
        ...getPythonEnvForSubprocess(),
        // 确保 pip 使用国内镜像
        PIP_INDEX_URL: 'https://pypi.tuna.tsinghua.edu.cn/simple',
        PIP_TRUSTED_HOST: 'pypi.tuna.tsinghua.edu.cn',
      }
    })

    let stderr = ''

    proc.stdout.on('data', (data) => {
      const text = data.toString()
      onOutput?.(text)
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
      onOutput?.(data.toString())
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true })
      } else {
        resolve({ success: false, error: stderr || `pip 退出码: ${code}` })
      }
    })

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message })
    })
  })
}

/**
 * 验证 pdf2docx 是否可用（实际运行 Python 检查 Converter 导入）
 * 注意：必须验证 from pdf2docx import Converter，而非仅 import pdf2docx
 * 因为某些版本可能包存在但子模块缺失
 */
export async function verifyPdf2docx(): Promise<boolean> {
  const pythonExe = getPythonExePath()

  return new Promise((resolve) => {
    const proc = spawn(pythonExe, ['-c', 'from pdf2docx import Converter; print("ok")'], {
      shell: false,
      windowsHide: true,
      env: getPythonEnvForSubprocess()
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => { stdout += data.toString() })
    proc.stderr.on('data', (data) => { stderr += data.toString() })
    proc.on('close', (code) => {
      if (code === 0 && stdout.includes('ok')) {
        resolve(true)
      } else {
        console.error('[verifyPdf2docx] 验证失败:', { code, stdout, stderr })
        resolve(false)
      }
    })
    proc.on('error', (err) => {
      console.error('[verifyPdf2docx] 启动失败:', err.message)
      resolve(false)
    })
  })
}

/**
 * 验证 PyMuPDF (fitz) 是否可用
 * 用于 PDF 加密/解密功能
 */
export async function verifyPyMuPDF(): Promise<boolean> {
  const pythonExe = getPythonExePath()

  return new Promise((resolve) => {
    const proc = spawn(pythonExe, ['-c', 'import fitz; print("ok")'], {
      shell: false,
      windowsHide: true,
      env: getPythonEnvForSubprocess()
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => { stdout += data.toString() })
    proc.stderr.on('data', (data) => { stderr += data.toString() })
    proc.on('close', (code) => {
      if (code === 0 && stdout.includes('ok')) {
        resolve(true)
      } else {
        console.error('[verifyPyMuPDF] 验证失败:', { code, stdout, stderr })
        resolve(false)
      }
    })

    proc.on('error', (err) => {
      console.error('[verifyPyMuPDF] 启动失败:', err.message)
      resolve(false)
    })
  })
}

/**
 * 确保 PyMuPDF 已安装（加密/解密前调用）
 * 如果未安装则自动 pip install pymupdf
 */
export async function ensurePyMuPDFReady(): Promise<{ ready: boolean, error?: string }> {
  // 先验证是否已安装
  const ok = await verifyPyMuPDF()
  if (ok) {
    console.log('[ensurePyMuPDFReady] PyMuPDF 已就绪')
    return { ready: true }
  }

  // 未安装，尝试 pip install pymupdf
  console.log('[ensurePyMuPDFReady] PyMuPDF 未安装，开始安装...')
  const pipResult = await pipInstall('pymupdf', (output) => {
    console.log('[ensurePyMuPDFReady] pip output:', output.trim())
  })

  if (!pipResult.success) {
    return { ready: false, error: `PyMuPDF 安装失败: ${pipResult.error || '未知错误'}` }
  }

  // 安装后再次验证
  const recheck = await verifyPyMuPDF()
  if (recheck) {
    console.log('[ensurePyMuPDFReady] 安装后验证通过')
    return { ready: true }
  }

  console.error('[ensurePyMuPDFReady] 安装后验证仍然失败')
  return { ready: false, error: 'PyMuPDF 安装后仍无法导入' }
}

// 取消安装的标记
let installCancelled = false

export function cancelInstall(): void {
  installCancelled = true
}

export function resetCancelFlag(): void {
  installCancelled = false
}
