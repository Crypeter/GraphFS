import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphFS } from '../../src/workspace/graphfs.ts'
import { digest16 } from '../../src/core/hash.ts'

const EN = '# Demo\n\nIntro.\n\n## Summary\n\nhello\n\n## Usage\n\nuse it\n'
const ZH = '# 演示\n\n前言。\n\n## 概述\n\n你好\n\n## 用法\n\n用它\n'

const pair = (en: string, zh: string) => ({ en: digest16(en), zh: digest16(zh) })
const RECORDS = [
  ['/demo', pair('# Demo\nIntro.', '# 演示\n前言。')],
  ['/demo/summary', pair('## Summary\nhello', '## 概述\n你好')],
  ['/demo/usage', pair('## Usage\nuse it', '## 用法\n用它')],
] as const

function ledger(): string {
  return [
    ...RECORDS.flatMap(([key, value]) => [`${key}:`, `  en: ${value.en}`, `  zh: ${value.zh}`]),
    '',
  ].join('\n')
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'graphfs-import-'))
  const pkg = join(root, 'pkgs/demo')
  await mkdir(pkg, { recursive: true })
  await writeFile(join(pkg, 'README.md'), EN, 'utf8')
  await writeFile(join(pkg, 'README.zh.md'), ZH, 'utf8')
  await writeFile(join(pkg, 'README.i18n.yaml'), ledger(), 'utf8')
  return root
}

test('import i18n：建 3 条边、基线等于账本、check 干净、账本本身标 unmanaged', async () => {
  const root = await workspace()
  const gfs = await GraphFS.open({ root, actor: 'importer', normalize: 'dsh-i18n-v1' })

  const report = await gfs.importI18n({ write: true })
  assert.equal(report.packages, 1)
  assert.equal(report.edges, 3)
  assert.equal(report.nodes, 6)
  assert.equal(report.verified, 3)
  assert.equal(report.unverified, 0)
  assert.equal(report.write, true)

  const check = await gfs.check()
  assert.equal(check.clean, 3)
  assert.equal(check.drift.length, 0)
  assert.equal(check.orphans.length, 0)
  assert.equal(check.unlinked.length, 0)

  const edge = [...gfs.snapshot!.edges.values()][0]!
  assert.equal(edge.relation, 'translates')
  assert.equal(edge.fromHash, RECORDS[0]![1].en)
  assert.equal(edge.toHash, RECORDS[0]![1].zh)

  // 账本文件声明为 unmanaged（派生来源，不是一致性单元）
  assert.equal(gfs.snapshot!.unmanaged.has('pkgs/demo/README.i18n.yaml'), true)
  assert.equal(
    gfs.snapshot!.unmanagedReasons.get('pkgs/demo/README.i18n.yaml'),
    'i18n ledger (import source)',
  )

  // 审计
  const journal = await gfs.auditTail(5)
  assert.equal(journal.at(-1)!.kind, 'import')
})

test('import i18n：重复导入幂等（不重复建节点/边）', async () => {
  const root = await workspace()
  const gfs = await GraphFS.open({ root, normalize: 'dsh-i18n-v1' })
  await gfs.importI18n({ write: true })

  const again = await gfs.importI18n({ write: true })
  assert.equal(again.nodes, 0)
  assert.equal(again.edges, 0)
  assert.equal(gfs.snapshot!.edges.size, 3)
})

test('import i18n：不预览写盘时 snapshot 不变', async () => {
  const root = await workspace()
  const gfs = await GraphFS.open({ root, normalize: 'dsh-i18n-v1' })
  const report = await gfs.importI18n({ write: false })
  assert.equal(report.edges, 3)
  assert.equal(report.write, false)
  assert.equal(gfs.snapshot, null)
})

test('import i18n：归一化口径不对时直接拒绝', async () => {
  const root = await workspace()
  const gfs = await GraphFS.open({ root }) // normalize 默认 text

  await assert.rejects(
    () => gfs.importI18n({ write: true }),
    (error: unknown) => (error as { code?: string }).code === 'GF_UNIT_MISMATCH',
  )
})

test('import i18n：结构漂移的包被跳过，其余照常导入', async () => {
  const root = await workspace()
  // 同一个工作区里再放一个结构漂移的包（中文少一节）
  const bad = join(root, 'pkgs/bad')
  await mkdir(bad, { recursive: true })
  await writeFile(join(bad, 'README.md'), EN, 'utf8')
  await writeFile(join(bad, 'README.zh.md'), '# 演示\n\n## 概述\n\n你好\n', 'utf8')
  await writeFile(join(bad, 'README.i18n.yaml'), ledger(), 'utf8')

  const gfs = await GraphFS.open({ root, normalize: 'dsh-i18n-v1' })
  const report = await gfs.importI18n({ write: true })

  assert.equal(report.packages, 2)
  assert.equal(report.skipped, 1)
  assert.equal(report.edges, 3)
  assert.ok(report.issues.some((issue) => issue.code === 'GF_UNIT_MISMATCH' && issue.message.startsWith('pkgs/bad')))
})

test('重新打开时采用图文件记录的归一化口径（除非显式指定）', async () => {
  const root = await workspace()
  const gfs = await GraphFS.open({ root, normalize: 'dsh-i18n-v1' })
  await gfs.importI18n({ write: true })

  const implicit = await GraphFS.open({ root })
  assert.equal(implicit.config.normalize, 'dsh-i18n-v1')
  assert.equal((await implicit.check()).drift.length, 0)

  const explicit = await GraphFS.open({ root, normalize: 'text', normalizeLocked: true })
  assert.equal(explicit.config.normalize, 'text')
  assert.equal((await explicit.check()).drift.length, 3, '显式口径应当覆盖图里的记录')
})
