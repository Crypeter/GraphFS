import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileJournal, MemoryJournal, journalPathFor } from '../../src/store/journal.ts'

async function dir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'graphfs-journal-'))
}

test('MemoryJournal：按顺序追加，tail 取最近 n 条', async () => {
  const journal = new MemoryJournal()
  await journal.append({ at: 't1', kind: 'init' })
  await journal.append({ at: 't2', kind: 'link', edgeId: 'e1' })
  await journal.append({ at: 't3', kind: 'ack', edgeId: 'e1' })

  const tail = await journal.tail(2)
  assert.deepEqual(tail.map((e) => e.kind), ['link', 'ack'])
  assert.equal((await journal.tail(0)).length, 0)
})

test('FileJournal：JSONL 追加可读，tail 保留原始 detail', async () => {
  const base = await dir()
  const path = join(base, 'audit/journal.jsonl')
  const journal = new FileJournal(path)

  await journal.append({ at: '2026-01-01T00:00:00.000Z', kind: 'ack', actor: 'cli', edgeId: 'e1', detail: { reason: '因为' } })
  const entries = await journal.tail(10)
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0]!.detail, { reason: '因为' })

  const raw = await readFile(path, 'utf8')
  assert.equal(raw.trim().split('\n').length, 1)
  assert.ok(raw.endsWith('\n'))
})

test('FileJournal：损坏的半行被跳过，不影响其余记录', async () => {
  const base = await dir()
  const path = join(base, 'journal.jsonl')
  await writeFile(
    path,
    '{"at":"t1","kind":"init"}\n{ broken json\n{"at":"t2","kind":"link"}\n',
    'utf8',
  )
  const journal = new FileJournal(path)
  const entries = await journal.tail(10)
  assert.deepEqual(entries.map((e) => e.kind), ['init', 'link'])
})

test('FileJournal：超过 maxBytes 轮转成 .1，且只保留一代', async () => {
  const base = await dir()
  const path = join(base, 'journal.jsonl')
  const journal = new FileJournal(path, { maxBytes: 20 })

  await journal.append({ at: 't1', kind: 'init', detail: 'a'.repeat(20) })
  await journal.append({ at: 't2', kind: 'link', detail: 'b'.repeat(20) })
  await journal.append({ at: 't3', kind: 'ack', detail: 'c'.repeat(20) })

  assert.equal((await stat(`${path}.1`)).isFile(), true)
  const current = await readFile(path, 'utf8')
  assert.ok(current.includes('"t3"'))
})

test('FileJournal：不可写时 append 不抛（审计降级）', async () => {
  const base = await dir()
  // 让父路径是个普通文件：mkdir/append 都会 ENOTDIR。
  const blocker = join(base, 'blocker')
  await writeFile(blocker, 'x', 'utf8')
  const journal = new FileJournal(join(blocker, 'audit.jsonl'))

  await assert.doesNotReject(() => journal.append({ at: 't', kind: 'init' }))
  assert.deepEqual(await journal.tail(5), [])
})

test('FileJournal：目录不存在时自动创建', async () => {
  const base = await dir()
  const path = join(base, 'deep', 'audit', 'journal.jsonl')
  const journal = new FileJournal(path)
  await journal.append({ at: 't', kind: 'init' })
  assert.equal((await journal.tail(1)).length, 1)
  await mkdir(join(base, 'deep'), { recursive: true })
})

test('journalPathFor：审计跟图文件走', () => {
  assert.equal(journalPathFor('/w/.graphfs/graph.yaml'), '/w/.graphfs/audit/journal.jsonl')
  assert.equal(journalPathFor('/tmp/g.yaml'), '/tmp/audit/journal.jsonl')
})
