/**
 * 易转 - 自定义代码签名脚本
 *
 * 使用方式：
 * 1. 环境变量方式（推荐）：
 *    set CSC_LINK=file:///path/to/cert.pfx
 *    set CSC_KEY_PASSWORD=your_password
 *    npm run build:win
 *
 * 2. 证书文件方式：
 *    将证书放在 build/cert/ 目录下，命名为 yizhuan.pfx
 *    设置环境变量 WIN_CSC_KEY_PASSWORD=your_password
 *
 * 3. Windows 证书库方式：
 *    set WIN_CSC_LINK=subject_name  (证书主题名称)
 *
 * 无证书时跳过签名，不影响打包流程。
 */
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

exports.default = async function(configuration) {
  // 检查是否有证书配置
  const certFile = process.env.CSC_LINK || process.env.WIN_CSC_LINK
  const certPassword = process.env.CSC_KEY_PASSWORD || process.env.WIN_CSC_KEY_PASSWORD

  // 本地证书文件
  const localCertPath = path.join(__dirname, 'cert', 'yizhuan.pfx')

  if (!certFile && !fs.existsSync(localCertPath)) {
    console.log('[sign] 未检测到代码签名证书，跳过签名步骤')
    console.log('[sign] 如需签名，请设置环境变量 CSC_LINK 和 CSC_KEY_PASSWORD')
    console.log('[sign] 或将证书文件放在 build/cert/yizhuan.pfx')
    return
  }

  const filePath = configuration.path
  if (!filePath) {
    console.log('[sign] 无文件路径，跳过签名')
    return
  }

  // 确定证书路径
  const finalCertPath = certFile
    ? certFile.replace(/^file:\/\//, '')
    : localCertPath

  if (!fs.existsSync(finalCertPath)) {
    console.log(`[sign] 证书文件不存在: ${finalCertPath}，跳过签名`)
    return
  }

  console.log(`[sign] 正在签名: ${filePath}`)

  try {
    const signtoolPath = findSigntool()
    const args = [
      'sign',
      '/f', `"${finalCertPath}"`,
      '/fd', 'sha256',
      '/td', 'http://timestamp.digicert.com',
      '/tr', 'http://timestamp.digicert.com',
    ]

    if (certPassword) {
      args.push('/p', `"${certPassword}"`)
    }

    args.push(`"${filePath}"`)

    const cmd = `"${signtoolPath}" ${args.join(' ')}`
    console.log('[sign] 执行签名命令...')
    execSync(cmd, { stdio: 'inherit' })
    console.log('[sign] 签名成功')
  } catch (err) {
    console.error('[sign] 签名失败:', err.message)
    // 不中断构建流程
  }
}

/**
 * 查找 signtool.exe 路径
 */
function findSigntool() {
  const candidates = [
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.22621.0\\x64\\signtool.exe',
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.22000.0\\x64\\signtool.exe',
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.19041.0\\x64\\signtool.exe',
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.18362.0\\x64\\signtool.exe',
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\x64\\signtool.exe',
  ]

  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }

  // 尝试从 PATH 中查找
  try {
    const result = execSync('where signtool.exe', { encoding: 'utf-8' }).trim()
    if (result) return result.split('\n')[0].trim()
  } catch {}

  console.warn('[sign] 未找到 signtool.exe，请安装 Windows SDK')
  return 'signtool.exe'
}
