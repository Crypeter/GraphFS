import { incident } from './graph.ts'
import { createObligation } from './obligation.ts'
import { measure } from './staleness.ts'
import { judge } from './verdict.ts'
import type { DigestedChange, GraphSnapshot, Obligation, Plan } from '../types.ts'

export interface PlanInput {
  changed: string[]
  graph: GraphSnapshot
  /** undefined = 未知（还没算）；null = 明确不存在。两者语义不同，不能混。 */
  hashes: Map<string, string | null | undefined>
  limits: { maxDepth: number; maxObligations: number }
  /** ISO 时间，由 clock 注入。 */
  now: string
}

const SEVERITY_RANK: Record<Obligation['severity'], number> = { block: 0, warn: 1, info: 2 }

/**
 * 两阶段规划（Intent §4.1）：
 *
 *   阶段 1｜本地评估：用存储图的双向索引把「有端点变脏」的边都看一遍，
 *            但只有 conflict / dangling 直接进队列；drift 先记下来；counterpart 只消化不派发。
 *   阶段 2｜闭包：只沿有效弧（outArcs）展开，且只从「真正变化的那一端」出发。
 *
 * 把这两个阶段合成一个循环，就会得到那个经典 bug：`trigger: from` 的边在 to 侧变更时反向派发，
 * 并把 from 拉进 frontier 继续扩散（L4 的「改代码零打扰」当场失效）。
 */
export function plan(input: PlanInput): Plan {
  const { changed, graph, hashes, limits, now } = input
  const maxDepth = Math.max(1, limits.maxDepth)
  const maxObligations = Math.max(1, limits.maxObligations)

  const roots = [...new Set(changed)].filter((id) => graph.nodes.has(id))
  const obligations = new Map<string, Obligation>()
  const digested = new Map<string, DigestedChange>()

  /* ---------------- 阶段 1：本地评估（不派发，除了 conflict/dangling） ---------------- */

  for (const nodeId of roots) {
    for (const edge of incident(graph, nodeId)) {
      const fromHash = hashes.get(edge.from)
      const toHash = hashes.get(edge.to)
      if (fromHash === undefined || toHash === undefined) continue // 未知不清算

      const verdict = judge({ edge, fromHash, toHash })

      switch (verdict.kind) {
        case 'clean':
          break

        case 'drift':
          // 不在这里派发：drift 只在「有效弧」上兑现（阶段 2 会重新判定）。
          break

        case 'counterpart': {
          if (edge.counterpart === 'ignore') break
          const changedNode = verdict.side === 'to' ? edge.to : edge.from
          digested.set(edge.id, {
            edgeId: edge.id,
            node: changedNode,
            action: edge.counterpart === 'absorb' ? 'absorb' : 'confirm',
          })

          // 场景 3：派生物被直接修改。非触发侧的变更通常"消化"即可（L1 改译文、L4 改代码），
          // 但 generates 的产物被直接改，恰恰是要拦下来提示"改源文件"的那种变更。
          if (edge.relation === 'generates' && edge.counterpart === 'confirm') {
            const derived = changedNode
            const source = derived === edge.to ? edge.from : edge.to
            const obligation = createObligation({
              edge,
              target: derived,
              cause: source,
              causeHash: String(hashes.get(derived) ?? ''),
              verdict,
              baseline: derived === edge.to ? edge.toHash : edge.fromHash,
              now,
              detail: `${derived} 是派生物，被直接修改了：应改 ${source} 后重新生成${edge.policy === 'auto' ? '' : '（或撤销这次改动）'}`,
            })
            obligations.set(obligation.id, obligation)
          }
          break
        }

        case 'conflict': {
          const target = edge.to
          const cause = edge.from
          const obligation = createObligation({
            edge,
            target,
            cause,
            causeHash: String(hashes.get(cause) ?? ''),
            verdict,
            baseline: target === edge.to ? edge.toHash : edge.fromHash,
            now,
          })
          obligations.set(obligation.id, obligation)
          break
        }

        case 'dangling': {
          const missing = verdict.missing
          const target = missing === 'from' ? edge.from : edge.to
          const cause = missing === 'from' ? edge.to : edge.from
          const obligation = createObligation({
            edge,
            target,
            cause,
            causeHash: String(hashes.get(cause) ?? ''),
            verdict,
            baseline: '',
            now,
          })
          obligations.set(obligation.id, obligation)
          break
        }
      }
    }
  }

  /* ---------------- 阶段 2：沿有效弧闭包（唯一的派发入口） ---------------- */

  const visited = new Set(roots)
  let frontier = roots

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = []

    for (const nodeId of frontier) {
      for (const arc of graph.outArcs.get(nodeId) ?? []) {
        const { edge } = arc
        const fromHash = hashes.get(edge.from)
        const toHash = hashes.get(edge.to)
        if (fromHash === undefined || toHash === undefined) continue

        const verdict = judge({ edge, fromHash, toHash })
        if (verdict.kind !== 'drift') continue // conflict/counterpart 由阶段 1 处理

        // verdict.side 是 'from'|'to' 的侧别标签，必须换算成节点 id 再比较。
        const causeNode = verdict.side === 'from' ? edge.from : edge.to
        if (causeNode !== nodeId) continue // 只从真正变化的那一端出发

        const causeHash = String(hashes.get(nodeId) ?? '')
        const obligation = createObligation({
          edge: arc.edge,
          target: arc.target,
          cause: nodeId,
          causeHash,
          verdict,
          baseline: arc.target === arc.edge.to ? arc.edge.toHash : arc.edge.fromHash,
          now,
        })
        if (!obligations.has(obligation.id)) obligations.set(obligation.id, obligation)

        if (!visited.has(arc.target)) {
          visited.add(arc.target)
          next.push(arc.target)
        }
      }
    }

    frontier = next
  }

  /* ---------------- 排序与截断 ---------------- */

  const ordered = [...obligations.values()].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    return bySeverity !== 0 ? bySeverity : a.edgeId.localeCompare(b.edgeId)
  })

  return {
    obligations: ordered.slice(0, maxObligations),
    digested: [...digested.values()],
    changed: roots,
    changedHashes: Object.fromEntries(roots.map((id) => [id, String(hashes.get(id) ?? '')])),
    stalenessBefore: measure(graph, hashes).total,
    truncated: ordered.length > maxObligations,
  }
}
