import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { emptyState } from '../ports/state.js'
                                                   
                                               

/** 进程内状态：测试与无盘场景。 */
export class MemoryState                       {
                   map = new Map                      ()

  async load(key        )                        {
    return structuredClone(this.map.get(key) ?? emptyState())
  }

  async save(key        , state              )                {
    this.map.set(key, structuredClone(state))
  }
}

/** 工作区文件状态：`.graphfs/state.json`，原子写，损坏时按空状态恢复。 */
export class FileState                       {
                   path        

  constructor(path        ) {
    this.path = path
  }

  async load(_key        )                        {
    try {
      const text = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(text)                
      if (parsed?.version !== 1) return emptyState()
      return { ...emptyState(), ...parsed }
    } catch {
      return emptyState()
    }
  }

  async save(_key        , state              )                {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(tmp, this.path)
  }
}


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/store/state.ts