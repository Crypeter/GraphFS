import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphFS } from '../../src/workspace/graphfs.ts'
import { startUi } from '../../src/ui/server.ts'

async function workspace(): Promise<{ root: string; graph: string }> {
  const root = await mkdtemp(join(tmpdir(), 'graphfs-ui-'))
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'src.md'), '# src\n\nv1\n', 'utf8')
  await writeFile(join(root, 'docs/zh.md'), '# 源\n\nv1\n', 'utf8')
  const graph = join(root, '.graphfs/graph.yaml')

  const gfs = await GraphFS.open({ root, graphPath: graph, actor: 'setup' })
  await gfs.init()
  await gfs.link({ from: 'src', to: 'docs-zh', relation: 'translates' })
  return { root, graph }
}

test('面板：HTML 自包含，API 返回状态/图/审计', async () => {
  const { root, graph } = await workspace()
  const before = await readFile(graph, 'utf8')
  const server = await startUi({ root, graphPath: graph, port: 0 })

  try {
    const html = await (await fetch(server.url)).text()
    assert.match(html, /<canvas id="canvas">/)
    assert.match(html, /GraphFS/)
    assert.match(html, /\/api\/overview/)
    assert.ok(!html.includes('http://cdn'), '不能依赖外部 CDN')

    const health = await (await fetch(`${server.url}api/health`)).json()
    assert.deepEqual(health, { ok: true })

    const overview = await (await fetch(`${server.url}api/overview`)).json()
    assert.equal(overview.hasGraph, true)
    assert.equal(overview.counts.nodes, 2)
    assert.equal(overview.counts.edges, 1)
    assert.equal(overview.ok, true)
    assert.equal(overview.drift.length, 0)
    assert.deepEqual(overview.journal.map((e: { kind: string }) => e.kind), ['init', 'link'])

    const g = await (await fetch(`${server.url}api/graph`)).json()
    assert.equal(g.hasGraph, true)
    assert.equal(g.nodes.length, 2)
    assert.equal(g.edges.length, 1)
    assert.equal(g.edges[0].relation, 'translates')
    assert.equal(typeof g.edges[0].fromHash, 'string')

    const journal = await (await fetch(`${server.url}api/journal?limit=1`)).json()
    assert.equal(journal.entries.length, 1)
    assert.equal(journal.entries[0].kind, 'link')

    const missing = await fetch(`${server.url}api/nope`)
    assert.equal(missing.status, 404)

    // 只读：面板不写图
    assert.equal(await readFile(graph, 'utf8'), before)
  } finally {
    await server.close()
  }
})

test('面板：没有图时给出初始化提示而不是报错', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphfs-ui-empty-'))
  await writeFile(join(root, 'a.md'), '# a\n', 'utf8')
  const server = await startUi({ root, port: 0 })
  try {
    const overview = await (await fetch(`${server.url}api/overview`)).json()
    assert.equal(overview.hasGraph, false)
    assert.ok(Array.isArray(overview.journal))

    const graph = await (await fetch(`${server.url}api/graph`)).json()
    assert.equal(graph.hasGraph, false)
    assert.deepEqual(graph.nodes, [])

    const check = await fetch(`${server.url}api/check`)
    assert.equal(check.status, 409)
  } finally {
    await server.close()
  }
})

test('面板：drift 出现在 overview 里', async () => {
  const { root, graph } = await workspace()
  await writeFile(join(root, 'src.md'), '# src\n\nv2\n', 'utf8')

  const server = await startUi({ root, graphPath: graph, port: 0 })
  try {
    const overview = await (await fetch(`${server.url}api/overview`)).json()
    assert.equal(overview.ok, false)
    assert.equal(overview.drift.length, 1)
    assert.equal(overview.drift[0].from, 'src')
  } finally {
    await server.close()
  }
})
