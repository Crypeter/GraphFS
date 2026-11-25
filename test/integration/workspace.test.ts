import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphFS } from '../../src/workspace/graphfs.ts'

async function workspace(files: Record<string, string>): Promise<{ root: string; graph: string }> {
  const root = await mkdtemp(join(tmpdir(), 'graphfs-it-'))
  for (const [path, text] of Object.entries(files)) {
    const abs = join(root, path)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, text, 'utf8')
  }
  return { root, graph: join(root, '.graphfs/graph.yaml') }
}

const FILES = {
  'a.md': '# A\n\nalpha\n',
  'b.md': '# B\n\nbeta\n',
  'c.py': '# framework\n',
}

test('init → link → check 干净；编辑源侧 → 漂移 + 义务；编辑非触发侧 → counterpart', async () => {
  const { root, graph } = await workspace(FILES)

  const gfs = await GraphFS.open({ root, graphPath: graph })
  const init = await gfs.init()
  assert.equal(init.nodes, 3)

  await gfs.link({ from: 'a', to: 'b', relation: 'translates' })
  await gfs.link({ from: 'c', to: 'a', relation: 'constrains' })

  const clean = await gfs.check()
  assert.equal(clean.ok, true, JSON.stringify(clean))
  assert.equal(clean.clean, 2)

  // 编辑源侧：a→b 的 from 变了
  await writeFile(join(root, 'a.md'), '# A\n\nalpha v2\n', 'utf8')
  const drifted = await gfs.check()
  assert.equal(drifted.ok, false)
  assert.equal(drifted.drift.length, 1)
  assert.equal(drifted.drift[0]!.edgeId.startsWith('gf-'), true)
  assert.equal(drifted.drift[0]!.from, 'a')

  const plan = await gfs.plan()
  assert.ok(plan.obligations.some((o) => o.target === 'b'), JSON.stringify(plan))

  // 编辑非触发侧（a 是 c→a 的 to 端，且 authority=c）：只走 counterpart，不产生新义务
  assert.ok(drifted.counterpart.some((x) => x.edgeId && x.action === 'absorb'))
})

test('仅 touch（内容不变）不产生漂移', async () => {
  const { root, graph } = await workspace(FILES)
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await gfs.link({ from: 'a', to: 'b', relation: 'translates' })

  await writeFile(join(root, 'a.md'), '# A\n\nalpha\n', 'utf8') // 同内容重写
  const report = await gfs.check()
  assert.equal(report.ok, true)
  assert.equal(report.drift.length, 0)
})

test('init 已存在时拒绝，--force 覆盖', async () => {
  const { root, graph } = await workspace(FILES)
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await assert.rejects(() => gfs.init(), (e: unknown) => (e as { code?: string }).code === 'GF_GRAPH_INVALID')
  await gfs.init({ force: true })
})

test('非法建边被拒（required 反向环）', async () => {
  const { root, graph } = await workspace(FILES)
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await gfs.link({ from: 'a', to: 'b', relation: 'translates' })
  await assert.rejects(
    () => gfs.link({ from: 'b', to: 'a', relation: 'translates' }),
    (e: unknown) => (e as { code?: string }).code === 'GF_EDGE_CYCLE',
  )
})

test('suggest → applySuggestions → check 干净（真实文件关系）', async () => {
  const { root, graph } = await workspace({
    'models.py': 'class M:\n    pass\n',
    'main.py': 'from models import M\n',
    'README.md': '# Doc\n\nsee [models](./models.py) and [main](./main.py)\n',
  })

  const gfs = await GraphFS.open({ root, graphPath: graph })
  const candidates = await gfs.suggest()
  assert.ok(candidates.some((c) => c.from === 'models' && c.to === 'main' && c.relation === 'constrains'))
  assert.ok(candidates.some((c) => c.from === 'main' && c.to === 'readme' && c.relation === 'documents'))

  await gfs.init()
  const applied = await gfs.applySuggestions(candidates, { minConfidence: 0.7 })
  assert.ok(applied.linked.length >= 2, JSON.stringify(applied.skipped))

  const report = await gfs.check()
  assert.equal(report.ok, true, JSON.stringify(report))
})

test('graph.yaml 可往返：重新打开后状态一致', async () => {
  const { root, graph } = await workspace(FILES)
  const first = await GraphFS.open({ root, graphPath: graph })
  await first.init()
  await first.link({ from: 'a', to: 'b', relation: 'translates' })

  const second = await GraphFS.open({ root, graphPath: graph })
  assert.equal(second.snapshot?.nodes.size, 3)
  assert.equal(second.snapshot?.edges.size, 1)
  assert.equal((await second.check()).ok, true)
})
