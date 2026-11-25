import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphFS } from '../../src/workspace/graphfs.ts'
import { PathPolicy } from '../../src/workspace/path-policy.ts'
import { CtxFsIo } from '../../src/adapters/ctx-fs-io.ts'
import { FakeFs } from '../helpers/fake-fs.ts'

async function withCtxFs(files: Record<string, string>, run: (gfs: GraphFS) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'graphfs-ctxfs-'))
  for (const [path, text] of Object.entries(files)) {
    const abs = join(root, path)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, text, 'utf8')
  }
  const policy = new PathPolicy(root, ['.graphfs'])
  const gfs = await GraphFS.open({
    root,
    graphPath: join(root, '.graphfs/graph.yaml'),
    io: new CtxFsIo(new FakeFs(), policy),
  })
  await run(gfs)
}

test('CtxFsIo：list 递归、相对路径正确', async () => {
  await withCtxFs({ 'a.md': '# a\n', 'sub/b.md': '# b\n', 'sub/deep/c.md': '# c\n' }, async (gfs) => {
    const files = await gfs.io.list('.')
    assert.deepEqual(files, ['a.md', 'sub/b.md', 'sub/deep/c.md'])
  })
})

test('CtxFsIo：readText 缺失返回 null 而不是抛错', async () => {
  await withCtxFs({ 'a.md': '# a\n' }, async (gfs) => {
    assert.equal(await gfs.io.readText('missing.md'), null)
  })
})

test('CtxFsIo：写入走「存在则 CAS、不存在才创建」', async () => {
  await withCtxFs({ 'a.md': 'old\n' }, async (gfs) => {
    await gfs.io.writeText('a.md', 'new\n')
    assert.equal(await gfs.io.readText('a.md'), 'new\n')
    await gfs.io.writeText('created.md', 'x\n')
    assert.equal(await gfs.io.readText('created.md'), 'x\n')
  })
})

test('CtxFsIo：move 与 remove', async () => {
  await withCtxFs({ 'a.md': '# a\n' }, async (gfs) => {
    await gfs.io.move('a.md', 'sub/b.md')
    assert.equal(await gfs.io.readText('a.md'), null)
    assert.equal(await gfs.io.readText('sub/b.md'), '# a\n')
    assert.equal(await gfs.io.remove('sub/b.md'), true)
    assert.equal(await gfs.io.remove('sub/b.md'), false)
  })
})

test('CtxFsIo：整条链路（init / link / check / suggest）跑在同一套 IO 上', async () => {
  await withCtxFs({ 'models.py': 'class M: pass\n', 'main.py': 'from models import M\n' }, async (gfs) => {
    const init = await gfs.init()
    assert.equal(init.nodes, 2)

    await gfs.link({ from: 'models', to: 'main', relation: 'constrains' })
    assert.equal((await gfs.check()).ok, true)

    const candidates = await gfs.suggest()
    assert.equal(candidates.length, 0, '已建过的边不再重复提')
  })
})
