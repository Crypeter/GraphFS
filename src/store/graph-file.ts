import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseGraph } from '../core/graph.ts'
import { parseYaml, stringifyYaml } from './yaml.ts'
import { GraphFSError } from '../types.ts'
import type { Edge, GraphSnapshot, Node } from '../types.ts'

/**
 * graph.yaml 的读写。
 *
 * 注意：图文件**不走 FileIo**——它可能在 root 之外（只读挂载、CI 模板），
 * 也可能由宿主用自己的存储层管理。这里用 node:fs，路径由调用方给绝对路径。
 */

const HEADER = `# GraphFS graph —— 一致性账本（入库、可 review）
# 节点 = 一致性单元；边 = 关系 + 两端指纹。
# 修改后用 \`graphfs check\` 校验，\`graphfs ack <edge>\` 重录漂移。
`

export interface LoadedGraph {
  graph: GraphSnapshot
  source: string
}

export async function readGraphFile(path: string): Promise<LoadedGraph | null> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null
    throw error
  }

  const data = parseYaml(source)
  const { graph, issues } = parseGraph(data)
  if (!graph) {
    const detail = issues.map((i) => `${i.code}: ${i.message}`).join('; ')
    throw new GraphFSError(`invalid graph file: ${detail}`, 'GF_GRAPH_INVALID', path)
  }
  return { graph, source }
}

export async function writeGraphFile(path: string, graph: GraphSnapshot): Promise<void> {
  const text = `${HEADER}\n${renderGraph(graph)}\n`
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/** 序列化：键序固定，便于 review 与 diff。 */
export function renderGraph(graph: GraphSnapshot): string {
  const nodes = [...graph.nodes.values()].map((node: Node) => ({
    id: node.id,
    path: node.path,
    unit: unitToObject(node),
  }))

  const edges = [...graph.edges.values()].map((edge: Edge) => {
    const out: Record<string, unknown> = {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      relation: edge.relation,
      authority: edge.authority,
      trigger: edge.trigger,
      counterpart: edge.counterpart,
      obligation: edge.obligation,
      verdict: edge.verdict,
      policy: edge.policy,
      fromHash: edge.fromHash,
      toHash: edge.toHash,
    }
    if (edge.producer) out.producer = edge.producer
    if (edge.verifiedAt) out.verifiedAt = edge.verifiedAt
    return out
  })

  // M4：有理由就写 `{path, reason}`；没有理由仍写纯字符串（旧图保持可读的最小 diff）。
  const unmanaged = [...graph.unmanaged]
    .sort()
    .map((path) => {
      const reason = graph.unmanagedReasons?.get(path)
      return reason ? { path, reason } : path
    })

  return stringifyYaml({
    version: 1,
    hash: { alg: graph.hashConfig.alg, truncate: graph.hashConfig.truncate, normalize: graph.hashConfig.normalize },
    nodes,
    edges,
    ...(unmanaged.length > 0 ? { unmanaged } : {}),
  })
}

function unitToObject(node: Node): Record<string, unknown> {
  if (node.unit.kind === 'whole-file') return { kind: 'whole-file' }
  if (node.unit.kind === 'heading') return { kind: 'heading', index: node.unit.index }
  return { kind: 'lines', from: node.unit.from, to: node.unit.to }
}
