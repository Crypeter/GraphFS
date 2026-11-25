import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize, normalizeI18nSection, normalizeI18nText, normalizeText } from '../../src/core/normalize.ts'
import { digest16 } from '../../src/core/hash.ts'

/* ---------------------------------------------- text：空白/换行不敏感 */

test('text：CRLF 与 LF 等价', () => {
  assert.equal(normalizeText('a\r\nb\r\n'), normalizeText('a\nb\n'))
})

test('text：末尾换行数量无关', () => {
  assert.equal(normalizeText('a\n'), normalizeText('a\n\n\n'))
  assert.equal(normalizeText('a'), normalizeText('a\n'))
})

test('text：行尾空白无关，但行内空白有关', () => {
  assert.equal(normalizeText('a   \nb\t\n'), normalizeText('a\nb\n'))
  assert.notEqual(normalizeText('a b'), normalizeText('a  b'))
})

test('text：BOM 被剥离', () => {
  assert.equal(normalizeText('\uFEFFhello\n'), normalizeText('hello\n'))
})

test('text：空输入是空串而不是换行', () => {
  assert.equal(normalizeText(''), '')
  assert.equal(normalizeText('\n\n'), '')
})

/* ------------------------------------------- dsh-i18n-v1：与 DSH 账本对齐 */

test('i18n：代码块整体剔除（含围栏行）', () => {
  const withCode = ['## X', '', '前', '', '```ts', 'const a = 1', '```', '', '后'].join('\n')
  assert.equal(normalizeI18nText(withCode), '## X\n前\n后')
})

test('i18n：空行剔除、逐行 trim', () => {
  assert.equal(normalizeI18nText('  ## X  \n\n\n   正文   \n'), '## X\n正文')
})

test('i18n：末尾不加换行', () => {
  assert.equal(normalizeI18nText('a\n\n'), 'a')
})

test('i18n：normalizeI18nSection 与直接拼接口径一致', () => {
  assert.equal(normalizeI18nSection('## X', ['a', '', 'b']), normalizeI18nText('## X\na\n\nb'))
})

/* ---------------------------------------------------------------- golden */

const SUMMARY_BODY =
  'Use `dsh-atomic-write` to replace a file without exposing partial content or following a symlinked temporary path. ' +
  'Its writer lock serializes read-modify-write cycles across processes so concurrent writers cannot overwrite one another with stale state. ' +
  "Each replacement uses caller-selected permission bits on a fresh inode, which safely narrows an existing file's permissions. " +
  'This zero-dependency library accepts strings and binary byte arrays; it does not provide a `cordis.yml` plugin or crash durability because it does not call `fsync`.'

test('golden：dsh-atomic-write 的 ## Summary 节 == 账本里的 d2d40e759179f047', () => {
  const text = normalizeI18nSection('## Summary', [SUMMARY_BODY])
  assert.equal(digest16(text), 'd2d40e759179f047')
})

test('golden：## Table of Contents 连同分隔线与下一节锚点 == d152484eb41ac6b4', () => {
  const lines = [
    '## Table of Contents',
    '',
    '- [Use this package](#use-this-package)',
    '- [Understand the implementation](#understand-the-implementation)',
    '- [Further Exploration](#further-exploration)',
    '- [Model Experience](#model-experience)',
    '- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)',
    '- [Dev Note](#dev-note)',
    '',
    '-----',
    '',
    '<a id="use-this-package"></a>',
  ]
  assert.equal(digest16(normalizeI18nText(lines.join('\n'))), 'd152484eb41ac6b4')
})

/* --------------------------------------------------------------- 分派器 */

test('normalize 按 id 分派；未知 id 抛错', () => {
  assert.equal(normalize('a\n', 'text'), 'a\n')
  assert.equal(normalize(' a \n\n', 'dsh-i18n-v1'), 'a')
  assert.equal(normalize('raw\r\n', 'bytes'), 'raw\r\n')
  assert.throws(() => normalize('x', 'nope' as never))
})
