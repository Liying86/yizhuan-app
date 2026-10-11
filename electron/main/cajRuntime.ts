/**
 * CAJ 运行时管理模块
 * - 自动下载 mupdf（含 mutool）到 userData/caj-tools
 * - 使用内嵌 Python 自动 pip install caj2pdf 及其依赖
 * - 提供运行时状态查询、自动安装和进度回调
 *
 * 依赖：pythonRuntime.ts 提供的内嵌 Python 运行时（getEmbeddedPythonExe）
 */
import { app } from 'electron'
import { join, dirname } from 'path'
import { spawn, execSync } from 'child_process'
import fs from 'fs'
import { createWriteStream } from 'fs'
import https from 'https'
import http from 'http'
import { getEmbeddedPythonExe } from './pythonRuntime'

// ============================================================
// 常量配置
// ============================================================

/** mupdf 下载地址列表（按优先级排序，国内镜像优先） */
const MUPDF_DOWNLOAD_URLS = [
  // 1. ghfast.top（ghproxy 替代，速度较快）
  'https://ghfast.top/https://github.com/ArtifexSoftware/mupdf-downloads/releases/download/1.28.0/mupdf-1.28.0-windows.zip',
  // 2. gh-proxy.com 镜像
  'https://gh-proxy.com/https://github.com/ArtifexSoftware/mupdf-downloads/releases/download/1.28.0/mupdf-1.28.0-windows.zip',
  // 3. ghproxy.net 镜像
  'https://ghproxy.net/https://github.com/ArtifexSoftware/mupdf-downloads/releases/download/1.28.0/mupdf-1.28.0-windows.zip',
  // 4. GitHub 原始地址（备用）
  'https://github.com/ArtifexSoftware/mupdf-downloads/releases/download/1.28.0/mupdf-1.28.0-windows.zip',
]

/** 兼容旧字段名 */
const MUPDF_DOWNLOAD_URL = MUPDF_DOWNLOAD_URLS[0]
const MUPDF_FALLBACK_URL = MUPDF_DOWNLOAD_URLS[MUPDF_DOWNLOAD_URLS.length - 1]

/** CAJ 工具存储目录（位于 userData 下） */
function getCajToolsDir(): string {
  return join(app.getPath('userData'), 'caj-tools')
}

/** mutool.exe 的本地路径 */
function getMutoolLocalPath(): string {
  return join(getCajToolsDir(), 'mutool.exe')
}

/** 下载的 ZIP 临时路径 */
function getMupdfZipPath(): string {
  return join(getCajToolsDir(), 'mupdf.zip')
}

// ============================================================
// 导出类型
// ============================================================

export interface CajRuntimeStatus {
  /** caj2pdf 和 mutool 都已就绪 */
  cajReady: boolean
  /** caj2pdf Python 包已安装 */
  caj2pdfInstalled: boolean
  /** mutool.exe 可用 */
  mutoolReady: boolean
  /** mutool.exe 路径 */
  mutoolPath: string | null
  /** 是否正在安装中 */
  busy: boolean
  /** 当前安装阶段 */
  phase: string | null
  /** 安装进度 0-100 */
  progress: number
  /** 当前重试次数 */
  retryCount?: number
}

export type CajProgressCallback = (status: Partial<CajRuntimeStatus>) => void

// ============================================================
// 取消安装标记
// ============================================================

let installCancelled = false

// ============================================================
// 导出函数
// ============================================================

/**
 * 检测 CAJ 运行时状态（不触发安装）
 */
export function checkCajRuntime(): CajRuntimeStatus {
  const mutoolPath = getMutoolExe()
  const mutoolReady = mutoolPath !== 'mutool'
    ? fs.existsSync(mutoolPath)
    : isMutoolInPath()

  // caj2pdf 需要异步检测，这里做保守判断
  const caj2pdfInstalled = false

  return {
    cajReady: mutoolReady && caj2pdfInstalled,
    caj2pdfInstalled,
    mutoolReady,
    mutoolPath: mutoolReady ? mutoolPath : null,
    busy: false,
    phase: null,
    progress: 0,
  }
}

/**
 * 异步检测 caj2pdf 是否已安装（通过 import 检测）
 */
export async function checkCaj2pdfInstalled(): Promise<boolean> {
  const pythonExe = getEmbeddedPythonExe()

  // 如果 Python 运行时未安装，直接返回 false（不等待 spawn 失败）
  if (pythonExe === 'python' || !fs.existsSync(pythonExe)) {
    return false
  }

  return new Promise((resolve) => {
    // caj2pdf 源码是以扁平文件形式存放的（cajparser.py, utils.py 等），
    // 通过 .pth 文件将目录加入 sys.path，所以验证应使用实际导入语句
    const proc = spawn(pythonExe, ['-c', 'from cajparser import CAJParser; print("ok")'], {
      shell: false,
      windowsHide: true,
    })

    let stdout = ''
    let resolved = false

    const finish = (result: boolean) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      try { proc.kill() } catch { /* ignore */ }
      resolve(result)
    }

    // 5 秒超时，防止检测卡住导致 cajReady 始终为 null
    const timer = setTimeout(() => finish(false), 5000)

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })
    proc.on('close', (code) => {
      finish(code === 0 && stdout.includes('ok'))
    })
    proc.on('error', () => finish(false))
  })
}

/**
 * 自动安装 CAJ 运行时（mupdf + caj2pdf），带进度回调
 *
 * 流程：
 * 1. 下载 mupdf ZIP（进度 0-60%）
 * 2. 解压并提取 mutool.exe（进度 60-70%）
 * 3. pip install caj2pdf（进度 70-95%）
 * 4. 验证（进度 95-100%）
 */
export async function installCajRuntime(
  onProgress?: CajProgressCallback
): Promise<{ success: boolean; error?: string }> {
  // 前置检查：Python 运行时必须已安装（caj2pdf 依赖 Python 运行环境）
  const pythonExe = getEmbeddedPythonExe()
  if (pythonExe === 'python' || !fs.existsSync(pythonExe)) {
    return {
      success: false,
      error: 'Python 运行时未安装，请先在设置页面点击"一键安装"安装 PDF 转换组件（Python 运行时），安装完成后再安装 CAJ 转换组件',
    }
  }

  const cajToolsDir = getCajToolsDir()
  const zipPath = getMupdfZipPath()

  // 确保目录存在
  if (!fs.existsSync(cajToolsDir)) {
    fs.mkdirSync(cajToolsDir, { recursive: true })
  }

  installCancelled = false

  const report = (partial: Partial<CajRuntimeStatus>) => {
    onProgress?.({ busy: true, ...partial })
  }

  try {
    // === 阶段 1：检查 mutool.exe 是否已存在 ===
    // 优先级：userData > extraResources（打包内置）
    const existingMutool = getMutoolExe()
    const mutoolAlreadyExists = existingMutool !== 'mutool' && fs.existsSync(existingMutool)

    if (mutoolAlreadyExists) {
      // mutool.exe 已存在（可能来自打包内置或之前安装），复制到 userData 目录
      report({ phase: 'extracting-mupdf', progress: 60 })
      if (existingMutool !== getMutoolLocalPath()) {
        // 从 extraResources 复制到 userData
        fs.copyFileSync(existingMutool, getMutoolLocalPath())
      }
      report({ phase: 'extracting-mupdf', progress: 70 })
    } else {
      // 需要下载 mupdf
      report({ phase: 'download-mupdf', progress: 0 })

      if (installCancelled) return { success: false, error: '安装已取消' }

      // 尝试多个下载源，直到成功或全部失败
      let downloadSuccess = false
      let downloadError = ''
      for (let i = 0; i < MUPDF_DOWNLOAD_URLS.length; i++) {
        if (installCancelled) return { success: false, error: '安装已取消' }
        const url = MUPDF_DOWNLOAD_URLS[i]
        try {
          await downloadFile(
            url,
            zipPath,
            (downloaded, total, retryCount) => {
              if (installCancelled) return
              const pct = total > 0 ? Math.round((downloaded / total) * 60) : 0
              report({ progress: pct, phase: 'download-mupdf', retryCount })
            }
          )
          downloadSuccess = true
          break
        } catch (err: any) {
          downloadError = err.message || '下载失败'
          // 清理不完整的下载文件
          try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath) } catch { /* ignore */ }
          if (i < MUPDF_DOWNLOAD_URLS.length - 1) {
            report({ phase: 'download-mupdf', progress: 0, retryCount: 0 })
          }
        }
      }

      if (!downloadSuccess) {
        return { success: false, error: `所有下载源均失败: ${downloadError}` }
      }

      if (installCancelled) {
        cleanupZip()
        return { success: false, error: '安装已取消' }
      }

      // === 阶段 2：解压 mupdf ===
      report({ phase: 'extracting-mupdf', progress: 60 })

      const tempExtractDir = join(cajToolsDir, '_temp_extract')
      await extractZip(zipPath, tempExtractDir)

      if (installCancelled) {
        cleanupTemp(tempExtractDir)
        cleanupZip()
        return { success: false, error: '安装已取消' }
      }

      // 在解压目录中找到 mutool.exe 并移动
      const mutoolFound = findAndMoveMutool(tempExtractDir, getMutoolLocalPath())
      cleanupTemp(tempExtractDir)
      cleanupZip()

      if (!mutoolFound) {
        return { success: false, error: '解压后未找到 mutool.exe' }
      }

      report({ phase: 'extracting-mupdf', progress: 70 })
    }

    // === 阶段 3：pip install caj2pdf ===
    report({ phase: 'installing-caj2pdf', progress: 70 })

    if (installCancelled) return { success: false, error: '安装已取消' }

    // 安装 caj2pdf（从 git）及其额外依赖
    const pythonExe = getEmbeddedPythonExe()
    const pipResult = await pipInstallCaj(pythonExe, (output) => {
      if (installCancelled) return
      const match = output.match(/(\d+)/)
      if (match) {
        const pct = 70 + Math.round(Math.min(parseInt(match[1], 10), 10) / 10 * 25)
        report({ progress: Math.min(pct, 95), phase: 'installing-caj2pdf' })
      }
    })

    if (installCancelled) return { success: false, error: '安装已取消' }

    if (!pipResult.success) {
      return { success: false, error: `caj2pdf 安装失败: ${pipResult.error}` }
    }

    // === 阶段 4：验证 ===
    report({ phase: 'verifying', progress: 95 })

    // 验证 mutool.exe 可执行
    const mutoolExe = getMutoolLocalPath()
    if (!fs.existsSync(mutoolExe)) {
      return { success: false, error: 'mutool.exe 不存在' }
    }

    // 验证 caj2pdf import
    const caj2pdfOk = await checkCaj2pdfInstalled()
    if (!caj2pdfOk) {
      return { success: false, error: 'caj2pdf 安装验证失败' }
    }

    report({
      phase: null,
      progress: 100,
      cajReady: true,
      caj2pdfInstalled: true,
      mutoolReady: true,
      mutoolPath: mutoolExe,
      busy: false,
    })

    return { success: true }
  } catch (err: any) {
    // 清理可能不完整的下载
    cleanupZip()
    return { success: false, error: err.message || '未知错误' }
  }
}

/**
 * 获取 mutool 可执行文件路径
 * 优先级：
 *   1. userData/caj-tools/mutool.exe（已安装或从打包资源复制）
 *   2. extraResources/caj-tools/mutool.exe（打包内置）
 *   3. 系统 PATH 中的 mutool
 */
export function getMutoolExe(): string {
  // 1. userData 目录
  const localPath = getMutoolLocalPath()
  if (fs.existsSync(localPath)) return localPath

  // 2. 打包内置的 extraResources
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, 'caj-tools', 'mutool.exe')
    if (fs.existsSync(bundled)) return bundled
  }

  // 3. 开发环境从 build 目录查找
  if (!app.isPackaged) {
    const devPath = join(__dirname, '..', '..', 'build', 'caj-tools', 'mutool.exe')
    if (fs.existsSync(devPath)) return devPath
  }

  return 'mutool'
}

/**
 * 取消正在进行的 CAJ 运行时安装
 */
export function cancelCajInstall(): void {
  installCancelled = true
}

// ============================================================
// 内部工具函数
// ============================================================

/**
 * 下载文件（支持 HTTPS + 重定向 + 断点续传 + 自动重试），带进度回调
 *
 * 特性：
 * - 断点续传：通过 HTTP Range 请求从断点继续下载
 * - 自动重试：最多 3 次重试，指数退避延迟（1s, 2s, 4s）
 * - 短超时：单次连接 30 秒无数据即重试，快速检测网络中断
 * - 多源切换由调用方处理（installCajRuntime 中的循环）
 */
async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (downloaded: number, total: number, retryCount: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const MAX_RETRIES = 3
    let retryCount = 0
    let lastProgress = 0

    const attemptDownload = () => {
      // 检查是否已有部分下载
      let startBytes = 0
      if (fs.existsSync(destPath)) {
        startBytes = fs.statSync(destPath).size
      }

      const attemptSingle = (targetUrl: string, redirectCount = 0) => {
        if (installCancelled) {
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
          if (
            response.statusCode &&
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
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

          response.on('data', (chunk: Buffer) => {
            downloaded += chunk.length
            lastProgress = downloaded
            onProgress?.(downloaded, total, retryCount)
          })

          fileStream.on('finish', () => {
            fileStream.close()
            // 验证完整性（允许 1 字节误差）
            if (total > 0 && downloaded < total - 1) {
              tryNextRetry('下载不完整')
              return
            }
            resolve()
          })

          fileStream.on('error', (err) => {
            tryNextRetry(`文件写入错误: ${err.message}`)
          })

          response.pipe(fileStream)
        })

        request.on('error', (err) => {
          tryNextRetry(`网络错误: ${err.message}`)
        })

        // 单次连接 30 秒无数据即触发重试（快速检测网络中断）
        request.setTimeout(30000, () => {
          request.destroy()
          tryNextRetry('连接超时（30秒无响应）')
        })
      }

      const tryNextRetry = (reason: string) => {
        if (installCancelled) {
          reject(new Error('安装已取消'))
          return
        }

        if (retryCount >= MAX_RETRIES) {
          reject(new Error(`下载失败，已重试 ${MAX_RETRIES} 次 (${reason})`))
          return
        }

        retryCount++
        // 指数退避：1s, 2s, 4s
        const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 10000)
        onProgress?.(lastProgress, 0, retryCount)
        setTimeout(() => attemptSingle(url, 0), delay)
      }

      attemptSingle(url, 0)
    }

    attemptDownload()
  })
}

/**
 * 使用 PowerShell Expand-Archive 解压 ZIP 文件
 */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  // 确保 destDir 不存在
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true })
  }
  fs.mkdirSync(destDir, { recursive: true })

  return new Promise((resolve, reject) => {
    // 对路径做转义，避免 PowerShell 注入
    const safeZip = zipPath.replace(/'/g, "''")
    const safeDest = destDir.replace(/'/g, "''")
    const psCommand = `Expand-Archive -Path '${safeZip}' -DestinationPath '${safeDest}' -Force`

    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', psCommand],
      { windowsHide: true }
    )

    let stderr = ''
    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`PowerShell Expand-Archive 失败，退出码: ${code}，${stderr.trim()}`))
        return
      }
      resolve()
    })

    proc.on('error', (err) => {
      reject(err)
    })
  })
}

/**
 * 在解压目录中递归查找 mutool.exe，并将其移动到目标路径
 */
function findAndMoveMutool(searchDir: string, destPath: string): boolean {
  if (!fs.existsSync(searchDir)) return false

  const entries = fs.readdirSync(searchDir)
  for (const entry of entries) {
    const fullPath = join(searchDir, entry)
    const stat = fs.statSync(fullPath)

    if (stat.isFile() && entry.toLowerCase() === 'mutool.exe') {
      // 确保目标目录存在
      const destDir = dirname(destPath)
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true })
      }
      fs.renameSync(fullPath, destPath)
      return true
    } else if (stat.isDirectory()) {
      const found = findAndMoveMutool(fullPath, destPath)
      if (found) return true
    }
  }

  return false
}

/**
 * 检查 mutool 是否在系统 PATH 中可用
 */
function isMutoolInPath(): boolean {
  // 在 Windows 上可以用 where 命令检测
  try {
    const result = execSync('where mutool', {
      encoding: 'utf-8',
      timeout: 5000,
    })
    return !!result && result.trim().length > 0
  } catch {
    return false
  }
}

/**
 * 使用内嵌 pip 安装 caj2pdf 及其依赖
 *
 * caj2pdf 不在 PyPI 上，需要从 GitHub 下载源码到 caj-tools 目录，
 * 然后安装 pip 依赖，最后将目录路径注入到 Python 的 sys.path 中。
 */
async function pipInstallCaj(
  pythonExe: string,
  onOutput?: (output: string) => void
): Promise<{ success: boolean; error?: string }> {
  // 先安装 pip 依赖（PyPDF2, imagesize 在 PyPI 上）
  const pipDepsResult = await new Promise<{ success: boolean; error?: string }>((resolve) => {
    const args = [
      '-m', 'pip', 'install',
      '--no-cache-dir',
      '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple',
      '--trusted-host', 'pypi.tuna.tsinghua.edu.cn',
      'PyPDF2', 'imagesize',
    ]

    const proc = spawn(pythonExe, args, {
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        PIP_INDEX_URL: 'https://pypi.tuna.tsinghua.edu.cn/simple',
        PIP_TRUSTED_HOST: 'pypi.tuna.tsinghua.edu.cn',
      },
    })

    let stderr = ''
    proc.stdout.on('data', (data) => { onOutput?.(data.toString()) })
    proc.stderr.on('data', (data) => { stderr += data.toString(); onOutput?.(data.toString()) })
    proc.on('close', (code) => {
      if (code === 0) resolve({ success: true })
      else resolve({ success: false, error: stderr || `pip 退出码: ${code}` })
    })
    proc.on('error', (err) => resolve({ success: false, error: err.message }))
  })

  if (!pipDepsResult.success) return pipDepsResult

  // 下载 caj2pdf 源码到 caj-tools 目录
  const cajToolsDir = getCajToolsDir()
  const caj2pdfDir = join(cajToolsDir, 'caj2pdf-src')
  if (!fs.existsSync(caj2pdfDir)) {
    fs.mkdirSync(caj2pdfDir, { recursive: true })
  }

  // 需要下载的文件列表
  // caj2pdf 仓库的源码文件位于根目录（不在子目录下），__init__.py 需自行创建
  // 参考：https://github.com/caj2pdf/caj2pdf
  const filesToDownload = [
    '__init__.py', 'cajparser.py', 'utils.py', 'jbigdec.py', 'jbig2dec.py',
    'pdfwutils.py', 'HNParsePage.py',
  ]

  // 下载镜像列表（国内镜像优先，避免 raw.githubusercontent.com 被墙）
  // 注意：源码文件在仓库根目录，无需子目录前缀
  const DOWNLOAD_MIRRORS = [
    // 1. jsDelivr CDN（国内可访问，缓存 GitHub 内容）
    'https://cdn.jsdelivr.net/gh/caj2pdf/caj2pdf@master',
    // 2. ghfast.top 代理（GitHub 代理）
    'https://ghfast.top/https://raw.githubusercontent.com/caj2pdf/caj2pdf/master',
    // 3. GitHub 原始地址（备用，国内可能被墙）
    'https://raw.githubusercontent.com/caj2pdf/caj2pdf/master',
  ]

  // 检查本地 extraResources 中是否有预置的 caj2pdf 源码
  let localSrcDir: string | null = null
  if (app.isPackaged) {
    const bundledDir = join(process.resourcesPath, 'caj-tools', 'caj2pdf-src')
    if (fs.existsSync(bundledDir)) {
      localSrcDir = bundledDir
    }
  } else {
    // 开发环境从 build 目录查找
    const devDir = join(__dirname, '..', '..', 'build', 'caj-tools', 'caj2pdf-src')
    if (fs.existsSync(devDir)) {
      localSrcDir = devDir
    }
  }

  for (const fileName of filesToDownload) {
    if (installCancelled) return { success: false, error: '安装已取消' }
    const destPath = join(caj2pdfDir, fileName)

    // 跳过已存在且有内容的文件
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) continue

    // 1. 先尝试从本地 extraResources 复制
    let obtained = false
    if (localSrcDir) {
      const localFile = join(localSrcDir, fileName)
      if (fs.existsSync(localFile) && fs.statSync(localFile).size > 0) {
        try {
          fs.copyFileSync(localFile, destPath)
          obtained = true
        } catch {
          // 复制失败，继续尝试下载
        }
      }
    }

    if (obtained) continue

    // 2. 本地没有，从镜像下载
    let downloaded = false
    for (const baseUrl of DOWNLOAD_MIRRORS) {
      if (installCancelled) return { success: false, error: '安装已取消' }
      try {
        await downloadTextFile(`${baseUrl}/${fileName}`, destPath)
        // 验证下载的文件不为空
        if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
          downloaded = true
          break
        }
      } catch {
        // 尝试下一个镜像
      }
    }

    if (!downloaded) {
      // __init__.py 在 GitHub 仓库中不存在，创建空文件即可
      if (fileName === '__init__.py') {
        fs.writeFileSync(destPath, '')
        continue
      }
      return { success: false, error: `下载 caj2pdf 源码失败: ${fileName}` }
    }
  }

  // 写入 .pth 文件到 site-packages，让 Python 能 import caj2pdf 目录中的模块
  // 这样 convert_caj.py 中的 `from cajparser import CAJParser` 就能正常工作
  const pthResult = await new Promise<{ success: boolean; error?: string }>((resolve) => {
    // 使用 "python -c" 获取 site-packages 路径并写入 .pth 文件
    const args = ['-c', `
import site
import os
site_dir = site.getsitepackages()[0]
pth_path = os.path.join(site_dir, 'caj2pdf_path.pth')
with open(pth_path, 'w') as f:
    f.write(r'${caj2pdfDir.replace(/\\/g, '\\\\')}')
print('ok')
`]
    const proc = spawn(pythonExe, args, { shell: false, windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (data) => { stderr += data.toString() })
    proc.on('close', (code) => {
      if (code === 0) resolve({ success: true })
      else resolve({ success: false, error: `写入 Python 路径失败: ${stderr}` })
    })
    proc.on('error', (err) => resolve({ success: false, error: err.message }))
  })

  return pthResult
}

/**
 * 下载文本文件（支持 HTTPS + 重定向）
 */
async function downloadTextFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    client.get(url, { headers: {} }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        // 处理重定向
        downloadTextFile(response.headers.location, destPath).then(resolve).catch(reject)
        return
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`))
        return
      }
      const fileStream = createWriteStream(destPath)
      response.pipe(fileStream)
      fileStream.on('finish', () => { fileStream.close(); resolve() })
      fileStream.on('error', reject)
    }).on('error', reject)
  })
}

/**
 * 清理下载的 ZIP 文件
 */
function cleanupZip(): void {
  try {
    const zipPath = getMupdfZipPath()
    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath)
    }
  } catch {
    /* ignore */
  }
}

/**
 * 清理临时解压目录
 */
function cleanupTemp(tempDir: string): void {
  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  } catch {
    /* ignore */
  }
}
