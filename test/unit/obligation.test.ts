import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createObligation, isClosed, obligationId, transition } from '../../src/core/obligation.ts'
import { defaultsFor } from '../../src/core/graph.ts'
import type { Edge, Verdict } from '../../src/types.ts'

const NOW = '2026-11-23T00:00:00.000Z'

function mkEdge(over: Partial<Edge> = {}): Edge {
  return {
    id: 'e1',
    from: 'a',
    to: 'b',
    relation: 'translates',
    ...defaultsFor('translates'),
    fromHash: 'A0',
    toHash: 'B0',
    ...over,
  }
}

const drift: Verdict = { kind: 'drift', side: 'from', cause: 'a' }

function mk(kind: Verdict = drift, edge = mkEdge()) {
  return createObligation({ edge, target: 'b', cause: 'a', causeHash: 'A1', verdict: kind, baseline: 'B0', now: NOW })
}

test('id 由 (edgeId, target, causeHash) 决定，可去重', () => {
  assert.equal(obligationId('e1', 'b', 'A1'), obligationId('e1', 'b', 'A1'))
  assert.notEqual(obligationId('e1', 'b', 'A1'), obligationId('e1', 'b', 'A2'))
  assert.notEqual(obligationId('e1', 'b', 'A1'), obligationId('e2', 'b', 'A1'))
})

test('kind：auto + producer → regenerate；否则 review', () => {
  const auto = mkEdge({ policy: 'auto', producer: { kind: 'shell', command: 'gen', outputs: ['b.md'] } })
  assert.equal(mk(drift, auto).kind, 'regenerate')
  assert.equal(mk(drift).kind, 'review')
})

test('kind：conflict / dangling 直接映射；dangling 在 required 边上是 block', () => {
  assert.equal(mk({ kind: 'conflict', fromMoved: true, toMoved: true }).kind, 'conflict')
  const dangling = mk({ kind: 'dangling', missing: 'to' })
  assert.equal(dangling.kind, 'dangling')
  assert.equal(dangling.severity, 'block')
})

test('severity：required 的 drift 是 warn，advisory 的是 info', () => {
  assert.equal(mk(drift).severity, 'warn')
  assert.equal(mk(drift, mkEdge({ obligation: 'advisory' })).severity, 'info')
})

test('acceptance：机械判定用 mechanical，其余用 hash-changed', () => {
  const auto = mkEdge({ policy: 'auto', verdict: 'mechanical', producer: { kind: 'shell', command: 'g', outputs: ['b'] } })
  assert.equal(mk(drift, auto).acceptance.kind, 'mechanical')
  const review = mk(drift)
  assert.deepEqual(review.acceptance, { kind: 'hash-changed', node: 'b', from: 'B0' })
})

test('状态机：open → claimed → resolved', () => {
  const o = mk()
  const claimed = transition(o, { type: 'claim' })
  assert.equal(claimed.status, 'claimed')
  const resolved = transition(claimed, { type: 'resolve' })
  assert.equal(resolved.status, 'resolved')
  assert.equal(isClosed(resolved), true)
})

test('状态机：open → deferred → acked（带理由）', () => {
  const deferred = transition(mk(), { type: 'defer', until: '2026-11-26T00:00:00.000Z' })
  assert.equal(deferred.status, 'deferred')
  assert.equal(deferred.expiresAt, '2026-11-26T00:00:00.000Z')

  const acked = transition(deferred, { type: 'ack', reason: '人工确认接受漂移' })
  assert.equal(acked.status, 'acked')
  assert.equal(acked.detail, '人工确认接受漂移')
})

test('状态机：escalate 可从任意未关闭态发起', () => {
  assert.equal(transition(mk(), { type: 'escalate', reason: 'x' }).status, 'escalated')
  assert.equal(
    transition(transition(mk(), { type: 'claim' }), { type: 'escalate', reason: 'x' }).status,
    'escalated',
  )
})

test('终态不可再迁移，抛 GF_STATE_INVALID', () => {
  const closed = transition(mk(), { type: 'resolve' })
  for (const event of [
    { type: 'claim' as const },
    { type: 'resolve' as const },
    { type: 'defer' as const, until: NOW },
    { type: 'ack' as const, reason: 'x' },
    { type: 'escalate' as const, reason: 'x' },
  ]) {
    assert.throws(
      () => transition(closed, event),
      (e: unknown) => (e as { code?: string }).code === 'GF_STATE_INVALID',
    )
  }
})

test('非法迁移：deferred 不能再 claim', () => {
  const deferred = transition(mk(), { type: 'defer', until: NOW })
  assert.throws(
    () => transition(deferred, { type: 'claim' }),
    (e: unknown) => (e as { code?: string }).code === 'GF_STATE_INVALID',
  )
})
