import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphFS } from '../../src/workspace/graphfs.ts'

async function workspace(files: Record<string, string>): Promise<{ root: string; graph: string }> {
  const root = await mkdtemp(join(tmpdir(), 'graphfs-audit-'))
  for (const [path, text] of Object.entries(files)) {
    const abs = join(root, path)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, text, 'utf8')
  }
  return { root, graph: join(root, '.graphfs/graph.yaml') }
}

test('init / link / attach / ack 都写审计，ack 带上理由', async () => {
  const { root, graph } = await workspace({ 'a.md': '# A\n', 'b.md': '# B\n', 'c.md': '# C\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph, actor: 'tester' })

  await gfs.init()
  const edge = await gfs.link({ from: 'a', to: 'b', relation: 'translates' })
  await writeFile(join(root, 'a.md'), '# A2\n', 'utf8')
  await gfs.ack(edge.id, '这次不同步是有意的')

  const entries = await gfs.auditTail(20)
  assert.deepEqual(
    entries.map((e) => e.kind),
    ['init', 'link', 'ack'],
  )
  assert.equal(entries[0]!.actor, 'tester')
  assert.equal(entries[1]!.edgeId, edge.id)

  const ack = entries[2]!
  assert.equal(ack.edgeId, edge.id)
  assert.equal((ack.detail as { reason: string }).reason, '这次不同步是有意的')
  // 基线确实被重录到当前内容
  assert.equal((await gfs.check()).drift.length, 0)

  // 审计落到磁盘（不是只留在内存）
  const raw = await readFile(join(root, '.graphfs/audit/journal.jsonl'), 'utf8')
  assert.match(raw, /"kind":"ack"/)
})

test('ack 拒绝空理由，且不写审计', async () => {
  const { root, graph } = await workspace({ 'a.md': '# A\n', 'b.md': '# B\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  const edge = await gfs.link({ from: 'a', to: 'b', relation: 'translates' })
  const before = (await gfs.auditTail(10)).length

  await assert.rejects(
    () => gfs.ack(edge.id, '   '),
    (error: unknown) => (error as { code?: string }).code === 'GF_GRAPH_INVALID',
  )
  assert.equal((await gfs.auditTail(10)).length, before)
})

test('attach --unmanaged 记录理由，并能在重开后读回', async () => {
  const { root, graph } = await workspace({ 'a.md': '# A\n', 'logo.png': '\u0000' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await gfs.attach('logo.png', { unmanaged: true, reason: '品牌素材，不需要一致性' })

  const text = await readFile(graph, 'utf8')
  assert.match(text, /reason: 品牌素材，不需要一致性/u)

  const again = await GraphFS.open({ root, graphPath: graph })
  assert.equal(again.snapshot!.unmanaged.has('logo.png'), true)
  assert.equal(again.snapshot!.unmanagedReasons.get('logo.png'), '品牌素材，不需要一致性')
  assert.equal((await again.check()).orphans.length, 0)

  const entries = await again.auditTail(10)
  assert.ok(entries.some((e) => e.kind === 'attach' && e.node === 'logo.png'))
})

test('create 不声明关系：拒绝并记 refuse 审计', async () => {
  const { root, graph } = await workspace({ 'a.md': '# A\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()

  await assert.rejects(
    () => gfs.create('new.md', 'x'),
    (error: unknown) => (error as { code?: string }).code === 'GF_GRAPH_INVALID',
  )
  const entries = await gfs.auditTail(10)
  assert.equal(entries.at(-1)!.kind, 'refuse')
  assert.equal(entries.at(-1)!.node, 'new.md')
})

test('init 覆盖时审计记录 overwritten', async () => {
  const { root, graph } = await workspace({ 'a.md': '# A\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await gfs.init({ force: true })
  const entries = await gfs.auditTail(10)
  assert.equal(entries.length, 2)
  assert.equal((entries[1]!.detail as { overwritten: boolean }).overwritten, true)
})
