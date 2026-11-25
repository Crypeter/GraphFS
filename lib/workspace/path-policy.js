import { resolve as resolvePath, relative as relativePath, isAbsolute, normalize } from 'node:path'
import { GraphFSError } from '../types.js'

/**
 * 路径围栏：把用户/模型给的相对路径钉在 root 内。
 * 只做词法判断（不解析符号链接）——符号链接逃逸由 IO 适配器的 realpath 检查兜底。
 */
export class PathPolicy {
           root        
                   ignores             

  constructor(root        , ignore          ) {
    this.root = normalize(root).replace(/\/+$/, '')
    this.ignores = new Set(ignore)
  }

  /** 相对路径 → 绝对路径；越界或非法输入抛 GF_WORKSPACE_MISMATCH。 */
  resolve(rel        )         {
    if (rel.includes('\0')) throw new GraphFSError('path contains NUL', 'GF_WORKSPACE_MISMATCH')
    if (isAbsolute(rel)) throw new GraphFSError(`absolute paths are not allowed: ${rel}`, 'GF_WORKSPACE_MISMATCH')

    const abs = resolvePath(this.root, rel)
    if (abs !== this.root && !abs.startsWith(`${this.root}/`)) {
      throw new GraphFSError(`path escapes workspace: ${rel}`, 'GF_WORKSPACE_MISMATCH', 'use a path inside the root')
    }
    return abs
  }

  /** 绝对路径 → 相对路径；不在 root 内返回 null。 */
  relative(abs        )                {
    const rel = relativePath(this.root, abs)
    if (rel === '') return '.'
    if (rel.startsWith('..')) return null
    return rel
  }

  /** 忽略规则：任一路径段命中即忽略（如 node_modules），也支持带斜杠的前缀规则。 */
  isIgnored(rel        )          {
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


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/workspace/path-policy.ts