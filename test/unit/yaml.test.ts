import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseYaml, stringifyYaml, YamlError } from '../../src/store/yaml.ts'

test('块状映射 / 序列 / 序列内嵌映射', () => {
  const value = parseYaml(`
a: 1
b:
  c: true
  d: null
list:
  - x
  - y
items:
  - id: one
    n: 2
  - id: two
`)
  assert.deepEqual(value, {
    a: 1,
    b: { c: true, d: null },
    list: ['x', 'y'],
    items: [
      { id: 'one', n: 2 },
      { id: 'two' },
    ],
  })
})

test('引号、行内数组与注释', () => {
  const value = parseYaml(`s: "a: b"   # 注释
q: 'x y'
arr: [a, b, c]
`)
  assert.deepEqual(value, { s: 'a: b', q: 'x y', arr: ['a', 'b', 'c'] })
})

test('roundtrip 保持结构', () => {
  const source = `version: 1
hash:
  alg: sha256
nodes:
  - id: a
    path: a.md
edges: []`
  const once = parseYaml(source)
  const twice = parseYaml(stringifyYaml(once))
  assert.deepEqual(twice, once)
})

test('拒绝行内映射（不猜）', () => {
  assert.throws(() => parseYaml('x: { a: 1 }'), (e: unknown) => e instanceof YamlError)
})

test('拒绝 Tab 缩进与奇数缩进', () => {
  assert.throws(() => parseYaml('a:\n\tb: 1'))
  assert.throws(() => parseYaml('a:\n   b: 1'))
})

test('拒绝重复键', () => {
  assert.throws(() => parseYaml('a: 1\na: 2'))
})

test('空文档解析为空对象', () => {
  assert.deepEqual(parseYaml(''), {})
})
