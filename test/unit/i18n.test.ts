import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importI18n, parseLedger, sectionize, slugifyHeading } from '../../src/importers/i18n.ts'
import { digest16 } from '../../src/core/hash.ts'

const EN = `# Demo

Intro paragraph.

## Summary

hello

\`\`\`js
console.log(1)
\`\`\`

## Usage

use it
`

const ZH = `# 演示

前言。

## 概述

你好

## 用法

用它
`

const record = (enText: string, zhText: string) => ({ en: digest16(enText), zh: digest16(zhText) })

const RECORDS: Array<[string, { en: string; zh: string }]> = [
  ['/demo', record('# Demo\nIntro paragraph.', '# 演示\n前言。')],
  ['/demo/summary', record('## Summary\nhello', '## 概述\n你好')],
  ['/demo/usage', record('## Usage\nuse it', '## 用法\n用它')],
]

function ledger(records: Array<[string, { en: string; zh: string }]>): string {
  return [
    '# 测试账本',
    ...records.flatMap(([key, value]) => [`${key}:`, `  en: ${value.en}`, `  zh: ${value.zh}`]),
    '',
  ].join('\n')
}

function reader(files: Record<string, string>): (path: string) => Promise<string | null> {
  return async (path) => files[path] ?? null
}

test('slugifyHeading：与账本同口径', () => {
  assert.equal(slugifyHeading('@deepseek-ai/dsh-atomic-write'), 'deepseek-ai-dsh-atomic-write')
  assert.equal(slugifyHeading('The `dsh` feedback command'), 'the-dsh-feedback-command')
  assert.equal(slugifyHeading("Drive an agent's conversation"), 'drive-an-agents-conversation')
})

test('sectionize：代码块里的 # 不算标题；节范围含标题前的锚点', () => {
  const sections = sectionize(
    ['# A', '', '<a id="b"></a>', '## B', '', '```sh', '# not a heading', '```', '', 'tail', ''].join('\n'),
  )
  assert.deepEqual(
    sections.map((s) => s.path),
    ['/', '/a', '/a/b'],
  )
  // 锚点属于 A 节（在下一个标题之前）
  assert.equal(sections[1]!.text, '# A\n<a id="b"></a>')
  assert.equal(sections[2]!.text, '## B\ntail')
})

test('sectionize：前言是第一个标题之前的行', () => {
  const sections = sectionize('---\ntitle: x\n---\n# T\n\nbody\n')
  assert.equal(sections[0]!.path, '/')
  assert.equal(sections[0]!.text, '---\ntitle: x\n---')
  assert.deepEqual([sections[0]!.from, sections[0]!.to], [1, 3])
  assert.equal(sections[1]!.index, 1)
  assert.equal(sections[1]!.text, '# T\nbody')
})

test('parseLedger：保留纯数字指纹（不能被 YAML 当整数，前导零不能丢）', () => {
  const entries = parseLedger(
    ['/a:', '  en: 0123456789012345', '  zh: 9876543210987654', '/b:', '  en: abcdef0123456789', '  zh: fedcba9876543210', ''].join('\n'),
  )
  assert.deepEqual(
    entries.map((e) => [e.key, e.en, e.zh]),
    [
      ['/a', '0123456789012345', '9876543210987654'],
      ['/b', 'abcdef0123456789', 'fedcba9876543210'],
    ],
  )
})

test('importI18n：节点按位置对齐，基线等于账本值', async () => {
  const result = await importI18n({
    read: reader({
      'pkg/README.i18n.yaml': ledger(RECORDS),
      'pkg/README.md': EN,
      'pkg/README.zh.md': ZH,
    }),
    yamlPath: 'pkg/README.i18n.yaml',
    enPath: 'pkg/README.md',
    zhPath: 'pkg/README.zh.md',
    now: '2026-01-01T00:00:00.000Z',
  })

  assert.deepEqual(result.issues, [])
  assert.equal(result.unverified.length, 0)
  assert.equal(result.nodes.length, 6)
  assert.equal(result.edges.length, 3)
  assert.equal(result.verified, 3)

  // 前言不在账本里：第一条记录对应第 1 个标题
  assert.deepEqual(result.nodes[0]!.unit, { kind: 'heading', index: 1 })
  assert.deepEqual(result.nodes[1]!.unit, { kind: 'heading', index: 1 })
  assert.equal(result.nodes[0]!.path, 'pkg/README.md')
  assert.equal(result.nodes[1]!.path, 'pkg/README.zh.md')

  const edge = result.edges[0]!
  assert.equal(edge.relation, 'translates')
  assert.equal(edge.authority, 'from')
  assert.equal(edge.trigger, 'from')
  assert.equal(edge.obligation, 'required')
  assert.equal(edge.fromHash, RECORDS[0]![1].en)
  assert.equal(edge.toHash, RECORDS[0]![1].zh)
  assert.equal(edge.verifiedAt, '2026-01-01T00:00:00.000Z')
})

test('importI18n：账本记了前言时，前言用 lines 区域', async () => {
  const EN2 = '---\ntitle: demo\n---\n# Demo\n\nbody\n'
  const ZH2 = '---\ntitle: 演示\n---\n# 演示\n\n正文\n'
  const recs: Array<[string, { en: string; zh: string }]> = [
    ['/', record('---\ntitle: demo\n---', '---\ntitle: 演示\n---')],
    ['/demo', record('# Demo\nbody', '# 演示\n正文')],
  ]

  const result = await importI18n({
    read: reader({ 'README.i18n.yaml': ledger(recs), 'README.md': EN2, 'README.zh.md': ZH2 }),
    yamlPath: 'README.i18n.yaml',
    enPath: 'README.md',
    zhPath: 'README.zh.md',
  })

  assert.equal(result.edges.length, 2)
  assert.equal(result.verified, 2)
  assert.deepEqual(result.nodes[0]!.unit, { kind: 'lines', from: 1, to: 3 })
  assert.deepEqual(result.nodes[2]!.unit, { kind: 'heading', index: 1 })
})

test('importI18n：复算不一致只标记 unverified，不阻断', async () => {
  const broken: Array<[string, { en: string; zh: string }]> = RECORDS.map(([key, value], i) =>
    i === 1 ? [key, { en: 'aaaaaaaaaaaaaaaa', zh: value.zh }] : [key, value],
  )

  const result = await importI18n({
    read: reader({ 'pkg/README.i18n.yaml': ledger(broken), 'pkg/README.md': EN, 'pkg/README.zh.md': ZH }),
    yamlPath: 'pkg/README.i18n.yaml',
    enPath: 'pkg/README.md',
    zhPath: 'pkg/README.zh.md',
  })

  assert.equal(result.edges.length, 3)
  assert.equal(result.verified, 2)
  assert.equal(result.unverified.length, 1)
  assert.match(result.unverified[0]!, /README\.md#\/demo\/summary$/u)
  assert.equal(result.issues.filter((i) => i.code === 'GF_I18N_UNVERIFIED').length, 1)
  // 基线仍然是账本值（绝不静默替换成"看起来对"的哈希）
  assert.equal(result.edges[1]!.fromHash, 'aaaaaaaaaaaaaaaa')
})

test('importI18n：中英标题数不一致 → 整包跳过（GF_UNIT_MISMATCH）', async () => {
  const ZH_SHORT = '# 演示\n\n## 概述\n\n你好\n'
  const result = await importI18n({
    read: reader({ 'pkg/README.i18n.yaml': ledger(RECORDS), 'pkg/README.md': EN, 'pkg/README.zh.md': ZH_SHORT }),
    yamlPath: 'pkg/README.i18n.yaml',
    enPath: 'pkg/README.md',
    zhPath: 'pkg/README.zh.md',
  })

  assert.equal(result.nodes.length, 0)
  assert.equal(result.edges.length, 0)
  assert.equal(result.issues[0]!.code, 'GF_UNIT_MISMATCH')
})

test('importI18n：缺文件 → 跳过并给出 issue', async () => {
  const result = await importI18n({
    read: reader({ 'pkg/README.md': EN }),
    yamlPath: 'pkg/README.i18n.yaml',
    enPath: 'pkg/README.md',
    zhPath: 'pkg/README.zh.md',
  })
  assert.equal(result.edges.length, 0)
  assert.equal(result.issues[0]!.code, 'GF_UNIT_MISMATCH')
})
