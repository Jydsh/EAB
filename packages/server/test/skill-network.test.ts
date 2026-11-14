import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageSkillFromArchive, stageSkillFromGithub } from '../src/skill-network.js'

const MANIFEST = {
  id: 'network-skill',
  name: '网络技能示例',
  version: '1.0.0',
  description: '从网络下载并安装的技能包',
  author: 'EAB',
  level: 'L0',
  scopes: ['chat:use', 'skill:list', 'skill:use'],
  triggers: ['网络技能'],
  tools: [],
}

function makeSkillPackage(root: string, relative: string): string {
  const dir = join(root, relative)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'skill.json'), JSON.stringify(MANIFEST, null, 2))
  writeFileSync(join(dir, 'SKILL.md'), '# 网络技能示例\n\n只回答测试问题。\n')
  return dir
}

function makeTarGz(root: string, folder: string, archive: string): void {
  execFileSync('tar', ['-czf', archive, '-C', root, folder], { stdio: 'ignore' })
}

describe('skill network sources', () => {
  let root: string
  let server: Server
  let baseUrl: string
  let previousAllowPrivate: string | undefined
  let previousApi: string | undefined
  let previousCodeload: string | undefined

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'eab-skill-network-test-'))
    previousAllowPrivate = process.env.EAB_SKILL_ALLOW_PRIVATE_NETWORK
    previousApi = process.env.EAB_GITHUB_API
    previousCodeload = process.env.EAB_GITHUB_CODELOAD
    process.env.EAB_SKILL_ALLOW_PRIVATE_NETWORK = '1'

    const packageRoot = join(root, 'package')
    makeSkillPackage(packageRoot, 'repo-main/skills/network-skill')
    const archive = join(root, 'network-skill.tar.gz')
    makeTarGz(packageRoot, 'repo-main', archive)
    const archiveBody = readFileSync(archive)

    server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (url.pathname === '/network-skill.tar.gz') {
        res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': archiveBody.length })
        res.end(archiveBody)
        return
      }
      if (url.pathname === '/api/repos/owner/repo') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ default_branch: 'main' }))
        return
      }
      if (url.pathname === '/codeload/owner/repo/tar.gz/main') {
        res.writeHead(200, { 'content-type': 'application/gzip' })
        res.end(archiveBody)
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')
    baseUrl = `http://127.0.0.1:${address.port}`
    process.env.EAB_GITHUB_API = `${baseUrl}/api`
    process.env.EAB_GITHUB_CODELOAD = `${baseUrl}/codeload`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
    if (previousAllowPrivate === undefined) delete process.env.EAB_SKILL_ALLOW_PRIVATE_NETWORK
    else process.env.EAB_SKILL_ALLOW_PRIVATE_NETWORK = previousAllowPrivate
    if (previousApi === undefined) delete process.env.EAB_GITHUB_API
    else process.env.EAB_GITHUB_API = previousApi
    if (previousCodeload === undefined) delete process.env.EAB_GITHUB_CODELOAD
    else process.env.EAB_GITHUB_CODELOAD = previousCodeload
  })

  it('downloads a tar.gz URL, finds the skill root and strips query from sourceRef', async () => {
    const staged = await stageSkillFromArchive({ url: `${baseUrl}/network-skill.tar.gz?token=secret` })
    try {
      expect(staged.source).toBe('http')
      expect(staged.dir).toContain('skills')
      expect(staged.sourceRef).toBe(`url:${baseUrl}/network-skill.tar.gz`)
    } finally {
      staged.cleanup()
    }
  })

  it('downloads a GitHub subdirectory and records a reproducible sourceRef', async () => {
    const staged = await stageSkillFromGithub({ repo: 'owner/repo', subdir: 'skills/network-skill' })
    try {
      expect(staged.source).toBe('git')
      expect(staged.sourceRef).toBe('github:owner/repo#main?dir=skills%2Fnetwork-skill')
      expect(staged.dir.endsWith('network-skill')).toBe(true)
    } finally {
      staged.cleanup()
    }
  })

  it('refuses localhost downloads unless the private-network switch is explicitly enabled', async () => {
    delete process.env.EAB_SKILL_ALLOW_PRIVATE_NETWORK
    await expect(stageSkillFromArchive({ url: `${baseUrl}/network-skill.tar.gz` })).rejects.toThrow(
      'EAB_SKILL_ALLOW_PRIVATE_NETWORK',
    )
  })
})
