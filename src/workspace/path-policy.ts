import { resolve as resolvePath, relative as relativePath, isAbsolute, normalize } from 'node:path'
import { GraphFSError } from '../types.ts'

/**
 * 路径围栏：把用户/模型给的相对路径钉在 root 内。
 * 只做词法判断（不解析符号链接）——符号链接逃逸由 IO 适配器的 realpath 检查兜底。
 */
export class PathPolicy {
  readonly root: string
  private readonly ignores: Set<string>

  constructor(root: string, ignore: string[]) {
    this.root = normalize(root).replace(/\/+$/, '')
    this.ignores = new Set(ignore)
  }

  /** 相对路径 → 绝对路径；越界或非法输入抛 GF_WORKSPACE_MISMATCH。 */
  resolve(rel: string): string {
    if (rel.includes('\0')) throw new GraphFSError('path contains NUL', 'GF_WORKSPACE_MISMATCH')
    if (isAbsolute(rel)) throw new GraphFSError(`absolute paths are not allowed: ${rel}`, 'GF_WORKSPACE_MISMATCH')

    const abs = resolvePath(this.root, rel)
    if (abs !== this.root && !abs.startsWith(`${this.root}/`)) {
      throw new GraphFSError(`path escapes workspace: ${rel}`, 'GF_WORKSPACE_MISMATCH', 'use a path inside the root')
    }
    return abs
  }

  /** 绝对路径 → 相对路径；不在 root 内返回 null。 */
  relative(abs: string): string | null {
    const rel = relativePath(this.root, abs)
    if (rel === '') return '.'
    if (rel.startsWith('..')) return null
    return rel
  }

  /** 忽略规则：任一路径段命中即忽略（如 node_modules），也支持带斜杠的前缀规则。 */
  isIgnored(rel: string): boolean {
    if (rel === '.' || rel === '') return false
    const parts = rel.split('/')
    for (const part of parts) {
      if (this.ignores.has(part)) return true
    }
    for (const rule of this.ignores) {
      if (rule.includes('/') && rel.startsWith(`${rule}/`)) return true
    }
    return false
  }
}
