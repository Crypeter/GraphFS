import { parseGraph } from '../../src/core/graph.ts'
import type { Edge, GraphSnapshot, Node, Relation, Unit } from '../../src/types.ts'

/** 构造一个节点；unit 默认整文件。 */
export function node(id: string, path = `${id}.md`, unit: Unit = { kind: 'whole-file' }): Node {
  return { id, path, unit }
}

export interface EdgeSeed {
  id?: string
  from: string
  to: string
  relation: Relation
  authority?: Edge['authority']
  trigger?: Edge['trigger']
  counterpart?: Edge['counterpart']
  obligation?: Edge['obligation']
  verdict?: Edge['verdict']
  policy?: Edge['policy']
  fromHash?: string
  toHash?: string
  producer?: Edge['producer']
}

/** 把种子转成 parseGraph 吃的普通对象（缺省项交给 defaultsFor 补）。 */
export function edgeSeed(seed: EdgeSeed): Record<string, unknown> {
  return {
    id: seed.id,
    from: seed.from,
    to: seed.to,
    relation: seed.relation,
    authority: seed.authority,
    trigger: seed.trigger,
    counterpart: seed.counterpart,
    obligation: seed.obligation,
    verdict: seed.verdict,
    policy: seed.policy,
    fromHash: seed.fromHash ?? 'h-from',
    toHash: seed.toHash ?? 'h-to',
    producer: seed.producer,
  }
}

/** 解析并断言没有 issue（需要故意构造非法图时直接用 parseGraph）。 */
export function buildGraph(nodes: Node[], edges: EdgeSeed[]): GraphSnapshot {
  const { graph, issues } = parseGraph({
    version: 1,
    nodes: nodes.map((n) => ({ id: n.id, path: n.path, unit: n.unit })),
    edges: edges.map(edgeSeed),
  })
  if (!graph) throw new Error(`graph is null: ${JSON.stringify(issues)}`)
  if (issues.length > 0) throw new Error(`unexpected issues: ${JSON.stringify(issues, null, 2)}`)
  return graph
}

/** 便捷：给一组节点配一份「全部未变」的指纹表。 */
export function hashesOf(graph: GraphSnapshot): Map<string, string | null> {
  const out = new Map<string, string | null>()
  for (const nodeId of graph.nodes.keys()) out.set(nodeId, null)
  for (const edge of graph.edges.values()) {
    out.set(edge.from, edge.fromHash)
    out.set(edge.to, edge.toHash)
  }
  return out
}

/** 改一个节点的指纹，模拟它被编辑。 */
export function touched(hashes: Map<string, string | null>, nodeId: string, hash = `h-${nodeId}-new`): void {
  hashes.set(nodeId, hash)
}
