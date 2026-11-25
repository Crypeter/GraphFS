import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeCandidates, parseProposals } from '../../src/importers/proposals.ts'
import { buildGraph, node } from '../helpers/graph.ts'
import type { Candidate } from '../../src/importers/suggest.ts'

const graph = buildGraph(
  [node('main', 'main.py'), node('models', 'models.py'), node('readme', 'README.md')],
  [],
)

test('按 id 或按路径都能解析端点', () => {
  const { candidates } = parseProposals(
    {
      generatedBy: 'test',
      candidates: [
        { from: 'models', to: 'main', relation: 'constrains', confidence: 0.9, evidence: 'import' },
        { fromPath: 'models.py', toPath: 'README.md', relation: 'documents', confidence: 0.7, evidence: 'link' },
      ],
    },
    graph,
  )
  assert.equal(candidates.length, 2)
  assert.equal(candidates[0]!.source, 'model')
  assert.equal(candidates[1]!.from, 'models')
})

test('端点不存在 / 缺证据 / 非法关系 → 丢弃并说明原因', () => {
  const { candidates, dropped } = parseProposals(
    {
      candidates: [
        { from: 'models', to: 'ghost', relation: 'constrains', evidence: 'x' },
        { from: 'models', to: 'main', relation: 'nonsense', evidence: 'x' },
        { from: 'models', to: 'main', relation: 'constrains' },
      ],
    },
    graph,
  )
  assert.equal(candidates.length, 0)
  assert.equal(dropped.length, 3)
})

test('置信度夹到 [0,1]', () => {
  const { candidates } = parseProposals(
    { candidates: [{ from: 'models', to: 'main', relation: 'constrains', confidence: 9, evidence: 'x' }] },
    graph,
  )
  assert.equal(candidates[0]!.confidence, 1)
})

test('mergeCandidates：同一条边合并为 both 并取高置信度', () => {
  const a: Candidate = {
    from: 'models', to: 'main', source: 'heuristic', fromPath: 'models.py', toPath: 'main.py',
    relation: 'constrains', confidence: 0.8, evidence: 'import models',
  }
  const b: Candidate = {
    from: 'models', to: 'main', source: 'model', fromPath: 'models.py', toPath: 'main.py',
    relation: 'constrains', confidence: 0.95, evidence: '模型判断',
  }
  const merged = mergeCandidates([a], [b])
  assert.equal(merged.length, 1)
  assert.equal(merged[0]!.source, 'both')
  assert.equal(merged[0]!.confidence, 0.95)
  assert.match(merged[0]!.evidence, /模型判断/)
})
