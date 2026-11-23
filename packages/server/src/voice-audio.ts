/**
 * 钉钉原生语音需要 OGG/Opus 或 AMR。当前 TTS 端点稳定输出 mp3/wav，
 * 这里用随包携带的 ffmpeg 做一次转码，并从 OGG 末页 granule 计算时长。
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { EC, EabError } from '@eab/domain'

const OGG_OPUS_BITRATE = '32k'
const OGG_OPUS_SAMPLE_RATE = '48000'

export interface DingTalkVoiceAudio {
  readonly buffer: Buffer
  readonly mime: 'audio/ogg'
  readonly durationMs: number
  readonly fileName: string
}

/** OGG 每个 page 的 granule 位置在 header 偏移 6，按 48 kHz 换算成毫秒。 */
export function oggOpusDurationMs(buffer: Buffer): number {
  let offset = 0
  let granule = 0n
  while (offset + 27 <= buffer.length) {
    if (buffer.subarray(offset, offset + 4).toString('ascii') !== 'OggS') break
    const nsegs = buffer[offset + 26]
    const tableEnd = offset + 27 + nsegs
    if (tableEnd > buffer.length) break
    const pageGranule = buffer.readBigUInt64LE(offset + 6)
    if (pageGranule > 0n) granule = pageGranule
    let payload = 0
    for (let i = 0; i < nsegs; i += 1) payload += buffer[offset + 27 + i]
    offset = tableEnd + payload
  }
  if (granule <= 0n) return 0
  const ms = Number(granule) / (Number(OGG_OPUS_SAMPLE_RATE) / 1000)
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0
}

function runFfmpeg(args: string[]): Promise<void> {
  const binary = String(ffmpegPath || '').trim()
  if (!binary) {
    return Promise.reject(
      new EabError(EC.UPSTREAM, '语音转码组件缺失，无法生成钉钉语音', {
        hint: '请重新安装服务端依赖，确保 ffmpeg-static 的二进制已下载。',
      }),
    )
  }
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else {
        reject(
          new EabError(EC.UPSTREAM, '语音转码失败，没有生成钉钉语音', {
            details: { code, stderr: stderr.slice(-500) },
          }),
        )
      }
    })
  })
}

/** 把 TTS 返回的 mp3/wav 转成钉钉可播放的 OGG/Opus。 */
export async function toDingTalkVoice(input: Buffer, mime: string): Promise<DingTalkVoiceAudio> {
  if (input.length === 0) throw new EabError(EC.VALIDATION, '语音内容为空，无法发送钉钉语音')
  if (String(mime).toLowerCase().includes('audio/ogg')) {
    const duration = oggOpusDurationMs(input)
    return { buffer: input, mime: 'audio/ogg', durationMs: Math.max(1000, duration), fileName: 'EAB语音.ogg' }
  }

  const dir = await mkdtemp(join(tmpdir(), 'eab-voice-'))
  const inputExt = String(mime).toLowerCase().includes('wav') ? 'wav' : 'mp3'
  const source = join(dir, `source.${inputExt}`)
  const target = join(dir, 'reply.ogg')
  try {
    await writeFile(source, input)
    await runFfmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      source,
      '-c:a',
      'libopus',
      '-b:a',
      OGG_OPUS_BITRATE,
      '-ar',
      OGG_OPUS_SAMPLE_RATE,
      '-ac',
      '1',
      '-f',
      'ogg',
      target,
    ])
    const buffer = await readFile(target)
    if (buffer.length === 0) throw new EabError(EC.UPSTREAM, '语音转码结果为空')
    return {
      buffer,
      mime: 'audio/ogg',
      durationMs: Math.max(1000, oggOpusDurationMs(buffer)),
      fileName: 'EAB语音.ogg',
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
