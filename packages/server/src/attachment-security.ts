/**
 * 对话附件的类型与恶意文件检查。
 *
 * 不依赖外部杀毒服务也能拦住最常见的风险：
 * - 可执行文件、脚本、快捷方式、压缩包等主动内容直接拒绝；
 * - 按扩展名校验魔数，防止 exe 改名为 pdf/docx 后进入解析器；
 * - OOXML 先看 ZIP 包内是否真有对应文档入口，拒绝伪装包；
 * - 检测 EICAR 标准测试串，供部署侧验证拦截链路；
 * - 限制 OOXML 解压总量，避免压缩炸弹把内存打满。
 *
 * 这是入口级兜底，不替代 ClamAV/企业杀毒；文件通过检查后仍按不可信内容处理。
 */
import { extname } from 'node:path'
import { unzipSync } from 'fflate'
import { EC, EabError } from '@eab/domain'

export const EICAR_SIGNATURE = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'

const OOXML_MAX_TOTAL_BYTES = 128 * 1024 * 1024
const OOXML_MAX_ENTRIES = 10_000
const OOXML_MAX_REQUIRED_BYTES = 32 * 1024 * 1024

const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.dll', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse',
  '.wsf', '.wsh', '.scr', '.msi', '.msp', '.cpl', '.hta', '.jar', '.apk', '.dex', '.so',
  '.dylib', '.sys', '.drv', '.lnk', '.pif', '.reg', '.chm', '.hlp', '.url',
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.cab', '.arj', '.ace',
  '.iso', '.img', '.vhd', '.vhdx', '.svg', '.html', '.htm', '.xhtml',
])

const ACTIVE_MAGIC_LABELS: Array<{ label: string; test: (buffer: Buffer) => boolean }> = [
  { label: 'Windows 可执行文件', test: (b) => b.subarray(0, 2).toString('latin1') === 'MZ' },
  { label: 'ELF 可执行文件', test: (b) => b.subarray(0, 4).toString('latin1') === '\x7fELF' },
  {
    label: 'Mach-O 可执行文件',
    test: (b) => {
      const magic = b.subarray(0, 4).toString('hex')
      return magic === 'feedface' || magic === 'feedfacf' || magic === 'cefaedfe' || magic === 'cffaedfe'
    },
  },
  { label: 'Java 字节码', test: (b) => b.subarray(0, 4).toString('hex') === 'cafebabe' },
  { label: '7-Zip 压缩包', test: (b) => b.subarray(0, 6).toString('hex') === '377abcaf271c' },
  { label: 'RAR 压缩包', test: (b) => b.subarray(0, 4).toString('latin1') === 'Rar!' },
  { label: 'GZip 压缩包', test: (b) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b },
]

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
  if (buffer.length < bytes.length) return false
  for (let index = 0; index < bytes.length; index += 1) {
    if (buffer[index] !== bytes[index]) return false
  }
  return true
}

function isZip(buffer: Buffer): boolean {
  return startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buffer, [0x50, 0x4b, 0x05, 0x06])
}

function isOle(buffer: Buffer): boolean {
  return startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
}

function isPng(buffer: Buffer): boolean {
  return startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
}

function isJpeg(buffer: Buffer): boolean {
  return startsWith(buffer, [0xff, 0xd8, 0xff])
}

function isGif(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 6).toString('latin1')
  return head === 'GIF87a' || head === 'GIF89a'
}

function isWebp(buffer: Buffer): boolean {
  return buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP'
}

function isBmp(buffer: Buffer): boolean {
  return buffer.subarray(0, 2).toString('latin1') === 'BM'
}

function isTiff(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 4).toString('hex')
  return head === '49492a00' || head === '4d4d002a'
}

function hasActiveMagic(buffer: Buffer): string | null {
  return ACTIVE_MAGIC_LABELS.find((item) => item.test(buffer))?.label ?? null
}

function compactOoxml(buffer: Buffer, required: readonly string[]): void {
  let entries = 0
  let totalBytes = 0
  let extracted: Record<string, Uint8Array>
  try {
    extracted = unzipSync(buffer, {
      filter: (file) => {
        entries += 1
        totalBytes += file.originalSize
        if (entries > OOXML_MAX_ENTRIES) {
          throw new Error(`压缩包内文件过多（超过 ${OOXML_MAX_ENTRIES} 个）`)
        }
        if (totalBytes > OOXML_MAX_TOTAL_BYTES) {
          throw new Error(`压缩包解压后超过 ${OOXML_MAX_TOTAL_BYTES / 1024 / 1024} MB`)
        }
        const wanted = required.includes(file.name)
        if (wanted && file.originalSize > OOXML_MAX_REQUIRED_BYTES) {
          throw new Error(`文档主结构文件超过 ${OOXML_MAX_REQUIRED_BYTES / 1024 / 1024} MB`)
        }
        return wanted
      },
    })
  } catch (error) {
    throw new EabError(EC.VALIDATION, `Office 文件结构不合法或疑似压缩炸弹：${(error as Error).message}`, {
      hint: '请用 Office/WPS 重新另存后再发送，不要发送压缩包或损坏文件。',
    })
  }
  const missing = required.find((name) => !extracted[name])
  if (missing) {
    throw new EabError(EC.VALIDATION, '文件内容与扩展名不符：缺少 Office 文档主结构', {
      details: { missing },
      hint: '请确认文件没有被改名或损坏；可另存为新的 docx/xlsx/pptx 后重试。',
    })
  }
}

function assertExtMagic(extension: string, buffer: Buffer): void {
  switch (extension) {
    case '.pdf':
      if (!startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
        throw new EabError(EC.VALIDATION, 'PDF 文件头不正确，可能被改名或已损坏', {
          hint: '请从原始来源重新下载 PDF 后再发送。',
        })
      }
      return
    case '.docx':
      if (!isZip(buffer)) {
        throw new EabError(EC.VALIDATION, 'DOCX 内容不是有效的 Office 压缩包，可能被改名')
      }
      compactOoxml(buffer, ['[Content_Types].xml', 'word/document.xml'])
      return
    case '.xlsx':
    case '.xlsm':
      if (!isZip(buffer)) throw new EabError(EC.VALIDATION, 'Excel 内容不是有效的 Office 压缩包，可能被改名')
      compactOoxml(buffer, ['[Content_Types].xml', 'xl/workbook.xml'])
      return
    case '.pptx':
      if (!isZip(buffer)) throw new EabError(EC.VALIDATION, 'PPTX 内容不是有效的 Office 压缩包，可能被改名')
      compactOoxml(buffer, ['[Content_Types].xml', 'ppt/presentation.xml'])
      return
    case '.doc':
    case '.xls':
    case '.ppt':
      if (!isOle(buffer)) {
        throw new EabError(EC.VALIDATION, `${extension} 内容不是有效的旧版 Office 文件，可能被改名`, {
          hint: '建议用 Office/WPS 另存为 docx/xlsx/pptx 后再发送。',
        })
      }
      return
    case '.png':
      if (!isPng(buffer)) throw new EabError(EC.VALIDATION, '图片内容不是有效的 PNG，可能被改名')
      return
    case '.jpg':
    case '.jpeg':
      if (!isJpeg(buffer)) throw new EabError(EC.VALIDATION, '图片内容不是有效的 JPEG，可能被改名')
      return
    case '.gif':
      if (!isGif(buffer)) throw new EabError(EC.VALIDATION, '图片内容不是有效的 GIF，可能被改名')
      return
    case '.webp':
      if (!isWebp(buffer)) throw new EabError(EC.VALIDATION, '图片内容不是有效的 WEBP，可能被改名')
      return
    case '.bmp':
      if (!isBmp(buffer)) throw new EabError(EC.VALIDATION, '图片内容不是有效的 BMP，可能被改名')
      return
    case '.tif':
    case '.tiff':
      if (!isTiff(buffer)) throw new EabError(EC.VALIDATION, '图片内容不是有效的 TIFF，可能被改名')
      return
    case '.txt':
    case '.md':
    case '.markdown':
    case '.csv':
    case '.tsv':
    case '.json':
    case '.jsonl':
    case '.log':
    case '.xml':
    case '.yaml':
    case '.yml':
    case '.ini':
    case '.conf': {
      // 文本类只要出现 NUL 就按二进制伪装拒绝；UTF-16 文本请先另存为 UTF-8。
      if (buffer.subarray(0, 8192).includes(0)) {
        throw new EabError(EC.VALIDATION, '文本文件包含二进制内容，可能被改名', {
          hint: '请另存为 UTF-8 文本后再发送。',
        })
      }
      return
    }
    default: {
      const active = hasActiveMagic(buffer)
      if (active) throw new EabError(EC.VALIDATION, `文件内容疑似${active}，已拦截`)
      if (isZip(buffer)) {
        throw new EabError(EC.VALIDATION, '压缩包不能作为对话附件发送', {
          hint: '请先解压，只发送需要的具体文件。',
        })
      }
    }
  }
}

export interface ChatAttachmentInspection {
  readonly extension: string
  readonly mime: string
}

/** 对话附件统一落在个人云空间的「对话附件」目录；只有这个目录走附件安全策略。 */
export function isChatAttachmentRelPath(relPath: string): boolean {
  return String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .startsWith('对话附件/')
}

/**
 * 检查一个即将进入对话的附件。通过返回标准化后的扩展名/MIME，失败抛 400。
 * 只用于对话附件入口；云空间普通文件不因为业务需要被一刀切限制。
 */
export function inspectChatAttachment(input: {
  filename: string
  mime?: string | null
  buffer: Buffer
}): ChatAttachmentInspection {
  const filename = String(input.filename || '').trim()
  const extension = extname(filename).toLowerCase()
  if (!filename) throw new EabError(EC.VALIDATION, '附件名称不能为空')
  if (!extension) {
    throw new EabError(EC.VALIDATION, '附件缺少扩展名，无法确认文件类型', {
      hint: '请给文件补上正确扩展名后再发送。',
    })
  }
  if (BLOCKED_EXTENSIONS.has(extension)) {
    throw new EabError(EC.VALIDATION, `不允许发送 ${extension} 类型的附件`, {
      details: { extension },
      hint: '可执行文件、脚本、快捷方式和压缩包不能进入对话；请发送解压后的文档、图片或文本。',
    })
  }
  if (input.buffer.length === 0) {
    throw new EabError(EC.VALIDATION, '附件内容为空')
  }
  if (input.buffer.includes(EICAR_SIGNATURE)) {
    throw new EabError(EC.VALIDATION, '附件命中病毒测试特征（EICAR），已拒绝', {
      details: { signature: 'EICAR-Test-File' },
      hint: '这是用于验证拦截链路的标准测试串，不是真实病毒；真实文件请扫描后再发送。',
    })
  }
  const active = hasActiveMagic(input.buffer)
  if (active) {
    throw new EabError(EC.VALIDATION, `文件内容疑似${active}，已拦截`, {
      details: { extension },
      hint: '请确认文件来源，并改为发送文档、图片或文本。',
    })
  }
  assertExtMagic(extension, input.buffer)
  return {
    extension,
    mime: String(input.mime || '').trim() || 'application/octet-stream',
  }
}
