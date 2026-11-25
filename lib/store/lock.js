import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname } from 'node:path'
import { hostname } from 'node:os'
import { GraphFSError } from '../types.js'

/**
 * 跨进程文件锁（M4）。
 *
 * 场景：IDE 里的 CLI 与 DSH 插件同时改 `graph.yaml`；两个 CLI 同时 `ack`。
 * 做法是**单机文件锁**：`O_CREAT|O_EXCL` 建锁文件，内容记录 pid/host/时间。
 *
 * 三条务实规则：
 *   1. **同进程可重入**：`apply` 持锁执行 producer，内部 `commit` 再取锁不应死锁；
 *   2. **可抢陈旧锁**：持锁进程已死（同机 pid 不存在）或超过 `staleMs`，视为残留；
 *   3. **超时给码**：`GF_LOCK_TIMEOUT` + remedy，而不是无限等待。
 *
 * 明确不做：分布式锁、租约续期。单机工作区不需要，Spec §13 也把它列为非目标。
 */

                              
                      
                    
                                                        
                  
                      
                     
 

/**
 * 用异步上下文（而不是进程级 Map）判断"重入"：
 * 并发的两个调用在同一个进程里也必须互斥，只有**同一条调用链**里的嵌套才算重入。
 */
const heldByChain = new AsyncLocalStorage                     ()

                      
              
               
             
 

/** 同进程重入 + 跨进程排他。 */
export async function withFileLock   (
  path        ,
  fn                  ,
  opts              = {},
)             {
  const chain = heldByChain.getStore()
  if (chain?.has(path)) return await fn()

  const release = await acquire(path, opts)
  const next = new Set(chain ?? [])
  next.add(path)
  try {
    return await heldByChain.run(next, fn)
  } finally {
    await release()
  }
}

async function acquire(path        , opts             )                               {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const staleMs = opts.staleMs ?? 5 * 60_000
  const intervalMs = opts.intervalMs ?? 25
  const deadline = Date.now() + timeoutMs

  await mkdir(dirname(path), { recursive: true })

  for (;;) {
    try {
      const handle = await open(path, 'wx')
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() })}\n`,
        'utf8',
      )
      await handle.close()
      return async () => {
        await unlink(path).catch(() => undefined)
      }
    } catch (error) {
      if ((error                     ).code !== 'EEXIST') throw error
    }

    if (await isStale(path, staleMs)) {
      // 只删"确认陈旧"的锁；删除失败就继续等，交给下一轮判断。
      await unlink(path).catch(() => undefined)
      continue
    }

    if (Date.now() >= deadline) {
      throw new GraphFSError(
        `timed out waiting for the workspace lock: ${path}`,
        'GF_LOCK_TIMEOUT',
        'another graphfs/DSH process is writing this workspace; retry, or delete the lock file if it is stale',
      )
    }
    await sleep(intervalMs)
  }
}

async function isStale(path        , staleMs        )                   {
  let record            
  try {
    const text = await readFile(path, 'utf8')
    record = JSON.parse(text)              
  } catch {
    // 锁文件刚建、内容还没写完：当作新鲜，等超时而不是抢。
    return false
  }

  if (record.host !== hostname()) {
    // 别的主机：pid 检查没有意义，只能按时间判断（NFS/共享盘上仍可能残留）。
  } else if (typeof record.pid === 'number') {
    // 同进程的并发调用也会看到自己的 pid：这里必须当作"活着"等待，
    // 否则会把正在进行的持锁当成残留直接抢掉。
    if (!alive(record.pid)) return true
  }

  // 拿不到记录时间时退回文件 mtime；两处都不可信就当新鲜。
  const at = typeof record.at === 'string' ? Date.parse(record.at) : Number.NaN
  let stamp = Number.isFinite(at) ? at : 0
  if (stamp === 0) {
    try {
      stamp = (await stat(path)).mtimeMs
    } catch {
      return false
    }
  }
  return stamp > 0 && Date.now() - stamp > staleMs
}

function alive(pid        )          {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但没权限；只有 ESRCH 才是"确实没了"。
    return (error                     ).code === 'EPERM'
  }
}

function sleep(ms        )                {
  return new Promise((resolve) => setTimeout(resolve, ms))
}


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/store/lock.ts