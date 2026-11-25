import type { FileIo } from '../ports/io.ts'
import type { PathPolicy } from '../workspace/path-policy.ts'

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

export interface FsTargetLike {
  targetKey?: unknown
  displayPath?: string
}

interface DirEntry {
  name: string
  type: string
  target: FsTargetLike
}

export interface DshFs {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTargetLike>
  stat(target: FsTargetLike, signal?: AbortSignal): Promise<{ version?: unknown; type?: string; size?: number } | undefined>
  readText(target: FsTargetLike, signal?: AbortSignal): Promise<string>
  writeText(target: FsTargetLike, content: string, expected?: unknown, signal?: AbortSignal): Promise<unknown>
  deleteFile(target: FsTargetLike, expected?: unknown, signal?: AbortSignal): Promise<unknown>
  moveFile(source: FsTargetLike, destination: FsTargetLike, options?: unknown, signal?: AbortSignal): Promise<unknown>
  listDir?(target: FsTargetLike, signal?: AbortSignal): Promise<DirEntry[]>
  watch?(target: FsTargetLike, changed: () => void, signal?: AbortSignal): Promise<(() => Promise<void>) | void>
  processPath?(target: FsTargetLike): string
}

export class CtxFsIo implements FileIo {
  private readonly fs: DshFs
  private readonly policy: PathPolicy

  constructor(fs: DshFs, policy: PathPolicy) {
    this.fs = fs
    this.policy = policy
  }

  async readText(rel: string): Promise<string | null> {
    const target = await this.target(rel)
    try {
      return await this.fs.readText(target)
    } catch (error) {
      if (isCode(error, 'FS_NOT_FOUND')) return null
      throw error
    }
  }

  async writeText(rel: string, text: string): Promise<string> {
    const target = await this.target(rel)
    const info = await this.fs.stat(target)
    // 有版本就带上 CAS，没有就要求「不存在才建」——两种情况都不会静默覆盖并发写入。
    const expected = info?.version !== undefined ? { version: info.version } : { kind: 'createIfAbsent' }
    await this.fs.writeText(target, text, expected)
    return typeof info?.version === 'string' ? info.version : ''
  }

  async remove(rel: string): Promise<boolean> {
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

  async move(from: string, to: string): Promise<void> {
    await this.fs.moveFile(await this.target(from), await this.target(to), {})
  }

  async list(relDir = '.', opts: { depth?: number } = {}): Promise<string[]> {
    if (!this.fs.listDir) return []
    const maxDepth = opts.depth ?? 12
    const out: string[] = []

    const walk = async (rel: string, depth: number): Promise<void> => {
      if (depth > maxDepth) return
      const entries = await this.fs.listDir!(await this.target(rel))
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

  async watch(relPath: string, onChange: () => void): Promise<(() => Promise<void>) | null> {
    if (!this.fs.watch) return null
    const closed = await this.fs.watch(await this.target(relPath), onChange)
    return closed ?? (async () => undefined)
  }

  /** 工作区相对路径 → 宿主 target；路径围栏仍由 PathPolicy 兜底。 */
  private async target(rel: string): Promise<FsTargetLike> {
    const abs = rel === '.' || rel === '' ? this.policy.root : this.policy.resolve(rel)
    return this.fs.resolve(abs, { cwd: this.policy.root })
  }
}

function isCode(error: unknown, code: string): boolean {
  return (error as { code?: string })?.code === code
}
