import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildArcs, defaultsFor, incident, parseGraph } from '../../src/core/graph.ts'
import { buildGraph, node } from '../helpers/graph.ts'
import type { GraphIssue } from '../../src/types.ts'

const codes = (issues: GraphIssue[]): string[] => issues.map((i) => i.code)

/* ---------------------------------------------------------------- 正常路径 */

test('合法图：无 issue，outArcs 与 incident 正确', () => {
  const g = buildGraph(
    [node('en'), node('zh')],
    [{ from: 'en', to: 'zh', relation: 'translates' }],
  )
  assert.equal(g.issues.length, 0)
  assert.deepEqual(
    g.outArcs.get('en')?.map((a) => a.target),
    ['zh'],
  )
  assert.equal(g.outArcs.get('zh'), undefined)
  assert.equal(incident(g, 'zh').length, 1, '双向索引：to 侧也能查到边')
})

test('默认值来自强度阶梯：mirror 对称、translates 单向', () => {
  assert.deepEqual(
    (({ authority, trigger }) => ({ authority, trigger }))(defaultsFor('mirror')),
    { authority: 'none', trigger: 'both' },
  )
  assert.deepEqual(
    (({ authority, trigger, obligation }) => ({ authority, trigger, obligation }))(defaultsFor('translates')),
    { authority: 'from', trigger: 'from', obligation: 'required' },
  )
  assert.equal(defaultsFor('documents').obligation, 'advisory')
  assert.equal(defaultsFor('related').trigger, 'none')
})

test('pathIndex：一个文件可贡献多个区域节点', () => {
  const { graph } = parseGraph({
    version: 1,
    nodes: [
      { id: 'a#1', path: 'a.md', unit: { kind: 'heading', index: 1 } },
      { id: 'a#2', path: 'a.md', unit: { kind: 'heading', index: 2 } },
    ],
    edges: [],
  })
  assert.deepEqual(graph!.pathIndex.get('a.md'), ['a#1', 'a#2'])
})

/* ---------------------------------------------------------------- 非法图 */

function issuesOf(input: unknown): GraphIssue[] {
  const { issues } = parseGraph(input)
  return issues
}

test('重复节点 id', () => {
  const issues = issuesOf({
    version: 1,
    nodes: [{ id: 'a', path: 'a.md' }, { id: 'a', path: 'b.md' }],
    edges: [],
  })
  assert.ok(codes(issues).includes('GF_GRAPH_INVALID'))
})

test('边引用不存在的节点 → GF_DANGLING_EDGE', () => {
  const issues = issuesOf({
    version: 1,
    nodes: [{ id: 'a', path: 'a.md' }],
    edges: [{ id: 'e', from: 'a', to: 'ghost', relation: 'translates' }],
  })
  assert.ok(codes(issues).includes('GF_DANGLING_EDGE'))
})

test('自环被拒', () => {
  const issues = issuesOf({
    version: 1,
    nodes: [{ id: 'a', path: 'a.md' }],
    edges: [{ id: 'e', from: 'a', to: 'a', relation: 'translates' }],
  })
  assert.ok(codes(issues).includes('GF_GRAPH_INVALID'))
})

test('整文件节点连区域节点 → GF_UNIT_MISMATCH', () => {
  const issues = issuesOf({
    version: 1,
    nodes: [
      { id: 'a', path: 'a.md' },
      { id: 'b', path: 'b.md', unit: { kind: 'heading', index: 1 } },
    ],
    edges: [{ id: 'e', from: 'a', to: 'b', relation: 'translates' }],
  })
  assert.ok(codes(issues).includes('GF_UNIT_MISMATCH'))
})

test('trigger: both 但 authority ≠ none → 拒绝（死配置）', () => {
  const issues = issuesOf({
    version: 1,
    nodes: [{ id: 'a', path: 'a.md' }, { id: 'b', path: 'b.md' }],
    edges: [{ id: 'e', from: 'a', to: 'b', relation: 'mirror', trigger: 'both', authority: 'from' }],
  })
  assert.ok(codes(issues).includes('GF_GRAPH_INVALID'))
})

test('translates / generates 不允许双向', () => {
  for (const relation of ['translates', 'generates']) {
    const issues = issuesOf({
      version: 1,
      nodes: [{ id: 'a', path: 'a.md' }, { id: 'b', path: 'b.md' }],
      edges: [{ id: 'e', from: 'a', to: 'b', relation, trigger: 'both', authority: 'none' }],
    })
    assert.ok(codes(issues).includes('GF_GRAPH_INVALID'), relation)
  }
})

test('弱关系不得 required（documents / related）', () => {
  for (const relation of ['documents', 'related']) {
    const issues = issuesOf({
      version: 1,
      nodes: [{ id: 'a', path: 'a.md' }, { id: 'b', path: 'b.md' }],
      edges: [{ id: 'e', from: 'a', to: 'b', relation, obligation: 'required' }],
    })
    assert.ok(codes(issues).includes('GF_GRAPH_INVALID'), relation)
  }
})

test('policy: auto 必须有 producer.outputs', () => {
  const issues = issuesOf({
    version: 1,
    nodes: [{ id: 'a', path: 'a.md' }, { id: 'b', path: 'b.md' }],
    edges: [{ id: 'e', from: 'a', to: 'b', relation: 'generates', policy: 'auto' }],
  })
  assert.ok(codes(issues).includes('GF_GRAPH_INVALID'))
})

test('方向相反的 required 边 → GF_EDGE_CYCLE', () => {
  const issues = issuesOf({
    version: 1,
    nodes: [{ id: 'a', path: 'a.md' }, { id: 'b', path: 'b.md' }],
    edges: [
      { id: 'e1', from: 'a', to: 'b', relation: 'translates' },
      { id: 'e2', from: 'b', to: 'a', relation: 'translates' },
    ],
  })
  assert.ok(codes(issues).includes('GF_EDGE_CYCLE'))
})

test('required 三元环 → GF_EDGE_CYCLE，且报出具体路径', () => {
  const issues = issuesOf({
    version: 1,
    nodes: [{ id: 'a', path: 'a.md' }, { id: 'b', path: 'b.md' }, { id: 'c', path: 'c.md' }],
    edges: [
      { id: 'e1', from: 'a', to: 'b', relation: 'translates' },
      { id: 'e2', from: 'b', to: 'c', relation: 'translates' },
      { id: 'e3', from: 'c', to: 'a', relation: 'translates' },
    ],
  })
  const issue = issues.find((i) => i.code === 'GF_EDGE_CYCLE')
  assert.ok(issue)
  assert.match(issue.message, /→/)
})

test('advisory 环不算环（只对 required 判环）', () => {
  const issues = issuesOf({
    version: 1,
    nodes: [{ id: 'a', path: 'a.md' }, { id: 'b', path: 'b.md' }],
    edges: [
      { id: 'e1', from: 'a', to: 'b', relation: 'documents' },
      { id: 'e2', from: 'b', to: 'a', relation: 'documents' },
    ],
  })
  assert.ok(!codes(issues).includes('GF_EDGE_CYCLE'))
})

test('不支持的 hash 口径被拒', () => {
  const issues = issuesOf({ version: 1, hash: { normalize: 'nope' }, nodes: [], edges: [] })
  assert.ok(codes(issues).includes('GF_GRAPH_INVALID'))
})

/* --------------------------------------------------------------- 有效弧 */

test('有效弧 = trigger 方向 ∩ 终点不是权威端', () => {
  const g = buildGraph(
    [node('a'), node('b')],
    [
      // 单向：只有 a→b
      { id: 'one-way', from: 'a', to: 'b', relation: 'translates' },
      // 权威在 to：a→b 这条弧的终点正是权威端，必须被剔掉
      { id: 'auth-to', from: 'a', to: 'b', relation: 'translates', authority: 'to' },
    ],
  )
  const arcs = buildArcs(g)
  const fromA = arcs.get('a') ?? []
  assert.deepEqual(
    fromA.map((x) => x.edge.id),
    ['one-way'],
    'auth-to 的弧被权威锁剔除',
  )
})

test('mirror（both + none）产生两条弧', () => {
  const g = buildGraph([node('a'), node('b')], [{ id: 'm', from: 'a', to: 'b', relation: 'mirror' }])
  assert.equal(g.outArcs.get('a')?.length, 1)
  assert.equal(g.outArcs.get('b')?.length, 1)
})

test('trigger: none 不产生弧', () => {
  const g = buildGraph([node('a'), node('b')], [{ id: 'r', from: 'a', to: 'b', relation: 'related' }])
  assert.equal(g.outArcs.size, 0)
})
