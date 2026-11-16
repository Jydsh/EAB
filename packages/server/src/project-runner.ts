/**
 * 项目命令执行器（P0，对齐 DSH 的 shell 执行器思路）。
 *
 * DSH 在 Windows 上默认用 `dsh-pwsh-local` 直接跑
 * `pwsh -NoLogo -NoProfile -NonInteractive -Command <command>`；需要隔离时
 * 才叠 `dsh-pwsh-sandbox`，底层是 Windows ACL 受限令牌，不是 Docker。
 *
 * 这里先实现 DSH 的“本地执行器”这一层：
 * - 每次调用都是全新 shell，不保留 cd / 变量；
 * - cwd 锁定在当前用户工作区内，禁止路径穿越；
 * - 默认 120 秒、最多 600 秒；超时杀进程树；
 * - stdout/stderr 各保留 64 KB 尾部，完整输出交给批次层落盘；
 * - 支持后台任务，给 `npm install`、`dev server` 这类长命令用。
 *
 * 它不做文件隔离，enforcement 明确返回 `none`。共享部署要等后续接入
 * `workspace-write` 沙箱后端；不要把本地执行器当成安全边界。
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EC, EabError } from '@eab/domain'
import { isWithinRoot, safeJoin } from '@eab/workspace'

export type ProjectExecMode = 'off' | 'local'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_SPILL_BYTES = 64 * 1024 * 1024
const MAX_COMMAND_CHARS = 8_000
const KILL_GRACE_MS = 3_000
const MAX_JOBS_PER_USER = 8
const JOB_TTL_MS = 30 * 60_000

export function resolveProjectExecMode(env: NodeJS.ProcessEnv = process.env): ProjectExecMode {
  const raw = (env.EAB_PROJECT_EXEC ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'local' ? 'local' : 'off'
}

export function assertProjectExecEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (resolveProjectExecMode(env) === 'local') return
  throw new EabError(
    EC.FORBIDDEN,
    '项目命令执行未启用。请在服务进程设置 EAB_PROJECT_EXEC=1 后重启；当前为本地执行器，不做文件隔离，共享部署请等待沙箱后端接入。',
    { hint: 'EAB_PROJECT_EXEC=1 pnpm --filter @eab/server dev' },
  )
}

export interface ProjectCommandInput {
  /** 用户工作区根目录；命令只能从这里启动 */
  readonly root: string
  readonly command: string
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export type ProjectCommandStatus = 'running' | 'completed' | 'failed' | 'killed' | 'timedout' | 'aborted'

export interface ProjectCommandResult {
  readonly command: string
  readonly cwd: string
  readonly status: ProjectCommandStatus
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly durationMs: number
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  /** 完整输出，只给工具层落批次，不直接回给模型 */
  readonly fullOutput?: string
  readonly fullBytes?: number
  readonly enforcement: 'none'
}

export interface ProjectCommandHandle {
  readonly id: string
  readonly command: string
  readonly cwd: string
  readonly startedAt: number
  readonly done: Promise<ProjectCommandResult>
  read(): ProjectCommandView
  kill(reason?: string): void
}

export interface ProjectCommandView {
  readonly jobId: string
  readonly command: string
  readonly cwd: string
  readonly status: ProjectCommandStatus
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly durationMs: number
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
}

interface ShellSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly windows: boolean
}

const WIN_ENCODING_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

function winExitWrapper(command: string): string {
  // PowerShell 会把非零的原生退出码归一成 1，直接 `-Command` 会让模型看不到
  // npm test / tsc 的真实 exit code。用 `& { ... }` 包一层再把 $LASTEXITCODE
  // 原样带出去；命令自己 `exit 3` 时仍会先退出 shell，保持 DSH 的语义。
  return `${WIN_ENCODING_PREAMBLE}$global:LASTEXITCODE = 0; & { ${command} }; $eabCommandOk = $?; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if (-not $eabCommandOk) { exit 1 }`
}

function isFileLike(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    return false
  }
}

function pwshCandidates(env: NodeJS.ProcessEnv): string[] {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const systemRoot = env.SystemRoot ?? 'C:\\Windows'
  const candidates = [join(programFiles, 'PowerShell', '7', 'pwsh.exe')]
  for (const entry of (env.PATH ?? '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (trimmed.length > 0) candidates.push(join(trimmed, 'pwsh.exe'))
  }
  candidates.push(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  return candidates
}

function resolveShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ShellSpec {
  const explicit = (env.EAB_PROJECT_SHELL ?? '').trim()
  if (explicit.length > 0) {
    const base = explicit.toLowerCase()
    if (base.includes('pwsh') || base.includes('powershell')) {
      return {
        command: explicit,
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
        windows: true,
      }
    }
    return { command: explicit, args: ['-c'], windows: false }
  }
  if (platform === 'win32') {
    for (const candidate of pwshCandidates(env)) {
      if (isFileLike(candidate)) {
        return {
          command: candidate,
          args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
          windows: true,
        }
      }
    }
    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
      windows: true,
    }
  }
  return { command: env.SHELL?.trim() || 'bash', args: ['-c'], windows: false }
}

function sanitizeEnv(root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (/^EAB_/i.test(key)) continue
    if (/(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIAL|COOKIE|SESSION)/i.test(key)) continue
    clean[key] = value
  }
  clean.NO_COLOR = '1'
  clean.PAGER = 'cat'
  clean.GIT_PAGER = 'cat'
  clean.PYTHONIOENCODING = 'utf-8'
  if (process.platform !== 'win32') clean.TERM = 'dumb'
  clean.EAB_PROJECT_ROOT = root
  return clean
}

function resolveProjectRoot(root: string): string {
  const raw = root.trim()
  if (!raw) throw new EabError(EC.VALIDATION, '项目工作区根目录为空')
  let real: string
  try {
    real = realpathSync(raw)
  } catch {
    throw new EabError(EC.NOT_FOUND, `项目工作区不存在: ${raw}`)
  }
  if (!statSync(real).isDirectory()) throw new EabError(EC.VALIDATION, `项目工作区不是目录: ${raw}`)
  return real
}

function resolveCwd(root: string, cwd: string | undefined): string {
  const raw = (cwd ?? '').trim()
  const target = raw === '' || raw === '.' || raw === './' || raw === '.\\' ? root : safeJoin(root, raw)
  let real: string
  try {
    real = realpathSync(target)
  } catch {
    throw new EabError(EC.NOT_FOUND, `命令工作目录不存在: ${raw || '.'}`)
  }
  if (!statSync(real).isDirectory()) throw new EabError(EC.VALIDATION, `命令工作目录不是文件夹: ${raw || '.'}`)
  if (!isWithinRoot(root, real)) {
    throw new EabError(EC.VALIDATION, `命令工作目录不能跳出项目工作区: ${raw || '.'}`)
  }
  return real
}

function clampTimeout(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_TIMEOUT_MS
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new EabError(EC.VALIDATION, 'timeoutMs 必须是正数')
  return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.round(n)))
}

function normalizeCommand(command: string): string {
  const text = command.trim()
  if (text.length === 0) throw new EabError(EC.VALIDATION, 'command 不能为空')
  if (text.length > MAX_COMMAND_CHARS) {
    throw new EabError(EC.VALIDATION, `command 太长，最多 ${MAX_COMMAND_CHARS} 字符`)
  }
  return text
}

class BoundedBuffer {
  private chunks: Buffer[] = []
  private bytes = 0
  private totalBytes = 0
  private fullChunks: Buffer[] = []
  private fullBytesValue = 0
  private spillComplete = true
  private lossy = false

  constructor(
    private readonly maxBytes: number,
    private readonly captureFull: boolean,
    private readonly maxSpillBytes: number,
  ) {}

  append(chunk: Buffer): void {
    this.totalBytes += chunk.length
    if (this.captureFull && this.spillComplete) {
      if (this.fullBytesValue + chunk.length <= this.maxSpillBytes) {
        this.fullChunks.push(chunk)
        this.fullBytesValue += chunk.length
      } else {
        this.spillComplete = false
        this.lossy = true
      }
    }
    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const first = this.chunks[0]!
      const excess = this.bytes - this.maxBytes
      if (first.length <= excess) {
        this.chunks.shift()
        this.bytes -= first.length
      } else {
        this.chunks[0] = first.subarray(excess)
        this.bytes -= excess
        break
      }
      this.lossy = true
    }
    if (this.bytes > this.maxBytes) this.bytes = this.maxBytes
  }

  text(): string {
    return Buffer.concat(this.chunks, this.bytes).toString('utf8')
  }

  fullText(): string | undefined {
    if (!this.captureFull || !this.spillComplete) return undefined
    return Buffer.concat(this.fullChunks, this.fullBytesValue).toString('utf8')
  }

  get truncated(): boolean {
    return this.lossy || this.totalBytes > this.maxBytes
  }

  get total(): number {
    return this.totalBytes
  }

  get fullSize(): number {
    return this.fullBytesValue
  }
}

function terminateTree(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    // 先让 taskkill 按进程树杀，不能先 child.kill：杀掉 pwsh 后 tree 关系就丢了，
    // 子进程还握着 stdout 管道，close 会拖到子进程自然结束。
    execFile(
      join(systemRoot, 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, timeout: 10_000 },
      () => {
        /* child close 会结算结果 */
      },
    )
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, KILL_GRACE_MS)
    timer.unref()
    return
  }
  try {
    child.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }, KILL_GRACE_MS)
  timer.unref()
}

export function spawnProjectCommand(input: ProjectCommandInput, options: { background?: boolean } = {}): ProjectCommandHandle {
  assertProjectExecEnabled()
  const root = resolveProjectRoot(input.root)
  const cwd = resolveCwd(root, input.cwd)
  const command = normalizeCommand(input.command)
  const timeoutMs = clampTimeout(input.timeoutMs)
  const shell = resolveShell(process.env, process.platform)
  const argvCommand = shell.windows ? winExitWrapper(command) : command
  const startedAt = Date.now()

  const stdout = new BoundedBuffer(MAX_OUTPUT_BYTES, true, MAX_SPILL_BYTES)
  const stderr = new BoundedBuffer(MAX_OUTPUT_BYTES, true, MAX_SPILL_BYTES)
  let child: ChildProcess | null = null
  let status: ProjectCommandStatus = 'running'
  let exitCode: number | null = null
  let signal: NodeJS.Signals | null = null
  let timedOut = false
  let aborted = false
  let settled = false
  let timer: NodeJS.Timeout | null = null
  let killTimer: NodeJS.Timeout | null = null
  let abortListener: (() => void) | null = null

  const clearTimers = (): void => {
    if (timer) clearTimeout(timer)
    if (killTimer) clearTimeout(killTimer)
    timer = null
    killTimer = null
  }

  let resolveDone!: (result: ProjectCommandResult) => void
  const donePromise = new Promise<ProjectCommandResult>((resolvePromise) => {
    resolveDone = resolvePromise
  })

  const id = randomUUID()

  function readView(): ProjectCommandView {
    const elapsed = Date.now() - startedAt
    return {
      jobId: id,
      command,
      cwd,
      status,
      exitCode,
      signal,
      timedOut,
      aborted,
      durationMs: elapsed,
      stdout: stdout.text(),
      stderr: stderr.text(),
      truncated: stdout.truncated || stderr.truncated,
    }
  }

  const handle: ProjectCommandHandle = {
    id,
    command,
    cwd,
    startedAt,
    done: donePromise,
    read: readView,
    kill: () => {
      if (settled) return
      status = 'killed'
      if (child) terminateTree(child)
    },
  }

  const settle = (result: ProjectCommandResult): void => {
    if (settled) return
    settled = true
    clearTimers()
    if (abortListener) input.signal?.removeEventListener('abort', abortListener)
    resolveDone(result)
  }

  try {
    child = spawn(shell.command, [...shell.args, argvCommand], {
      cwd,
      env: sanitizeEnv(root, process.env),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    status = 'failed'
    settle({
      command,
      cwd,
      status,
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: false,
      durationMs: Date.now() - startedAt,
      stdout: '',
      stderr: '',
      truncated: false,
      enforcement: 'none',
    })
    throw new EabError(EC.INTERNAL, `启动命令失败: ${error instanceof Error ? error.message : String(error)}`)
  }

  const settleFrom = (): void => {
    const derived: ProjectCommandStatus = timedOut
      ? 'timedout'
      : aborted
        ? 'aborted'
        : status === 'killed'
          ? 'killed'
          : exitCode === 0
            ? 'completed'
            : 'failed'
    status = derived
    const full = stdout.fullText()
    const errFull = stderr.fullText()
    const fullOutput =
      full === undefined || errFull === undefined
        ? undefined
        : errFull.length > 0
          ? `${full}${full.endsWith('\n') || full.length === 0 ? '' : '\n'}[stderr]\n${errFull}`
          : full
    settle({
      command,
      cwd,
      status,
      exitCode,
      signal,
      timedOut,
      aborted,
      durationMs: Date.now() - startedAt,
      stdout: stdout.text(),
      stderr: stderr.text(),
      truncated: stdout.truncated || stderr.truncated,
      fullOutput,
      fullBytes: stdout.total + stderr.total,
      enforcement: 'none',
    })
  }

  child.stdout?.on('data', (chunk: Buffer) => stdout.append(chunk))
  child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk))
  child.on('error', (error) => {
    if (settled) return
    status = 'failed'
    stderr.append(Buffer.from(`spawn failed: ${error.message}\n`, 'utf8'))
    settleFrom()
  })
  child.on('close', (code, sig) => {
    exitCode = code
    signal = (sig as NodeJS.Signals | null) ?? null
    settleFrom()
  })

  if (!options.background) {
    timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      if (child) terminateTree(child)
    }, timeoutMs)
  }

  if (input.signal) {
    abortListener = () => {
      if (settled) return
      aborted = true
      if (child) terminateTree(child)
    }
    if (input.signal.aborted) abortListener()
    else input.signal.addEventListener('abort', abortListener, { once: true })
  }

  return handle
}

export async function runProjectCommand(input: ProjectCommandInput): Promise<ProjectCommandResult> {
  return spawnProjectCommand(input).done
}

interface ProjectJobRecord {
  readonly ownerKey: string
  readonly handle: ProjectCommandHandle
}

const jobs = new Map<string, ProjectJobRecord>()

function cleanupJobs(now = Date.now()): void {
  for (const [id, record] of jobs) {
    if (record.handle.read().status === 'running') continue
    const finishedAt = record.handle.startedAt + record.handle.read().durationMs
    if (now - finishedAt > JOB_TTL_MS) jobs.delete(id)
  }
}

function ownerKey(companyId: string, userId: string): string {
  return `${companyId}:${userId}`
}

export function startProjectJob(
  owner: { companyId: string; userId: string },
  input: Omit<ProjectCommandInput, 'signal'>,
): ProjectCommandView {
  assertProjectExecEnabled()
  cleanupJobs()
  const key = ownerKey(owner.companyId, owner.userId)
  let running = 0
  for (const record of jobs.values()) {
    if (record.ownerKey === key && record.handle.read().status === 'running') running += 1
  }
  if (running >= MAX_JOBS_PER_USER) {
    throw new EabError(EC.RATE_LIMITED, `同一用户最多同时运行 ${MAX_JOBS_PER_USER} 个项目后台任务，请先 project.job kill 掉不用的任务。`)
  }
  const handle = spawnProjectCommand(input, { background: true })
  jobs.set(handle.id, { ownerKey: key, handle })
  return handle.read()
}

function getJob(owner: { companyId: string; userId: string }, jobId: string): ProjectJobRecord {
  cleanupJobs()
  const record = jobs.get(jobId)
  if (!record) throw new EabError(EC.NOT_FOUND, `项目后台任务不存在或已过期: ${jobId}`)
  if (record.ownerKey !== ownerKey(owner.companyId, owner.userId)) {
    throw new EabError(EC.FORBIDDEN, '这个项目后台任务属于其他用户，当前账号不能操作')
  }
  return record
}

export function readProjectJob(
  owner: { companyId: string; userId: string },
  jobId: string,
): ProjectCommandView {
  return getJob(owner, jobId).handle.read()
}

export function killProjectJob(
  owner: { companyId: string; userId: string },
  jobId: string,
): ProjectCommandView {
  const record = getJob(owner, jobId)
  record.handle.kill('user')
  return record.handle.read()
}

export function listProjectJobs(owner: { companyId: string; userId: string }): ProjectCommandView[] {
  cleanupJobs()
  const key = ownerKey(owner.companyId, owner.userId)
  return [...jobs.values()]
    .filter((record) => record.ownerKey === key)
    .map((record) => record.handle.read())
    .sort((a, b) => b.durationMs - a.durationMs)
}

export const projectRunnerConstants = {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  MAX_SPILL_BYTES,
  MAX_COMMAND_CHARS,
  KILL_GRACE_MS,
  MAX_JOBS_PER_USER,
  JOB_TTL_MS,
} as const
