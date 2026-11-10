#!/usr/bin/env node
/**
 * 构建桌面端内嵌服务：把 @eab/server 打成单个 server.cjs，并复制静态页面。
 * 产出在 packages/desktop/build/，供 electron-builder 打进安装包。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DESKTOP = join(ROOT, 'packages', 'desktop')
const BUILD_DIR = join(DESKTOP, 'build')
const PUBLIC_SRC = join(ROOT, 'packages', 'server', 'public')
const PUBLIC_DEST = join(BUILD_DIR, 'public')
const MIGRATIONS_SRC = join(ROOT, 'packages', 'storage', 'migrations')
const MIGRATIONS_DEST = join(BUILD_DIR, 'migrations')
const PLUGINS_SRC = join(ROOT, 'plugins')
const PLUGINS_DEST = join(BUILD_DIR, 'plugins')

if (existsSync(BUILD_DIR)) rmSync(BUILD_DIR, { recursive: true, force: true })
mkdirSync(BUILD_DIR, { recursive: true })

await build({
  entryPoints: [join(ROOT, 'packages', 'server', 'src', 'main.ts')],
  outfile: join(BUILD_DIR, 'server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  minify: true,
  logLevel: 'info',
  banner: {
    js: "import { createRequire as __eabCreateRequire } from 'node:module'; const require = __eabCreateRequire(import.meta.url);",
  },
  external: ['electron'],
})

cpSync(PUBLIC_SRC, PUBLIC_DEST, { recursive: true })
cpSync(MIGRATIONS_SRC, MIGRATIONS_DEST, { recursive: true })
cpSync(PLUGINS_SRC, PLUGINS_DEST, { recursive: true, filter: (source) => !source.includes(`${'\\'}.trash${'\\'}`) })
console.log(`桌面端服务已构建：${join(BUILD_DIR, 'server.mjs')}`)
console.log(`静态页面 / 迁移 / 插件已复制到：${BUILD_DIR}`)
