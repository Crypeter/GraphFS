import type { Arc, GraphSnapshot } from '../types.ts'

/**
 * 进度度量（Intent §4.4 G3）：只统计 required 边。
 *
 * 把 advisory 混进来，staleness 永远降不到 0，进度判据直接失效——
 * 这是实现阶段最容易写错、也最难在测试里被发现的一句。
 */
export interface StalenessReport {
  total: number
  byEdge: Map<string, number>
}

export function measure(
  graph: GraphSnapshot,
  hashes: Map<string, string | null | undefined>,
): StalenessReport {
  const byEdge = new Map<string, number>()
  let total = 0

  for (const edge of graph.edges.values()) {
    if (edge.obligation !== 'required') continue

    const fromHash = hashes.get(edge.from)
    const toHash = hashes.get(edge.to)

    // 未知（还没算）不计入：0 是「一致」，未知不该冒充一致，也不该冒充失配。
    if (fromHash === undefined || toHash === undefined) continue

    // 缺一端：整体记 1，不重复计（Intent §3.3 dangling 行）。
    if (fromHash === null || toHash === null) {
      byEdge.set(edge.id, 1)
      total += 1
      continue
    }

    const n = (fromHash !== edge.fromHash ? 1 : 0) + (toHash !== edge.toHash ? 1 : 0)
    if (n > 0) {
      byEdge.set(edge.id, n)
      total += n
    }
  }

  return { total, byEdge }
}

/** 供测试与调试：哪些边在贡献失配。 */
export function staleEdges(report: StalenessReport): string[] {
  return [...report.byEdge.keys()].sort()
}

/** 只保留 required 边构成的弧表，供环检测使用。 */
export function requiredArcs(graph: GraphSnapshot): Map<string, Arc[]> {
  const out = new Map<string, Arc[]>()
  for (const [node, arcs] of graph.outArcs) {
    const kept = arcs.filter((a) => a.edge.obligation === 'required')
    if (kept.length > 0) out.set(node, kept)
  }
  return out
}
