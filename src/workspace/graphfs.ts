import { resolveConfig } from '../config.ts'
import type { ConfigInput, GraphFSConfig } from '../config.ts'
import { PathPolicy } from './path-policy.ts'
import { NodeFsIo } from '../adapters/node-fs-io.ts'
import type { FileIo } from '../ports/io.ts'
import { FsFingerprint } from './fingerprint.ts'
import { readGraphFile, writeGraphFile, renderGraph } from '../store/graph-file.ts'
import { parseYaml } from '../store/yaml.ts'
import { parseGraph } from '../core/graph.ts'
import { judge } from '../core/verdict.ts'
import { plan as corePlan } from '../core/plan.ts'
import { digest16 } from '../core/hash.ts'
import { suggestEdges } from '../importers/suggest.ts'
import { mergeCandidates, readProposals } from '../importers/proposals.ts'
import { applyPlan } from './apply.ts'
import type { ApplyReport } from './apply.ts'
import { NodeRunner } from '../adapters/runner.ts'
import type { Runner } from '../ports/runner.ts'
import { buildPack } from '../importers/pack.ts'
import type { PromptPack } from '../importers/pack.ts'
import type { Candidate } from '../importers/suggest.ts'
import { importI18n } from '../importers/i18n.ts'
import type { I18nPackageImport } from '../importers/i18n.ts'
import { FileJournal, journalPathFor } from '../store/journal.ts'
import type { AuditEntry, AuditKind } from '../store/journal.ts'
import type { Journal } from '../ports/journal.ts'
import { withFileLock } from '../store/lock.ts'
import { GraphFSError } from '../types.ts'
import type { Edge, GraphIssue, GraphSnapshot, Node, Plan } from '../types.ts'

export interface DriftItem {
  edgeId: string
  from: string
  to: string
  relation: string
  side: 'from' | 'to'
  bothMoved: boolean
}

export interface ConflictItem {
  edgeId: string
  from: string
  to: string
  relation: string
}

export interface DanglingItem {
  kind: 'edge' | 'node'
  ref: string
  path?: string
}

export interface CheckReport {
  root: string
  graphPath: string
  counts: { nodes: number; edges: number; hashed: number }
  clean: number
  drift: DriftItem[]
  conflicts: ConflictItem[]
  dangling: DanglingItem[]
  unhashable: Array<{ node: string; path: string; reason: string }>
  counterpart: Array<{ edgeId: string; side: 'from' | 'to'; action: string }>
  /** 存在但既不在图里、也没声明 unmanaged 的文件。 */
  orphans: string[]
  /** 在图里但一条边都没有的节点。 */
  unlinked: string[]
  issues: Array<{ code: string; edgeId?: string; message: string }>
  ok: boolean
}

export interface StatusReport {
  root: string
  graphPath: string
  nodes: number
  edges: number
  byRelation: Record<string, number>
  missingHash: number
}

/** `bootstrap()`：建图 + 自动采纳高置信关系的汇总。 */
export interface BootstrapReport {
  path: string
  nodes: number
  /** 本次是否新建了图（false = 图已存在，只补关系）。 */
  created: boolean
  candidates: number
  linked: number
  /** 采纳完成后的边总数（已有图时包含历史边）。 */
  totalEdges: number
  skipped: Array<{ candidate: Candidate; reason: string }>
}

/** `import i18n` 的汇总（预览与落盘同一形状，`write` 区分）。 */
export interface I18nReport {
  write: boolean
  /** 扫到的账本包数。 */
  packages: number
  /** 结构漂移/文件缺失而整包跳过的数量。 */
  skipped: number
  nodes: number
  edges: number
  verified: number
  unverified: number
  issues: GraphIssue[]
  unverifiedList: string[]
}

export interface LinkSeed {
  from: string
  to: string
  relation: Edge['relation']
  producer?: Edge['producer']
  authority?: Edge['authority']
  trigger?: Edge['trigger']
  counterpart?: Edge['counterpart']
  obligation?: Edge['obligation']
  verdict?: Edge['verdict']
  policy?: Edge['policy']
  id?: string
}

/**
 * 工作区图门面：文件语义 ↔ 图语义。
 * 不实现判定，一律转调 core；不实现宿主，文件读写走 FileIo。
 */
export class GraphFS {
  readonly config: GraphFSConfig
  readonly policy: PathPolicy
  readonly io: FileIo
  readonly fingerprint: FsFingerprint
  /** 审计日志：写失败不阻塞业务（见 store/journal.ts 的契约）。 */
  readonly journal: Journal
  /** 当前操作者（写进审计）：`cli` / 插件工具里的 agent id / 导入器。 */
  readonly actor: string
  /** 跨进程锁文件：与 graph.yaml 同目录。 */
  readonly lockPath: string
  private graph: GraphSnapshot | null = null

  private constructor(config: GraphFSConfig, io?: FileIo, journal?: Journal, actor?: string) {
    this.config = config
    this.policy = new PathPolicy(config.root, config.ignore)
    this.io = io ?? new NodeFsIo(this.policy)
    this.fingerprint = new FsFingerprint(this.io, {
      normalize: config.normalize,
      maxFileBytes: config.maxFileBytes,
    })
    this.journal = journal ?? new FileJournal(journalPathFor(config.graphPath))
    this.actor = actor ?? 'unknown'
    this.lockPath = `${config.graphPath.replace(/\/[^/]*$/, '')}/lock`
  }

  /**
   * `io` 用来换宿主（插件传 ctx.fs 适配器；CLI 用默认 node:fs）。
   *
   * 归一化口径以**图文件里记录的**为准，除非调用方显式给了 `normalize`：
   * 一个 `dsh-i18n-v1` 的图被默认的 `text` 口径打开，会让每条边都显示漂移——
   * 这种"打开就报错"的体验比配置错误更难排查。
   */
  static async open(
    input: ConfigInput & {
      io?: FileIo
      journal?: Journal
      actor?: string
      /** 调用方显式指定了归一化口径（CLI 的 --normalize），不要被图文件覆盖。 */
      normalizeLocked?: boolean
    },
  ): Promise<GraphFS> {
    let instance = new GraphFS(resolveConfig(input), input.io, input.journal, input.actor)
    const loaded = await readGraphFile(instance.config.graphPath)
    instance.graph = loaded?.graph ?? null

    const recorded = loaded?.graph.hashConfig.normalize
    if (loaded && input.normalizeLocked !== true && recorded && recorded !== instance.config.normalize) {
      instance = new GraphFS(
        { ...instance.config, normalize: recorded },
        input.io,
        input.journal,
        input.actor,
      )
      instance.graph = loaded.graph
    }
    return instance
  }

  get snapshot(): GraphSnapshot | null {
    return this.graph
  }

  get graphPath(): string {
    return this.config.graphPath
  }

  /** 重新读盘（外部改了 graph.yaml 时用）。 */
  async reload(): Promise<void> {
    const loaded = await readGraphFile(this.config.graphPath)
    this.graph = loaded?.graph ?? null
  }

  /** 审计最近 n 条。 */
  async auditTail(limit = 50): Promise<AuditEntry[]> {
    return (await this.journal.tail(limit)) as AuditEntry[]
  }

  /** 追加审计：调用方不需要 try/catch（Journal 契约是"失败不外抛"）。 */
  private async audit(
    kind: AuditKind,
    fields: { edgeId?: string; node?: string; detail?: unknown } = {},
  ): Promise<void> {
    await this.journal.append({
      at: new Date().toISOString(),
      kind,
      actor: this.actor,
      root: this.config.root,
      ...fields,
    })
  }

  /**
   * 图的读-改-写必须整体持锁：否则两个进程各自读旧图、各自写回，后写者会吞掉前者的边。
   * 进锁后先 reload，把内存快照对齐到磁盘（另一个进程可能刚改过）。
   */
  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    return await withFileLock(this.lockPath, async () => {
      if (this.graph) await this.reload()
      return await fn()
    })
  }

  /** 计算指定节点（默认全部）的指纹；不可哈希的节点返回 undefined 并单独报告。 */
  async hashes(only?: string[]): Promise<{
    map: Map<string, string | null | undefined>
    unhashable: CheckReport['unhashable']
  }> {
    const graph = this.requireGraph()
    const ids = only ?? [...graph.nodes.keys()]
    const map = new Map<string, string | null | undefined>()
    const unhashable: CheckReport['unhashable'] = []

    for (const id of ids) {
      const node = graph.nodes.get(id)
      if (!node) continue
      try {
        const fingerprint = await this.fingerprint.read(node)
        map.set(id, fingerprint?.hash ?? null)
      } catch (error) {
        if (error instanceof GraphFSError && error.code === 'GF_UNHASHABLE') {
          map.set(id, undefined)
          unhashable.push({ node: id, path: node.path, reason: error.message })
          continue
        }
        throw error
      }
    }

    return { map, unhashable }
  }

  /** 只读校验：逐边判定，不改任何文件。只对「边涉及的节点」取指纹——工作区里没人引用的文件不参与。 */
  async check(): Promise<CheckReport> {
    const graph = this.requireGraph()
    const involved = this.involvedNodes()
    const { map: hashes, unhashable } = await this.hashes(involved)

    const report: CheckReport = {
      root: this.config.root,
      graphPath: this.config.graphPath,
      counts: { nodes: graph.nodes.size, edges: graph.edges.size, hashed: hashes.size },
      clean: 0,
      drift: [],
      conflicts: [],
      dangling: [],
      unhashable,
      counterpart: [],
      orphans: [],
      unlinked: [],
      issues: graph.issues.map((i) => ({ code: i.code, edgeId: i.edgeId, message: i.message })),
      ok: true,
    }

    for (const edge of graph.edges.values()) {
      const fromHash = hashes.get(edge.from)
      const toHash = hashes.get(edge.to)
      if (fromHash === undefined || toHash === undefined) continue

      const verdict = judge({ edge, fromHash, toHash })
      switch (verdict.kind) {
        case 'clean':
          report.clean += 1
          break
        case 'drift':
          report.drift.push({
            edgeId: edge.id,
            from: edge.from,
            to: edge.to,
            relation: edge.relation,
            side: verdict.side,
            bothMoved: Boolean(verdict.bothMoved),
          })
          break
        case 'conflict':
          report.conflicts.push({ edgeId: edge.id, from: edge.from, to: edge.to, relation: edge.relation })
          break
        case 'counterpart':
          // 非触发侧变更且不许写权威端：不是漂移，按 counterpart 策略消化
          report.counterpart.push({ edgeId: edge.id, side: verdict.side, action: edge.counterpart })
          break
        case 'dangling': {
          const missing = edge[verdict.missing]
          report.dangling.push({ kind: 'node', ref: missing, path: graph.nodes.get(missing)?.path })
          break
        }
      }
    }

    for (const node of graph.nodes.values()) {
      if (hashes.get(node.id) === null) {
        report.dangling.push({ kind: 'node', ref: node.id, path: node.path })
      }
    }

    // 孤儿：工作区里存在、但没建节点也没声明 unmanaged 的文件。
    const files = await this.io.list('.')
    const nodePaths = new Set([...graph.nodes.values()].map((n) => n.path))
    report.orphans = files.filter((file) => !nodePaths.has(file) && !graph.unmanaged.has(file))

    // 孤立节点：建了节点但没有任何边——通常意味着"声明了却没说和谁一致"。
    const linked = new Set<string>()
    for (const edge of graph.edges.values()) {
      linked.add(edge.from)
      linked.add(edge.to)
    }
    report.unlinked = [...graph.nodes.values()]
      .filter((n) => !linked.has(n.id) && !graph.unmanaged.has(n.path))
      .map((n) => n.path)
      .sort()

    // 不可哈希只影响「涉及它的边」（那些边会跳过判定），不单独判定失败。
    report.ok = report.drift.length === 0 && report.conflicts.length === 0 && report.dangling.length === 0
    return report
  }

  /** 规划义务：changed = 与任一边基线不一致的节点。 */
  async plan(): Promise<Plan> {
    const graph = this.requireGraph()
    const { map: hashes } = await this.hashes(this.involvedNodes())

    const changed = new Set<string>()
    for (const edge of graph.edges.values()) {
      const fromHash = hashes.get(edge.from)
      const toHash = hashes.get(edge.to)
      if (typeof fromHash === 'string' && fromHash !== edge.fromHash) changed.add(edge.from)
      if (typeof toHash === 'string' && toHash !== edge.toHash) changed.add(edge.to)
      if (fromHash === null) changed.add(edge.from)
      if (toHash === null) changed.add(edge.to)
    }

    return corePlan({
      changed: [...changed],
      graph,
      hashes,
      limits: { maxDepth: this.config.maxDepth, maxObligations: this.config.maxObligations },
      now: new Date().toISOString(),
    })
  }

  status(): StatusReport {
    const graph = this.requireGraph()
    const byRelation: Record<string, number> = {}
    let missingHash = 0
    for (const edge of graph.edges.values()) {
      byRelation[edge.relation] = (byRelation[edge.relation] ?? 0) + 1
      if (!edge.fromHash || !edge.toHash) missingHash += 1
    }
    return {
      root: this.config.root,
      graphPath: this.config.graphPath,
      nodes: graph.nodes.size,
      edges: graph.edges.size,
      byRelation,
      missingHash,
    }
  }

  /** 建边：用当前指纹填基线，过一遍与 load 时相同的校验，再原子写回。 */
  async link(seed: LinkSeed, opts: { write?: boolean } = {}): Promise<Edge> {
    return await this.mutate(() => this.linkUnlocked(seed, opts))
  }

  private async linkUnlocked(seed: LinkSeed, opts: { write?: boolean } = {}): Promise<Edge> {
    const graph = this.requireGraph()
    const from = graph.nodes.get(seed.from)
    const to = graph.nodes.get(seed.to)
    if (!from || !to) throw new GraphFSError('link: unknown node id', 'GF_GRAPH_INVALID')

    const fromHash = await this.hashOf(from)
    const toHash = await this.hashOf(to)

    const data = parseYaml(renderGraph(graph)) as { nodes: unknown[]; edges: unknown[]; hash: unknown; version: number }
    data.edges.push({
      id: seed.id ?? `gf-${digest16(`${seed.from}|${seed.to}|${seed.relation}`).slice(0, 8)}`,
      from: seed.from,
      to: seed.to,
      relation: seed.relation,
      authority: seed.authority,
      trigger: seed.trigger,
      counterpart: seed.counterpart,
      obligation: seed.obligation,
      verdict: seed.verdict,
      policy: seed.policy,
      producer: seed.producer,
      fromHash: fromHash ?? '',
      toHash: toHash ?? '',
      verifiedAt: new Date().toISOString(),
    })

    const { graph: next, issues } = parseGraph(data)
    if (!next) throw new GraphFSError('link produced an invalid graph', 'GF_GRAPH_INVALID', issues.map((i) => i.message).join('; '))
    const fatal = next.issues.filter((i) => i.code !== 'GF_DANGLING_EDGE')
    if (fatal.length > 0) {
      throw new GraphFSError(
        `link rejected: ${fatal.map((i) => i.message).join('; ')}`,
        fatal[0]!.code === 'GF_EDGE_CYCLE' ? 'GF_EDGE_CYCLE' : 'GF_GRAPH_INVALID',
      )
    }

    const created = [...next.edges.values()].at(-1)!
    if (opts.write !== false) {
      await writeGraphFile(this.config.graphPath, next)
      this.graph = next
      await this.audit('link', {
        edgeId: created.id,
        detail: { from: created.from, to: created.to, relation: created.relation },
      })
    }
    return created
  }

  /**
   * 候选边发现。
   *
   * 默认是**增量**的：只对「未覆盖的文件」提案——不在图里、或在图里但没有边、且没声明 unmanaged。
   * 已经有边的文件不再重复提。`all: true` 才全量重扫。
   *
   * 触发时机只有两个：`init` 时一次，或用户显式要求；不在每次变更后自动跑。
   */
  async suggest(opts: { proposalsPath?: string; all?: boolean; extra?: Candidate[] } = {}): Promise<Candidate[]> {
    const files = await this.io.list('.')
    const graph = this.snapshot

    const heuristic = await suggestEdges({ files, read: (rel) => this.io.readText(rel) })
    let proposals: Candidate[] = []
    if (opts.proposalsPath && graph) {
      proposals = (await readProposals(opts.proposalsPath, graph)).candidates
    }

    // 候选里的 from/to 是 `idFor(path)` 的产物；图里真正的节点 id 可能带去重后缀
    // （`a.md` 与 `a.txt` 撞 id）。这里按 pathIndex 校正，避免边指向不存在的节点。
    const merged = mergeCandidates(heuristic, proposals, opts.extra ?? []).map((candidate) => {
      if (!graph) return candidate
      return {
        ...candidate,
        from: graph.pathIndex.get(candidate.fromPath)?.[0] ?? candidate.from,
        to: graph.pathIndex.get(candidate.toPath)?.[0] ?? candidate.to,
      }
    })
    if (!graph) return merged

    // 已经建过的边永远不再提（`--all` 也一样，否则「采纳」会重复建边）。
    const declared = new Set<string>()
    for (const edge of graph.edges.values()) declared.add(`${edge.from}|${edge.to}|${edge.relation}`)
    const fresh = merged.filter(
      (candidate) => !declared.has(`${candidate.from}|${candidate.to}|${candidate.relation}`),
    )

    if (opts.all || opts.extra !== undefined) return fresh

    const scope = new Set(files.filter((file) => this.isUncovered(graph, file)))
    return fresh.filter((candidate) => scope.has(candidate.fromPath) || scope.has(candidate.toPath))
  }

  /** 组装"让模型提边"的提示包（有界、可复现）。 */
  async buildPack(limits?: { maxFiles?: number; maxCandidates?: number }): Promise<PromptPack> {
    const files = await this.io.list('.')
    const heuristic = await suggestEdges({ files, read: (rel) => this.io.readText(rel) })
    return buildPack({
      root: this.config.root,
      files,
      read: (rel) => this.io.readText(rel),
      heuristic,
      now: new Date().toISOString(),
      limits,
    })
  }

  /** 未覆盖 = 没建节点（且没标 unmanaged），或建了节点但一条边都没有。 */
  private isUncovered(graph: GraphSnapshot, path: string): boolean {
    if (graph.unmanaged.has(path)) return false
    const ids = graph.pathIndex.get(path)
    if (!ids || ids.length === 0) return true
    return ids.some((id) => this.incidentCount(graph, id) === 0)
  }

  private incidentCount(graph: GraphSnapshot, nodeId: string): number {
    let count = 0
    for (const edge of graph.edges.values()) {
      if (edge.from === nodeId || edge.to === nodeId) count += 1
    }
    return count
  }

  /**
   * 采纳候选：逐条建边（自动填基线 + 走建边校验），失败的跳过并给出原因。
   * 默认只写通过校验且置信度 ≥ minConfidence 的候选。
   */
  async applySuggestions(
    candidates: Candidate[],
    opts: { minConfidence?: number; write?: boolean } = {},
  ): Promise<{ linked: Edge[]; skipped: Array<{ candidate: Candidate; reason: string }> }> {
    const min = opts.minConfidence ?? 0.7
    const write = opts.write !== false
    const skipped: Array<{ candidate: Candidate; reason: string }> = []

    const selected: Candidate[] = []
    for (const candidate of candidates) {
      if (candidate.confidence < min) {
        skipped.push({ candidate, reason: `confidence ${candidate.confidence} < ${min}` })
        continue
      }
      selected.push(candidate)
    }

    // 批量采纳时一次持锁、一次写盘：600 条边逐条 link 会把图重写 600 次。
    if (write && selected.length > 1) {
      const batch = await this.linkBatch(
        selected.map((candidate) => ({
          from: candidate.from,
          to: candidate.to,
          relation: candidate.relation,
          authority: candidate.authority,
          trigger: candidate.trigger,
          counterpart: candidate.counterpart,
          obligation: candidate.obligation,
        })),
        { source: 'suggest' },
      )
      for (const miss of batch.skipped) {
        skipped.push({ candidate: selected[miss.index]!, reason: miss.reason })
      }
      return { linked: batch.linked, skipped }
    }

    const linked: Edge[] = []
    for (const candidate of selected) {
      try {
        linked.push(
          await this.link(
            {
              from: candidate.from,
              to: candidate.to,
              relation: candidate.relation,
              authority: candidate.authority,
              trigger: candidate.trigger,
              counterpart: candidate.counterpart,
              obligation: candidate.obligation,
            },
            { write },
          ),
        )
      } catch (error) {
        skipped.push({
          candidate,
          reason: error instanceof GraphFSError ? `${error.code}: ${error.message}` : String(error),
        })
      }
    }

    return { linked, skipped }
  }

  /**
   * 批量建边：一次 lock、一次 load/hash、一次写盘。
   * 每条边仍然单独过 `parseAndCheck`（环/方向锁/重复边），失败的跳过并继续。
   */
  private async linkBatch(
    seeds: LinkSeed[],
    opts: { source?: string } = {},
  ): Promise<{ linked: Edge[]; skipped: Array<{ index: number; reason: string }> }> {
    return await this.mutate(async () => {
      const graph = this.requireGraph()
      const data = this.dataOf(graph)
      const edges = data.edges as Array<Record<string, unknown>>
      const known = new Set(edges.map((edge) => String(edge.id)))
      const hashes = new Map<string, string | null>()
      const linked: Edge[] = []
      const skipped: Array<{ index: number; reason: string }> = []
      let current = graph

      const hashOfNode = async (node: Node): Promise<string | null> => {
        if (!hashes.has(node.id)) hashes.set(node.id, await this.hashOf(node))
        return hashes.get(node.id) ?? null
      }

      for (const [index, seed] of seeds.entries()) {
        const from = current.nodes.get(seed.from)
        const to = current.nodes.get(seed.to)
        if (!from || !to) {
          skipped.push({ index, reason: 'unknown node id (run graphfs_status to refresh)' })
          continue
        }
        const id = seed.id ?? `gf-${digest16(`${seed.from}|${seed.to}|${seed.relation}`).slice(0, 8)}`
        if (known.has(id)) {
          skipped.push({ index, reason: `duplicate edge id ${id}` })
          continue
        }

        const raw: Record<string, unknown> = {
          id,
          from: seed.from,
          to: seed.to,
          relation: seed.relation,
          authority: seed.authority,
          trigger: seed.trigger,
          counterpart: seed.counterpart,
          obligation: seed.obligation,
          verdict: seed.verdict,
          policy: seed.policy,
          producer: seed.producer,
          fromHash: (await hashOfNode(from)) ?? '',
          toHash: (await hashOfNode(to)) ?? '',
          verifiedAt: new Date().toISOString(),
        }

        try {
          const next = this.parseAndCheck({ ...data, edges: [...edges, raw] })
          edges.push(raw)
          known.add(id)
          current = next
          linked.push(next.edges.get(id)!)
          this.graph = next
        } catch (error) {
          skipped.push({
            index,
            reason: error instanceof GraphFSError ? `${error.code}: ${error.message}` : String(error),
          })
        }
      }

      if (linked.length > 0) {
        await writeGraphFile(this.config.graphPath, current)
        this.graph = current
        await this.audit('link', {
          detail: { count: linked.length, source: opts.source ?? 'batch' },
        })
      }
      return { linked, skipped }
    })
  }

  /**
   * 批量导入 `README.i18n.yaml`（M5）。默认只预览；`write: true` 才落盘。
   *
   * 要求 `normalize: 'dsh-i18n-v1'`——账本里的指纹就是这个口径算的，
   * 用别的口径导入会让每一条边立刻显示漂移（那不是导入，是制造噪声）。
   */
  async importI18n(opts: { dirs?: string[]; write?: boolean } = {}): Promise<I18nReport> {
    if (this.config.normalize !== 'dsh-i18n-v1') {
      throw new GraphFSError(
        `import i18n requires normalize='dsh-i18n-v1' (current: '${this.config.normalize}')`,
        'GF_UNIT_MISMATCH',
        'run with `--normalize dsh-i18n-v1` (the ledger fingerprints use that normalizer)',
      )
    }

    const files = await this.io.list('.')
    const yamlPaths = files.filter((path) => {
      if (!path.endsWith('README.i18n.yaml')) return false
      if (!opts.dirs || opts.dirs.length === 0) return true
      return opts.dirs.some((dir) => path === `${dir}/README.i18n.yaml` || path.startsWith(`${dir.replace(/\/$/, '')}/`))
    })

    const run = async (): Promise<I18nReport> => {
      const base = this.snapshot
      const data: Record<string, unknown> & { nodes: unknown[]; edges: unknown[]; unmanaged?: unknown[] } = base
        ? this.dataOf(base)
        : {
            version: 1,
            hash: { alg: 'sha256', truncate: 16, normalize: this.config.normalize },
            nodes: [],
            edges: [],
          }

      const existingNodes = new Set(
        (data.nodes as Array<Record<string, unknown>>).map((node) => String(node.id)),
      )
      const existingEdges = new Set(
        (data.edges as Array<Record<string, unknown>>).map((edge) => String(edge.id)),
      )
      const unmanagedPaths = new Set(unmanagedEntries(data).map((entry) => entry.path))

      const report: I18nReport = {
        write: opts.write === true,
        packages: 0,
        skipped: 0,
        nodes: 0,
        edges: 0,
        verified: 0,
        unverified: 0,
        issues: [],
        unverifiedList: [],
      }

      for (const yamlPath of yamlPaths) {
        // 账本本身不是一致性单元（它是派生来源），标 unmanaged 而不是留给孤儿报告。
        if (!unmanagedPaths.has(yamlPath)) {
          unmanagedPaths.add(yamlPath)
          data.unmanaged = [...(data.unmanaged ?? []), { path: yamlPath, reason: 'i18n ledger (import source)' }]
        }

        const dir = yamlPath.replace(/\/?README\.i18n\.yaml$/, '')
        const imported = await importI18n({
          read: (path) => this.io.readText(path),
          yamlPath,
          enPath: dir === '' ? 'README.md' : `${dir}/README.md`,
          zhPath: dir === '' ? 'README.zh.md' : `${dir}/README.zh.md`,
        })

        report.packages += 1
        report.issues.push(...imported.issues)
        report.verified += imported.verified
        report.unverified += imported.unverified.length
        report.unverifiedList.push(...imported.unverified)
        if (imported.nodes.length === 0) report.skipped += 1

        for (const node of imported.nodes) {
          if (existingNodes.has(node.id)) continue
          existingNodes.add(node.id)
          data.nodes.push({ id: node.id, path: node.path, unit: node.unit })
          report.nodes += 1
        }
        for (const edge of imported.edges) {
          if (existingEdges.has(edge.id)) continue
          existingEdges.add(edge.id)
          data.edges.push(edge)
          report.edges += 1
        }
      }

      if (report.edges === 0 && report.nodes === 0) {
        report.write = false
        return report
      }

      const next = this.parseAndCheck(data)
      if (opts.write === true) {
        await writeGraphFile(this.config.graphPath, next)
        this.graph = next
        await this.audit('import', {
          detail: {
            packages: report.packages,
            skipped: report.skipped,
            nodes: report.nodes,
            edges: report.edges,
            unverified: report.unverified,
          },
        })
      }
      return report
    }

    // 导入是纯追加，但和别的写操作一样要排队。
    if (opts.write === true) return await this.mutate(run)
    return await run()
  }

  /**
   * 新建文件**必须**同时声明关系（Spec §8.6）：
   * 要么 `links` 至少一条，要么 `unmanaged: true`，否则直接拒绝。
   */
  async create(
    path: string,
    content: string,
    opts: { links?: Array<{ to: string; relation?: Edge['relation']; as?: 'from' | 'to' }>; unmanaged?: boolean } = {},
  ): Promise<{ nodeId: string; edges: Edge[] }> {
    const links = opts.links ?? []
    if (links.length === 0 && !opts.unmanaged) {
      await this.audit('refuse', {
        node: path,
        detail: { reason: 'new file has no declared relations' },
      })
      throw new GraphFSError(
        `new file ${path} has no declared relations`,
        'GF_GRAPH_INVALID',
        'pass links: [{to, relation}] , or unmanaged: true if it needs no consistency',
      )
    }
    if (links.length > 0 && opts.unmanaged) {
      throw new GraphFSError('links and unmanaged are mutually exclusive', 'GF_GRAPH_INVALID')
    }

    const existed = (await this.io.readText(path)) !== null
    if (existed) {
      throw new GraphFSError(`${path} already exists`, 'GF_GRAPH_INVALID', 'use write/edit for existing files')
    }
    await this.io.writeText(path, content)

    if (opts.unmanaged) {
      try {
        await this.attach(path, { unmanaged: true, reason: 'new file needs no consistency' })
      } catch (error) {
        await this.io.remove(path).catch(() => undefined)
        throw error
      }
      return { nodeId: idFor(path), edges: [] }
    }

    const created: Edge[] = []
    let nodeId = idFor(path)
    try {
      for (const link of links) {
        const result = await this.attach(path, {
          to: [link.to],
          relation: link.relation ?? 'documents',
          as: link.as ?? 'to',
        })
        nodeId = result.nodeId ?? nodeId
        created.push(...result.edges)
      }
    } catch (error) {
      // 建边失败就回滚文件，避免留下"写了但没声明"的孤儿。
      await this.io.remove(path).catch(() => undefined)
      throw error
    }

    return { nodeId, edges: created }
  }

  /**
   * 把「新文件」接进图：要么给至少一条边，要么显式声明 unmanaged。
   * 这是"新建文件必须声明关系"的落地点（CLI 与插件工具共用）。
   */
  async attach(
    path: string,
    opts: { to?: string[]; relation?: Edge['relation']; as?: 'from' | 'to'; unmanaged?: boolean; reason?: string },
  ): Promise<{ nodeId?: string; edges: Edge[]; unmanaged: boolean }> {
    return await this.mutate(() => this.attachUnlocked(path, opts))
  }

  private async attachUnlocked(
    path: string,
    opts: { to?: string[]; relation?: Edge['relation']; as?: 'from' | 'to'; unmanaged?: boolean; reason?: string },
  ): Promise<{ nodeId?: string; edges: Edge[]; unmanaged: boolean }> {
    const graph = this.requireGraph()
    const rel = normalizeRel(path)

    if (opts.unmanaged) {
      const existing = [...graph.nodes.values()].find((n) => n.path === rel)
      if (existing) {
        throw new GraphFSError(
          `${rel} already has a node; detach it first or link it instead`,
          'GF_GRAPH_INVALID',
        )
      }
      const data = this.dataOf(graph)
      const others = unmanagedEntries(data).filter((entry) => entry.path !== rel)
      data.unmanaged = [
        ...others,
        { path: rel, reason: opts.reason ?? 'declared unmanaged' },
      ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      const next = this.parseAndCheck(data)
      await writeGraphFile(this.config.graphPath, next)
      this.graph = next
      await this.audit('attach', { node: rel, detail: { unmanaged: true, reason: opts.reason } })
      return { edges: [], unmanaged: true }
    }

    const targets = opts.to ?? []
    if (targets.length === 0) {
      throw new GraphFSError('attach requires --to <node> or --unmanaged', 'GF_GRAPH_INVALID')
    }
    const relation = opts.relation ?? 'documents'
    const side = opts.as ?? 'to'

    const data = this.dataOf(graph)
    const existing = [...graph.nodes.values()].find((n) => n.path === rel)
    const nodeId = existing?.id ?? idFor(rel)
    if (!existing) data.nodes.push({ id: nodeId, path: rel, unit: { kind: 'whole-file' } })

    const self = graph.nodes.get(nodeId) ?? { id: nodeId, path: rel, unit: { kind: 'whole-file' as const } }
    const selfHash = await this.hashOf(self)

    for (const target of targets) {
      const other =
        graph.nodes.get(target) ?? [...graph.nodes.values()].find((n) => n.path === target)
      if (!other) {
        throw new GraphFSError(
          `attach: unknown node ${target}`,
          'GF_GRAPH_INVALID',
          'pass a node id from `graphfs status` or its path',
        )
      }
      const otherHash = await this.hashOf(other)
      const [from, to] = side === 'to' ? [other.id, nodeId] : [nodeId, other.id]
      const duplicate = [...graph.edges.values()].find(
        (e) => e.from === from && e.to === to && e.relation === relation,
      )
      if (duplicate) {
        throw new GraphFSError(
          `edge already exists: ${from} → ${to} [${relation}] (${duplicate.id})`,
          'GF_GRAPH_INVALID',
          'change the relation, or detach the existing edge first',
        )
      }
      const fromHash = side === 'to' ? otherHash : selfHash
      const toHash = side === 'to' ? selfHash : otherHash
      data.edges.push({
        id: `gf-${digest16(`${from}|${to}|${relation}`).slice(0, 8)}`,
        from,
        to,
        relation,
        fromHash: fromHash ?? '',
        toHash: toHash ?? '',
        verifiedAt: new Date().toISOString(),
      })
    }

    const next = this.parseAndCheck(data)
    await writeGraphFile(this.config.graphPath, next)
    this.graph = next
    const edges = [...next.edges.values()].filter((e) => e.from === nodeId || e.to === nodeId)
    await this.audit('attach', {
      node: rel,
      detail: { edges: edges.map((e) => e.id), relation, targets },
    })
    return { nodeId, edges, unmanaged: false }
  }

  /** 扫描工作区，生成节点骨架（不写盘）。id 冲突时加后缀，避免 dotfile 互相覆盖。 */
  async scanNodes(): Promise<{
    nodes: Array<{ id: string; path: string; unit: { kind: 'whole-file' } }>
    unmanaged: Array<{ path: string; reason: string }>
  }> {
    const files = await this.io.list('.')
    const used = new Map<string, number>()
    const nodes: Array<{ id: string; path: string; unit: { kind: 'whole-file' } }> = []

    for (const path of files) {
      if (looksBinary(path)) continue
      const base = idFor(path)
      const count = used.get(base) ?? 0
      used.set(base, count + 1)
      nodes.push({ id: count === 0 ? base : `${base}-${count + 1}`, path, unit: { kind: 'whole-file' } })
    }

    return {
      nodes,
      unmanaged: files.filter(looksBinary).map((path) => ({ path, reason: 'binary file (auto)' })),
    }
  }

  /** 只读地建一份「假如 init」的图：给 `--deep` 在没有图的工作区里用。 */
  async previewGraph(): Promise<GraphSnapshot> {
    const { nodes, unmanaged } = await this.scanNodes()
    const { graph, issues } = parseGraph({
      version: 1,
      hash: { alg: 'sha256', truncate: 16, normalize: this.config.normalize },
      nodes,
      edges: [],
      ...(unmanaged.length > 0 ? { unmanaged } : {}),
    })
    if (!graph) {
      throw new GraphFSError('cannot scan workspace', 'GF_GRAPH_INVALID', issues.map((i) => i.message).join('; '))
    }
    return graph
  }

  /**
   * 执行确定性边（policy: auto + producer）。默认 dry-run：真跑、出 diff、再恢复原状。
   * 真实执行后用当前指纹重录基线。
   */
  async apply(
    plan: Plan,
    opts: { dryRun?: boolean; only?: string[]; runner?: Runner; signal?: AbortSignal; allowUnstable?: boolean } = {},
  ): Promise<ApplyReport> {
    const runner = opts.runner ?? new NodeRunner(this.config.root)
    const dryRun = opts.dryRun ?? true

    const run = async (): Promise<ApplyReport> => {
      const graph = this.requireGraph()
      return await applyPlan(
        {
          io: this.io,
          policy: this.policy,
          graph,
          runner,
          maxFileBytes: this.config.maxFileBytes,
          normalize: this.config.normalize,
          now: () => new Date().toISOString(),
          commit: async (edgeId, fromHash, toHash) => {
            const current = this.requireGraph()
            const data = this.dataOf(current)
            const raw = (data.edges as Array<Record<string, unknown>>).find((e) => e.id === edgeId)
            if (!raw) throw new GraphFSError(`edge ${edgeId} vanished`, 'GF_GRAPH_INVALID')
            raw.fromHash = fromHash
            raw.toHash = toHash
            raw.verifiedAt = new Date().toISOString()
            const next = this.parseAndCheck(data)
            await writeGraphFile(this.config.graphPath, next)
            this.graph = next
          },
        },
        plan,
        { dryRun, only: opts.only, signal: opts.signal, allowUnstable: opts.allowUnstable },
      )
    }

    // 预览不写图；真实执行要持锁（producer 直接改工作区文件，不能与别的进程交错）。
    const report = dryRun ? await run() : await this.mutate(run)

    for (const outcome of report.outcomes) {
      if (outcome.status === 'skipped') continue
      await this.audit('apply', {
        edgeId: outcome.edgeId,
        detail: { status: outcome.status, dryRun: report.dryRun, reason: outcome.reason },
      })
    }
    return report
  }

  /** 认可漂移：用当前指纹重录这条边的基线（等价于 i18n 工具里的 --write）。 */
  async ack(edgeId: string, reason: string): Promise<Edge> {
    const why = reason.trim()
    if (why === '') {
      throw new GraphFSError('ack requires a non-empty reason', 'GF_GRAPH_INVALID', 'say why the drift is acceptable')
    }
    return await this.mutate(() => this.ackUnlocked(edgeId, why))
  }

  private async ackUnlocked(edgeId: string, reason: string): Promise<Edge> {
    const graph = this.requireGraph()
    const edge = graph.edges.get(edgeId)
    if (!edge) throw new GraphFSError(`unknown edge ${edgeId}`, 'GF_GRAPH_INVALID')

    const fromNode = graph.nodes.get(edge.from)
    const toNode = graph.nodes.get(edge.to)
    if (!fromNode || !toNode) throw new GraphFSError('edge endpoints are missing', 'GF_DANGLING_EDGE')

    const fromHash = await this.hashOf(fromNode)
    const toHash = await this.hashOf(toNode)

    const data = this.dataOf(graph)
    const rawEdges = data.edges as Array<Record<string, unknown>>
    const target = rawEdges.find((e) => e.id === edgeId)
    if (!target) throw new GraphFSError(`edge ${edgeId} not found in file`, 'GF_GRAPH_INVALID')
    const previous = { fromHash: edge.fromHash, toHash: edge.toHash }
    target.fromHash = fromHash ?? ''
    target.toHash = toHash ?? ''
    target.verifiedAt = new Date().toISOString()

    const next = this.parseAndCheck(data)
    await writeGraphFile(this.config.graphPath, next)
    this.graph = next

    // M4：审计才是 ack 的意义所在——没有「谁/何时/为什么」，重录基线就等于掩盖漂移。
    await this.audit('ack', {
      edgeId,
      detail: {
        reason,
        from: edge.from,
        to: edge.to,
        relation: edge.relation,
        before: previous,
        after: { fromHash: target.fromHash, toHash: target.toHash },
      },
    })
    return next.edges.get(edgeId)!
  }

  /** 初始化：扫描工作区、生成骨架（节点 + 空边）。 */
  async init(opts: { force?: boolean } = {}): Promise<{ path: string; nodes: number }> {
    return await this.mutate(async () => {
      const existing = await readGraphFile(this.config.graphPath)
      if (existing && !opts.force) {
        throw new GraphFSError('graph already exists', 'GF_GRAPH_INVALID', 'pass --force to overwrite')
      }

      const { nodes, unmanaged } = await this.scanNodes()
      const data = {
        version: 1,
        hash: { alg: 'sha256', truncate: 16, normalize: this.config.normalize },
        nodes,
        edges: [],
        ...(unmanaged.length > 0 ? { unmanaged } : {}),
      }
      const { graph, issues } = parseGraph(data)
      if (!graph) throw new GraphFSError('init produced an invalid graph', 'GF_GRAPH_INVALID')

      const fatal = issues.filter((i) => i.code !== 'GF_DANGLING_EDGE')
      if (fatal.length > 0) {
        throw new GraphFSError(
          `init rejected: ${fatal.slice(0, 3).map((i) => i.message).join('; ')}`,
          'GF_GRAPH_INVALID',
        )
      }

      await writeGraphFile(this.config.graphPath, graph)
      this.graph = graph
      await this.audit('init', {
        node: this.config.graphPath,
        detail: { nodes: nodes.length, unmanaged: unmanaged.length, overwritten: Boolean(existing) },
      })
      return { path: this.config.graphPath, nodes: nodes.length }
    })
  }

  /**
   * 一键建图（M7）：`init` → 扫描候选边 → 采纳置信度 ≥ 0.8 的。
   *
   * 这是"用户点一下/模型调一次就有一张能用的图"的入口：
   * `graphfs_init` 工具、生命周期里的自动初始化、CLI 的 `init` 都走它。
   */
  async bootstrap(opts: { force?: boolean; minConfidence?: number; write?: boolean } = {}): Promise<BootstrapReport> {
    const created = !this.snapshot || opts.force === true
    const initialized = created
      ? await this.init({ force: opts.force })
      : { path: this.config.graphPath, nodes: this.snapshot!.nodes.size }

    const candidates = await this.suggest({ all: created })
    const min = opts.minConfidence ?? 0.7

    if (opts.write === false) {
      return {
        path: initialized.path,
        nodes: initialized.nodes,
        created,
        candidates: candidates.length,
        linked: 0,
        totalEdges: this.snapshot?.edges.size ?? 0,
        skipped: [],
      }
    }

    const applied = await this.applySuggestions(candidates, { minConfidence: min })
    return {
      path: initialized.path,
      nodes: initialized.nodes,
      created,
      candidates: candidates.length,
      linked: applied.linked.length,
      totalEdges: this.snapshot?.edges.size ?? 0,
      skipped: applied.skipped,
    }
  }

  /** 边涉及的全部节点 id。 */
  private involvedNodes(): string[] {
    const graph = this.requireGraph()
    const ids = new Set<string>()
    for (const edge of graph.edges.values()) {
      ids.add(edge.from)
      ids.add(edge.to)
    }
    return [...ids]
  }

  private dataOf(graph: GraphSnapshot): Record<string, unknown> & {
    nodes: unknown[]
    edges: unknown[]
    unmanaged?: unknown[]
  } {
    const data = parseYaml(renderGraph(graph)) as Record<string, unknown> & {
      nodes: unknown[]
      edges: unknown[]
      unmanaged?: unknown[]
    }
    return data
  }

  private parseAndCheck(data: unknown): GraphSnapshot {
    const { graph, issues } = parseGraph(data)
    if (!graph) throw new GraphFSError('graph became invalid', 'GF_GRAPH_INVALID', issues.map((i) => i.message).join('; '))
    const fatal = graph.issues.filter((i) => i.code !== 'GF_DANGLING_EDGE')
    if (fatal.length > 0) {
      throw new GraphFSError(
        `rejected: ${fatal.map((i) => i.message).join('; ')}`,
        fatal.some((i) => i.code === 'GF_EDGE_CYCLE') ? 'GF_EDGE_CYCLE' : 'GF_GRAPH_INVALID',
      )
    }
    return graph
  }

  private requireGraph(): GraphSnapshot {
    if (!this.graph) {
      throw new GraphFSError(
        `no graph at ${this.config.graphPath}`,
        'GF_GRAPH_INVALID',
        'run `graphfs init` first',
      )
    }
    return this.graph
  }

  private async hashOf(node: Node): Promise<string | null> {
    const fingerprint = await this.fingerprint.read(node)
    return fingerprint?.hash ?? null
  }
}

const BINARY_EXT = new Set([
  '.zip', '.gz', '.tar', '.7z', '.rar', '.pth', '.pt', '.ckpt', '.bin', '.npy', '.npz', '.pkl', '.onnx', '.h5',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.mp3', '.wav', '.mp4', '.mov',
  '.so', '.dylib', '.dll', '.exe', '.pyc', '.class', '.jar', '.woff', '.woff2', '.ttf', '.otf',
])

/** 按扩展名猜二进制：只为「init 时自动标 unmanaged」，不参与哈希判定。 */
export function looksBinary(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return false
  return BINARY_EXT.has(path.slice(dot).toLowerCase())
}

function normalizeRel(path: string): string {
  if (path.startsWith('/') || path.includes('..')) {
    throw new GraphFSError(`path must be workspace-relative: ${path}`, 'GF_WORKSPACE_MISMATCH')
  }
  return path.replace(/^\.\//, '')
}

interface UnmanagedEntry {
  path: string
  reason?: string
}

/** 兼容两种写法：旧的纯字符串与 M4 的 `{ path, reason }`。 */
function unmanagedEntries(data: { unmanaged?: unknown }): UnmanagedEntry[] {
  const raw = data.unmanaged
  if (!Array.isArray(raw)) return []
  const out: UnmanagedEntry[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push({ path: item })
      continue
    }
    if (item && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string') {
      const entry = item as { path: string; reason?: unknown }
      out.push(typeof entry.reason === 'string' ? { path: entry.path, reason: entry.reason } : { path: entry.path })
    }
  }
  return out
}

/** 节点 id：路径去掉扩展名、分隔符换成 `-`。`.gitignore` 这类点文件保留名字本身。 */
export function idFor(path: string): string {
  const segments = path.split('/')
  const base = segments.pop() ?? path
  // `.gitignore` → gitignore；`.eslintrc.json` → eslintrc
  const stem =
    base.startsWith('.') && !base.slice(1).includes('.') ? base.slice(1) : base.replace(/\.[^./]+$/, '')
  const raw = [...segments, stem].join('-').toLowerCase()
  const slug = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return slug === '' ? 'node' : slug
}
