/**
 * 视频转换服务 - 基于 ffmpeg-static
 * 支持常见视频格式互转：mp4, avi, mkv, mov, webm, flv, wmv
 * 支持音频提取：mp3, wav, aac, flac
 *
 * ===== 硬件加速策略 =====
 * 1. 探测：ffmpeg -encoders 列表 + 实际编码测试（生成 1 帧测试视频）
 * 2. 使用：优先使用可用的硬件编码器（nvenc > qsv > amf）
 * 3. 回退：若实际转换时硬件编码器失败，自动切换到 libx264 软件编码重试
 */
import { spawn, execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { app } from 'electron'
import ffmpegPath from 'ffmpeg-static'

// 支持的视频输入格式
export const VIDEO_INPUT_EXTS = ['mp4', 'avi', 'mkv', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts']
// 支持的视频输出格式
export const VIDEO_OUTPUT_EXTS = ['mp4', 'avi', 'mkv', 'mov', 'webm', 'flv', 'gif']
// 支持的音频输出格式
export const AUDIO_OUTPUT_EXTS = ['mp3', 'wav', 'aac', 'flac']

export type VideoTargetFormat = 'mp4' | 'avi' | 'mkv' | 'mov' | 'webm' | 'flv' | 'gif' | 'mp3' | 'wav' | 'aac' | 'flac'

/**
 * 视频画质预设
 * - original: 保持原画质
 * - 1080p: 1920x1080，高码率
 * - 720p: 1280x720，中码率
 * - 480p: 854x480，低码率
 * - minimal: 最小体积（480p + 低码率 + 24fps）
 */
export type VideoQualityPreset = 'original' | '1080p' | '720p' | '480p' | 'minimal'

interface QualityPresetConfig {
  resolution?: string
  videoBitrate: string
  fps?: number
  crf?: number  // 质量因子（仅软件编码时使用，越小质量越高）
}

const QUALITY_PRESETS: Record<VideoQualityPreset, QualityPresetConfig> = {
  'original': { videoBitrate: '', crf: 20 },
  '1080p': { resolution: '1920:1080', videoBitrate: '5M', crf: 20 },
  '720p': { resolution: '1280:720', videoBitrate: '2.5M', crf: 23 },
  '480p': { resolution: '854:480', videoBitrate: '1M', crf: 26 },
  'minimal': { resolution: '640:360', videoBitrate: '500k', fps: 24, crf: 30 },
}

// 硬件加速编码器缓存
// null = 尚未探测, '' = 无可用硬件编码器, 'h264_nvenc' 等 = 可用的编码器
let cachedHwEncoder: string | null = null

interface VideoConvertOptions {
  inputPath: string
  outputPath: string
  targetFormat: VideoTargetFormat
  taskId: string
  // 可选参数
  videoCodec?: string      // 视频编码器，如 h264, h265
  videoBitrate?: string    // 视频码率，如 '2M'
  audioCodec?: string      // 音频编码器
  resolution?: string      // 分辨率，如 '1280:720'
  fps?: number             // 帧率
  startTime?: number       // 开始时间（秒）
  duration?: number        // 持续时间（秒）
  qualityPreset?: VideoQualityPreset  // 画质预设
  gifMaxWidth?: number      // GIF 最大宽度（默认 480，用于内存优化降级）
  gifMaxColors?: number     // GIF 调色板最大颜色数（默认 128，用于内存优化降级）
}

/**
 * 实际测试硬件编码器是否可用
 * 用指定编码器编码 1 帧 64x64 的纯色测试视频，成功则说明编码器真正可用
 */
function testEncoder(ffmpeg: string, encoder: string): boolean {
  const testFile = path.join(os.tmpdir(), `_yizhuan_hwtest_${Date.now()}.mp4`)
  try {
    execSync(
      `"${ffmpeg}" -y -f lavfi -i color=c=black:s=64x64:d=0.1 -c:v ${encoder} -frames:v 1 "${testFile}" 2>&1`,
      { timeout: 15000, encoding: 'utf-8', windowsHide: true }
    )
    const ok = fs.existsSync(testFile) && fs.statSync(testFile).size > 0
    return ok
  } catch {
    return false
  } finally {
    try { if (fs.existsSync(testFile)) fs.unlinkSync(testFile) } catch { /* ignore */ }
  }
}

/**
 * 探测可用的硬件加速视频编码器
 * 1. 先检查 ffmpeg -encoders 列表
 * 2. 再做实际编码测试（防止编码器存在但驱动/CUDA不可用）
 * 优先级：h264_nvenc (NVIDIA) > h264_qsv (Intel) > h264_amf (AMD)
 * 返回空字符串表示无可用硬件编码器，将使用软件编码
 */
function detectHardwareEncoder(): string {
  if (cachedHwEncoder !== null) return cachedHwEncoder
  cachedHwEncoder = '' // 默认无可用

  try {
    const ffmpeg = getFfmpegPath()
    if (!ffmpeg || ffmpeg === 'ffmpeg') return ''

    // 运行 ffmpeg -encoders 获取支持的编码器列表
    const result = execSync(
      `"${ffmpeg}" -encoders 2>&1`,
      { timeout: 10000, encoding: 'utf-8', windowsHide: true }
    )

    // 按优先级检查并实际测试
    const candidates: string[] = []
    if (result.includes('h264_nvenc')) candidates.push('h264_nvenc')
    if (result.includes('h264_qsv')) candidates.push('h264_qsv')
    if (result.includes('h264_amf')) candidates.push('h264_amf')

    for (const encoder of candidates) {
      if (testEncoder(ffmpeg, encoder)) {
        cachedHwEncoder = encoder
        break
      }
    }

    return cachedHwEncoder
  } catch {
    return ''
  }
}

/**
 * 获取 ffmpeg 可执行文件路径
 *
 * 打包后 ffmpeg-static 被 asarUnpack 解包到 app.asar.unpacked 目录，
 * 但 ffmpeg-static 模块返回的路径仍指向 app.asar 内部。
 * spawn() 无法执行 asar 内的文件，必须替换为 app.asar.unpacked 路径。
 */
export function getFfmpegPath(): string {
  if (!app.isPackaged) {
    // 开发环境直接使用 ffmpeg-static 返回的路径
    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      return ffmpegPath
    }
    return 'ffmpeg'
  }

  // 打包环境：按优先级尝试多个候选路径
  const candidates: string[] = []

  // 1. 基于 ffmpeg-static 返回路径的 unpacked 版本
  if (ffmpegPath) {
    candidates.push(ffmpegPath.replace(/app\.asar(?!\.unpacked)/g, 'app.asar.unpacked'))
  }

  // 2. 从 __dirname 推导（main 进程在 app.asar/dist-electron/main/）
  candidates.push(path.join(__dirname, '..', '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'))
  candidates.push(path.join(__dirname, '..', '..', 'node_modules', 'ffmpeg-static', 'ffmpeg'))

  // 3. 从 process.resourcesPath 推导
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'))
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg'))
  }

  // 4. extraResources 备用
  candidates.push(path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'))

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p
    }
  }

  return 'ffmpeg'
}

/**
 * 构建 FFmpeg 转换参数
 * @param useHardware 是否尝试使用硬件加速编码器
 * @returns { args, encoderUsed } 编码参数和实际使用的视频编码器
 */
function buildFFmpegArgs(
  options: VideoConvertOptions,
  outputPath: string,
  useHardware: boolean
): { args: string[]; encoderUsed: string } {
  const { targetFormat } = options
  const args: string[] = ['-y']

  // 应用画质预设（GIF 和音频提取不受画质预设影响）
  const isGif = targetFormat === 'gif'
  const isAudioOnly = AUDIO_OUTPUT_EXTS.includes(targetFormat)
  const preset = (!isGif && !isAudioOnly && options.qualityPreset && options.qualityPreset !== 'original')
    ? QUALITY_PRESETS[options.qualityPreset]
    : null

  // 开始时间
  if (options.startTime !== undefined) {
    args.push('-ss', String(options.startTime))
  }

  // 输入文件
  args.push('-i', options.inputPath)

  // 持续时间
  if (options.duration !== undefined) {
    args.push('-t', String(options.duration))
  }

  // ===== GIF 特殊处理 =====
  if (isGif) {
    // GIF 使用调色板生成模式以获得更好的画质
    // 优化：降低默认 FPS、限制最大宽度、减少调色板颜色数，避免大视频导致内存溢出
    const gifFps = options.fps || 10
    // 限制 GIF 最大宽度为 480，避免大视频导致内存溢出
    const maxGifWidth = options.gifMaxWidth || 480
    const maxColors = options.gifMaxColors || 128
    const vfParts = [
      `fps=${gifFps}`,
      `scale=${maxGifWidth}:-1:flags=lanczos`,
      // palettegen 减少颜色数降低内存，paletteuse 使用 bayer 抖动降低内存
      `split[s0][s1];[s0]palettegen=max_colors=${maxColors}[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`
    ]
    // -fs 限制输出文件大小为 50MB，-loop 0 表示无限循环
    args.push('-vf', vfParts.join(','), '-loop', '0', '-fs', '50M')
    args.push(outputPath)
    return { args, encoderUsed: 'gif' }
  }

  // 默认软件编码器映射
  const swCodecMap: Record<string, string> = {
    'mp4': 'libx264',
    'webm': 'libvpx-vp9',
    'mkv': 'libx264',
    'avi': 'mpeg4',
    'mov': 'libx264',
    'flv': 'libx264',
  }

  let videoCodec = swCodecMap[targetFormat] || 'libx264'
  let useCrf = false

  // 视频编码选择
  if (options.videoCodec) {
    // 用户指定编码器，直接使用
    videoCodec = options.videoCodec
    args.push('-c:v', videoCodec)
  } else {
    // 尝试硬件加速（仅 h264 系列目标格式）
    const hwTargets = ['mp4', 'mkv', 'mov', 'flv']
    if (useHardware && hwTargets.includes(targetFormat) && !preset) {
      // 有画质预设时不使用硬件加速（因为 CRF 控制在软件编码下更精确）
      const hwEncoder = detectHardwareEncoder()
      if (hwEncoder) {
        videoCodec = hwEncoder
        args.push('-c:v', hwEncoder)
        // nvenc 使用 p7 preset（最快速度）
        if (hwEncoder === 'h264_nvenc') {
          args.push('-preset', 'p7')
        }
      } else {
        args.push('-c:v', videoCodec)
        useCrf = true
      }
    } else {
      args.push('-c:v', videoCodec)
      useCrf = true
    }
  }

  // 视频码率（优先使用预设值，其次用户指定值）
  const effectiveBitrate = preset?.videoBitrate || options.videoBitrate
  if (effectiveBitrate) {
    args.push('-b:v', effectiveBitrate)
  }

  // CRF 质量因子（仅软件编码时使用）
  if (useCrf && preset?.crf !== undefined) {
    args.push('-crf', String(preset.crf))
  } else if (useCrf && !effectiveBitrate) {
    // 无预设且无指定码率时使用默认 CRF
    args.push('-crf', '23')
  }

  // 分辨率（优先使用预设值，其次用户指定值）
  const effectiveResolution = preset?.resolution || options.resolution
  if (effectiveResolution) {
    args.push('-s', effectiveResolution)
  }

  // 帧率（优先使用预设值，其次用户指定值）
  const effectiveFps = preset?.fps || options.fps
  if (effectiveFps) {
    args.push('-r', String(effectiveFps))
  }

  // 音频处理
  if (isAudioOnly) {
    const audioCodecMap: Record<string, string> = {
      'mp3': 'libmp3lame',
      'wav': 'pcm_s16le',
      'aac': 'aac',
      'flac': 'flac',
    }
    args.push('-vn', '-c:a', audioCodecMap[targetFormat] || 'copy')
  } else {
    if (options.audioCodec) {
      args.push('-c:a', options.audioCodec)
    } else {
      // WebM 只支持 Vorbis/Opus 音频，不能使用 aac
      const defaultAudioCodec = targetFormat === 'webm' ? 'libopus' : 'aac'
      args.push('-c:a', defaultAudioCodec)
    }
  }

  // 输出文件
  args.push(outputPath)

  return { args, encoderUsed: videoCodec }
}

/**
 * 执行一次 FFmpeg 转换（内部函数）
 * 返回退出码和 stderr 日志
 */
function runFFmpegOnce(
  ffmpeg: string,
  args: string[],
  onProgress?: (progress: number, status: string) => void
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, args, { shell: false, windowsHide: true })
    let stderr = ''
    let duration = 0

    proc.stderr.on('data', (data) => {
      const text = data.toString()
      stderr += text

      if (onProgress) {
        const durMatch = stderr.match(/Duration:\s(\d+):(\d+):(\d+\.\d+)/)
        if (durMatch && duration === 0) {
          duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3])
        }

        const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/)
        if (timeMatch && duration > 0) {
          const currentTime = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3])
          const progress = Math.min(99, Math.round((currentTime / duration) * 100))
          onProgress(progress, 'converting')
        }
      }
    })

    proc.on('close', (code) => {
      resolve({ code, stderr })
    })

    proc.on('error', () => {
      resolve({ code: -1, stderr })
    })
  })
}

/**
 * 执行视频/音频转换
 * 策略：优先硬件加速 → 失败自动回退软件编码(libx264)重试
 * GIF 特殊策略：大文件预降级 → 内存不足时更低参数重试
 */
export function convertVideo(
  options: VideoConvertOptions,
  onProgress?: (progress: number, status: string) => void
): Promise<{ status: 'success' | 'error', output?: string, message?: string }> {
  return new Promise(async (resolve) => {
    const { inputPath, outputPath, targetFormat } = options

    if (!fs.existsSync(inputPath)) {
      resolve({ status: 'error', message: `输入文件不存在: ${inputPath}` })
      return
    }

    const ffmpeg = getFfmpegPath()

    // 确保输出目录存在
    const outputDir = path.dirname(outputPath)
    if (outputDir && !fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    // ===== GIF 大文件预处理：检查输入视频大小，超 100MB 自动降低参数 =====
    let effectiveOptions = options
    const isGif = targetFormat === 'gif'
    if (isGif) {
      try {
        const inputSize = fs.statSync(inputPath).size
        const inputSizeMB = inputSize / 1024 / 1024
        if (inputSizeMB > 200) {
          // 超大文件（>200MB）：限制 GIF 时长为 30 秒 + 最低参数
          console.warn(`[VideoConverter] 输入视频超大 (${inputSizeMB.toFixed(1)} MB)，限制 GIF 时长为 30 秒并使用最低参数`)
          if (onProgress) onProgress(0, '超大文件优化中（限制时长+降级参数）')
          effectiveOptions = {
            ...options,
            fps: 6,
            gifMaxWidth: 320,
            gifMaxColors: 64,
            duration: Math.min(options.duration || 30, 30),
          }
        } else if (inputSizeMB > 100) {
          // 大文件（>100MB）：降低帧率，保留默认宽度与颜色数
          console.warn(`[VideoConverter] 输入视频较大 (${inputSizeMB.toFixed(1)} MB)，自动降低 GIF 转换参数以避免内存不足`)
          if (onProgress) onProgress(0, '优化参数中（大文件降级）')
          effectiveOptions = {
            ...options,
            fps: Math.min(options.fps || 10, 8),
          }
        }
      } catch {
        // 忽略文件大小检查错误，继续使用默认参数
      }
    }

    // 第一次尝试：优先使用硬件加速
    const { args, encoderUsed } = buildFFmpegArgs(effectiveOptions, outputPath, true)

    console.log(`[VideoConverter] 第一次转换，编码器: ${encoderUsed}`)
    const result1 = await runFFmpegOnce(ffmpeg, args, onProgress)

    if (result1.code === 0 && fs.existsSync(outputPath)) {
      const size = fs.statSync(outputPath).size
      if (onProgress) onProgress(100, 'done')
      resolve({
        status: 'success',
        output: outputPath,
        message: `转换成功（${encoderUsed}），文件大小: ${(size / 1024 / 1024).toFixed(1)} MB`
      })
      return
    }

    // ===== GIF 内存不足特殊处理：检测内存错误并用更低参数重试 =====
    if (isGif) {
      const stderrLower = result1.stderr.toLowerCase()
      const isMemoryError = stderrLower.includes('cannot allocate memory') || stderrLower.includes('memory')

      if (isMemoryError) {
        console.warn('[VideoConverter] GIF 转换因内存不足失败，使用更低参数重试（FPS=8, 宽度=320, max_colors=64）')
        if (onProgress) onProgress(0, '内存不足，降低参数重试中')

        // 清理可能的不完整输出文件
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch { /* ignore */ }

        // 第二次重试：使用更低的参数：FPS=8, 宽度=320, max_colors=64
        const retryOptions: VideoConvertOptions = {
          ...effectiveOptions,
          fps: 8,
          gifMaxWidth: 320,
          gifMaxColors: 64
        }
        const { args: retryArgs } = buildFFmpegArgs(retryOptions, outputPath, false)

        const resultRetry = await runFFmpegOnce(ffmpeg, retryArgs, onProgress)

        if (resultRetry.code === 0 && fs.existsSync(outputPath)) {
          const size = fs.statSync(outputPath).size
          if (onProgress) onProgress(100, 'done')
          resolve({
            status: 'success',
            output: outputPath,
            message: `转换成功（内存不足降级重试，FPS=8 宽度=320），文件大小: ${(size / 1024 / 1024).toFixed(1)} MB`
          })
          return
        }

        // 第三次重试：最低参数 + 限制时长为 15 秒
        const retryStderrLower2 = resultRetry.stderr.toLowerCase()
        const stillMemoryError = retryStderrLower2.includes('cannot allocate memory') || retryStderrLower2.includes('memory')
        if (stillMemoryError) {
          console.warn('[VideoConverter] 第二次重试仍内存不足，使用最低参数+限制15秒重试')
          if (onProgress) onProgress(0, '极限模式重试中（限制15秒）')
          try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch { /* ignore */ }

          const extremeOptions: VideoConvertOptions = {
            ...effectiveOptions,
            fps: 5,
            gifMaxWidth: 240,
            gifMaxColors: 32,
            duration: 15,
          }
          const { args: extremeArgs } = buildFFmpegArgs(extremeOptions, outputPath, false)
          const resultExtreme = await runFFmpegOnce(ffmpeg, extremeArgs, onProgress)

          if (resultExtreme.code === 0 && fs.existsSync(outputPath)) {
            const size = fs.statSync(outputPath).size
            if (onProgress) onProgress(100, 'done')
            resolve({
              status: 'success',
              output: outputPath,
              message: `转换成功（极限模式，FPS=5 宽度=240 时长≤15秒），文件大小: ${(size / 1024 / 1024).toFixed(1)} MB`
            })
            return
          }
        }

        // 所有重试都失败了
        const retryStderrLower = resultRetry.stderr.toLowerCase()
        const retryMemoryError = retryStderrLower.includes('cannot allocate memory') || retryStderrLower.includes('memory')
        const hint = retryMemoryError
          ? '\n\n提示：即使使用最低参数仍然内存不足，建议：\n1. 截取视频片段后再转 GIF\n2. 降低视频分辨率\n3. 关闭其他占用内存的程序后重试'
          : ''
        resolve({
          status: 'error',
          message: `GIF 转换失败（已尝试内存不足降级重试）\n${resultRetry.stderr.slice(-500)}${hint}`
        })
        return
      }
    }

    // 第一次失败：如果使用了硬件编码器，自动回退到软件编码重试
    const usedHwEncoder = ['h264_nvenc', 'h264_qsv', 'h264_amf'].includes(encoderUsed)

    if (usedHwEncoder) {
      console.warn(`[VideoConverter] 硬件编码器 ${encoderUsed} 失败（退出码 ${result1.code}），回退到软件编码`)

      // 清理可能的不完整输出文件
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch { /* ignore */ }

      // 第二次尝试：强制使用软件编码
      const { args: args2, encoderUsed: encoder2 } = buildFFmpegArgs(effectiveOptions, outputPath, false)

      console.log(`[VideoConverter] 第二次转换，编码器: ${encoder2}`)
      if (onProgress) onProgress(0, 'retrying')

      const result2 = await runFFmpegOnce(ffmpeg, args2, onProgress)

      if (result2.code === 0 && fs.existsSync(outputPath)) {
        const size = fs.statSync(outputPath).size
        if (onProgress) onProgress(100, 'done')
        resolve({
          status: 'success',
          output: outputPath,
          message: `转换成功（软件编码回退），文件大小: ${(size / 1024 / 1024).toFixed(1)} MB`
        })
        return
      }

      // 软件编码也失败了
      resolve({
        status: 'error',
        message: `FFmpeg 转换失败（已尝试软件编码回退）\n${result2.stderr.slice(-500)}`
      })
    } else {
      // 第一次使用的是软件编码，直接返回错误
      resolve({
        status: 'error',
        message: `FFmpeg 退出码: ${result1.code}\n${result1.stderr.slice(-500)}`
      })
    }
  })
}

/**
 * 获取视频信息（时长、分辨率等）
 */
export function getVideoInfo(videoPath: string): Promise<{
  duration: number,
  width: number,
  height: number,
  fps: number,
  bitrate: number,
  hasAudio: boolean
}> {
  return new Promise((resolve) => {
    const ffmpeg = getFfmpegPath()
    const proc = spawn(ffmpeg, ['-i', videoPath], { shell: false })

    let stderr = ''
    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', () => {
      const result = { duration: 0, width: 0, height: 0, fps: 0, bitrate: 0, hasAudio: false }

      const durMatch = stderr.match(/Duration:\s(\d+):(\d+):(\d+\.\d+)/)
      if (durMatch) {
        result.duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3])
      }

      const resMatch = stderr.match(/(\d{2,5})x(\d{2,5})/)
      if (resMatch) {
        result.width = parseInt(resMatch[1])
        result.height = parseInt(resMatch[2])
      }

      const fpsMatch = stderr.match(/(\d+\.?\d*)\s*fps/)
      if (fpsMatch) {
        result.fps = parseFloat(fpsMatch[1])
      }

      const bitrateMatch = stderr.match(/(\d+)\s*kb\/s/)
      if (bitrateMatch) {
        result.bitrate = parseInt(bitrateMatch[1])
      }

      result.hasAudio = /Audio:/.test(stderr)

      resolve(result)
    })

    proc.on('error', () => {
      resolve({ duration: 0, width: 0, height: 0, fps: 0, bitrate: 0, hasAudio: false })
    })
  })
}

/**
 * 给视频添加水印（通过 ffmpeg overlay 滤镜）
 * 水印图片居中叠加到视频上，半透明
 * @param videoPath 视频文件路径（将被替换为带水印的版本）
 * @param watermarkPngPath 水印 PNG 图片路径
 * @returns 成功返回 true，失败返回 false
 */
export function addVideoWatermark(videoPath: string, watermarkPngPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      if (!fs.existsSync(videoPath) || !fs.existsSync(watermarkPngPath)) {
        resolve(false)
        return
      }

      const ffmpeg = getFfmpegPath()
      const ext = path.extname(videoPath).toLowerCase().replace('.', '')
      const tmpOutput = videoPath + '.watermarked_tmp' + path.extname(videoPath)

      // 根据输出格式选择合适的视频编码器和音频编码器
      // libx264 适用于 mp4/mkv/mov/flv，libvpx-vp9 适用于 webm，mpeg4 适用于 avi
      const videoCodecMap: Record<string, string> = {
        'mp4': 'libx264',
        'mkv': 'libx264',
        'mov': 'libx264',
        'flv': 'libx264',
        'webm': 'libvpx-vp9',
        'avi': 'mpeg4',
        'wmv': 'wmv2',
        'm4v': 'libx264',
        'mpg': 'mpeg2video',
        'mpeg': 'mpeg2video',
        'ts': 'libx264',
      }
      const audioCodecMap: Record<string, string> = {
        'webm': 'libopus',
        'mp4': 'aac',
        'mkv': 'aac',
        'mov': 'aac',
        'flv': 'aac',
        'avi': 'mp3',
        'wmv': 'wmav2',
      }

      const videoCodec = videoCodecMap[ext] || 'libx264'
      const audioCodec = audioCodecMap[ext] || 'aac'

      // 使用 ffmpeg overlay 滤镜将水印居中叠加
      const args = [
        '-y',
        '-i', videoPath,
        '-i', watermarkPngPath,
        '-filter_complex', '[0:v][1:v]overlay=(W-w)/2:(H-h)/2',
        '-c:v', videoCodec,
        '-c:a', audioCodec,
      ]

      // libx264 使用 CRF + preset，其他编码器使用各自的质量参数
      if (videoCodec === 'libx264') {
        args.push('-crf', '23', '-preset', 'fast')
      } else if (videoCodec === 'libvpx-vp9') {
        args.push('-crf', '32', '-b:v', '0', '-row-mt', '1')
      } else {
        args.push('-q:v', '5')
      }

      // webm 需要指定像素格式
      if (ext === 'webm') {
        args.push('-pix_fmt', 'yuv420p')
      }

      args.push(tmpOutput)

      const proc = spawn(ffmpeg, args, { shell: false, windowsHide: true })
      let stderr = ''

      proc.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(tmpOutput)) {
          // 用带水印的文件替换原文件
          try {
            fs.copyFileSync(tmpOutput, videoPath)
            fs.unlinkSync(tmpOutput)
            resolve(true)
          } catch {
            resolve(false)
          }
        } else {
          // 清理临时文件
          try { if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput) } catch {}
          console.error('[VideoWatermark] ffmpeg overlay failed (codec=' + videoCodec + '):', stderr.slice(-500))

          // 如果格式特定编码器失败，回退到 libx264（仅对非 webm 格式）
          if (videoCodec !== 'libx264' && ext !== 'webm') {
            console.warn('[VideoWatermark] 回退到 libx264 编码器重试')
            const fallbackArgs = [
              '-y',
              '-i', videoPath,
              '-i', watermarkPngPath,
              '-filter_complex', '[0:v][1:v]overlay=(W-w)/2:(H-h)/2',
              '-c:v', 'libx264',
              '-c:a', 'aac',
              '-crf', '23',
              '-preset', 'fast',
              tmpOutput
            ]
            const fallbackProc = spawn(ffmpeg, fallbackArgs, { shell: false, windowsHide: true })
            let fbStderr = ''
            fallbackProc.stderr.on('data', (data) => { fbStderr += data.toString() })
            fallbackProc.on('close', (fbCode) => {
              if (fbCode === 0 && fs.existsSync(tmpOutput)) {
                try {
                  fs.copyFileSync(tmpOutput, videoPath)
                  fs.unlinkSync(tmpOutput)
                  resolve(true)
                } catch {
                  resolve(false)
                }
              } else {
                try { if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput) } catch {}
                console.error('[VideoWatermark] fallback libx264 also failed:', fbStderr.slice(-300))
                resolve(false)
              }
            })
            fallbackProc.on('error', () => resolve(false))
          } else {
            resolve(false)
          }
        }
      })

      proc.on('error', () => {
        resolve(false)
      })
    } catch (err) {
      console.error('[VideoWatermark] error:', err)
      resolve(false)
    }
  })
}
