import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sliceUnit } from '../../src/workspace/fingerprint.ts'
import type { Unit } from '../../src/types.ts'

const doc = `# Title

intro

## A

alpha

\`\`\`ts
## not a heading
\`\`\`

## B

beta
`

test('whole-file 原样返回', () => {
  assert.equal(sliceUnit(doc, { kind: 'whole-file' }), doc)
})

test('heading 按第 n 个标题切，代码块里的 # 不算', () => {
  const a = sliceUnit(doc, { kind: 'heading', index: 2 })!
  assert.match(a, /^## A\n/)
  assert.match(a, /alpha/)
  assert.doesNotMatch(a, /## B/)

  const b = sliceUnit(doc, { kind: 'heading', index: 3 })!
  assert.match(b, /^## B\n/)
})

test('heading 越界返回 null（当 dangling）', () => {
  assert.equal(sliceUnit(doc, { kind: 'heading', index: 9 }), null)
})

test('lines 闭区间', () => {
  assert.equal(sliceUnit('a\nb\nc', { kind: 'lines', from: 2, to: 2 }), 'b')
  assert.equal(sliceUnit('a\nb\nc', { kind: 'lines', from: 2, to: 3 }), 'b\nc')
})

test('lines 起点越界返回 null', () => {
  assert.equal(sliceUnit('a', { kind: 'lines', from: 5, to: 9 }), null)
})
