import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { EabError } from '@eab/domain'
import {
  killProjectJob,
  listProjectJobs,
  readProjectJob,
  runProjectCommand,
  spawnProjectCommand,
  startProjectJob,
  projectRunnerConstants,
} from '../src/project-runner.js'

const roots: string[] = []
let previousMode: string | undefined

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'eab-project-runner-'))
  roots.push(root)
  return root
}

async function waitForJob(owner: { companyId: string; userId: string }, jobId: string, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const job = readProjectJob(owner, jobId)
    if (job.status !== 'running') return job
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return readProjectJob(owner, jobId)
}

beforeAll(() => {
  previousMode = process.env.EAB_PROJECT_EXEC
  process.env.EAB_PROJECT_EXEC = '1'
})

afterAll(() => {
  if (previousMode === undefined) delete process.env.EAB_PROJECT_EXEC
  else process.env.EAB_PROJECT_EXEC = previousMode
})

afterEach(() => {
  delete process.env.EAB_PROJECT_EXEC
  process.env.EAB_PROJECT_EXEC = '1'
})

describe('project-runner', () => {
  it('runs a command in a fresh shell and reports stdout, stderr and exit code', async () => {
    const root = makeRoot()
    const result = await runProjectCommand({
      root,
      command: `node -e "console.log('蓝鲸-ok'); console.error('err-line'); process.exit(3)"`,
    })
    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(3)
    expect(result.stdout).toContain('蓝鲸-ok')
    expect(result.stderr).toContain('err-line')
    expect(result.truncated).toBe(false)
    expect(result.enforcement).toBe('none')
  }, 20_000)

  it('starts in the requested subdirectory and refuses traversal outside the root', async () => {
    const root = makeRoot()
    mkdirSync(join(root, 'sub'))
    const result = await runProjectCommand({
      root,
      cwd: 'sub',
      command: `node -e "process.stdout.write(process.cwd())"`,
    })
    expect(result.cwd.toLowerCase()).toContain(`${root}${sep}sub`.toLowerCase())
    await expect(runProjectCommand({ root, cwd: '..', command: 'node -e ""' })).rejects.toBeInstanceOf(EabError)
  }, 20_000)

  it('kills a command at the timeout and reports timedout', async () => {
    const root = makeRoot()
    const started = Date.now()
    const result = await runProjectCommand({
      root,
      timeoutMs: 1_000,
      command: `node -e "setTimeout(() => {}, 5000)"`,
    })
    expect(result.timedOut).toBe(true)
    expect(result.status).toBe('timedout')
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('keeps the tail and full output when a stream exceeds the cap', async () => {
    const root = makeRoot()
    const result = await runProjectCommand({
      root,
      command: `node -e "for (let i = 0; i < 10000; i++) console.log('line-' + i)"`,
    })
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(projectRunnerConstants.MAX_OUTPUT_BYTES)
    expect(result.stdout).toContain('line-4999')
    expect(result.stdout).not.toContain('line-0\n')
    expect(result.fullOutput).toBeTruthy()
    expect((result.fullOutput ?? '').length).toBeGreaterThan(projectRunnerConstants.MAX_OUTPUT_BYTES)
  })

  it('runs background jobs, reads output and enforces ownership', async () => {
    const root = makeRoot()
    const owner = { companyId: 'c1', userId: 'u-project-test' }
    const view = startProjectJob(owner, {
      root,
      command: `node -e "setTimeout(() => console.log('bg-done'), 1200)"`,
    })
    expect(view.status).toBe('running')
    expect(view.jobId).toBeTruthy()
    const running = readProjectJob(owner, view.jobId)
    expect(running.status).toBe('running')
    const done = await waitForJob(owner, view.jobId)
    expect(done.status).toBe('completed')
    expect(done.stdout).toContain('bg-done')
    expect(done.exitCode).toBe(0)
    expect(listProjectJobs(owner).some((job) => job.jobId === view.jobId)).toBe(true)
    expect(() => readProjectJob({ companyId: 'c1', userId: 'other' }, view.jobId)).toThrow(EabError)
  })

  it('starts a background job and can kill it', async () => {
    const root = makeRoot()
    const owner = { companyId: 'c1', userId: 'u-project-kill' }
    const view = startProjectJob(owner, {
      root,
      command: `node -e "setTimeout(() => {}, 5000)"`,
    })
    const killed = killProjectJob(owner, view.jobId)
    expect(killed.status).toBe('killed')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(readProjectJob(owner, view.jobId).status).toBe('killed')
  })

  it('marks aborted when the caller signal aborts', async () => {
    const root = makeRoot()
    const controller = new AbortController()
    const handle = spawnProjectCommand({
      root,
      command: `node -e "setTimeout(() => {}, 5000)"`,
      signal: controller.signal,
    })
    controller.abort()
    const result = await handle.done
    expect(result.aborted).toBe(true)
    expect(result.status).toBe('aborted')
  })
})

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
