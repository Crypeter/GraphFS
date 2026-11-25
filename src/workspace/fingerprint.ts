import { digest16 } from '../core/hash.ts'
import { normalize } from '../core/normalize.ts'
import type { NormalizerId } from '../core/normalize.ts'
import { GraphFSError } from '../types.ts'
import type { Node, Unit } from '../types.ts'
import type { Fingerprint, FingerprintSource } from '../ports/fingerprint.ts'
import type { FileIo } from '../ports/io.ts'

/** 二进制探测：前 8 KB 出现 NUL 就当二进制，不参与一致性判定。 */
const BINARY_PROBE = 8192

/**
 * 按 unit 切出参与哈希的那段文本。
 * - whole-file：整篇
 * - heading：第 n 个标题（1 起）到下一个标题之前；代码块里的 `#` 不算标题
 * - lines：第 from..to 行（1 起，闭区间）
 * 切不出来返回 null（调用方按 dangling 处理，不抛错）。
 */
export function sliceUnit(text: string, unit: Unit): string | null {
  if (unit.kind === 'whole-file') return text

  const lines = text.split('\n')

  if (unit.kind === 'lines') {
    if (unit.from > lines.length) return null
    return lines.slice(unit.from - 1, unit.to).join('\n')
  }

  const starts: number[] = []
  let fence = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (/^\s*```/.test(line)) {
      fence = !fence
      continue
    }
    if (fence) continue
    if (/^#{1,6}\s+/.test(line)) starts.push(i)
  }

  const begin = starts[unit.index - 1]
  if (begin === undefined) return null
  const end = starts[unit.index] ?? lines.length
  return lines.slice(begin, end).join('\n')
}

export interface FingerprintOptions {
  normalize: NormalizerId
  maxFileBytes: number
}

/** 从 FileIo 读文本并产出指纹；FileIo 由宿主决定（ctx.fs 或 node:fs）。 */
export class FsFingerprint implements FingerprintSource {
  private readonly io: FileIo
  private readonly opts: FingerprintOptions

  constructor(io: FileIo, opts: FingerprintOptions) {
    this.io = io
    this.opts = opts
  }

  async read(node: Node, signal?: AbortSignal): Promise<Fingerprint | null> {
    const text = await this.io.readText(node.path, signal)
    if (text === null) return null

    const size = Buffer.byteLength(text, 'utf8')
    if (size > this.opts.maxFileBytes) {
      throw new GraphFSError(`file too large to hash: ${node.path} (${size} B)`, 'GF_UNHASHABLE')
    }
    if (text.slice(0, BINARY_PROBE).includes('\u0000')) {
      throw new GraphFSError(`binary file is not comparable: ${node.path}`, 'GF_UNHASHABLE')
    }

    const sliced = sliceUnit(text, node.unit)
    if (sliced === null) return null

    const normalized = normalize(sliced, this.opts.normalize)
    return { hash: digest16(normalized), size, unit: node.unit }
  }
}
