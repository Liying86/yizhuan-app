/**
 * Office 文件构建模块
 * 功能：
 * 1. 从图片创建 PPTX（用于 PDF 转 PPT）
 * 2. 从 DOCX 表格数据创建 XLSX（用于 PDF 转 Excel）
 * 依赖：adm-zip
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import AdmZip from 'adm-zip'

// ============================================================
// PPTX 创建（从图片）
// ============================================================

interface SlideImage {
  imagePath: string
  width: number
  height: number
}

/**
 * EMU（English Metric Unit）转换
 * PPTX 使用 EMU 作为内部单位：1 inch = 914400 EMU
 */
const EMU_PER_INCH = 914400
const EMU_PER_PIXEL_96DPI = 9525 // 914400 / 96

/**
 * 从图片创建 PPTX 文件
 * 每张图片作为一个独立幻灯片的全页背景
 * @param images - 图片信息数组
 * @param outputPath - 输出 PPTX 路径
 */
export async function createPptxFromImages(
  images: SlideImage[],
  outputPath: string
): Promise<{ status: 'success' | 'error', output?: string, size?: number, message?: string }> {
  try {
    // 使用顶部导入的 AdmZip
    const zip = new AdmZip()

    // 根据第一张图片的实际宽高比设置幻灯片尺寸
    // 不强制使用 4:3 或 16:9，而是匹配图片的实际比例，确保图片完美填充幻灯片
    const firstImg = images[0]
    const aspectRatio = firstImg.width / firstImg.height
    // 固定幻灯片高度为 7.5 inches (6858000 EMU)，宽度按图片比例计算
    const slideHeight = 6858000 // 7.5 inches
    const slideWidth = Math.round(slideHeight * aspectRatio)

    // 收集所有图片的实际扩展名，动态生成 Content Types
    const imageExts = new Set<string>()
    for (const img of images) {
      let ext = path.extname(img.imagePath).toLowerCase().slice(1) || 'png'
      if (ext === 'jpg') ext = 'jpeg'
      imageExts.add(ext)
    }
    const imageContentTypes: Record<string, string> = {
      png: 'image/png',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      bmp: 'image/bmp',
      tiff: 'image/tiff',
    }
    const imageTypeDecls = Array.from(imageExts)
      .map(ext => `<Default Extension="${ext}" ContentType="${imageContentTypes[ext] || 'application/octet-stream'}"/>`)
      .join('\n  ')

    // ============================================================
    // [Content_Types].xml
    // ============================================================
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${imageTypeDecls}
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  ${images.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('\n  ')}
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`

    // ============================================================
    // _rels/.rels
    // ============================================================
    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`

    // ============================================================
    // ppt/presentation.xml
    // ============================================================
    const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst>
    <p:sldMasterId id="2147483648" r:id="rId1"/>
  </p:sldMasterIdLst>
  <p:sldIdLst>
    ${images.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('\n    ')}
  </p:sldIdLst>
  <p:sldSz cx="${slideWidth}" cy="${slideHeight}"/>
  <p:defaultTextStyle/>
</p:presentation>`

    // ============================================================
    // ppt/_rels/presentation.xml.rels
    // ============================================================
    const presentationRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  ${images.map((_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('\n  ')}
</Relationships>`

    // ============================================================
    // ppt/slideMasters/slideMaster1.xml
    // ============================================================
    const slideMaster = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg>
      <p:bgRef idx="1001">
        <a:schemeClr val="bg1"/>
      </p:bgRef>
    </p:bg>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst>
    <p:sldLayoutId id="2147483649" r:id="rId1"/>
  </p:sldLayoutIdLst>
  <p:txStyles>
    <p:titleStyle>
      <a:lvl1pPr algn="ctr"><a:defRPr sz="4400" b="1"/></a:lvl1pPr>
    </p:titleStyle>
    <p:bodyStyle>
      <a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr>
    </p:bodyStyle>
    <p:otherStyle/>
  </p:txStyles>
</p:sldMaster>`

    // ============================================================
    // ppt/slideMasters/_rels/slideMaster1.xml.rels
    // ============================================================
    const slideMasterRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`

    // ============================================================
    // ppt/slideLayouts/slideLayout1.xml
    // ============================================================
    const slideLayout = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
    </p:spTree>
  </p:cSld>
</p:sldLayout>`

    // ============================================================
    // ppt/slideLayouts/_rels/slideLayout1.xml.rels
    // ============================================================
    const slideLayoutRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`

    // ============================================================
    // ppt/theme/theme1.xml (简化版)
    // ============================================================
    const theme = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">
  <a:themeElements>
    <a:clrScheme name="Office">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="44546A"/></a:dk2>
      <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
      <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
      <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
      <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
      <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
      <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
      <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
      <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Office">
      <a:majorFont>
        <a:latin typeface="Calibri Light"/>
        <a:ea typeface=""/>
        <a:cs typeface=""/>
      </a:majorFont>
      <a:minorFont>
        <a:latin typeface="Calibri"/>
        <a:ea typeface=""/>
        <a:cs typeface=""/>
      </a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Office">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
        <a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
        <a:ln w="38100" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`

    // ============================================================
    // docProps/core.xml
    // ============================================================
    const coreProps = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>易转 PDF 转 PPT</dc:title>
  <dc:creator>易转</dc:creator>
  <cp:lastModifiedBy>易转</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`

    // ============================================================
    // docProps/app.xml
    // ============================================================
    const appProps = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>易转</Application>
  <Slides>${images.length}</Slides>
</Properties>`

    // 添加所有基础文件到 ZIP
    zip.addFile('[Content_Types].xml', Buffer.from(contentTypes, 'utf-8'))
    zip.addFile('_rels/.rels', Buffer.from(rootRels, 'utf-8'))
    zip.addFile('ppt/presentation.xml', Buffer.from(presentation, 'utf-8'))
    zip.addFile('ppt/_rels/presentation.xml.rels', Buffer.from(presentationRels, 'utf-8'))
    zip.addFile('ppt/slideMasters/slideMaster1.xml', Buffer.from(slideMaster, 'utf-8'))
    zip.addFile('ppt/slideMasters/_rels/slideMaster1.xml.rels', Buffer.from(slideMasterRels, 'utf-8'))
    zip.addFile('ppt/slideLayouts/slideLayout1.xml', Buffer.from(slideLayout, 'utf-8'))
    zip.addFile('ppt/slideLayouts/_rels/slideLayout1.xml.rels', Buffer.from(slideLayoutRels, 'utf-8'))
    zip.addFile('ppt/theme/theme1.xml', Buffer.from(theme, 'utf-8'))
    zip.addFile('docProps/core.xml', Buffer.from(coreProps, 'utf-8'))
    zip.addFile('docProps/app.xml', Buffer.from(appProps, 'utf-8'))

    // ============================================================
    // 为每张图片创建幻灯片
    // ============================================================
    for (let i = 0; i < images.length; i++) {
      const img = images[i]
      const slideNum = i + 1
      const imgExt = path.extname(img.imagePath).toLowerCase().slice(1) || 'png'
      const mediaName = `image${slideNum}.${imgExt === 'jpg' ? 'jpeg' : imgExt}`

      // 计算图片在幻灯片中的位置
      // 图片填充整个幻灯片（拉伸至幻灯片尺寸），避免白边
      // 对于与首张图片比例一致的页面（同一PDF文档常见情况），不会产生形变
      const picWidth = slideWidth
      const picHeight = slideHeight
      const picX = 0
      const picY = 0

      // 幻灯片 XML
      const slide = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
      <p:pic>
        <p:nvPicPr>
          <p:cNvPr id="${slideNum + 1}" name="图片 ${slideNum}"/>
          <p:cNvPicPr>
            <a:picLocks noChangeAspect="1"/>
          </p:cNvPicPr>
          <p:nvPr/>
        </p:nvPicPr>
        <p:blipFill>
          <a:blip r:embed="rId1"/>
          <a:stretch>
            <a:fillRect/>
          </a:stretch>
        </p:blipFill>
        <p:spPr>
          <a:xfrm>
            <a:off x="${picX}" y="${picY}"/>
            <a:ext cx="${picWidth}" cy="${picHeight}"/>
          </a:xfrm>
          <a:prstGeom prst="rect">
            <a:avLst/>
          </a:prstGeom>
        </p:spPr>
      </p:pic>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr>
    <a:masterClrMapping/>
  </p:clrMapOvr>
</p:sld>`

      // 幻灯片关系文件
      const slideRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${mediaName}"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`

      // 添加幻灯片文件
      zip.addFile(`ppt/slides/slide${slideNum}.xml`, Buffer.from(slide, 'utf-8'))
      zip.addFile(`ppt/slides/_rels/slide${slideNum}.xml.rels`, Buffer.from(slideRels, 'utf-8'))

      // 添加图片文件
      const imgBuffer = fs.readFileSync(img.imagePath)
      zip.addFile(`ppt/media/${mediaName}`, imgBuffer)
    }

    // 确保输出目录存在
    const outputDir = path.dirname(outputPath)
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    // 写入 PPTX 文件
    // 使用 toBuffer() + writeFileSync 代替 writeZip()，避免 adm-zip 的 chmod 导致 ENOENT 错误
    const zipBuffer = zip.toBuffer()
    fs.writeFileSync(outputPath, zipBuffer)

    const size = fs.statSync(outputPath).size
    return {
      status: 'success',
      output: outputPath,
      size,
      message: `PPTX 创建成功，共 ${images.length} 张幻灯片，文件大小: ${(size / 1024).toFixed(1)} KB`
    }
  } catch (err: any) {
    return {
      status: 'error',
      message: `创建 PPTX 失败: ${err.message}`
    }
  }
}

// ============================================================
// XLSX 创建（从 DOCX 表格数据）
// ============================================================

interface TableCell {
  text: string
}

interface TableRow {
  cells: TableCell[]
}

interface TableData {
  rows: TableRow[]
}

/**
 * 从 DOCX 文件中提取表格数据
 * 解析 word/document.xml 中的 <w:tbl> 元素
 * @param docxPath - DOCX 文件路径
 * @returns 表格数据数组
 */
export function extractTablesFromDocx(docxPath: string): TableData[] {
  try {
    // 使用顶部导入的 AdmZip
    const zip = new AdmZip(docxPath)
    const docEntry = zip.getEntry('word/document.xml')
    if (!docEntry) {
      return []
    }

    const xmlContent = docEntry.getData().toString('utf-8')
    const tables: TableData[] = []

    // 提取所有 <w:tbl>...</w:tbl> 块
    const tableRegex = /<w:tbl[\s\S]*?<\/w:tbl>/g
    let tableMatch: RegExpExecArray | null

    while ((tableMatch = tableRegex.exec(xmlContent)) !== null) {
      const tableXml = tableMatch[0]
      const rows: TableRow[] = []

      // 提取所有 <w:tr>...</w:tr> 行
      const rowRegex = /<w:tr[\s\S]*?<\/w:tr>/g
      let rowMatch: RegExpExecArray | null

      while ((rowMatch = rowRegex.exec(tableXml)) !== null) {
        const rowXml = rowMatch[0]
        const cells: TableCell[] = []

        // 提取所有 <w:tc>...</w:tc> 单元格
        const cellRegex = /<w:tc[\s\S]*?<\/w:tc>/g
        let cellMatch: RegExpExecArray | null

        while ((cellMatch = cellRegex.exec(rowXml)) !== null) {
          const cellXml = cellMatch[0]
          // 提取单元格中的文本：<w:t>文本内容</w:t>
          const textParts: string[] = []
          const textRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g
          let textMatch: RegExpExecArray | null
          while ((textMatch = textRegex.exec(cellXml)) !== null) {
            textParts.push(textMatch[1])
          }
          cells.push({ text: textParts.join('') })
        }

        if (cells.length > 0) {
          rows.push({ cells })
        }
      }

      if (rows.length > 0) {
        tables.push({ rows })
      }
    }

    return tables
  } catch (err) {
    console.error('[officeBuilder] 解析 DOCX 表格失败:', err)
    return []
  }
}

/**
 * 从 DOCX 文件中提取所有文本内容（用于没有表格时的回退方案）
 * @param docxPath - DOCX 文件路径
 * @returns 按段落分割的文本行数组
 */
export function extractTextFromDocx(docxPath: string): string[][] {
  try {
    // 使用顶部导入的 AdmZip
    const zip = new AdmZip(docxPath)
    const docEntry = zip.getEntry('word/document.xml')
    if (!docEntry) {
      return []
    }

    const xmlContent = docEntry.getData().toString('utf-8')
    const rows: string[][] = []

    // 提取段落 <w:p>...</w:p>
    const paraRegex = /<w:p[\s\S]*?<\/w:p>/g
    let paraMatch: RegExpExecArray | null

    while ((paraMatch = paraRegex.exec(xmlContent)) !== null) {
      const paraXml = paraMatch[0]
      const textParts: string[] = []
      const textRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g
      let textMatch: RegExpExecArray | null
      while ((textMatch = textRegex.exec(paraXml)) !== null) {
        textParts.push(textMatch[1])
      }
      const line = textParts.join('')
      if (line.trim()) {
        // 按 Tab 或多个空格分割成列
        const columns = line.split(/\t+|\s{2,}/).filter(s => s.trim())
        rows.push(columns.length > 0 ? columns : [line])
      }
    }

    return rows
  } catch (err) {
    console.error('[officeBuilder] 解析 DOCX 文本失败:', err)
    return []
  }
}

/**
 * XML 特殊字符转义
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
  }

/**
 * 列号转字母（0 -> A, 1 -> B, 26 -> AA）
 */
function colIndexToLetter(col: number): string {
  let result = ''
  while (col >= 0) {
    result = String.fromCharCode(65 + (col % 26)) + result
    col = Math.floor(col / 26) - 1
  }
  return result
}

/**
 * 从表格数据创建 XLSX 文件
 * @param tables - 表格数据数组
 * @param fallbackRows - 回退文本行（当没有表格时使用）
 * @param outputPath - 输出 XLSX 路径
 */
export function createXlsxFromTables(
  tables: TableData[],
  fallbackRows: string[][],
  outputPath: string
): { status: 'success' | 'error', output?: string, size?: number, message?: string } {
  try {
    // 使用顶部导入的 AdmZip
    const zip = new AdmZip()

    // 收集所有行数据
    const allRows: string[][] = []

    if (tables.length > 0) {
      // 有表格：将所有表格的行合并
      for (const table of tables) {
        for (const row of table.rows) {
          allRows.push(row.cells.map(c => c.text))
        }
        // 表格之间空一行分隔
        allRows.push([])
      }
    } else if (fallbackRows.length > 0) {
      // 没有表格：使用文本行
      allRows.push(...fallbackRows)
    } else {
      return { status: 'error', message: '未在文档中找到可转换的表格或文本数据' }
    }

    // ============================================================
    // 构建 XLSX 的 XML 结构
    // ============================================================

    // 收集所有字符串（用于 sharedStrings）
    const sharedStrings: string[] = []
    const stringIndexMap = new Map<string, number>()

    function getOrCreateStringIndex(str: string): number {
      if (stringIndexMap.has(str)) {
        return stringIndexMap.get(str)!
      }
      const index = sharedStrings.length
      sharedStrings.push(str)
      stringIndexMap.set(str, index)
      return index
    }

    // 构建行 XML
    let rowsXml = ''
    for (let rowIdx = 0; rowIdx < allRows.length; rowIdx++) {
      const row = allRows[rowIdx]
      let cellsXml = ''
      for (let colIdx = 0; colIdx < row.length; colIdx++) {
        const cellValue = row[colIdx] || ''
        const cellRef = `${colIndexToLetter(colIdx)}${rowIdx + 1}`
        if (cellValue === '') {
          cellsXml += `<c r="${cellRef}"/>`
        } else {
          const strIdx = getOrCreateStringIndex(cellValue)
          cellsXml += `<c r="${cellRef}" t="s"><v>${strIdx}</v></c>`
        }
      }
      rowsXml += `<row r="${rowIdx + 1}">${cellsXml}</row>`
    }

    // 计算最大列数
    const maxCols = Math.max(...allRows.map(r => r.length), 1)

    // [Content_Types].xml
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`

    // _rels/.rels
    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`

    // xl/workbook.xml
    const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Sheet1" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`

    // xl/_rels/workbook.xml.rels
    const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`

    // xl/worksheets/sheet1.xml
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    ${rowsXml}
  </sheetData>
</worksheet>`

    // xl/sharedStrings.xml
    const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">
  ${sharedStrings.map(s => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join('\n  ')}
</sst>`

    // docProps/core.xml
    const coreProps = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>易转 PDF 转 Excel</dc:title>
  <dc:creator>易转</dc:creator>
  <cp:lastModifiedBy>易转</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`

    // docProps/app.xml
    const appProps = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>易转</Application>
</Properties>`

    // 添加所有文件到 ZIP
    zip.addFile('[Content_Types].xml', Buffer.from(contentTypes, 'utf-8'))
    zip.addFile('_rels/.rels', Buffer.from(rootRels, 'utf-8'))
    zip.addFile('xl/workbook.xml', Buffer.from(workbook, 'utf-8'))
    zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(workbookRels, 'utf-8'))
    zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(sheet, 'utf-8'))
    zip.addFile('xl/sharedStrings.xml', Buffer.from(sharedStringsXml, 'utf-8'))
    zip.addFile('docProps/core.xml', Buffer.from(coreProps, 'utf-8'))
    zip.addFile('docProps/app.xml', Buffer.from(appProps, 'utf-8'))

    // 确保输出目录存在
    const outputDir = path.dirname(outputPath)
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    // 写入 XLSX 文件
    // 使用 toBuffer() + writeFileSync 代替 writeZip()，避免 adm-zip 的 chmod 导致 ENOENT 错误
    const zipBuffer = zip.toBuffer()
    fs.writeFileSync(outputPath, zipBuffer)

    const size = fs.statSync(outputPath).size
    const tableCount = tables.length
    return {
      status: 'success',
      output: outputPath,
      size,
      message: `XLSX 创建成功${tableCount > 0 ? `，提取了 ${tableCount} 个表格` : ''}，共 ${allRows.length} 行数据，文件大小: ${(size / 1024).toFixed(1)} KB`
    }
  } catch (err: any) {
    return {
      status: 'error',
      message: `创建 XLSX 失败: ${err.message}`
    }
  }
}
