/**
 * 对话附件的对象存储适配器（S3 / MinIO 兼容，Path-Style 与虚拟主机都支持）。
 *
 * EAB 仍然把本地磁盘当作工作副本：OnlyOffice、Office 工具和同步读取不用改成异步。
 * 但对话附件上传成功后会额外写一份对象存储，读本地缺失时可以按 fileId 回源；
 * 这样个人机器磁盘被清理后，历史会话仍能恢复附件。
 *
 * 不引入 AWS SDK：只用到 PUT / GET / DELETE，签名按 AWS SigV4 实现，减少部署依赖。
 */
import { createHash, createHmac } from 'node:crypto'
import type { ObjectStorageConfig } from './config.js'

const REQUEST_TIMEOUT_MS = 20_000
const ERROR_BODY_LIMIT = 300

export interface AttachmentObjectStore {
  readonly driver: 's3'
  readonly bucket: string
  /** 不含桶名前缀的附件键，用于日志与接口回显。 */
  attachmentKey(companyId: string, ownerUserId: string, fileId: string): string
  put(key: string, buffer: Buffer, contentType: string): Promise<void>
  get(key: string): Promise<Buffer | null>
  delete(key: string): Promise<void>
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest()
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function encodePath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map(encodeRfc3986)
    .join('/')
}

function safeSegment(value: string): string {
  return (
    String(value || '')
      .trim()
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 200) || '_'
  )
}

export function chatAttachmentObjectKey(companyId: string, ownerUserId: string, fileId: string): string {
  return ['chat-attachments', safeSegment(companyId), safeSegment(ownerUserId), safeSegment(fileId)].join('/')
}

class S3AttachmentObjectStore implements AttachmentObjectStore {
  readonly driver = 's3' as const
  readonly bucket: string
  private readonly base: URL
  private readonly prefix: string

  constructor(private readonly config: ObjectStorageConfig) {
    this.bucket = config.bucket
    this.base = new URL(config.endpoint)
    this.prefix = config.prefix.replace(/^\/+|\/+$/g, '')
  }

  attachmentKey(companyId: string, ownerUserId: string, fileId: string): string {
    return chatAttachmentObjectKey(companyId, ownerUserId, fileId)
  }

  private fullKey(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key
  }

  private target(fullKey: string): { url: string; host: string; canonicalUri: string } {
    const basePath = this.base.pathname.replace(/\/+$/, '')
    const objectPath = encodePath(fullKey)
    if (this.config.forcePathStyle) {
      const pathname = `${basePath}/${encodeRfc3986(this.bucket)}/${objectPath}`
      return {
        url: `${this.base.origin}${pathname}`,
        host: this.base.host,
        canonicalUri: pathname || '/',
      }
    }
    const host = `${this.bucket}.${this.base.host}`
    const pathname = `${basePath}/${objectPath}`
    return {
      url: `${this.base.protocol}//${host}${pathname}`,
      host,
      canonicalUri: pathname || '/',
    }
  }

  private signedHeaders(method: string, fullKey: string, payloadHash: string): {
    url: string
    headers: Record<string, string>
  } {
    const target = this.target(fullKey)
    const now = new Date()
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
    const dateStamp = amzDate.slice(0, 8)
    const canonicalHeaders =
      `host:${target.host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
    const canonicalRequest = [
      method,
      target.canonicalUri,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n')
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.config.secretKey}`, dateStamp), this.config.region), 's3'),
      'aws4_request',
    )
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
    return {
      url: target.url,
      headers: {
        host: target.host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        authorization:
          `AWS4-HMAC-SHA256 Credential=${this.config.accessKey}/${scope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
    }
  }

  private async request(
    method: 'PUT' | 'GET' | 'DELETE',
    key: string,
    body?: Buffer,
    contentType?: string,
  ): Promise<Response> {
    const fullKey = this.fullKey(key)
    const payload = body ?? Buffer.alloc(0)
    const payloadHash = sha256Hex(payload)
    const signed = this.signedHeaders(method, fullKey, payloadHash)
    const headers: Record<string, string> = { ...signed.headers }
    if (contentType) headers['content-type'] = contentType
    let response: Response
    try {
      response = await fetch(signed.url, {
        method,
        headers,
        body: method === 'PUT' ? payload : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw new Error(`对象存储请求失败：${(error as Error).message}`)
    }
    if (response.ok) return response
    if (method === 'GET' || method === 'DELETE') {
      if (response.status === 404) return response
    }
    const text = (await response.text().catch(() => '')).slice(0, ERROR_BODY_LIMIT)
    throw new Error(`对象存储 ${method} 失败（HTTP ${response.status}）${text ? `：${text}` : ''}`)
  }

  async put(key: string, buffer: Buffer, contentType: string): Promise<void> {
    await this.request('PUT', key, buffer, contentType)
  }

  async get(key: string): Promise<Buffer | null> {
    const response = await this.request('GET', key)
    if (response.status === 404) return null
    const array = await response.arrayBuffer()
    return Buffer.from(array)
  }

  async delete(key: string): Promise<void> {
    const response = await this.request('DELETE', key)
    if (response.status === 404) return
  }
}

export function createAttachmentObjectStore(
  config: ObjectStorageConfig | undefined | null,
): AttachmentObjectStore | null {
  return config ? new S3AttachmentObjectStore(config) : null
}
