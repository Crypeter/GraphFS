import { test } from 'node:test'
import assert from 'node:assert/strict'
import { plan } from '../../src/core/plan.ts'
import { buildGraph, node } from '../helpers/graph.ts'
import type { Edge, GraphSnapshot, Relation } from '../../src/types.ts'

/** 确定性 PRNG：同一个 seed 永远得到同一张图，失败可复现。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const RELATIONS: Relation[] = ['translates', 'generates', 'documents', 'constrains', 'related']
const NODE_COUNT = 6
const NODE_IDS = Array.from({ length: NODE_COUNT }, (_, i) => `n${i}`)

const baseline = (id: string): string => `H(${id})`

/** 只连低索引 → 高索引，按构造就是 DAG，不会触发环检查。 */
function randomGraph(rand: () => number): GraphSnapshot {
  const edges: Parameters<typeof buildGraph>[1] = []
  const used = new Set<string>()
  let guard = 0

  while (edges.length < 9 && guard < 200) {
    guard += 1
    const a = Math.floor(rand() * NODE_COUNT)
    const b = Math.floor(rand() * NODE_COUNT)
    if (a === b) continue
    const from = NODE_IDS[Math.min(a, b)]!
    const to = NODE_IDS[Math.max(a, b)]!
    const key = `${from}|${to}`
    if (used.has(key)) continue
    used.add(key)
    edges.push({
      id: `e-${from}-${to}`,
      from,
      to,
      relation: RELATIONS[Math.floor(rand() * RELATIONS.length)]!,
      fromHash: baseline(from),
      toHash: baseline(to),
    })
  }

  return buildGraph(NODE_IDS.map((id) => node(id)), edges)
}

function randomHashes(rand: () => number): Map<string, string | null> {
  const out = new Map<string, string | null>()
  for (const id of NODE_IDS) {
    const roll = rand()
    if (roll < 0.1) out.set(id, null)
    else if (roll < 0.45) out.set(id, `${baseline(id)}+edited`)
    else out.set(id, baseline(id))
  }
  return out
}

function arcsOf(graph: GraphSnapshot): Set<string> {
  const set = new Set<string>()
  for (const [source, arcs] of graph.outArcs) {
    for (const arc of arcs) set.add(`${source}|${arc.target}|${arc.edge.id}`)
  }
  return set
}

test('property：随机图上 plan 的六条不变量（200 个 seed）', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const rand = mulberry32(seed)
    const graph = randomGraph(rand)
    const hashes = randomHashes(rand)

    const changed = NODE_IDS.filter(() => rand() < 0.35)
    if (changed.length === 0) changed.push(NODE_IDS[Math.floor(rand() * NODE_COUNT)]!)

    const limits = { maxDepth: 3, maxObligations: 5 }
    const first = plan({ changed, graph, hashes, limits, now: 't0' })
    const second = plan({ changed, graph, hashes, limits, now: 't0' })

    /* 1. 条数不超限 */
    assert.ok(first.obligations.length <= limits.maxObligations, `seed ${seed}: 超限`)

    /* 2. id 唯一且幂等 */
    const ids = first.obligations.map((o) => o.id)
    assert.equal(new Set(ids).size, ids.length, `seed ${seed}: id 重复`)
    assert.deepEqual(ids, second.obligations.map((o) => o.id), `seed ${seed}: 非幂等`)

    /* 3–5. 只有「有方向」的义务（review/regenerate）才受弧方向与权威锁约束；
           conflict / dangling 是仲裁项，不沿弧走。 */
    const arcs = arcsOf(graph)
    for (const o of first.obligations) {
      const edge = graph.edges.get(o.edgeId) as Edge
      assert.ok(edge, `seed ${seed}: 义务引用了不存在的边`)

      if (o.kind === 'conflict' || o.kind === 'dangling') {
        assert.ok(
          o.target === edge.from || o.target === edge.to,
          `seed ${seed}: ${o.id} 的 target 不是该边端点`,
        )
        continue
      }

      assert.ok(arcs.has(`${o.cause}|${o.target}|${o.edgeId}`), `seed ${seed}: ${o.id} 不在有效弧上`)
      if (edge.trigger === 'from') assert.equal(o.cause, edge.from, `seed ${seed}: ${o.id} 反向派发`)
      if (edge.trigger === 'to') assert.equal(o.cause, edge.to, `seed ${seed}: ${o.id} 反向派发`)
      if (edge.authority === 'from') assert.notEqual(o.target, edge.from, `seed ${seed}: 指向权威端`)
      if (edge.authority === 'to') assert.notEqual(o.target, edge.to, `seed ${seed}: 指向权威端`)
    }

    /* 6. 截断：与「放开上限」的结果对照，而不是靠条数反推 */
    const wide = plan({ changed, graph, hashes, limits: { maxDepth: 3, maxObligations: 999 }, now: 't0' })
    assert.equal(
      first.truncated,
      wide.obligations.length > limits.maxObligations,
      `seed ${seed}: truncated 不一致`,
    )
    assert.equal(
      first.obligations.length,
      Math.min(wide.obligations.length, limits.maxObligations),
      `seed ${seed}: 截断条数不对`,
    )
  }
})

test('property：非触发侧的变更永远不产生义务（L4 的核心保证）', () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const rand = mulberry32(seed * 7919)
    const graph = randomGraph(rand)

    // 只动「作为 to 端出现」的节点，且这些边都是单向的
    const toOnly = new Map<string, string | null>()
    for (const id of NODE_IDS) toOnly.set(id, baseline(id))
    const targets = new Set<string>()
    for (const edge of graph.edges.values()) {
      if (edge.trigger === 'from') {
        targets.add(edge.to)
        toOnly.set(edge.to, `${baseline(edge.to)}+edited`)
      }
    }
    if (targets.size === 0) continue

    const result = plan({
      changed: [...targets],
      graph,
      hashes: toOnly,
      limits: { maxDepth: 3, maxObligations: 20 },
      now: 't0',
    })

    for (const o of result.obligations) {
      const edge = graph.edges.get(o.edgeId) as Edge
      if (edge.trigger === 'from') {
        assert.notEqual(o.cause, edge.to, `seed ${seed}: to 侧变更竟驱动了传播`)
      }
    }
  }
})
