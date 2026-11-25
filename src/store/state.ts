import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { emptyState } from '../ports/state.ts'
import type { StateStore } from '../ports/state.ts'
import type { RuntimeState } from '../types.ts'

/** 进程内状态：测试与无盘场景。 */
export class MemoryState implements StateStore {
  private readonly map = new Map<string, RuntimeState>()

  async load(key: string): Promise<RuntimeState> {
    return structuredClone(this.map.get(key) ?? emptyState())
  }

  async save(key: string, state: RuntimeState): Promise<void> {
    this.map.set(key, structuredClone(state))
  }
}

/** 工作区文件状态：`.graphfs/state.json`，原子写，损坏时按空状态恢复。 */
export class FileState implements StateStore {
  private readonly path: string

  constructor(path: string) {
    this.path = path
  }

  async load(_key: string): Promise<RuntimeState> {
    try {
      const text = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(text) as RuntimeState
      if (parsed?.version !== 1) return emptyState()
      return { ...emptyState(), ...parsed }
    } catch {
      return emptyState()
    }
  }

  async save(_key: string, state: RuntimeState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(tmp, this.path)
  }
}
