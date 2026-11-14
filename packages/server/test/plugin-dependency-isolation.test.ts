import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  preparePluginDependencies,
  type HostInstance,
} from '../src/plugin-host.js'

describe('插件依赖启动隔离', () => {
  it('单个插件依赖安装失败只记在实例上，不中断其他插件启动', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eab-plugin-dep-probe-'))
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify(
        {
          name: 'eab-plugin-dependency-probe',
          version: '0.0.0',
          dependencies: {
            'eab-plugin-missing-dependency-probe': 'file:./missing-package',
          },
        },
        null,
        2,
      ),
    )
    const instance = {
      instanceKey: 'c1:eab-plugin-dependency-probe:company',
      id: 'eab-plugin-dependency-probe',
      companyId: 'c1',
      scope: { kind: 'company' },
      dataRoot: dir,
      record: {
        id: 'eab-plugin-dependency-probe',
        dir,
        dsh: { hostEntry: 'lib/index.js' },
      },
      logs: [],
    } as unknown as HostInstance
    try {
      const errors = await preparePluginDependencies([instance])
      expect(errors.has(dir)).toBe(true)
      expect(errors.get(dir)?.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
