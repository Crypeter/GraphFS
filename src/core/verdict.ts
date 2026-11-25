import type { Edge, Verdict } from '../types.ts'

export interface JudgeInput {
  edge: Edge
  /** 当前实际指纹；null 表示文件/区域不存在，undefined 由调用方过滤（未知不清算）。 */
  fromHash: string | null
  toHash: string | null
}

/**
 * 三态判定（GraphFS_Intent.md §3.3 的表，逐行对应）。
 *
 * 三条硬规则：
 *  1. 缺失即 dangling，不能当作空串；
 *  2. authority 是唯一裁决者——权威端不许被覆盖，所以「非权威侧单方面变更」是 counterpart 而不是 drift；
 *  3. 只有 authority = none 时，「两端都变」才是 conflict。
 */
export function judge({ edge, fromHash, toHash }: JudgeInput): Verdict {
  if (fromHash === null) return { kind: 'dangling', missing: 'from' }
  if (toHash === null) return { kind: 'dangling', missing: 'to' }

  const fromMoved = fromHash !== edge.fromHash
  const toMoved = toHash !== edge.toHash

  if (!fromMoved && !toMoved) return { kind: 'clean' }

  if (fromMoved && !toMoved) {
    return { kind: 'drift', side: 'from', cause: edge.from }
  }

  if (!fromMoved && toMoved) {
    // 写 from 等于覆盖权威端：不派发，交给 counterpart 消化。
    if (edge.authority === 'from') return { kind: 'counterpart', side: 'to' }
    return { kind: 'drift', side: 'to', cause: edge.to }
  }

  // 两端都变了
  if (edge.authority === 'none') return { kind: 'conflict', fromMoved, toMoved }

  return edge.authority === 'from'
    ? { kind: 'drift', side: 'from', cause: edge.from, bothMoved: true }
    : { kind: 'drift', side: 'to', cause: edge.to, bothMoved: true }
}
