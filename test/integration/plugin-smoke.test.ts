import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name, inject } from '../../src/index.ts'

/**
 * 用最小桩（node_modules/@deepseek-ai/*）跑一遍「插件装配」，
 * 在没装 DSH 的情况下验证：导入不炸、工具注册齐全、条件工具随图存在变化、生命周期接上了。
 */

function fakeCtx(root: string) {
  const tools: Array<{ name: string; when?: () => boolean }> = []
  const sections: Array<{ name: string }> = []
  const listeners = new Map<string, Array<(...a: any[]) => any>>()
  const logs: string[] = []
  const effects: Array<() => unknown> = []

  return {
    tools,
    sections,
    listeners,
    logs,
    effects,
    ctx: {
      fs: {},
      agents: { get: () => undefined },
      systemPrompt: {
        section(def: { name: string }) {
          sections.push(def)
        },
        getSectionOrder: () => 100,
      },
      tools: {
        register(def: { name: string }, opts?: { when?: () => boolean }) {
          tools.push({ name: def.name, when: opts?.when })
        },
      },
      on(event: string, handler: (...a: any[]) => any) {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
        return () => undefined
      },
      effect(fn: () => unknown) {
        effects.push(fn)
      },
      logger: { info: (m: string) => logs.push(`info ${m}`), warn: (m: string) => logs.push(`warn ${m}`) },
      workingDirectory: { get: () => root, ensure: async () => root },
    },
  }
}

test('插件入口：导出面正确，装配不抛错', async () => {
  assert.equal(name, 'graphfs')
  assert.deepEqual(inject, ['tools', 'fs', 'systemPrompt', 'agents', 'workingDirectory'])

  const root = await mkdtemp(join(tmpdir(), 'graphfs-plugin-'))
  await writeFile(join(root, 'a.md'), '# a\n', 'utf8')
  const fake = fakeCtx(root)

  apply(fake.ctx as never, {
    mode: 'advise',
    maxRounds: 2,
    maxObligations: 5,
    maxDepth: 3,
    maxFileBytes: 1024 * 1024,
    normalize: 'text',
    ignore: ['.git', '.graphfs'],
  } as never)

  // 装配是异步的（open 读图）；让出事件循环
  await new Promise((r) => setTimeout(r, 200))

  const names = fake.tools.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'graphfs_ack',
    'graphfs_apply',
    'graphfs_attach',
    'graphfs_check',
    'graphfs_create',
    'graphfs_init',
    'graphfs_journal',
    'graphfs_link',
    'graphfs_status',
    'graphfs_suggest',
  ])

  // 工具集合必须稳定：不做 when 级别的可见性切换。
  // 图是否存在会在一轮之内变化（graphfs_init 建图），中途改工具集会让宿主
  // 无法表达 "system update"（provider 直接报错），所以所有工具始终注册。
  for (const tool of fake.tools) {
    assert.equal(tool.when, undefined, `${tool.name} 不应注册 when（工具集会随建图中途变化）`)
  }

  // 生命周期接上了两类事件
  assert.ok(fake.listeners.has('fs/observed'))
  assert.ok(fake.listeners.has('agent/turn-stopping'))
  assert.ok(fake.effects.length >= 1, '应当注册 teardown effect')
  assert.ok(fake.sections.some((s) => s.name === 'graphfs'))
})
