import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultsFor } from '../../src/core/graph.ts'
import { judge } from '../../src/core/verdict.ts'
import type { Edge } from '../../src/types.ts'

function mkEdge(over: Partial<Edge> = {}): Edge {
  return {
    id: 'e1',
    from: 'a',
    to: 'b',
    relation: 'translates',
    ...defaultsFor('translates'),
    fromHash: 'FA',
    toHash: 'TB',
    ...over,
  }
}

test('两端都未变 → clean', () => {
  assert.deepEqual(judge({ edge: mkEdge(), fromHash: 'FA', toHash: 'TB' }), { kind: 'clean' })
})

test('from 变、to 未变 → drift(from)', () => {
  assert.deepEqual(judge({ edge: mkEdge(), fromHash: 'FA2', toHash: 'TB' }), {
    kind: 'drift',
    side: 'from',
    cause: 'a',
  })
})

test('to 变、from 未变、authority=from → counterpart（不许覆盖权威端）', () => {
  assert.deepEqual(judge({ edge: mkEdge({ authority: 'from' }), fromHash: 'FA', toHash: 'TB2' }), {
    kind: 'counterpart',
    side: 'to',
  })
})

test('to 变、from 未变、authority=to → drift(to)', () => {
  assert.deepEqual(judge({ edge: mkEdge({ authority: 'to' }), fromHash: 'FA', toHash: 'TB2' }), {
    kind: 'drift',
    side: 'to',
    cause: 'b',
  })
})

test('to 变、from 未变、authority=none → drift(to)', () => {
  assert.deepEqual(judge({ edge: mkEdge({ authority: 'none' }), fromHash: 'FA', toHash: 'TB2' }), {
    kind: 'drift',
    side: 'to',
    cause: 'b',
  })
})

test('两端都变、authority=from → drift(from, bothMoved)', () => {
  assert.deepEqual(judge({ edge: mkEdge({ authority: 'from' }), fromHash: 'FA2', toHash: 'TB2' }), {
    kind: 'drift',
    side: 'from',
    cause: 'a',
    bothMoved: true,
  })
})

test('两端都变、authority=to → drift(to, bothMoved)', () => {
  assert.deepEqual(judge({ edge: mkEdge({ authority: 'to' }), fromHash: 'FA2', toHash: 'TB2' }), {
    kind: 'drift',
    side: 'to',
    cause: 'b',
    bothMoved: true,
  })
})

test('两端都变、authority=none → 真冲突', () => {
  const v = judge({ edge: mkEdge({ authority: 'none' }), fromHash: 'FA2', toHash: 'TB2' })
  assert.equal(v.kind, 'conflict')
})

test('from 缺失 → dangling(from)，null 不当空串', () => {
  assert.deepEqual(judge({ edge: mkEdge(), fromHash: null, toHash: 'TB' }), {
    kind: 'dangling',
    missing: 'from',
  })
})

test('to 缺失 → dangling(to)', () => {
  assert.deepEqual(judge({ edge: mkEdge(), fromHash: 'FA', toHash: null }), {
    kind: 'dangling',
    missing: 'to',
  })
})

test('未校验的边（空串基线）+ 真实指纹 → 视为变更', () => {
  const v = judge({ edge: mkEdge({ fromHash: '', toHash: '' }), fromHash: 'FA', toHash: 'TB' })
  assert.equal(v.kind, 'drift')
})

test('matrix：3 种 authority × 3 种变更形态，判定不越界', () => {
  const authorities = ['from', 'to', 'none'] as const
  const states = [
    { fromHash: 'FA', toHash: 'TB', moved: 'none' },
    { fromHash: 'FA2', toHash: 'TB', moved: 'from' },
    { fromHash: 'FA', toHash: 'TB2', moved: 'to' },
    { fromHash: 'FA2', toHash: 'TB2', moved: 'both' },
  ] as const

  for (const authority of authorities) {
    for (const s of states) {
      const v = judge({ edge: mkEdge({ authority }), fromHash: s.fromHash, toHash: s.toHash })
      if (s.moved === 'none') assert.equal(v.kind, 'clean')
      if (s.moved === 'from') assert.equal(v.kind, 'drift')
      if (s.moved === 'to') {
        assert.equal(v.kind, authority === 'from' ? 'counterpart' : 'drift')
      }
      if (s.moved === 'both') {
        assert.equal(v.kind, authority === 'none' ? 'conflict' : 'drift')
        if (v.kind === 'drift') assert.equal(v.bothMoved, true)
      }
    }
  }
})
