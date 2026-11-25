import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
                                                                

/**
 * 审计日志（M4）。
 *
 * 事实来源是 **JSONL 文件**：`.graphfs/audit/journal.jsonl`，一行一条，追加写。
 * 选 JSONL 而不是二进制/存储服务的原因：
 *   - 可以被 git diff、`tail`、`jq` 直接读（"审计"首先得可读）；
 *   - 追加写在单机上通常不会写坏已有行（< PIPE_BUF），损坏行在读时跳过；
 *   - 零依赖，插件与 CLI 共用。
 *
 * 契约（Spec §5）：**append 失败不得抛到主流程**——审计丢了是遗憾，业务崩了是事故。
 */

/** 审计事件类型：只增不改，读侧按字符串容错。 */
                       
          
          
            
            
         
           
            
            
             
           

                                                  
                          
                                       
                
                                      
               
 

                                 
                                        
                   
                                        
                   
 

/** 进程内日志：测试与无盘场景。 */
export class MemoryJournal                    {
                   entries               = []

  async append(entry              )                {
    this.entries.push(structuredClone(entry)              )
  }

  async tail(n        )                          {
    if (n <= 0) return []
    return this.entries.slice(-n).map((entry) => structuredClone(entry))
  }
}

/** 什么都不记：`mode: observe` 之外的降级路径。 */
export class NullJournal                    {
  async append(_entry              )                {}

  async tail(_n        )                          {
    return []
  }
}

/** 文件审计日志；任何 I/O 错误都不外抛。 */
export class FileJournal                    {
           path        
                   maxBytes        
                   swallow         

  constructor(path        , opts                 = {}) {
    this.path = path
    this.maxBytes = opts.maxBytes ?? 1024 * 1024
    this.swallow = opts.swallow ?? true
  }

  async append(entry              )                {
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await this.rotateIfNeeded()
      await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch (error) {
      if (!this.swallow) throw error
      // 磁盘满 / 只读挂载：只降级为"不记"，下次调用再试一次（不永久关闭）。
    }
  }

  async tail(n        )                          {
    const limit = Math.max(0, n)
    if (limit === 0) return []
    let text        
    try {
      text = await readFile(this.path, 'utf8')
    } catch {
      return []
    }
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    const out                 = []
    for (const line of lines.slice(-limit)) {
      try {
        const parsed = JSON.parse(line)                
        if (parsed && typeof parsed === 'object' && typeof parsed.at === 'string') out.push(parsed)
      } catch {
        // 半行（进程被杀在写入中间）跳过，不影响其余记录。
      }
    }
    return out
  }

  /** 轮转只保留一代：`journal.jsonl` → `journal.jsonl.1`。 */
          async rotateIfNeeded()                {
    let size = 0
    try {
      size = (await stat(this.path)).size
    } catch {
      return
    }
    if (size < this.maxBytes) return
    try {
      await rename(this.path, `${this.path}.1`)
    } catch {
      // 轮转失败不阻塞写入：继续追加到原文件。
    }
  }
}

/** 审计路径：与 graph.yaml 同目录（图可能在 root 之外，审计跟着图走）。 */
export function journalPathFor(graphPath        )         {
  const dir = graphPath.replace(/\/[^/]*$/, '')
  return `${dir}/audit/journal.jsonl`
}


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/store/journal.ts