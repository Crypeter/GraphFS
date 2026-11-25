import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPack, extractImports, extractSymbols, renderPackMarkdown, sampleAcrossDirs } from '../../src/importers/pack.ts'

test('extractSymbols：Python 定义，注释不算', () => {
  const text = [
    '# Load CM scores',
    'class A:',
    '    pass',
    'def run():',
    '    pass',
    '# 又一个注释',
  ].join('\n')
  assert.deepEqual(extractSymbols('x.py', text), ['A', 'run'])
})

test('extractSymbols：TS export 与 Markdown 标题', () => {
  assert.deepEqual(extractSymbols('x.ts', 'export function go() {}\nexport const x = 1\n'), ['go', 'x'])
  assert.deepEqual(extractSymbols('x.md', '# A\n## B\n正文\n### C\n'), ['A', 'B', 'C'])
})

test('extractImports：只保留工作区内可解析的目标', () => {
  const files = new Set(['pkg/models.py', 'pkg/main.py', 'src/util.ts'])
  const py = 'from models import M\nimport os\nfrom . import x\n'
  assert.deepEqual(extractImports('pkg/main.py', py, files), ['pkg/models.py'])

  const ts = "import { x } from '../src/util.ts'\nimport 'node:fs'\n"
  assert.deepEqual(extractImports('pkg/main.ts', ts, files), ['src/util.ts'])
})

test('buildPack：有界、跳过二进制、带启发式候选', async () => {
  const files = ['a.py', 'b.py', 'noise.zip']
  const contents: Record<string, string> = { 'a.py': 'def f(): pass\n', 'b.py': 'from a import f\n' }
  const pack = await buildPack({
    root: '/r',
    files,
    read: async (p) => contents[p] ?? null,
    heuristic: [
      {
        from: 'a', to: 'b', fromPath: 'a.py', toPath: 'b.py',
        relation: 'constrains', confidence: 0.8, evidence: 'import a', source: 'heuristic',
      },
    ],
    now: 't0',
    limits: { maxFiles: 1 },
  })
  assert.equal(pack.files.length, 1, 'maxFiles 生效')
  assert.ok(pack.files.every((f) => f.path !== 'noise.zip'))
  assert.equal(pack.heuristic.length, 1)
  assert.match(renderPackMarkdown(pack), /候选边任务/)
})

test('sampleAcrossDirs：按目录轮流取，避免只喂字母序前缀', () => {
  const files = ['include/a.h', 'include/b.h', 'include/c.h', 'src/x.cpp', 'src/y.cpp', 'README.md']
  assert.deepEqual(sampleAcrossDirs(files, 4), ['README.md', 'include/a.h', 'src/x.cpp', 'include/b.h'])
})
