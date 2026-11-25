import { test } from 'node:test'
import assert from 'node:assert/strict'
import { measure, staleEdges } from '../../src/core/staleness.ts'
import { buildGraph, node } from '../helpers/graph.ts'

test('只统计 required 边：advisory 变化不计入进度度量', () => {
  const g = buildGraph(
    [node('a'), node('b'), node('c')],
    [
      { id: 'req', from: 'a', to: 'b', relation: 'translates', fromHash: 'A0', toHash: 'B0' },
      { id: 'adv', from: 'a', to: 'c', relation: 'documents', fromHash: 'A0', toHash: 'C0' },
    ],
  )
  const report = measure(g, new Map([['a', 'A1'], ['b', 'B0'], ['c', 'C1']]))

  assert.equal(report.total, 1, '只有 req 的 from 端失配')
  assert.deepEqual(staleEdges(report), ['req'])
})

test('两端都失配记 2', () => {
  const g = buildGraph([node('a'), node('b')], [
    { id: 'e', from: 'a', to: 'b', relation: 'translates', fromHash: 'A0', toHash: 'B0' },
  ])
  assert.equal(measure(g, new Map([['a', 'A1'], ['b', 'B1']])).total, 2)
})

test('dangling 只记 1，不重复计', () => {
  const g = buildGraph([node('a'), node('b')], [
    { id: 'e', from: 'a', to: 'b', relation: 'translates', fromHash: 'A0', toHash: 'B0' },
  ])
  assert.equal(measure(g, new Map([['a', null], ['b', null]])).total, 1)
  assert.equal(measure(g, new Map([['a', 'A0'], ['b', null]])).total, 1)
})

test('未知（undefined）既不算一致也不算失配', () => {
  const g = buildGraph([node('a'), node('b')], [
    { id: 'e', from: 'a', to: 'b', relation: 'translates', fromHash: 'A0', toHash: 'B0' },
  ])
  assert.equal(measure(g, new Map()).total, 0)
  assert.equal(measure(g, new Map([['a', 'A1']])).total, 0)
})

test('全部一致时为 0', () => {
  const g = buildGraph([node('a'), node('b')], [
    { id: 'e', from: 'a', to: 'b', relation: 'translates', fromHash: 'A0', toHash: 'B0' },
  ])
  assert.equal(measure(g, new Map([['a', 'A0'], ['b', 'B0']])).total, 0)
})
