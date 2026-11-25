import { unifiedDiff } from './diff.js'
                                            
                                            
                                                  
                                                
                                                                  
import { digest16 } from '../core/hash.js'
import { normalize } from '../core/normalize.js'
                                                        

/**
 * 确定性边的执行（`policy: auto` + `producer`）。
 *
 * 默认 **dry-run**：真的跑命令、捕获产物、算出 diff，然后**把文件恢复原状**。
 * 这样"预览"看到的是真实输出，而不是猜测；代价是生产者必须可重复执行（这是它的定义）。
 *
 * 拒绝 dry-run 的情况：产物不是文本 / 超过大小上限 / 不在 root 内 —— 无法恢复就不预览。
 */

                            
            
                    
                      
                
                      
                         
                   
                       
                                                                             
 

                             
              
                     
                    
                   
 

                               
                
                
                                                                   
                 
                       
                 
                 
 

                              
                 
                          
 

                               
                 
                 
                      
                                    
                         
 

export async function applyPlan(deps           , plan      , opts              )                       {
  const outcomes                 = []
  const selected = opts.only ? plan.obligations.filter((o) => opts.only .includes(o.edgeId)) : plan.obligations

  for (const obligation of selected) {
    const edge = deps.graph.edges.get(obligation.edgeId)
    if (!edge) {
      outcomes.push(skip(obligation, 'edge missing from graph'))
      continue
    }
    if (edge.policy !== 'auto' || !edge.producer) {
      outcomes.push(skip(obligation, 'not a deterministic edge (policy=auto + producer required)'))
      continue
    }
    outcomes.push(await applyOne(deps, obligation, edge.producer, opts))
  }

  return { dryRun: opts.dryRun, outcomes }
}

                                                                                                                                         

async function applyOne(
  deps           ,
  obligation            ,
  producer          ,
  opts              ,
)                        {
  const base = { edgeId: obligation.edgeId, target: obligation.target, outputs: []                 }

  if (producer.outputs.length === 0) {
    return { ...base, status: 'skipped', reason: 'producer declares no outputs' }
  }

  // 1) 先确认所有产物都能被读回——读不回来就无法 dry-run 恢复。
  const before = new Map                                               ()
  for (const path of producer.outputs) {
    deps.policy.resolve(path) // 越界在这里抛 GF_WORKSPACE_MISMATCH
    const text = await deps.io.readText(path)
    if (text === null) {
      before.set(path, null)
      continue
    }
    if (Buffer.byteLength(text, 'utf8') > deps.maxFileBytes) {
      return { ...base, status: 'skipped', reason: `${path} exceeds maxFileBytes; refusing to preview` }
    }
    if (text.slice(0, 8192).includes('\u0000')) {
      return { ...base, status: 'skipped', reason: `${path} looks binary; refusing to preview` }
    }
    before.set(path, { text, hash: digest16(normalize(text, deps.normalize)) })
  }

  // 2) 执行**两次**：第一次用来出 diff，第二次用来判断生产器是否确定（F5）。
  //    不确定的生成器（时间戳、随机顺序）在真实写回后会永远"看起来过期"，
  //    所以这里宁可降级为人工确认，也不自动写。
  const restore = async ()                => {
    for (const [path, previous] of before) {
      if (previous === null) await deps.io.remove(path).catch(() => undefined)
      else await deps.io.writeText(path, previous.text).catch(() => undefined)
    }
  }

  const runOnce = async (           
                                                                                       
                                                                     
  ) => {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    let result
    try {
      result = await deps.runner.run(producer, controller.signal)
    } catch (error) {
      return { ok: false, reason: (error         ).message }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
    }

    if (result.code !== 0) {
      return {
        ok: false,
        reason: `producer exited ${result.code}`,
        stdout: tail(result.stdout),
        stderr: tail(result.stderr),
      }
    }

    const after = new Map                       ()
    for (const path of producer.outputs) after.set(path, await deps.io.readText(path))
    return { ok: true, stdout: tail(result.stdout), stderr: tail(result.stderr), after }
  }

  const first = await runOnce()
  if (!first.ok) {
    await restore()
    return { ...base, status: 'failed', reason: first.reason, stdout: first.stdout, stderr: first.stderr }
  }
  await restore()

  const second = await runOnce()
  if (!second.ok) {
    await restore()
    return { ...base, status: 'failed', reason: second.reason, stdout: second.stdout, stderr: second.stderr }
  }

  const deterministic = sameOutputs(first.after, second.after, deps.normalize)

  // 3) 收集产物差异（以第二次运行为准：真实写回时留在盘上的就是它）
  const outputs               = []
  for (const path of producer.outputs) {
    const previous = before.get(path) ?? null
    const next = second.after.get(path) ?? null
    if (next === null && previous === null) continue
    const beforeText = previous?.text ?? ''
    const afterText = next ?? ''
    if (beforeText === afterText) continue
    outputs.push({
      path,
      beforeBytes: Buffer.byteLength(beforeText, 'utf8'),
      afterBytes: Buffer.byteLength(afterText, 'utf8'),
      diff: unifiedDiff(path, beforeText, afterText),
    })
  }

  if (!deterministic && opts.allowUnstable !== true) {
    await restore()
    return {
      ...base,
      outputs,
      status: 'unstable',
      reason: 'producer is not deterministic (two runs differ); demoted to advise — confirm with allowUnstable',
      stdout: second.stdout,
      stderr: second.stderr,
    }
  }

  // 4) dry-run：恢复原状；真实执行：提交基线
  if (opts.dryRun) {
    await restore()
    return { ...base, outputs, status: 'preview', stdout: second.stdout, stderr: second.stderr }
  }

  const fromHash = await hashNodeText(deps, deps.graph.nodes.get(obligation.cause)?.path)
  const toHash = await hashNodeText(deps, deps.graph.nodes.get(obligation.target)?.path)
  await deps.commit(obligation.edgeId, fromHash ?? '', toHash ?? '')
  return { ...base, outputs, status: 'applied', stdout: second.stdout, stderr: second.stderr }
}

/** 两次运行的产物是否等价（按规范化后的指纹比较，而不是字节）。 */
function sameOutputs(
  a                            ,
  b                            ,
  normalizer              ,
)          {
  if (a.size !== b.size) return false
  for (const [path, text] of a) {
    const other = b.get(path) ?? null
    const left = text === null ? null : digest16(normalize(text, normalizer))
    const right = other === null ? null : digest16(normalize(other, normalizer))
    if (left !== right) return false
  }
  return true
}

function skip(obligation            , reason        )               {
  return { edgeId: obligation.edgeId, target: obligation.target, status: 'skipped', reason, outputs: [] }
}

async function hashNodeText(deps           , path                    )                         {
  if (!path) return null
  const text = await deps.io.readText(path)
  if (text === null) return null
  return digest16(normalize(text, deps.normalize))
}

function tail(text                    , max = 800)                     {
  if (!text) return undefined
  return text.length > max ? `…${text.slice(-max)}` : text
}


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/workspace/apply.ts