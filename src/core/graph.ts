import { digest16 } from './hash.ts'
import { findCycle, stronglyConnected } from './scc.ts'
import type {
  Arc,
  Authority,
  Counterpart,
  Edge,
  EdgePolicy,
  GraphIssue,
  GraphSnapshot,
  HashConfig,
  Node,
  ObligationLevel,
  Relation,
  Trigger,
  Unit,
  VerdictLevel,
} from '../types.ts'

/**
 * 图的解析、校验与「有效弧」派生。
 *
 * 本文件不碰 YAML：入参是**已解析好的对象**（YAML 解析属于 adapters，见 Spec §4.3）。
 * 这样 core 保持零依赖，测试也能直接构造图。
 */

const RELATIONS: readonly Relation[] = ['mirror', 'translates', 'generates', 'documents', 'constrains', 'related']
const AUTHORITIES: readonly Authority[] = ['from', 'to', 'none']
const TRIGGERS: readonly Trigger[] = ['from', 'to', 'both', 'none']
const COUNTERPARTS: readonly Counterpart[] = ['absorb', 'confirm', 'ignore']
const LEVELS: readonly ObligationLevel[] = ['required', 'advisory', 'silent']
const VERDICTS: readonly VerdictLevel[] = ['mechanical', 'structural', 'human']
const POLICIES: readonly EdgePolicy[] = ['auto', 'advise', 'enforce']

/** 强度阶梯的默认值来源：让 graph.yaml 只写「与默认不同」的部分。 */
export function defaultsFor(relation: Relation): Pick<Edge, 'authority' | 'trigger' | 'counterpart' | 'obligation' | 'verdict' | 'policy'> {
  switch (relation) {
    case 'mirror':
      return { authority: 'none', trigger: 'both', counterpart: 'confirm', obligation: 'required', verdict: 'mechanical', policy: 'advise' }
    case 'translates':
      return { authority: 'from', trigger: 'from', counterpart: 'confirm', obligation: 'required', verdict: 'structural', policy: 'advise' }
    case 'generates':
      return { authority: 'from', trigger: 'from', counterpart: 'confirm', obligation: 'required', verdict: 'mechanical', policy: 'advise' }
    case 'documents':
      return { authority: 'from', trigger: 'from', counterpart: 'confirm', obligation: 'advisory', verdict: 'human', policy: 'advise' }
    case 'constrains':
      return { authority: 'from', trigger: 'from', counterpart: 'absorb', obligation: 'advisory', verdict: 'human', policy: 'advise' }
    case 'related':
      return { authority: 'none', trigger: 'none', counterpart: 'ignore', obligation: 'silent', verdict: 'human', policy: 'advise' }
    default: {
      const never: never = relation
      throw new Error(`unknown relation: ${String(never)}`)
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/**
 * 指纹字段只接受字符串；但历史文件里「全数字的 16 位哈希」会被 YAML 读成 number，
 * 所以这里把数字也认下来（前导零已丢失，但比整条边退化成"无基线"要好）。
 */
function hashString(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined
}

function parseUnit(raw: unknown): Unit | null {
  if (raw === undefined) return { kind: 'whole-file' }
  if (!isRecord(raw)) return null
  const kind = str(raw.kind)
  if (kind === 'whole-file') return { kind: 'whole-file' }
  if (kind === 'heading') {
    const index = raw.index
    return typeof index === 'number' && Number.isInteger(index) && index >= 1 ? { kind: 'heading', index } : null
  }
  if (kind === 'lines') {
    const from = raw.from
    const to = raw.to
    if (typeof from !== 'number' || typeof to !== 'number') return null
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) return null
    return { kind: 'lines', from, to }
  }
  return null
}

export interface ParseResult {
  graph: GraphSnapshot | null
  issues: GraphIssue[]
}

export function parseGraph(input: unknown): ParseResult {
  const issues: GraphIssue[] = []

  if (!isRecord(input)) {
    return { graph: null, issues: [{ code: 'GF_GRAPH_INVALID', message: 'graph must be an object' }] }
  }
  if (input.version !== undefined && input.version !== 1) {
    issues.push({ code: 'GF_GRAPH_INVALID', message: `unsupported graph version: ${String(input.version)}` })
  }

  const hashConfig = parseHashConfig(input.hash, issues)

  const rawNodes = input.nodes
  const rawEdges = input.edges
  if (!Array.isArray(rawNodes)) {
    return { graph: null, issues: [...issues, { code: 'GF_GRAPH_INVALID', message: 'nodes must be an array' }] }
  }
  if (!Array.isArray(rawEdges)) {
    return { graph: null, issues: [...issues, { code: 'GF_GRAPH_INVALID', message: 'edges must be an array' }] }
  }

  const nodes = new Map<string, Node>()
  const pathIndex = new Map<string, string[]>()

  for (const [i, raw] of rawNodes.entries()) {
    if (!isRecord(raw)) {
      issues.push({ code: 'GF_GRAPH_INVALID', nodeId: `#${i}`, message: 'node must be an object' })
      continue
    }
    const id = str(raw.id)
    const path = str(raw.path)
    if (!id || !path) {
      issues.push({ code: 'GF_GRAPH_INVALID', nodeId: id ?? `#${i}`, message: 'node requires id and path' })
      continue
    }
    if (nodes.has(id)) {
      issues.push({ code: 'GF_GRAPH_INVALID', nodeId: id, message: `duplicate node id ${id}` })
      continue
    }
    const unit = parseUnit(raw.unit)
    if (!unit) {
      issues.push({ code: 'GF_GRAPH_INVALID', nodeId: id, message: 'invalid unit selector' })
      continue
    }
    nodes.set(id, { id, path, unit })
    const list = pathIndex.get(path)
    if (list) list.push(id)
    else pathIndex.set(path, [id])
  }

  const edges = new Map<string, Edge>()

  for (const [i, raw] of rawEdges.entries()) {
    if (!isRecord(raw)) {
      issues.push({ code: 'GF_GRAPH_INVALID', edgeId: `#${i}`, message: 'edge must be an object' })
      continue
    }
    const relation = oneOf(raw.relation, RELATIONS)
    const from = str(raw.from)
    const to = str(raw.to)
    if (!relation || !from || !to) {
      issues.push({ code: 'GF_GRAPH_INVALID', edgeId: str(raw.id) ?? `#${i}`, message: 'edge requires relation, from, to' })
      continue
    }

    const d = defaultsFor(relation)
    const id = str(raw.id) ?? `gf-${digest16(`${from}|${to}|${relation}`).slice(0, 8)}`
    if (edges.has(id)) {
      issues.push({ code: 'GF_GRAPH_INVALID', edgeId: id, message: `duplicate edge id ${id}` })
      continue
    }

    const edge: Edge = {
      id,
      from,
      to,
      relation,
      authority: oneOf(raw.authority, AUTHORITIES) ?? d.authority,
      trigger: oneOf(raw.trigger, TRIGGERS) ?? d.trigger,
      counterpart: oneOf(raw.counterpart, COUNTERPARTS) ?? d.counterpart,
      obligation: oneOf(raw.obligation, LEVELS) ?? d.obligation,
      verdict: oneOf(raw.verdict, VERDICTS) ?? d.verdict,
      policy: oneOf(raw.policy, POLICIES) ?? d.policy,
      fromHash: hashString(raw.fromHash) ?? '',
      toHash: hashString(raw.toHash) ?? '',
    }

    const producer = raw.producer
    if (isRecord(producer)) {
      const kind = oneOf(producer.kind, ['shell', 'npm', 'node'] as const)
      const command = str(producer.command)
      const outputs = Array.isArray(producer.outputs) ? producer.outputs.filter((x): x is string => typeof x === 'string') : []
      if (kind && command) edge.producer = { kind, command, outputs }
      else issues.push({ code: 'GF_GRAPH_INVALID', edgeId: id, message: 'producer requires kind and command' })
    }
    const verifiedAt = str(raw.verifiedAt)
    if (verifiedAt) edge.verifiedAt = verifiedAt

    edges.set(id, edge)
  }

  const unmanaged = new Set<string>()
  const unmanagedReasons = new Map<string, string>()
  const rawUnmanaged = input.unmanaged
  if (Array.isArray(rawUnmanaged)) {
    for (const item of rawUnmanaged) {
      // M4 起允许 `{ path, reason }`，同时兼容旧图里的纯字符串。
      if (isRecord(item)) {
        const path = str(item.path)
        if (!path) {
          issues.push({ code: 'GF_GRAPH_INVALID', message: 'unmanaged entries require a path' })
          continue
        }
        unmanaged.add(path)
        const reason = str(item.reason)
        if (reason) unmanagedReasons.set(path, reason)
        continue
      }
      const path = str(item)
      if (!path) {
        issues.push({ code: 'GF_GRAPH_INVALID', message: 'unmanaged entries must be a path or {path, reason}' })
        continue
      }
      unmanaged.add(path)
    }
  } else if (rawUnmanaged !== undefined) {
    issues.push({ code: 'GF_GRAPH_INVALID', message: 'unmanaged must be an array of paths or {path, reason}' })
  }

  const graph: GraphSnapshot = {
    nodes,
    edges,
    outArcs: new Map(),
    pathIndex,
    issues: [],
    hashConfig,
    unmanaged,
    unmanagedReasons,
  }

  issues.push(...validateGraph(graph))
  graph.outArcs = buildArcs(graph)
  issues.push(...cycleIssues(graph))

  // 去重：同一 (code, edgeId, message) 只留一条
  const seen = new Set<string>()
  graph.issues = issues.filter((issue) => {
    const key = `${issue.code}|${issue.edgeId ?? ''}|${issue.nodeId ?? ''}|${issue.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return { graph, issues: graph.issues }
}

function parseHashConfig(raw: unknown, issues: GraphIssue[]): HashConfig {
  const fallback: HashConfig = { alg: 'sha256', truncate: 16, normalize: 'text' }
  if (raw === undefined) return fallback
  if (!isRecord(raw)) {
    issues.push({ code: 'GF_GRAPH_INVALID', message: 'hash must be an object' })
    return fallback
  }
  const alg = raw.alg === undefined ? 'sha256' : str(raw.alg)
  const truncate = raw.truncate === undefined ? 16 : raw.truncate
  const normalize = raw.normalize === undefined ? 'text' : str(raw.normalize)
  if (alg !== 'sha256' || truncate !== 16 || !['text', 'bytes', 'dsh-i18n-v1'].includes(String(normalize))) {
    issues.push({
      code: 'GF_GRAPH_INVALID',
      message: 'unsupported hash config (expect sha256 / 16 / text|bytes|dsh-i18n-v1)',
    })
    return fallback
  }
  return { alg: 'sha256', truncate: 16, normalize: normalize as HashConfig['normalize'] }
}

/** 结构合法性与建模合法性检查（不含环；环需要先有弧）。 */
export function validateGraph(graph: GraphSnapshot): GraphIssue[] {
  const issues: GraphIssue[] = []

  for (const edge of graph.edges.values()) {
    const from = graph.nodes.get(edge.from)
    const to = graph.nodes.get(edge.to)

    if (!from || !to) {
      issues.push({ code: 'GF_DANGLING_EDGE', edgeId: edge.id, message: `edge ${edge.id} references a missing node` })
      continue
    }
    if (edge.from === edge.to) {
      issues.push({ code: 'GF_GRAPH_INVALID', edgeId: edge.id, message: 'self-loop edges are not allowed' })
    }
    if (!compatibleUnits(from.unit, to.unit)) {
      issues.push({ code: 'GF_UNIT_MISMATCH', edgeId: edge.id, message: 'edge connects a whole-file node with a region node' })
    }
    if (edge.trigger === 'both' && edge.authority !== 'none') {
      issues.push({
        code: 'GF_GRAPH_INVALID',
        edgeId: edge.id,
        message: 'trigger: both requires authority: none (the authority lock would void half of it)',
      })
    }
    if ((edge.relation === 'translates' || edge.relation === 'generates') && edge.trigger === 'both') {
      issues.push({ code: 'GF_GRAPH_INVALID', edgeId: edge.id, message: `${edge.relation} must not be bidirectional` })
    }
    if (edge.relation === 'documents' || edge.relation === 'related') {
      if (edge.obligation === 'required') {
        issues.push({ code: 'GF_GRAPH_INVALID', edgeId: edge.id, message: `${edge.relation} must not be required` })
      }
    }
    if (edge.policy === 'auto') {
      if (!edge.producer || edge.producer.outputs.length === 0) {
        issues.push({ code: 'GF_GRAPH_INVALID', edgeId: edge.id, message: 'policy: auto requires producer.outputs' })
      }
    }
  }

  // 同一路径不能既建了节点又声明 unmanaged（否则「要不要关系」是自相矛盾的）。
  for (const node of graph.nodes.values()) {
    if (graph.unmanaged.has(node.path)) {
      issues.push({
        code: 'GF_GRAPH_INVALID',
        nodeId: node.id,
        message: `${node.path} is both a node and unmanaged`,
      })
    }
  }

  // 同一对节点之间不允许两条方向相反的 required 边（G_t 上的二元环）。
  for (const edge of graph.edges.values()) {
    if (edge.obligation !== 'required') continue
    for (const other of graph.edges.values()) {
      if (other.id === edge.id) continue
      if (other.obligation !== 'required') continue
      if (other.from === edge.to && other.to === edge.from) {
        const [first, second] = edge.id < other.id ? [edge, other] : [other, edge]
        if (first.id === edge.id) {
          issues.push({
            code: 'GF_EDGE_CYCLE',
            edgeId: second.id,
            message: `required edges ${first.id} and ${second.id} are reverse pairs`,
          })
        }
      }
    }
  }

  return issues
}

function compatibleUnits(a: Unit, b: Unit): boolean {
  if (a.kind === b.kind) return true
  const regionA = a.kind !== 'whole-file'
  const regionB = b.kind !== 'whole-file'
  return regionA && regionB
}

/**
 * 有效弧 = trigger 允许的方向 ∩ 终点不是权威端。
 * 这是唯一允许推导传播方向的地方（Intent §3.2）。
 */
export function buildArcs(graph: GraphSnapshot): Map<string, Arc[]> {
  const out = new Map<string, Arc[]>()

  for (const edge of graph.edges.values()) {
    const authorityNode =
      edge.authority === 'none' ? null : edge.authority === 'from' ? edge.from : edge.to

    const directions: Array<'from' | 'to'> =
      edge.trigger === 'both' ? ['from', 'to'] : edge.trigger === 'none' ? [] : [edge.trigger]

    for (const side of directions) {
      const source = side === 'from' ? edge.from : edge.to
      const target = side === 'from' ? edge.to : edge.from
      if (authorityNode !== null && target === authorityNode) continue
      const list = out.get(source)
      if (list) list.push({ edge, target })
      else out.set(source, [{ edge, target }])
    }
  }

  return out
}

/** 只保留 required 边的弧表，供环检测使用。 */
function requiredArcMap(graph: GraphSnapshot): Map<string, Arc[]> {
  const out = new Map<string, Arc[]>()
  for (const [node, arcs] of graph.outArcs) {
    const kept = arcs.filter((arc) => arc.edge.obligation === 'required')
    if (kept.length > 0) out.set(node, kept)
  }
  return out
}

/**
 * 环检查：只对 required 边，且**只认「多条边」构成的环**。
 *
 * 单条 mirror 边（both + authority: none）本身就会产生 a↔b 两条弧，这是合法的对称关系——
 * 修复是幂等复制，一次即成不动点。判成环会把它误杀，所以环必须由 ≥2 条不同边构成。
 */
function cycleIssues(graph: GraphSnapshot): GraphIssue[] {
  const arcs = requiredArcMap(graph)
  const nodes = [...graph.nodes.keys()]

  for (const comp of stronglyConnected(nodes, arcs)) {
    if (comp.length < 2) continue
    const members = new Set(comp)
    const edgeIds = new Set<string>()
    for (const nodeId of comp) {
      for (const arc of arcs.get(nodeId) ?? []) {
        if (members.has(arc.target)) edgeIds.add(arc.edge.id)
      }
    }
    if (edgeIds.size < 2) continue // 单条对称边的自环：合法

    const local = new Map<string, Arc[]>()
    for (const nodeId of comp) {
      const kept = (arcs.get(nodeId) ?? []).filter((arc) => members.has(arc.target))
      if (kept.length > 0) local.set(nodeId, kept)
    }
    const cycle = findCycle(comp, local) ?? [...comp, comp[0]!]
    return [
      {
        code: 'GF_EDGE_CYCLE',
        message: `required edges form a cycle: ${cycle.join(' → ')}`,
      },
    ]
  }

  return []
}

/** 存储图的双向邻接（阶段 1 用）。不要拿它做遍历——那是 outArcs 的职责。 */
export function incident(graph: GraphSnapshot, nodeId: string): Edge[] {
  const out: Edge[] = []
  for (const edge of graph.edges.values()) {
    if (edge.from === nodeId || edge.to === nodeId) out.push(edge)
  }
  return out
}
