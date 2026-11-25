import { test } from 'node:test'
import assert from 'node:assert/strict'
import { plan } from '../../src/core/plan.ts'
import { buildGraph, node } from '../helpers/graph.ts'
import type { GraphSnapshot } from '../../src/types.ts'

const NOW = '2026-11-23T00:00:00.000Z'

function run(
  graph: GraphSnapshot,
  changed: string[],
  hashes: Record<string, string | null | undefined>,
  limits = { maxDepth: 3, maxObligations: 10 },
) {
  return plan({ changed, graph, hashes: new Map(Object.entries(hashes)), limits, now: NOW })
}

/* ------------------------------------------------- L4：改代码零打扰 */

test('L4 只改代码侧：零义务，只产生 absorb 消化', () => {
  const g = buildGraph([node('fw'), node('code')], [
    { id: 'l4', from: 'fw', to: 'code', relation: 'constrains', fromHash: 'FW0', toHash: 'CODE0' },
  ])
  const result = run(g, ['code'], { fw: 'FW0', code: 'CODE1' })

  assert.deepEqual(result.obligations, [])
  assert.deepEqual(result.digested, [{ edgeId: 'l4', node: 'code', action: 'absorb' }])
})

test('L4 只改框架侧：产生指向代码的义务', () => {
  const g = buildGraph([node('fw'), node('code')], [
    { id: 'l4', from: 'fw', to: 'code', relation: 'constrains', fromHash: 'FW0', toHash: 'CODE0' },
  ])
  const result = run(g, ['fw'], { fw: 'FW1', code: 'CODE0' })

  assert.equal(result.obligations.length, 1)
  assert.equal(result.obligations[0]!.target, 'code')
  assert.equal(result.obligations[0]!.cause, 'fw')
})

test('L4 两侧都改：仍然是 drift(from)，不是冲突', () => {
  const g = buildGraph([node('fw'), node('code')], [
    { id: 'l4', from: 'fw', to: 'code', relation: 'constrains', fromHash: 'FW0', toHash: 'CODE0' },
  ])
  const result = run(g, ['fw', 'code'], { fw: 'FW1', code: 'CODE1' })
  assert.equal(result.obligations[0]!.target, 'code')
  assert.equal(result.obligations[0]!.kind, 'review')
})

/* ------------------------------------------------- L1：译文单方面变更 */

test('L1 只改译文：counterpart confirm，不派发义务', () => {
  const g = buildGraph([node('en'), node('zh')], [
    { id: 'l1', from: 'en', to: 'zh', relation: 'translates', fromHash: 'EN0', toHash: 'ZH0' },
  ])
  const result = run(g, ['zh'], { en: 'EN0', zh: 'ZH1' })

  assert.deepEqual(result.obligations, [])
  assert.deepEqual(result.digested, [{ edgeId: 'l1', node: 'zh', action: 'confirm' }])
})

test('L1 两侧都变：产生 bothMoved 的 required 义务（不是冲突）', () => {
  const g = buildGraph([node('en'), node('zh')], [
    { id: 'l1', from: 'en', to: 'zh', relation: 'translates', fromHash: 'EN0', toHash: 'ZH0' },
  ])
  const result = run(g, ['en', 'zh'], { en: 'EN1', zh: 'ZH1' })

  assert.equal(result.obligations.length, 1)
  assert.equal(result.obligations[0]!.severity, 'warn')
  assert.equal(result.obligations[0]!.target, 'zh')
})

/* ------------------------------------------------- L0：对称关系 */

test('L0 mirror 两侧都变 → 真冲突（无权威端）', () => {
  const g = buildGraph([node('a'), node('b')], [
    { id: 'm', from: 'a', to: 'b', relation: 'mirror', fromHash: 'A0', toHash: 'B0' },
  ])
  const result = run(g, ['a', 'b'], { a: 'A1', b: 'B1' })

  assert.equal(result.obligations.length, 1)
  assert.equal(result.obligations[0]!.kind, 'conflict')
})

test('L0 mirror 单侧变更 → 派发给另一侧（复制幂等）', () => {
  const g = buildGraph([node('a'), node('b')], [
    { id: 'm', from: 'a', to: 'b', relation: 'mirror', fromHash: 'A0', toHash: 'B0' },
  ])
  const result = run(g, ['a'], { a: 'A1', b: 'B0' })
  assert.equal(result.obligations.length, 1)
  assert.equal(result.obligations[0]!.target, 'b')
})

/* ------------------------------------------------- 闭包与深度 */

test('深度 2 的链会算到末端；深度 1 只算邻接', () => {
  const g = buildGraph(
    [node('a'), node('b'), node('c')],
    [
      { id: 'e1', from: 'a', to: 'b', relation: 'translates', fromHash: 'A0', toHash: 'B0' },
      { id: 'e2', from: 'b', to: 'c', relation: 'translates', fromHash: 'B0', toHash: 'C0' },
    ],
  )
  const hashes = { a: 'A1', b: 'B1', c: 'C1' }

  const deep = run(g, ['a'], hashes, { maxDepth: 2, maxObligations: 10 })
  assert.deepEqual(deep.obligations.map((o) => o.target).sort(), ['b', 'c'])

  const shallow = run(g, ['a'], hashes, { maxDepth: 1, maxObligations: 10 })
  assert.deepEqual(shallow.obligations.map((o) => o.target), ['b'])
})

test('同一节点重复出现只算一次', () => {
  const g = buildGraph([node('en'), node('zh')], [
    { id: 'l1', from: 'en', to: 'zh', relation: 'translates', fromHash: 'EN0', toHash: 'ZH0' },
  ])
  const result = run(g, ['en', 'en', 'en'], { en: 'EN1', zh: 'ZH0' })
  assert.equal(result.obligations.length, 1)
})

test('未知指纹（undefined）不清算；null 才结算为 dangling', () => {
  const g = buildGraph([node('en'), node('zh')], [
    { id: 'l1', from: 'en', to: 'zh', relation: 'translates', fromHash: 'EN0', toHash: 'ZH0' },
  ])
  assert.deepEqual(run(g, ['en'], { en: 'EN1' }).obligations, [])

  const result = run(g, ['en'], { en: 'EN1', zh: null })
  assert.equal(result.obligations.length, 1)
  assert.equal(result.obligations[0]!.kind, 'dangling')
  assert.equal(result.obligations[0]!.target, 'zh')
})

/* ------------------------------------------------- 截断与排序 */

test('超过 maxObligations 时截断并置位', () => {
  const g = buildGraph(
    [node('root'), node('x'), node('y'), node('z')],
    [
      { id: 'ex', from: 'root', to: 'x', relation: 'translates', fromHash: 'R0', toHash: 'X0' },
      { id: 'ey', from: 'root', to: 'y', relation: 'translates', fromHash: 'R0', toHash: 'Y0' },
      { id: 'ez', from: 'root', to: 'z', relation: 'documents', fromHash: 'R0', toHash: 'Z0' },
    ],
  )
  const result = run(g, ['root'], { root: 'R1', x: 'X0', y: 'Y0', z: 'Z0' }, {
    maxDepth: 2,
    maxObligations: 2,
  })

  assert.equal(result.obligations.length, 2)
  assert.equal(result.truncated, true)
})

test('排序：block 优先于 warn 优先于 info', () => {
  const g = buildGraph(
    [node('a'), node('b'), node('c')],
    [
      { id: 'dangling', from: 'a', to: 'b', relation: 'translates', fromHash: 'A0', toHash: 'B0' },
      { id: 'doc', from: 'a', to: 'c', relation: 'documents', fromHash: 'A0', toHash: 'C0' },
    ],
  )
  const result = run(g, ['a'], { a: 'A1', b: null, c: 'C1' })

  assert.equal(result.obligations[0]!.severity, 'block')
  assert.equal(result.obligations[0]!.kind, 'dangling')
})

/* ------------------------------------------------- 不变量 */

test('不变量：任何义务的 target 都是有效弧的终点、cause 都是弧的起点', () => {
  const g = buildGraph(
    [node('a'), node('b'), node('c')],
    [
      { id: 'e1', from: 'a', to: 'b', relation: 'translates', fromHash: 'A0', toHash: 'B0' },
      { id: 'e2', from: 'b', to: 'c', relation: 'translates', fromHash: 'B0', toHash: 'C0' },
      { id: 'e3', from: 'c', to: 'a', relation: 'documents', fromHash: 'C0', toHash: 'A0' },
    ],
  )
  const result = run(g, ['a'], { a: 'A1', b: 'B0', c: 'C0' })

  for (const o of result.obligations) {
    const arcsFromCause = g.outArcs.get(o.cause) ?? []
    assert.ok(
      arcsFromCause.some((arc) => arc.target === o.target && arc.edge.id === o.edgeId),
      `obligation ${o.id} 的 (cause,target) 不在有效弧上`,
    )
  }
})

/* --------------------------------------- 场景 3：派生物被直接修改 */

test('L2 只改派生物：派发 review 义务，提示改源文件', () => {
  const g = buildGraph([node('src'), node('out')], [
    { id: 'l2', from: 'src', to: 'out', relation: 'generates', fromHash: 'SRC0', toHash: 'OUT0' },
  ])
  const result = run(g, ['out'], { src: 'SRC0', out: 'OUT1' })

  assert.equal(result.obligations.length, 1)
  const obligation = result.obligations[0]!
  assert.equal(obligation.target, 'out')
  assert.equal(obligation.cause, 'src')
  assert.equal(obligation.kind, 'review')
  assert.match(obligation.detail ?? '', /派生物/u)
  assert.deepEqual(result.digested, [{ edgeId: 'l2', node: 'out', action: 'confirm' }])
})

test('L2 auto 边只改派生物：义务类型是 regenerate（可直接重跑生成器）', () => {
  const g = buildGraph([node('src'), node('out')], [
    {
      id: 'l2',
      from: 'src',
      to: 'out',
      relation: 'generates',
      fromHash: 'SRC0',
      toHash: 'OUT0',
      policy: 'auto',
      producer: { kind: 'shell', command: 'true', outputs: ['out'] },
    },
  ])
  const result = run(g, ['out'], { src: 'SRC0', out: 'OUT1' })
  assert.equal(result.obligations[0]!.kind, 'regenerate')
  assert.equal(result.obligations[0]!.target, 'out')
})
