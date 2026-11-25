import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFileIndex,
  headerImplPair,
  parseGoImports,
  parseIncludes,
  parseJvmImports,
  parseRustRefs,
  parseShellSources,
  resolveGoImport,
  resolveInclude,
  resolveJvmImport,
  resolveRustRef,
  testPair,
} from '../../src/importers/code-refs.ts'

const index = (...files: string[]) => buildFileIndex(files)

test('parseIncludes：区分引号与尖括号，忽略注释里的 #include', () => {
  const includes = parseIncludes(
    ['#include "a.h"', '#include <stdio.h>', '// #include "no.h"', '#include "b/c.h"'].join('\n'),
  )
  assert.deepEqual(includes, [
    { spec: 'a.h', quoted: true },
    { spec: 'stdio.h', quoted: false },
    { spec: 'b/c.h', quoted: true },
  ])
})

test('resolveInclude：相对命中、根目录命中、basename 最近邻、歧义放弃', () => {
  const files = index('src/a.h', 'include/b.h', 'pkg/include/x.h', 'other/x.h')
  assert.equal(resolveInclude('src', { spec: 'a.h', quoted: true }, files), 'src/a.h')
  assert.equal(resolveInclude('src', { spec: 'include/b.h', quoted: true }, files), 'include/b.h')
  assert.equal(resolveInclude('src', { spec: 'b.h', quoted: true }, files), 'include/b.h')
  // 两个 x.h：从 pkg/src 看，pkg/include 更近
  assert.equal(resolveInclude('pkg/src', { spec: 'x.h', quoted: true }, files), 'pkg/include/x.h')
  // 从无关目录看，两个候选一样远 → 不猜
  assert.equal(resolveInclude('zzz', { spec: 'x.h', quoted: true }, files), null)
})

test('headerImplPair / testPair：同名配对', () => {
  const files = new Set(['src/a.h', 'src/a.c', 'src/b.test.ts', 'src/b.ts', 'lib/c.go', 'lib/c_test.go'])
  assert.equal(headerImplPair('src/a.h', files), 'src/a.c')
  assert.equal(headerImplPair('src/a.c', files), null)
  assert.equal(testPair('src/b.ts', files), 'src/b.test.ts')
  assert.equal(testPair('lib/c.go', files), 'lib/c_test.go')
})

test('Go：单行与块状 import；解析到包目录下的文件', () => {
  const text = ['package main', '', 'import (', '\t"fmt"', '\t"example.com/x/pkg/foo"', ')', '', 'import "os"'].join('\n')
  assert.deepEqual(parseGoImports(text), ['fmt', 'example.com/x/pkg/foo', 'os'])

  const files = index('pkg/foo/a.go', 'pkg/foo/b.go', 'pkg/foo/a_test.go', 'app/main.go')
  const targets = resolveGoImport('app', 'example.com/x/pkg/foo', files)
  assert.deepEqual(targets, ['pkg/foo/a.go', 'pkg/foo/b.go'])
})

test('Rust：mod 与 use crate::', () => {
  const text = ['mod foo;', 'use crate::a::b::Thing;', 'use std::collections::HashMap;'].join('\n')
  assert.deepEqual(parseRustRefs(text), ['foo', 'crate::a::b::Thing'])

  const files = index('src/main.rs', 'src/foo.rs', 'src/a/b.rs')
  assert.equal(resolveRustRef('src', 'foo', files), 'src/foo.rs')
  assert.equal(resolveRustRef('src', 'crate::a::b', files), 'src/a/b.rs')
  assert.equal(resolveRustRef('src', 'crate::a::b::Thing', files), 'src/a/b.rs')
  assert.equal(resolveRustRef('src', 'crate::nope', files), null)
})

test('Java：点号 import → 源码路径', () => {
  assert.deepEqual(parseJvmImports('import com.x.A;\nimport static java.util.List.of;'), [
    'com.x.A',
    'java.util.List.of',
  ])
  const files = index('src/main/java/com/x/A.java', 'src/test/java/com/x/ATest.java')
  assert.equal(resolveJvmImport('com.x.A', files), 'src/main/java/com/x/A.java')
  assert.equal(resolveJvmImport('com.x.Nope', files), null)
})

test('Shell：source / . 两种写法', () => {
  assert.deepEqual(parseShellSources('source ./lib.sh\n. ../env\n# source never\n'), ['./lib.sh', '../env'])
})
