import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideTurn, renderAdvice, INIT_HINT } from '../../src/runtime/session.ts'
import type { Obligation, Plan } from '../../src/types.ts'

function obligation(over: Partial<Obligation> = {}): Obligation {
  return {
    id: 'o1', edgeId: 'e1', target: 'main.py', cause: 'models.py', causeHash: 'h',
    kind: 'review', severity: 'warn',
    acceptance: { kind: 'hash-changed', node: 'main.py', from: 'x' },
    status: 'open', round: 0, createdAt: 't0', ...over,
  }
}

const plan = (obligations: Obligation[], staleness = 1): Plan => ({
  obligations, digested: [], changed: [], changedHashes: {}, stalenessBefore: staleness, truncated: false,
})

test('renderAdvice：说清「谁因为谁」，并给出 ack 出口', () => {
  const text = renderAdvice(plan([obligation()]))
  assert.match(text, /1 条一致性义务/)
  assert.match(text, /main\.py ← models\.py/)
  assert.match(text, /graphfs_ack/)
})

test('renderAdvice：条数有上限，超出折叠', () => {
  const many = Array.from({ length: 9 }, (_, i) => obligation({ id: `o${i}`, target: `f${i}.py` }))
  const text = renderAdvice(plan(many), { maxLines: 3 })
  assert.match(text, /还有 6 条/)
  assert.equal(text.split('\n').length <= 8, true)
})

test('decideTurn：无义务 → clean', () => {
  assert.deepEqual(decideTurn({ plan: plan([]), steeredThisTurn: 0, roundsUsed: 0, maxRounds: 2 }), { kind: 'clean' })
})

test('decideTurn：有义务且未超预算 → dispatch', () => {
  const decision = decideTurn({ plan: plan([obligation()]), steeredThisTurn: 0, roundsUsed: 0, maxRounds: 2 })
  assert.equal(decision.kind, 'dispatch')
})

test('decideTurn：同回合已 steer 过 → exhausted（不重复打断）', () => {
  const decision = decideTurn({ plan: plan([obligation()]), steeredThisTurn: 1, roundsUsed: 1, maxRounds: 2 })
  assert.equal(decision.kind, 'exhausted')
})

test('decideTurn：轮次用尽 → exhausted', () => {
  const decision = decideTurn({ plan: plan([obligation()]), steeredThisTurn: 0, roundsUsed: 2, maxRounds: 2 })
  assert.equal(decision.kind, 'exhausted')
})

test('decideTurn：震荡 → escalate 而不是继续打断', () => {
  const decision = decideTurn({
    plan: plan([obligation()]), steeredThisTurn: 0, roundsUsed: 0, maxRounds: 2, oscillating: true,
  })
  assert.equal(decision.kind, 'escalate')
})

test('decideTurn：staleness 不降 → escalate(no-progress)', () => {
  const decision = decideTurn({
    plan: plan([obligation()], 3), steeredThisTurn: 0, roundsUsed: 0, maxRounds: 2, lastStaleness: 3,
  })
  assert.equal(decision.kind, 'escalate')
  if (decision.kind === 'escalate') assert.equal(decision.reason, 'no-progress')
})

test('INIT_HINT 提到 init 与 suggest', () => {
  assert.match(INIT_HINT, /graphfs_init/)
  assert.match(INIT_HINT, /graphfs_suggest/)
})
