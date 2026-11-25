import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unifiedDiff } from '../../src/workspace/diff.ts'

test('单行替换：一加一减', () => {
  const d = unifiedDiff('a.md', 'x\ny\n', 'x\nz\n')
  assert.equal(d.added, 1)
  assert.equal(d.removed, 1)
  assert.match(d.text, /^-y$/m)
  assert.match(d.text, /^\+z$/m)
})

test('纯追加', () => {
  const d = unifiedDiff('a.md', 'a\n', 'a\nb\nc\n')
  assert.equal(d.added, 2)
  assert.equal(d.removed, 0)
})

test('无变化时只有文件头', () => {
  const d = unifiedDiff('a.md', 'a\n', 'a\n')
  assert.equal(d.added, 0)
  assert.equal(d.removed, 0)
})

test('超长文件退化成摘要', () => {
  const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
  const d = unifiedDiff('big.md', big, `${big}\nextra`)
  assert.equal(d.truncated, true)
  assert.match(d.text, /文件太大/)
})
