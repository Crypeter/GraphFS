import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findCycle, stronglyConnected } from '../../src/core/scc.ts'
import type { Arc, Edge } from '../../src/types.ts'

function arcs(spec: Record<string, string[]>): Map<string, Arc[]> {
  const out = new Map<string, Arc[]>()
  for (const [from, targets] of Object.entries(spec)) {
    out.set(
      from,
      targets.map((target) => ({ edge: { id: `${from}->${target}` } as Edge, target })),
    )
  }
  return out
}

test('DAG：每个节点单独成量', () => {
  const comps = stronglyConnected(['a', 'b', 'c'], arcs({ a: ['b'], b: ['c'] }))
  assert.equal(comps.length, 3)
  assert.ok(comps.every((c) => c.length === 1))
})

test('三元环合成一个量', () => {
  const comps = stronglyConnected(['a', 'b', 'c'], arcs({ a: ['b'], b: ['c'], c: ['a'] }))
  assert.equal(comps.length, 1)
  assert.deepEqual([...comps[0]!].sort(), ['a', 'b', 'c'])
})

test('两个不相交的环各自成量', () => {
  const comps = stronglyConnected(
    ['a', 'b', 'x', 'y'],
    arcs({ a: ['b'], b: ['a'], x: ['y'], y: ['x'] }),
  )
  assert.equal(comps.length, 2)
})

test('findCycle：有环时首尾相同', () => {
  const cycle = findCycle(['a', 'b', 'c'], arcs({ a: ['b'], b: ['c'], c: ['a'] }))
  assert.ok(cycle)
  assert.equal(cycle[0], cycle[cycle.length - 1])
  assert.equal(cycle.length, 4)
})

test('findCycle：二元环', () => {
  const cycle = findCycle(['a', 'b'], arcs({ a: ['b'], b: ['a'] }))
  assert.deepEqual(cycle, ['a', 'b', 'a'])
})

test('findCycle：无环返回 null', () => {
  assert.equal(findCycle(['a', 'b', 'c'], arcs({ a: ['b'], b: ['c'] })), null)
})

test('深链不走爆调用栈（迭代实现）', () => {
  const n = 5000
  const nodes = Array.from({ length: n }, (_, i) => `n${i}`)
  const spec: Record<string, string[]> = {}
  for (let i = 0; i < n - 1; i += 1) spec[`n${i}`] = [`n${i + 1}`]
  const comps = stronglyConnected(nodes, arcs(spec))
  assert.equal(comps.length, n)
  assert.equal(findCycle(nodes, arcs(spec)), null)
})
