/**
 * 控制台「选择目录」：在服务器所在 Windows 桌面弹出系统文件夹选择框。
 *
 * 浏览器出于安全限制拿不到用户选择的绝对目录路径，所以由服务端代弹系统框。
 * 只返回用户选中的路径；路径仍由保存接口做绝对路径、嵌套和可写性校验。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EC, EabError } from '@eab/domain'

const CANCELED = '__EAB_PICK_CANCELED__'
const PICK_TIMEOUT_MS = 120_000
const PICKER_TITLE = '选择 EAB 存储目录'

const PICKER_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  // 透明置顶 owner：让文件夹选择框出现在浏览器窗口上方，而不是躲到后台。
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.Text = "EAB 目录选择"',
  '$owner.StartPosition = "CenterScreen"',
  '$owner.Size = New-Object System.Drawing.Size(1, 1)',
  '$owner.Opacity = 0',
  '$owner.ShowInTaskbar = $false',
  '$owner.TopMost = $true',
  '$owner.Show()',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
  `$d.Description = '${PICKER_TITLE}'`,
  // Windows PowerShell 5.1 的 FolderBrowserDialog 没有这个属性，先判断再设置。
  'if ($d.PSObject.Properties.Name -contains "UseDescriptionForTitle") { $d.UseDescriptionForTitle = $true }',
  '$d.ShowNewFolderButton = $true',
  'if ($env:EAB_PICK_INITIAL) { $d.SelectedPath = $env:EAB_PICK_INITIAL }',
  '$r = $d.ShowDialog($owner)',
  '$owner.Close()',
  `if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [IO.File]::WriteAllText($env:EAB_PICK_RESULT, $d.SelectedPath, (New-Object Text.UTF8Encoding $false)) } else { [IO.File]::WriteAllText($env:EAB_PICK_RESULT, '${CANCELED}', (New-Object Text.UTF8Encoding $false)) }`,
].join('; ')

function windowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const absolute = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(absolute) ? absolute : 'powershell.exe'
}

/** 返回选中的绝对目录；用户取消返回 null。 */
export async function pickSystemDirectory(initial: string): Promise<string | null> {
  if (process.platform !== 'win32') {
    throw new EabError(EC.VALIDATION, '当前操作系统不支持弹出系统文件夹选择框，请使用服务器目录浏览选择路径')
  }
  const tempDir = mkdtempSync(join(tmpdir(), 'eab-pick-dir-'))
  const resultFile = join(tempDir, 'result.txt')
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        windowsPowerShellPath(),
        ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', PICKER_SCRIPT],
        {
          env: { ...process.env, EAB_PICK_INITIAL: initial, EAB_PICK_RESULT: resultFile },
          windowsHide: true,
        },
      )
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new EabError(EC.INTERNAL, '系统文件夹选择框超时未完成，请重试或在服务器目录浏览中选择'))
      }, PICK_TIMEOUT_MS)
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(new EabError(EC.INTERNAL, `无法打开系统文件夹选择框：${error.message}`))
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          reject(new EabError(EC.INTERNAL, `系统文件夹选择框退出异常${stderr ? `：${stderr.trim().slice(0, 200)}` : ''}`))
          return
        }
        resolve()
      })
    })
    if (!existsSync(resultFile)) {
      throw new EabError(EC.INTERNAL, '系统文件夹选择框没有返回路径')
    }
    const text = readFileSync(resultFile, 'utf8').trim()
    if (!text || text === CANCELED) return null
    return text
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}
