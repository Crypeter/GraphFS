import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from '../../src/cli/args.ts'

test('布尔 flag 不吞下一个参数（--deep / --pack / --yes）', () => {
  const a = parseArgs(['suggest', '--deep', '--root', '/repo'])
  assert.equal(a.root, '/repo')
  assert.equal(a.flags.has('deep'), true)

  const b = parseArgs(['suggest', '--pack', '--root', '/repo', '--max-files', '5'])
  assert.equal(b.root, '/repo')
  assert.equal(b.flags.get('max-files'), '5')

  const c = parseArgs(['apply', '--root', '/r', '--apply', '--yes'])
  assert.equal(c.flags.has('apply'), true)
  assert.equal(c.flags.has('yes'), true)
  assert.equal(c.root, '/r')
})

test('取值 flag 正常消费，--to 可重复', () => {
  const a = parseArgs(['link', '--from', 'a', '--to', 'b', '--relation', 'documents'])
  assert.equal(a.flags.get('from'), 'a')
  assert.deepEqual(a.multi.get('to'), ['b'])
  assert.equal(a.flags.get('relation'), 'documents')

  const b = parseArgs(['attach', 'x.md', '--to', 'a', '--to', 'b', '--relation', 'documents'])
  assert.deepEqual(b.multi.get('to'), ['a', 'b'])
  assert.deepEqual(b.rest, ['x.md'])
})

test('--key=value 形式', () => {
  const a = parseArgs(['check', '--root=/repo', '--json'])
  assert.equal(a.root, '/repo')
  assert.equal(a.flags.has('json'), true)
})

test('root 相对路径转绝对', () => {
  const a = parseArgs(['check', '--root', '.'])
  assert.ok(a.root.startsWith('/'))
})
