import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { withFileLock } from '../../src/store/lock.ts'

async function lockPath(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'graphfs-lock-'))
  return join(base, 'lock')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('互斥：两个 withFileLock 不会同时进入临界区', async () => {
  const path = await lockPath()
  let inside = 0
  let maxInside = 0
  let entered = 0

  const task = async (): Promise<void> => {
    await withFileLock(path, async () => {
      inside += 1
      entered += 1
      maxInside = Math.max(maxInside, inside)
      await sleep(40)
      inside -= 1
    })
  }

  await Promise.all([task(), task()])
  assert.equal(entered, 2)
  assert.equal(maxInside, 1, '临界区最多只能有一个持有者')
})

test('同进程可重入：嵌套调用不会死锁', async () => {
  const path = await lockPath()
  const value = await withFileLock(path, async () => {
    return await withFileLock(path, async () => {
      return await withFileLock(path, async () => 42)
    })
  })
  assert.equal(value, 42)
  await assert.rejects(() => access(path), '锁在释放后必须删除')
})

test('残留锁（pid 已死）可以被抢', async () => {
  const path = await lockPath()
  // pid 999999 在这个容器/机器上不存在 → ESRCH
  await writeFile(path, JSON.stringify({ pid: 999999, host: hostname(), at: new Date().toISOString() }))

  const started = Date.now()
  const value = await withFileLock(path, async () => 'got-it', { timeoutMs: 1000, intervalMs: 5 })
  assert.equal(value, 'got-it')
  assert.ok(Date.now() - started < 800, '抢锁不应等到超时')
})

test('新鲜的外来锁：超时给出 GF_LOCK_TIMEOUT', async () => {
  const path = await lockPath()
  await writeFile(
    path,
    JSON.stringify({ pid: 1, host: 'a-different-host', at: new Date().toISOString() }),
  )

  await assert.rejects(
    () => withFileLock(path, async () => 'never', { timeoutMs: 80, intervalMs: 10 }),
    (error: unknown) => (error as { code?: string }).code === 'GF_LOCK_TIMEOUT',
  )
})

test('超过 staleMs 的锁视为残留（即使 pid 还活着）', async () => {
  const path = await lockPath()
  const old = new Date(Date.now() - 60_000).toISOString()
  await writeFile(path, JSON.stringify({ pid: process.pid, host: 'a-different-host', at: old }))

  const value = await withFileLock(path, async () => 'stolen', { timeoutMs: 1000, staleMs: 1000 })
  assert.equal(value, 'stolen')
})

test('释放锁后文件消失，后续可再次获取', async () => {
  const path = await lockPath()
  await withFileLock(path, async () => undefined)
  await withFileLock(path, async () => undefined)

  const text = await readFile(path, 'utf8').catch(() => null)
  assert.equal(text, null)
})
