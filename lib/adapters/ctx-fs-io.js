                                            
                                                             

/**
 * `FileIo` 的 DSH 实现：走 `ctx.fs`，因此继承宿主的沙箱与远端后端能力。
 *
 * 签名按 `@deepseek-ai/dsh-fs-local` 的实际实现核对过（2026-11）：
 *   resolve(path, {cwd, signal})      → { targetKey, displayPath }
 *   stat(target, signal)              → { version, type, size } | undefined
 *   readText(target, signal)          → string（缺文件抛 FS_NOT_FOUND）
 *   writeText(target, content, expected, signal)   expected = {kind:'createIfAbsent'} | {version}
 *   deleteFile(target, expected, signal)
 *   moveFile(source, destination, options, signal)
 *   listDir(target, signal)           → [{ name, type, target, version?, size? }]
 *   watch(target, changed, signal)
 *
 * ⚠️ 本文件只在 DSH 运行时可用；本地用 `test/helpers/fake-fs.ts` 按同一契约做替身测试。
 */

                               
                     
                      
 

                    
              
              
                      
 

                        
                                                                                             
                                                                                                                            
                                                                       
                                                                                                              
                                                                                              
                                                                                                                      
                                                                           
                                                                                                                
                                            
 

export class CtxFsIo                   {
                   fs       
                   policy            

  constructor(fs       , policy            ) {
    this.fs = fs
    this.policy = policy
  }

  async readText(rel        )                         {
    const target = await this.target(rel)
    try {
      return await this.fs.readText(target)
    } catch (error) {
      if (isCode(error, 'FS_NOT_FOUND')) return null
      throw error
    }
  }

  async writeText(rel        , text        )                  {
    const target = await this.target(rel)
    const info = await this.fs.stat(target)
    // 有版本就带上 CAS，没有就要求「不存在才建」——两种情况都不会静默覆盖并发写入。
    const expected = info?.version !== undefined ? { version: info.version } : { kind: 'createIfAbsent' }
    await this.fs.writeText(target, text, expected)
    return typeof info?.version === 'string' ? info.version : ''
  }

  async remove(rel        )                   {
    const target = await this.target(rel)
    try {
      const info = await this.fs.stat(target)
      await this.fs.deleteFile(target, info?.version !== undefined ? { version: info.version } : undefined)
      return true
    } catch (error) {
      if (isCode(error, 'FS_NOT_FOUND')) return false
      throw error
    }
  }

  async move(from        , to        )                {
    await this.fs.moveFile(await this.target(from), await this.target(to), {})
  }

  async list(relDir = '.', opts                     = {})                    {
    if (!this.fs.listDir) return []
    const maxDepth = opts.depth ?? 12
    const out           = []

    const walk = async (rel        , depth        )                => {
      if (depth > maxDepth) return
      const entries = await this.fs.listDir (await this.target(rel))
      for (const entry of entries) {
        const abs = this.fs.processPath?.(entry.target) ?? entry.target.displayPath ?? ''
        const childRel = this.policy.relative(abs)
        if (!childRel) continue
        if (this.policy.isIgnored(childRel)) continue
        if (entry.type === 'directory' || entry.type === 'dir') await walk(childRel, depth + 1)
        else if (entry.type === 'file') out.push(childRel)
      }
    }

    await walk(relDir, 0)
    return out.sort()
  }

  async watch(relPath        , onChange            )                                        {
    if (!this.fs.watch) return null
    const closed = await this.fs.watch(await this.target(relPath), onChange)
    return closed ?? (async () => undefined)
  }

  /** 工作区相对路径 → 宿主 target；路径围栏仍由 PathPolicy 兜底。 */
          async target(rel        )                        {
    const abs = rel === '.' || rel === '' ? this.policy.root : this.policy.resolve(rel)
    return this.fs.resolve(abs, { cwd: this.policy.root })
  }
}

function isCode(error         , code        )          {
  return (error                     )?.code === code
}


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/adapters/ctx-fs-io.ts