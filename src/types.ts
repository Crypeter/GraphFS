/**
 * GraphFS 领域类型（唯一真相）。
 *
 * 约束：本文件不含 I/O、不 import 任何 DSH 包；除 GraphFSError 外没有运行时逻辑。
 * 说明见 GraphFS_Spec.md §2 与 GraphFS_Intent.md §3。
 */

/* ------------------------------------------------------------------ 枚举 */

export type Mode = 'off' | 'observe' | 'advise' | 'auto'

export type Relation = 'mirror' | 'translates' | 'generates' | 'documents' | 'constrains' | 'related'

/** 权威端内容永远不被对方覆盖；none 表示不设权威（仅对称关系）。 */
export type Authority = 'from' | 'to' | 'none'

/** 哪一侧变更会发起修复。 */
export type Trigger = 'from' | 'to' | 'both' | 'none'

/** 非触发侧自己变了怎么办。 */
export type Counterpart = 'absorb' | 'confirm' | 'ignore'

/** 义务强度：required 才允许钉住回合。 */
export type ObligationLevel = 'required' | 'advisory' | 'silent'

/** 满足判据：机器判 / 结构判 / 人判。 */
export type VerdictLevel = 'mechanical' | 'structural' | 'human'

/** 边级策略：auto 可跑 producer；enforce 是 v2 的拒写。 */
export type EdgePolicy = 'auto' | 'advise' | 'enforce'

/* ------------------------------------------------------------------ 节点 */

/** 一致性单元：默认整文件；heading 按文档中第 n 个标题定位（1 起），lines 备用。 */
export type Unit =
  | { kind: 'whole-file' }
  | { kind: 'heading'; index: number }
  | { kind: 'lines'; from: number; to: number }

export interface Node {
  id: string
  path: string
  unit: Unit
}

/* ------------------------------------------------------------------ 边 */

export interface ProducerSpec {
  kind: 'shell' | 'npm' | 'node'
  command: string
  outputs: string[]
}

export interface Edge {
  id: string
  /** 存储图的起点（角色槽位，不等于传播方向）。 */
  from: string
  /** 存储图的终点。 */
  to: string
  relation: Relation
  authority: Authority
  trigger: Trigger
  counterpart: Counterpart
  obligation: ObligationLevel
  verdict: VerdictLevel
  policy: EdgePolicy
  /** 上次校验时 from 端指纹；空串表示尚未校验。 */
  fromHash: string
  /** 上次校验时 to 端指纹。 */
  toHash: string
  producer?: ProducerSpec
  verifiedAt?: string
}

/* ---------------------------------------------------------- 判定与义务 */

export type Verdict =
  | { kind: 'clean' }
  /** side = 变化的那一端，也就是有效弧的起点。 */
  | { kind: 'drift'; side: 'from' | 'to'; cause: string; bothMoved?: boolean }
  /** 非触发侧单方面变更且不许写回权威端：交给 counterpart 策略消化。 */
  | { kind: 'counterpart'; side: 'from' | 'to' }
  /** 只有 authority = none 时才是真冲突。 */
  | { kind: 'conflict'; fromMoved: boolean; toMoved: boolean }
  | { kind: 'dangling'; missing: 'from' | 'to' }

export type Acceptance =
  | { kind: 'hash-changed'; node: string; from: string }
  | { kind: 'mechanical'; node: string; expected: string }
  | { kind: 'structural'; source: string; target: string; unit: Unit }

export type ObligationStatus = 'open' | 'claimed' | 'resolved' | 'deferred' | 'acked' | 'escalated'

export type ObligationKind = 'regenerate' | 'review' | 'conflict' | 'dangling'

export interface Obligation {
  id: string
  edgeId: string
  /** 需要被更新的节点。 */
  target: string
  /** 触发者（drift 的 cause 侧）。 */
  cause: string
  causeHash: string
  kind: ObligationKind
  severity: 'info' | 'warn' | 'block'
  acceptance: Acceptance
  status: ObligationStatus
  round: number
  createdAt: string
  expiresAt?: string
  detail?: string
}

/* ---------------------------------------------------------------- 图 */

/** 有效弧：trigger 允许 且 终点不是权威端。 */
export interface Arc {
  edge: Edge
  target: string
}

export interface GraphIssue {
  code: GfCode
  edgeId?: string
  nodeId?: string
  message: string
}

export interface GraphSnapshot {
  nodes: Map<string, Node>
  edges: Map<string, Edge>
  /** 有效弧邻接表；载入时算好，plan 期只读。 */
  outArcs: Map<string, Arc[]>
  /** 路径 → 节点 id 列表（同一文件可能贡献多个区域节点）。 */
  pathIndex: Map<string, string[]>
  issues: GraphIssue[]
  hashConfig: HashConfig
  /** 显式声明「不需要关系」的路径（图片、压缩包、生成物…）：它们不是孤儿。 */
  unmanaged: Set<string>
  /**
   * 为什么不需要关系（M4 起随图落盘）：路径 → 理由。
   * 只做审计与展示，判定永远只看 `unmanaged` 集合。
   */
  unmanagedReasons: Map<string, string>
}

export interface HashConfig {
  alg: 'sha256'
  truncate: number
  normalize: 'text' | 'bytes' | 'dsh-i18n-v1'
}

/* -------------------------------------------------------- 运行时状态 */

export interface RuntimeState {
  version: 1
  dirty: string[]
  obligations: Obligation[]
  round: { turnId: string; count: number; lastStaleness?: number } | null
  /** node → 最近 4 次 hash（震荡检测）。 */
  oscillation: Record<string, string[]>
  lastCheckAt?: string
}

export interface DigestedChange {
  edgeId: string
  node: string
  action: 'absorb' | 'confirm'
}

export interface Plan {
  obligations: Obligation[]
  digested: DigestedChange[]
  /** 与基线确实不同的节点（不是"被观察过"的节点：读文件不算变更）。 */
  changed: string[]
  /** 变更节点的当前指纹，用来判断"同一内容只问一次"。 */
  changedHashes: Record<string, string>
  stalenessBefore: number
  truncated: boolean
}

/* ------------------------------------------------------------ 错误码 */

export const GF_CODES = [
  'GF_GRAPH_INVALID',
  'GF_EDGE_CYCLE',
  'GF_DANGLING_EDGE',
  'GF_UNIT_MISMATCH',
  'GF_UNHASHABLE',
  'GF_BUDGET_EXHAUSTED',
  'GF_OSCILLATION',
  'GF_NO_PROGRESS',
  'GF_PRODUCER_FAILED',
  'GF_APPROVAL_DENIED',
  'GF_STATE_INVALID',
  'GF_MODEL_FAILED',
  'GF_WORKSPACE_MISMATCH',
  /** 审计/导入：账本与正文复算不一致（不阻断导入，单独列出）。 */
  'GF_I18N_UNVERIFIED',
  /** 另一个进程正在写这个工作区。 */
  'GF_LOCK_TIMEOUT',
] as const

export type GfCode = (typeof GF_CODES)[number]

export class GraphFSError extends Error {
  readonly code: GfCode
  readonly remedy?: string

  constructor(message: string, code: GfCode, remedy?: string) {
    super(message)
    this.name = 'GraphFSError'
    this.code = code
    this.remedy = remedy
  }
}

/** 便捷构造：让所有抛错点都带上稳定 code。 */
export function gfError(code: GfCode, message: string, remedy?: string): GraphFSError {
  return new GraphFSError(message, code, remedy)
}
