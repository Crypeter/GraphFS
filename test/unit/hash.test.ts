import { test } from 'node:test'
import assert from 'node:assert/strict'
import { digest16 } from '../../src/core/hash.ts'

test('digest16 是 sha256 的前 8 字节', () => {
  assert.equal(digest16(''), 'e3b0c44298fc1c14')
  assert.equal(digest16('a'), 'ca978112ca1bbdca')
  assert.equal(digest16('abc').length, 16)
})

test('中文与换行差异进入指纹', () => {
  assert.notEqual(digest16('中文'), digest16('英文'))
  assert.notEqual(digest16('a\nb'), digest16('a b'))
})

test('同一输入稳定', () => {
  assert.equal(digest16('同一输入'), digest16('同一输入'))
})
