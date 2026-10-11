/**
 * 打包脚本 - 在已解压的 Electron 目录上添加应用代码
 * 支持 asarUnpack：将 native binaries 解包到 app.asar.unpacked 目录
 */
const fs = require('fs')
const path = require('path')

const APP_ROOT = 'C:\\Users\\DELL\\AppData\\Roaming\\TRAE SOLO CN\\ModularData\\ai-agent\\work-mode-projects\\6a65b1e957f9cf6b17a3518d\\yizhuan-app'
// 从命令行参数获取已解压的 Electron 目录
const WIN_UNPACKED = process.argv[2] || process.env.WIN_UNPACKED

if (!WIN_UNPACKED || !fs.existsSync(WIN_UNPACKED)) {
  console.error('ERROR: win-unpacked directory not found:', WIN_UNPACKED)
  process.exit(1)
}

console.log('Using Electron at:', WIN_UNPACKED)

async function main() {
  const resourcesDir = path.join(WIN_UNPACKED, 'resources')

  // 步骤1：创建 app.asar
  console.log('1. Creating app.asar...')
  const asar = require('@electron/asar')

  // 完整依赖列表（递归收集，包含所有间接依赖）
  const ALL_DEPS = [
    '@derhuerst/http-basic','@emnapi/runtime','@img/colour','@img/sharp-wasm32',
    '@img/sharp-win32-x64','@pdf-lib/standard-fonts','@pdf-lib/upng','@types/node',
    'adm-zip','agent-base','bmp-js','buffer-from','caseless','concat-stream','core-util-is',
    'debug','detect-libc','env-paths','ffmpeg-static','heic-convert','heic-decode',
    'http-response-object','https-proxy-agent','idb-keyval','inherits','is-url',
    'isarray','jpeg-js','libheif-js','marked','ms','node-fetch',
    'opencollective-postinstall','pako','parse-cache-control','pdf-lib',
    'pdfjs-dist','pngjs','process-nextick-args','progress','readable-stream',
    'regenerator-runtime','safe-buffer','semver','sharp','tesseract.js',
    'tesseract.js-core','tr46','tslib','typedarray','undici-types',
    'util-deprecate','wasm-feature-detect','webidl-conversions','whatwg-url','zlibjs'
  ]

  const filesToPack = [
    'dist',
    'dist-electron',
    ...ALL_DEPS.map(d => `node_modules/${d}`),
  ]

  const asarSrcDir = path.join(WIN_UNPACKED, '_asar_src')
  if (fs.existsSync(asarSrcDir)) fs.rmSync(asarSrcDir, { recursive: true, force: true })
  fs.mkdirSync(asarSrcDir, { recursive: true })

  // 复制 package.json（精简版）
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'))
  fs.writeFileSync(path.join(asarSrcDir, 'package.json'), JSON.stringify({
    name: pkg.name, version: pkg.version, description: pkg.description,
    author: pkg.author, type: pkg.type, main: pkg.main,
  }, null, 2))

  for (const f of filesToPack) {
    const src = path.join(APP_ROOT, f)
    if (!fs.existsSync(src)) { console.log(`   SKIP: ${f}`); continue }
    console.log(`   Packing: ${f}`)
    fs.cpSync(src, path.join(asarSrcDir, f), { recursive: true })
  }

  // 需要解包的目录（native binaries 必须放在 asar 外部才能被正确加载）
  // sharp: .node, .dll 文件
  // @img: .node, .dll, .wasm 文件
  // tesseract.js/tesseract.js-core: .node, .wasm 文件
  // ffmpeg-static: .exe 二进制文件
  const UNPACK_DIRS = [
    'node_modules/sharp',
    'node_modules/@img',
    'node_modules/tesseract.js',
    'node_modules/tesseract.js-core',
    'node_modules/ffmpeg-static',
  ]

  const asarPath = path.join(resourcesDir, 'app.asar')
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked')

  // 使用 asar.createPackageWithOptions，支持 unpack 选项
  // unpack 使用 glob 模式匹配需要解包的文件
  const unpackGlobs = UNPACK_DIRS.map(d => `${d}/**`).join('|')
  // asar 的 unpack 参数接受 glob 字符串，但不支持 | 分隔
  // 需要使用大括号扩展: {dir1,dir2,...}
  const unpackPattern = '{' + UNPACK_DIRS.join(',') + '}/**'

  console.log('   Unpack pattern:', unpackPattern)

  await asar.createPackageWithOptions(asarSrcDir, asarPath, {
    unpack: unpackPattern,
  })

  console.log('   app.asar created')
  console.log('   app.asar.unpacked created:', fs.existsSync(unpackedDir))

  // 验证解包目录内容
  if (fs.existsSync(unpackedDir)) {
    const unpackedFiles = []
    function listFiles(dir, base = '') {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        const rel = base ? `${base}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          listFiles(full, rel)
        } else {
          unpackedFiles.push(rel)
        }
      }
    }
    listFiles(unpackedDir)
    console.log(`   Unpacked files count: ${unpackedFiles.length}`)
    // 显示前 20 个文件
    for (const f of unpackedFiles.slice(0, 20)) {
      console.log(`     ${f}`)
    }
    if (unpackedFiles.length > 20) {
      console.log(`     ... and ${unpackedFiles.length - 20} more`)
    }
  }

  fs.rmSync(asarSrcDir, { recursive: true, force: true })

  // 步骤2：复制 extraResources
  console.log('2. Copying extraResources...')

  // mutool.exe
  const mutoolDst = path.join(resourcesDir, 'caj-tools', 'mutool.exe')
  fs.mkdirSync(path.dirname(mutoolDst), { recursive: true })
  fs.copyFileSync(path.join(APP_ROOT, 'build', 'caj-tools', 'mutool.exe'), mutoolDst)
  console.log('   mutool.exe copied')

  // caj2pdf-src
  fs.cpSync(
    path.join(APP_ROOT, 'build', 'caj-tools', 'caj2pdf-src'),
    path.join(resourcesDir, 'caj-tools', 'caj2pdf-src'),
    { recursive: true }
  )
  console.log('   caj2pdf-src copied')

  // icon.ico
  fs.copyFileSync(path.join(APP_ROOT, 'build', 'icon.ico'), path.join(resourcesDir, 'icon.ico'))
  console.log('   icon.ico copied')

  // watermark 目录（预生成的水印 PNG 图片）
  const watermarkSrc = path.join(APP_ROOT, 'build', 'watermark')
  if (fs.existsSync(watermarkSrc)) {
    fs.cpSync(watermarkSrc, path.join(resourcesDir, 'watermark'), { recursive: true })
    console.log('   watermark/ copied')
  }

  // python 目录
  const pythonSrc = path.join(APP_ROOT, 'python')
  if (fs.existsSync(pythonSrc)) {
    fs.cpSync(pythonSrc, path.join(resourcesDir, 'python'), { recursive: true })
    console.log('   python/ copied')
  }

  // 步骤3：删除 default_app.asar
  console.log('3. Removing default_app.asar...')
  const defaultApp = path.join(resourcesDir, 'default_app.asar')
  if (fs.existsSync(defaultApp)) {
    fs.unlinkSync(defaultApp)
    console.log('   removed')
  }

  // 步骤4：重命名 electron.exe -> 易转.exe
  console.log('4. Renaming electron.exe -> 易转.exe...')
  const electronExe = path.join(WIN_UNPACKED, 'electron.exe')
  const yizhuanExe = path.join(WIN_UNPACKED, '易转.exe')
  if (fs.existsSync(electronExe)) {
    fs.renameSync(electronExe, yizhuanExe)
    console.log('   renamed')
  }

  // 验证
  console.log('\n=== Build complete! ===')
  console.log('Output:', WIN_UNPACKED)

  const resFiles = fs.readdirSync(resourcesDir)
  console.log('\nResources:')
  for (const f of resFiles) {
    const stat = fs.statSync(path.join(resourcesDir, f))
    console.log(`  ${f} ${stat.isDirectory() ? '<DIR>' : `(${(stat.size / 1024).toFixed(0)} KB)`}`)
  }

  const exePath = path.join(WIN_UNPACKED, '易转.exe')
  if (fs.existsSync(exePath)) {
    const stat = fs.statSync(exePath)
    console.log(`\n易转.exe: ${(stat.size / 1024 / 1024).toFixed(1)} MB`)
  }
}

main().catch(err => {
  console.error('ERROR:', err)
  process.exit(1)
})
