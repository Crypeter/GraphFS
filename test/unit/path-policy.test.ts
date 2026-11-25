import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PathPolicy } from '../../src/workspace/path-policy.ts'

const policy = new PathPolicy('/repo', ['node_modules', '.graphfs', 'dist/out'])

test('resolve 把相对路径钉在 root 内', () => {
  assert.equal(policy.resolve('a/b.md'), '/repo/a/b.md')
  assert.equal(policy.resolve('./a.md'), '/repo/a.md')
})

test('越界与绝对路径被拒', () => {
  for (const bad of ['../etc/passwd', '/etc/passwd', 'a/../../x']) {
    assert.throws(() => policy.resolve(bad), (e: unknown) => (e as { code?: string }).code === 'GF_WORKSPACE_MISMATCH')
  }
})

test('relative 只接受 root 内路径', () => {
  assert.equal(policy.relative('/repo/a/b.md'), 'a/b.md')
  assert.equal(policy.relative('/other/a.md'), null)
})

test('isIgnored 命中任一路径段', () => {
  assert.equal(policy.isIgnored('node_modules/x/y.js'), true)
  assert.equal(policy.isIgnored('.graphfs/graph.yaml'), true)
  assert.equal(policy.isIgnored('src/main.py'), false)
  assert.equal(policy.isIgnored('dist/out/a.js'), true)
})
