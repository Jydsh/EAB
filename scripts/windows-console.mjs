/**
 * Windows 控制台的“快速编辑”模式会让鼠标点一下终端就进入选区，输出和 Node
 * 进程一起被挂起，必须再按回车才恢复。EAB 前台启动时在当前窗口关掉它，
 * 不改注册表、不影响其它终端；后台启动没有控制台输出，不需要处理。
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class EabConsoleMode {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr GetStdHandle(int nStdHandle);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);

  public static bool DisableQuickEdit() {
    IntPtr input = GetStdHandle(-10);
    uint mode = 0;
    if (!GetConsoleMode(input, out mode)) return false;
    // ENABLE_EXTENDED_FLAGS 必须先打开，ENABLE_QUICK_EDIT_MODE 才会被真正关闭。
    mode |= 0x0080u;
    mode &= ~0x0040u;
    return SetConsoleMode(input, mode);
  }
}
"@
if (-not [EabConsoleMode]::DisableQuickEdit()) { exit 1 }
`

export function disableWindowsQuickEdit() {
  if (process.platform !== 'win32') return false
  if (process.env.EAB_KEEP_QUICK_EDIT === '1') return false
  if (!process.stdin?.isTTY) return false
  if (process.env.EAB_QUICK_EDIT_GUARDED === '1') return true
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (!existsSync(powershell)) return false
  const encoded = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64')
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    // 必须继承 stdin 才能拿到当前控制台的输入句柄；不需要它的输出。
    stdio: ['inherit', 'ignore', 'ignore'],
    windowsHide: true,
    timeout: 5000,
  })
  return result.status === 0
}
