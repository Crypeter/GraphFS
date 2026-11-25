import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
                                            
                                                             

/** CLI / 测试用的 FileIo：直接落到 node:fs，路径先过 PathPolicy。 */
export class NodeFsIo                   {
                   policy            

  constructor(policy            ) {
    this.policy = policy
  }

  async readText(rel        )                         {
    const abs = this.policy.resolve(rel)
    try {
      const info = await stat(abs)
      if (info.isDirectory()) return null
      return await readFile(abs, 'utf8')
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async writeText(rel        , text        )                  {
    const abs = this.policy.resolve(rel)
    await mkdir(dirname(abs), { recursive: true })
    const tmp = `${abs}.graphfs-tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, abs)
    return ''
  }

  async remove(rel        )                   {
    const abs = this.policy.resolve(rel)
    try {
      await rm(abs)
      return true
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
  }

  async move(from        , to        )                {
    const src = this.policy.resolve(from)
    const dst = this.policy.resolve(to)
    await mkdir(dirname(dst), { recursive: true })
    await rename(src, dst)
  }

  async list(relDir = '.', opts                     = {})                    {
    const depth = opts.depth ?? 12
    const out           = []
    const walk = async (rel        , level        )                => {
      if (level > depth) return
      const abs = rel === '.' ? this.policy.root : this.policy.resolve(rel)
      let entries
      try {
        entries = await readdir(abs, { withFileTypes: true })
      } catch (error) {
        if (isMissing(error)) return
        throw error
      }
      for (const entry of entries) {
        const childRel = rel === '.' ? entry.name : `${rel}/${entry.name}`
        if (this.policy.isIgnored(childRel)) continue
        if (entry.isDirectory()) await walk(childRel, level + 1)
        else if (entry.isFile()) out.push(childRel)
      }
    }
    await walk(relDir, 0)
    return out.sort()
  }

  async watch()                {
    // M1 不实现监听：check 由调用方触发。
    return null
  }

  /** 供 init/诊断使用：绝对路径是否存在且是文件。 */
  async exists(rel        )                   {
    try {
      return (await stat(this.policy.resolve(rel))).isFile()
    } catch {
      return false
    }
  }
}

function isMissing(error         )          {
  const code = (error                     ).code
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR'
}


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/adapters/node-fs-io.ts