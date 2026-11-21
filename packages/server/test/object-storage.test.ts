import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createAttachmentObjectStore } from '../src/object-storage.js'
import type { ObjectStorageConfig } from '../src/config.js'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function mockS3(): Promise<{ endpoint: string; objects: Map<string, Buffer>; authHeaders: string[] }> {
  const objects = new Map<string, Buffer>()
  const authHeaders: string[] = []
  const server = createServer(async (req, res) => {
    if (req.headers.authorization) authHeaders.push(req.headers.authorization)
    const key = decodeURIComponent(String(req.url || ''))
    if (req.method === 'PUT') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      objects.set(key, Buffer.concat(chunks))
      res.statusCode = 200
      res.end()
      return
    }
    if (req.method === 'GET') {
      const body = objects.get(key)
      if (!body) {
        res.statusCode = 404
        res.end('not found')
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'application/octet-stream')
      res.end(body)
      return
    }
    if (req.method === 'DELETE') {
      const existed = objects.delete(key)
      res.statusCode = existed ? 204 : 404
      res.end()
      return
    }
    res.statusCode = 405
    res.end()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return { endpoint: `http://127.0.0.1:${port}`, objects, authHeaders }
}

function config(endpoint: string, overrides: Partial<ObjectStorageConfig> = {}): ObjectStorageConfig {
  return {
    driver: 's3',
    endpoint,
    bucket: 'eab-test',
    region: 'us-east-1',
    accessKey: 'AKIDEXAMPLE',
    secretKey: 'secret-example',
    prefix: 'eab',
    forcePathStyle: true,
    required: false,
    ...overrides,
  }
}

describe('S3/MinIO 对象存储适配器', () => {
  it('PUT / GET / DELETE 走 Path-Style 桶路径，并带 SigV4 签名', async () => {
    const s3 = await mockS3()
    const store = createAttachmentObjectStore(config(s3.endpoint))
    expect(store).not.toBeNull()
    const key = store!.attachmentKey('c1', 'u 1', 'file/1')
    await store!.put(key, Buffer.from('对象正文'), 'text/plain')
    expect(s3.objects.get('/eab-test/eab/chat-attachments/c1/u_1/file_1')?.toString('utf8')).toBe('对象正文')
    expect(s3.authHeaders[0]).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//)
    expect(s3.authHeaders[0]).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date')

    await expect(store!.get(key)).resolves.toEqual(Buffer.from('对象正文'))
    await store!.delete(key)
    await expect(store!.get(key)).resolves.toBeNull()
  })

  it('未配置时返回 null，不产生网络调用', () => {
    expect(createAttachmentObjectStore(undefined)).toBeNull()
    expect(createAttachmentObjectStore(null)).toBeNull()
  })
})
