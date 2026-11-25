import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DshFs } from '../../src/adapters/ctx-fs-io.ts'

/**
 * 按 `dsh-fs-local` 的契约实现的假后端：用来验证 CtxFsIo，而不需要真的 DSH。
 * 语义上刻意贴近真实实现（FS_NOT_FOUND / 版本 CAS / createIfAbsent）。
 */
export class FakeFs implements DshFs {
  async resolve(path: string) {
    return { targetKey: path, displayPath: path }
  }

  async stat(target: { targetKey?: unknown }) {
    try {
      const info = await stat(String(target.targetKey))
      if (info.isDirectory()) return { type: 'directory', size: 0 }
      return { type: 'file', size: info.size, version: `${info.mtimeMs}:${info.size}` }
    } catch {
      return undefined
    }
  }

  async readText(target: { targetKey?: unknown }) {
    try {
      return await readFile(String(target.targetKey), 'utf8')
    } catch {
      throw Object.assign(new Error('not found'), { code: 'FS_NOT_FOUND' })
    }
  }

  async writeText(target: { targetKey?: unknown }, content: string, expected?: any) {
    const path = String(target.targetKey)
    const info = await this.stat(target)
    if (expected?.kind === 'createIfAbsent' && info) {
      throw Object.assign(new Error('already exists'), { code: 'FS_STALE_VERSION' })
    }
    if (expected?.version !== undefined && info?.version !== expected.version) {
      throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' })
    }
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-fake`
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, path)
    return { version: (await this.stat(target))?.version }
  }

  async deleteFile(target: { targetKey?: unknown }, expected?: any) {
    const info = await this.stat(target)
    if (!info) throw Object.assign(new Error('not found'), { code: 'FS_NOT_FOUND' })
    if (expected?.version !== undefined && info.version !== expected.version) {
      throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' })
    }
    await rm(String(target.targetKey))
    return {}
  }

  async moveFile(source: { targetKey?: unknown }, destination: { targetKey?: unknown }) {
    await mkdir(dirname(String(destination.targetKey)), { recursive: true })
    await rename(String(source.targetKey), String(destination.targetKey))
    return {}
  }

  async listDir(target: { targetKey?: unknown }) {
    const dir = String(target.targetKey)
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file',
      target: { targetKey: `${dir}/${e.name}`, displayPath: `${dir}/${e.name}` },
    }))
  }

  processPath(target: { targetKey?: unknown }) {
    return String(target.targetKey)
  }

  async watch() {
    return async () => undefined
  }
}
