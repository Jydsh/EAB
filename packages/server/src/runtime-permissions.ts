/**
 * 运行目录权限收紧。
 *
 * Windows 上 Node 的 `chmod` 只影响只读位，不会改 ACL；数据库、密钥、日志
 * 仍会继承父目录的 `BUILTIN\Users` 读取和 `Authenticated Users` 修改权限。
 * 这里统一把运行目录交给「当前服务账号 + SYSTEM + Administrators」。
 *
 * 目录用 PowerShell `Set-Acl` 一次性替换 DACL，子文件会立即继承，不会像
 * `icacls /T` 那样把子文件 ACL 清空；敏感文件用 `icacls` 单独收紧。
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SYSTEM_SID = '*S-1-5-18'
const ADMINISTRATORS_SID = '*S-1-5-32-544'

function currentWindowsUser(): string | null {
  const username = (process.env.USERNAME ?? '').trim()
  if (!username) return null
  const domain = (process.env.USERDOMAIN ?? '').trim()
  return domain ? `${domain}\\${username}` : username
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function hardenWindowsDirectoryAcl(path: string): void {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$path = ${psQuote(path)}`,
    '$acl = Get-Acl -LiteralPath $path',
    '$acl.SetAccessRuleProtection($true, $false)',
    '@($acl.Access) | ForEach-Object { [void]$acl.RemoveAccessRule($_) }',
    '$inheritance = [System.Security.AccessControl.InheritanceFlags]"ContainerInherit,ObjectInherit"',
    '$propagation = [System.Security.AccessControl.PropagationFlags]"None"',
    '$type = [System.Security.AccessControl.AccessControlType]"Allow"',
    '$me = New-Object System.Security.Principal.NTAccount($env:USERNAME)',
    '$system = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")',
    '$admins = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-544")',
    '$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, "FullControl", $inheritance, $propagation, $type)))',
    '$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system, "FullControl", $inheritance, $propagation, $type)))',
    '$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($admins, "FullControl", $inheritance, $propagation, $type)))',
    'Set-Acl -LiteralPath $path -AclObject $acl',
  ].join('; ')
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true,
    stdio: 'ignore',
  })
}

/** 收紧一个文件或目录；不存在时静默跳过。失败由调用方决定是否告警。 */
export function hardenRuntimePath(path: string): void {
  if (!existsSync(path)) return
  const isDirectory = statSync(path).isDirectory()
  if (process.platform !== 'win32') {
    chmodSync(path, isDirectory ? 0o700 : 0o600)
    return
  }
  if (isDirectory) {
    hardenWindowsDirectoryAcl(path)
    return
  }

  const user = currentWindowsUser()
  if (!user) throw new Error('无法解析当前 Windows 账号，跳过运行目录权限收紧')
  execFileSync(
    'icacls',
    [
      path,
      '/inheritance:r',
      '/grant:r',
      `${user}:F`,
      '/grant:r',
      `${SYSTEM_SID}:F`,
      '/grant:r',
      `${ADMINISTRATORS_SID}:F`,
    ],
    { windowsHide: true, stdio: 'ignore' },
  )
}

/**
 * 运行目录的一次性收紧。目录 DACL 改完后新文件会自动继承，不需要每次启动
 * 再递归传播；用标记文件避免每次启动都触发 Windows 重算整棵子树的 ACL。
 */
export function hardenRuntimeDir(path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) return
  const marker = join(path, '.runtime-acl-v1')
  if (existsSync(marker)) return
  hardenRuntimePath(path)
  writeFileSync(marker, `${new Date().toISOString()}\n`, { encoding: 'utf8', mode: 0o600 })
  hardenRuntimePath(marker)
}
