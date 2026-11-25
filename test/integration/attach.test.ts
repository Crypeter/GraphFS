import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphFS } from '../../src/workspace/graphfs.ts'

async function workspace(files: Record<string, string>): Promise<{ root: string; graph: string }> {
  const root = await mkdtemp(join(tmpdir(), 'graphfs-attach-'))
  for (const [path, text] of Object.entries(files)) {
    const abs = join(root, path)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, text, 'utf8')
  }
  return { root, graph: join(root, '.graphfs/graph.yaml') }
}

test('新建文件未声明关系 → 报孤儿', async () => {
  const { root, graph } = await workspace({ 'models.py': 'class M: pass\n', 'main.py': 'from models import M\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await gfs.link({ from: 'models', to: 'main', relation: 'constrains' })

  await writeFile(join(root, 'utils.py'), 'def helper(): pass\n', 'utf8')
  const report = await gfs.check()
  assert.deepEqual(report.orphans, ['utils.py'])
})

test('attach：新文件给出边后就covered，孤儿消失', async () => {
  const { root, graph } = await workspace({ 'models.py': 'class M: pass\n', 'main.py': 'from models import M\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await gfs.link({ from: 'models', to: 'main', relation: 'constrains' })
  await writeFile(join(root, 'utils.py'), 'from models import M\n', 'utf8')

  const attached = await gfs.attach('utils.py', { to: ['main'], relation: 'constrains', as: 'from' })
  assert.equal(attached.edges.length, 1)
  assert.equal(attached.edges[0]!.from, 'utils')
  assert.equal(attached.edges[0]!.to, 'main')

  const report = await gfs.check()
  assert.deepEqual(report.orphans, [])
  assert.deepEqual(report.unlinked, [])
})

test('attach --unmanaged：声明「不需要关系」后不再是孤儿，且不能同时建节点', async () => {
  const { root, graph } = await workspace({ 'a.md': '# a\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await writeFile(join(root, 'icon.svg'), '<svg/>', 'utf8')

  await gfs.attach('icon.svg', { unmanaged: true })
  assert.equal((await gfs.check()).orphans.length, 0)

  // 已经是节点了，再声明 unmanaged 应当被拒
  await assert.rejects(
    () => gfs.attach('a.md', { unmanaged: true }),
    (e: unknown) => (e as { code?: string }).code === 'GF_GRAPH_INVALID',
  )
})

test('init 自动把二进制文件标成 unmanaged', async () => {
  const { root, graph } = await workspace({ 'a.md': '# a\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await writeFile(join(root, 'model.pth'), '\u0000binary', 'utf8')
  await gfs.init()

  const report = await gfs.check()
  assert.deepEqual(report.orphans, [], '二进制不应报孤儿')
  assert.equal(gfs.snapshot!.unmanaged.has('model.pth'), true)
})

test('suggest 默认只提「未覆盖的文件」，已建过的边不再重复提', async () => {
  const { root, graph } = await workspace({
    'models.py': 'class M: pass\n',
    'main.py': 'from models import M\n',
  })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await gfs.link({ from: 'models', to: 'main', relation: 'constrains' })

  await writeFile(join(root, 'utils.py'), 'from models import M\n', 'utf8')

  const incremental = await gfs.suggest()
  assert.equal(incremental.length, 1)
  assert.equal(incremental[0]!.toPath, 'utils.py')

  const full = await gfs.suggest({ all: true })
  assert.equal(full.length, 1, '已声明的 models→main 不应再出现')
})

test('create：不给关系直接拒绝（不写文件）', async () => {
  const { root, graph } = await workspace({ 'a.md': '# a\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()

  await assert.rejects(
    () => gfs.create('new.md', '# new\n', {}),
    (e: unknown) => (e as { code?: string }).code === 'GF_GRAPH_INVALID',
  )
  assert.equal(await gfs.io.readText('new.md'), null, '被拒时不应留下文件')
  assert.equal((await gfs.check()).orphans.length, 0)
})

test('create：给了边就同时写文件 + 建边', async () => {
  const { root, graph } = await workspace({ 'a.md': '# a\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()

  const created = await gfs.create('b.md', '# b\n', { links: [{ to: 'a', relation: 'documents', as: 'to' }] })
  assert.equal(created.edges.length, 1)
  assert.equal(await gfs.io.readText('b.md'), '# b\n')

  const report = await gfs.check()
  assert.deepEqual(report.orphans, [])
  assert.equal(report.ok, true)
})

test('create：建边失败要回滚文件', async () => {
  const { root, graph } = await workspace({ 'a.md': '# a\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await gfs.link({ from: 'a', to: 'a', relation: 'documents' }).catch(() => undefined)

  await assert.rejects(() =>
    gfs.create('c.md', '# c\n', { links: [{ to: 'ghost', relation: 'documents' }] }),
  )
  assert.equal(await gfs.io.readText('c.md'), null, '建边失败要删掉刚写的文件')
})

test('create: unmanaged 写文件并登记', async () => {
  const { root, graph } = await workspace({ 'a.md': '# a\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()

  await gfs.create('blob.bin', 'x', { unmanaged: true })
  assert.equal(gfs.snapshot!.unmanaged.has('blob.bin'), true)
  assert.deepEqual((await gfs.check()).orphans, [])
})

test('ack：重录基线后不再漂移', async () => {
  const { root, graph } = await workspace({ 'a.py': 'x = 1\n', 'b.py': 'from a import x\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  const edge = await gfs.link({ from: 'a', to: 'b', relation: 'constrains' })

  await writeFile(join(root, 'a.py'), 'x = 2\n', 'utf8')
  assert.equal((await gfs.check()).drift.length, 1)

  await gfs.ack(edge.id, '确认这次改动不需要同步 b')
  const after = await gfs.check()
  assert.equal(after.drift.length, 0)
  assert.equal(after.ok, true)
})
