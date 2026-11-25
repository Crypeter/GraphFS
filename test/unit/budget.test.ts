import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Budget } from '../../src/core/budget.ts'

test('轮数上限', () => {
  const b = new Budget({ rounds: 2, obligations: 10 })
  assert.equal(b.tryBeginRound(), true)
  assert.equal(b.tryBeginRound(), true)
  assert.equal(b.tryBeginRound(), false)
  assert.equal(b.exhausted, 'rounds')
})

test('单边一回合只派发一次', () => {
  const b = new Budget({ rounds: 1, obligations: 10 })
  assert.equal(b.canDispatch('edge-1', 'node-a'), true)
  b.consume('edge-1', 'node-a')
  assert.equal(b.canDispatch('edge-1', 'node-b'), false)
  assert.equal(b.canDispatch('edge-2', 'node-a'), true)
})

test('单节点最多 3 次', () => {
  const b = new Budget({ rounds: 1, obligations: 10 })
  for (let i = 0; i < 3; i += 1) {
    assert.equal(b.canDispatch(`edge-${i}`, 'hot'), true)
    b.consume(`edge-${i}`, 'hot')
  }
  assert.equal(b.canDispatch('edge-x', 'hot'), false)
  assert.equal(b.canDispatch('edge-x', 'cold'), true)
})

test('总条数上限与 exhausted', () => {
  const b = new Budget({ rounds: 3, obligations: 2 })
  b.consume('e1', 'n1')
  b.consume('e2', 'n2')
  assert.equal(b.canDispatch('e3', 'n3'), false)
  assert.equal(b.exhausted, 'obligations')
  assert.equal(b.dispatched, 2)
})

test('构造时把 0/负数夹到 1', () => {
  const b = new Budget({ rounds: 0, obligations: -5 })
  assert.equal(b.limits.rounds, 1)
  assert.equal(b.limits.obligations, 1)
  assert.equal(b.tryBeginRound(), true)
  assert.equal(b.tryBeginRound(), false)
})
