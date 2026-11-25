import type { Context } from '@deepseek-ai/cordis'
import type { GraphFS } from '../workspace/graphfs.ts'
import type { RootRegistry } from '../runtime/roots.ts'
import type { GraphFSConfig } from '../config.ts'
import type { Edge } from '../types.ts'
import { GraphFSError } from '../types.ts'

/**
 * 模型侧工具。全部是薄壳：参数校验 + 转调门面 + 有界渲染。
 *
 * 不 import `@deepseek-ai/dsh-tools`：`ctx.tools.register()` 只要求普通定义对象，
 * 自己拼 JSON Schema 就能做到**零运行时依赖**，安装时没有任何 registry 解析风险。
 */

const text = (value: string) => [{ type: 'text' as const, text: value }]

interface PropertySpec {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  description?: string
  items?: PropertySpec
  properties?: Record<string, PropertySpec>
  required?: string[]
  additionalProperties?: boolean
}

function params(properties: Record<string, PropertySpec>, required: string[] = []) {
  return {
    type: 'object' as const,
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

interface ToolDefinition<T> {
  name: string
  description: string
  parameters: ReturnType<typeof params>
  render: (value: T) => Array<{ type: 'text'; text: string }>
  execute: (args: any, exec: { signal?: AbortSignal }) => Promise<T>
}

function tool<T>(definition: ToolDefinition<T>) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: {
      schema: { type: 'object' as const },
      render: (_args: unknown, value: T) => definition.render(value),
    },
    execute: definition.execute,
  }
}

export interface AskProbe {
  interactive: boolean
  lastAskError?: string
}

export function registerTools(
  ctx: Context,
  roots: RootRegistry,
  config: GraphFSConfig,
  probe?: () => AskProbe,
): void {

  /** 每次调用都从执行上下文解析工作区——同一进程可能同时在服务多个项目。 */
  const gfsFor = (exec: { agent?: unknown; signal?: AbortSignal }): Promise<GraphFS> =>
    roots.forAgent(exec.agent, exec.signal)

  ctx.tools.register(
    tool({
      name: 'graphfs_init',
      description:
        '为当前工作区建立一致性图，并**自动发现/采纳高置信关系**（import、#include、译文、同名测试/实现）。' +
        '只在用户明确同意后调用：没有图时插件会在回合结束时先询问用户，不要抢先初始化。',
      parameters: params({ force: { type: 'boolean', description: '覆盖已存在的图' } }),
      render: (v: { path: string; nodes: number; edges: number }) =>
        text(`initialized ${v.path} (${v.nodes} nodes, ${v.edges} edges)`),
      async execute(args: { force?: boolean }, exec: { agent?: unknown; signal?: AbortSignal }) {
        const gfs = await gfsFor(exec)
        const result = await gfs.bootstrap({ force: args.force })
        return {
          path: result.path,
          nodes: result.nodes,
          edges: result.totalEdges,
          added: result.linked,
          candidates: result.candidates,
          next:
            result.linked > 0
              ? '用 graphfs_check 查看一致性；需要更多语义关系再调用 graphfs_suggest'
              : '调用 graphfs_suggest 发现候选边',
        }
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'graphfs_suggest',
      description:
        '发现候选一致性边（import、#include、Go/Rust/Java import、Markdown 链接、@generated、同名译文/测试）。默认只提「未覆盖的文件」，只返回候选不落盘；apply: true 才采纳。',
      parameters: params({
        all: { type: 'boolean', description: '全量重扫（默认增量）' },
        apply: { type: 'boolean', description: '直接采纳置信度 ≥ min_confidence 的候选' },
        min_confidence: { type: 'number', description: '采纳阈值，默认 0.7' },
      }),
      render: (v: { rendered: string; linked?: number }) =>
        text(v.linked === undefined ? v.rendered : `已采纳 ${v.linked} 条关系\n${v.rendered}`),
      async execute(args: { all?: boolean; apply?: boolean; min_confidence?: number }, exec: { agent?: unknown; signal?: AbortSignal }) {
        const gfs = await gfsFor(exec)
        const candidates = await gfs.suggest({ all: args.all })
        if (!args.apply) {
          return { count: candidates.length, candidates: candidates.slice(0, 20), rendered: renderCandidates(candidates) }
        }
        const min = args.min_confidence ?? 0.7
        const applied = await gfs.applySuggestions(candidates, { minConfidence: min })
        return {
          count: candidates.length,
          linked: applied.linked.length,
          skipped: applied.skipped.length,
          candidates: applied.linked.slice(0, 20),
          rendered: renderCandidates(candidates),
        }
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'graphfs_create',
      description:
        '新建文件并同时声明它的一致性关系。必须给出 links 或 unmanaged 之一，否则拒绝——临时文件请直接用 write。',
      parameters: params(
        {
          path: { type: 'string', description: '工作区相对路径' },
          content: { type: 'string', description: '文件内容' },
          links: {
            type: 'array',
            description: '与其他文件的关系',
            items: {
              type: 'object',
              properties: {
                to: { type: 'string', description: '目标节点 id 或路径' },
                relation: {
                  type: 'string',
                  description: 'mirror|translates|generates|documents|constrains|related',
                },
                as: { type: 'string', description: 'from|to（默认 to：新文件是被影响方）' },
              },
              required: ['to'],
              additionalProperties: false,
            },
          },
          unmanaged: { type: 'boolean', description: '确实不需要一致性时置 true' },
        },
        ['path', 'content'],
      ),
      render: (v: { nodeId: string }) => text(`Created ${v.nodeId}`),
      async execute(
        args: {
          path: string
          content: string
          links?: Array<{ to: string; relation?: string; as?: string }>
          unmanaged?: boolean
        },
        exec: { agent?: unknown; signal?: AbortSignal },
      ) {
        const gfs = await gfsFor(exec)
        const result = await gfs.create(args.path, args.content, {
          links: args.links?.map((l) => ({ to: l.to, relation: l.relation as Edge['relation'], as: l.as as 'from' | 'to' | undefined })),
          unmanaged: args.unmanaged,
        })
        return { nodeId: result.nodeId, edges: result.edges.map((e) => e.id) }
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'graphfs_attach',
      description: '给已经存在的文件补声明关系（用 write 建的文件走这里），或声明 unmanaged。',
      parameters: params(
        {
          path: { type: 'string', description: '工作区相对路径' },
          to: { type: 'array', items: { type: 'string' }, description: '目标节点 id 或路径' },
          relation: { type: 'string' },
          as: { type: 'string', description: 'from|to（默认 to）' },
          unmanaged: { type: 'boolean' },
        },
        ['path'],
      ),
      render: (v: { nodeId?: string; unmanaged: boolean }) =>
        text(v.unmanaged ? 'declared unmanaged' : `Attached ${v.nodeId}`),
      async execute(
        args: { path: string; to?: string[]; relation?: string; as?: string; unmanaged?: boolean },
        exec: { agent?: unknown; signal?: AbortSignal },
      ) {
        const gfs = await gfsFor(exec)
        const result = await gfs.attach(args.path, {
          to: args.to,
          relation: args.relation as Edge['relation'],
          as: args.as as 'from' | 'to' | undefined,
          unmanaged: args.unmanaged,
        })
        return { nodeId: result.nodeId, edges: result.edges.map((e) => e.id), unmanaged: result.unmanaged }
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'graphfs_check',
      description: '只读校验：返回漂移、冲突、缺失与未声明关系的文件。不修改任何文件。',
      parameters: params({}),
      render: (v: Parameters<typeof renderCheck>[0]) => text(renderCheck(v)),
      async execute(_args: unknown, exec: { agent?: unknown; signal?: AbortSignal }) {
        return await (await gfsFor(exec)).check()
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'graphfs_status',
      description: '图概览：节点/边/漂移/孤儿，以及交互式提问是否可用（排查"为什么没弹框"）。',
      parameters: params({}),
      render: (v: unknown) => text(JSON.stringify(v, null, 2)),
      async execute(_args: unknown, exec: { agent?: unknown; signal?: AbortSignal }) {
        const gfs = await gfsFor(exec)
        const diagnostics = probe?.() ?? { interactive: false }
        if (!gfs.snapshot) {
          return {
            root: gfs.config.root,
            graphPath: gfs.config.graphPath,
            hasGraph: false,
            interactive: diagnostics.interactive,
            lastAskError: diagnostics.lastAskError ?? null,
            autoInit: config.autoInit,
            askOnChange: config.askOnChange,
          }
        }
        const status = gfs.status()
        const report = await gfs.check()
        return {
          ...status,
          hasGraph: true,
          orphans: report.orphans.length,
          unlinked: report.unlinked.length,
          interactive: diagnostics.interactive,
          lastAskError: diagnostics.lastAskError ?? null,
          autoInit: config.autoInit,
          askOnChange: config.askOnChange,
        }
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'graphfs_apply',
      description:
        '对确定性边（policy: auto + producer）重新生成产物。默认 dry_run：真的跑命令、返回 diff、然后恢复原状。写盘需要 dry_run: false。',
      parameters: params({
        dry_run: { type: 'boolean', description: '默认 true' },
        edge_id: { type: 'string', description: '只处理某条边' },
      }),
      render: (v: ApplyView) => text(renderApply(v)),
      async execute(args: { dry_run?: boolean; edge_id?: string }, exec: { agent?: unknown; signal?: AbortSignal }) {
        const gfs = await gfsFor(exec)
        const plan = await gfs.plan()
        const report = await gfs.apply(plan, {
          dryRun: args.dry_run ?? true,
          only: args.edge_id ? [args.edge_id] : undefined,
        })
        return {
          dryRun: report.dryRun,
          outcomes: report.outcomes.map((o) => ({
            edgeId: o.edgeId,
            target: o.target,
            status: o.status,
            reason: o.reason,
            outputs: o.outputs.map((x) => ({ path: x.path, added: x.diff.added, removed: x.diff.removed })),
          })),
        }
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'graphfs_ack',
      description: '认可一次漂移（用当前指纹重录基线）。必须说明理由。',
      parameters: params(
        {
          edge_id: { type: 'string' },
          reason: { type: 'string', description: '为什么这次不同步是合理的' },
        },
        ['edge_id', 'reason'],
      ),
      render: (v: { id: string }) => text(`Acked ${v.id}`),
      async execute(args: { edge_id: string; reason: string }, exec: { agent?: unknown; signal?: AbortSignal }) {
        const gfs = await gfsFor(exec)
        const edge = await gfs.ack(args.edge_id, args.reason)
        return { id: edge.id, from: edge.from, to: edge.to, baseline: [edge.fromHash, edge.toHash] }
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'graphfs_link',
      description:
        '建一条一致性边（用当前指纹作基线）。边类型决定默认的权威/触发/义务；确定性边再加 policy: auto 与 producer。',
      parameters: params(
        {
          from: { type: 'string', description: '起点节点 id 或路径（存储方向，不等于传播方向）' },
          to: { type: 'string', description: '终点节点 id 或路径' },
          relation: {
            type: 'string',
            description: 'mirror|translates|generates|documents|constrains|related',
          },
          authority: { type: 'string', description: 'from|to|none（权威端永不被覆盖）' },
          trigger: { type: 'string', description: 'from|to|both|none' },
          counterpart: { type: 'string', description: 'absorb|confirm|ignore' },
          obligation: { type: 'string', description: 'required|advisory|silent' },
          policy: { type: 'string', description: 'auto|advise' },
          command: { type: 'string', description: 'policy=auto 时的 shell 命令（cwd = 工作区根）' },
          outputs: { type: 'array', items: { type: 'string' }, description: 'producer 的产物路径' },
        },
        ['from', 'to', 'relation'],
      ),
      render: (v: { id: string; from: string; to: string; relation: string }) =>
        text(`Linked ${v.id}: ${v.from} → ${v.to} [${v.relation}]`),
      async execute(
        args: {
          from: string
          to: string
          relation: string
          authority?: string
          trigger?: string
          counterpart?: string
          obligation?: string
          policy?: string
          command?: string
          outputs?: string[]
        },
        exec: { agent?: unknown; signal?: AbortSignal },
      ) {
        if (args.command && (!args.outputs || args.outputs.length === 0)) {
          throw new GraphFSError('command requires outputs: [paths]', 'GF_GRAPH_INVALID')
        }
        const gfs = await gfsFor(exec)
        const edge = await gfs.link({
          from: args.from,
          to: args.to,
          relation: args.relation as Edge['relation'],
          authority: args.authority as Edge['authority'],
          trigger: args.trigger as Edge['trigger'],
          counterpart: args.counterpart as Edge['counterpart'],
          obligation: args.obligation as Edge['obligation'],
          policy: args.policy as Edge['policy'],
          producer: args.command
            ? { kind: 'shell', command: args.command, outputs: args.outputs ?? [] }
            : undefined,
        })
        return {
          id: edge.id,
          from: edge.from,
          to: edge.to,
          relation: edge.relation,
          baseline: [edge.fromHash, edge.toHash],
        }
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'graphfs_journal',
      description: '审计日志：最近的 init/link/attach/ack/apply/import 记录（谁、何时、为什么）。',
      parameters: params({ limit: { type: 'number', description: '条数，默认 20，最多 200' } }),
      render: (v: { entries: Array<Record<string, unknown>> }) => text(renderJournal(v.entries)),
      async execute(args: { limit?: number }, exec: { agent?: unknown; signal?: AbortSignal }) {
        const gfs = await gfsFor(exec)
        const limit = Math.min(Math.max(args.limit ?? 20, 1), 200)
        const entries = await gfs.auditTail(limit)
        return { count: entries.length, entries: entries as unknown as Array<Record<string, unknown>> }
      },
    }),
  )
}

function renderJournal(entries: Array<Record<string, unknown>>): string {
  if (entries.length === 0) return '审计日志为空'
  return entries
    .map((entry) => {
      const at = String(entry.at ?? '').replace('T', ' ').replace(/\..*$/, '')
      const kind = String(entry.kind ?? '?')
      const actor = entry.actor ? ` by ${String(entry.actor)}` : ''
      const target = entry.edgeId ? ` ${String(entry.edgeId)}` : entry.node ? ` ${String(entry.node)}` : ''
      const detail = entry.detail ? ` ${JSON.stringify(entry.detail)}` : ''
      return `${at} [${kind}]${target}${actor}${detail}`
    })
    .join('\n')
}

interface ApplyView {
  dryRun: boolean
  outcomes: Array<{
    edgeId: string
    target: string
    status: string
    reason?: string
    outputs: Array<{ path: string; added: number; removed: number }>
  }>
}

function renderApply(report: ApplyView): string {
  if (report.outcomes.length === 0) return '没有可执行的确定性边'
  const lines = report.outcomes.map((o) => {
    const files = o.outputs.map((x) => `${x.path} (+${x.added}/-${x.removed})`).join(', ')
    return `${o.status}: ${o.target}${files ? ` — ${files}` : ''}${o.reason ? ` (${o.reason})` : ''}`
  })
  lines.push(report.dryRun ? '预览：未写盘。确认后调用 graphfs_apply({ dry_run: false })' : '已写盘')
  return lines.join('\n')
}

function renderCandidates(
  candidates: Array<{ fromPath: string; toPath: string; relation: string; confidence: number; evidence: string }>,
): string {
  if (candidates.length === 0) return '没有新的候选边（图可能已经覆盖了当前工作区）'
  const lines = candidates
    .slice(0, 20)
    .map((c) => `[${c.confidence.toFixed(2)}] ${c.relation}: ${c.fromPath} → ${c.toPath}（${c.evidence}）`)
  if (candidates.length > 20) lines.push(`…还有 ${candidates.length - 20} 条`)
  return lines.join('\n')
}

function renderCheck(report: {
  drift: unknown[]
  conflicts: unknown[]
  dangling: unknown[]
  orphans: string[]
  unlinked: string[]
  ok: boolean
}): string {
  const lines = [
    `drift ${report.drift.length} / conflicts ${report.conflicts.length} / dangling ${report.dangling.length}`,
  ]
  if (report.orphans.length > 0) {
    lines.push(`未声明关系的文件 ${report.orphans.length}: ${report.orphans.slice(0, 10).join(', ')}`)
    lines.push('用 graphfs_attach 声明关系，或 graphfs_attach(..., unmanaged: true)')
  }
  if (report.unlinked.length > 0) {
    lines.push(`孤立节点 ${report.unlinked.length}: ${report.unlinked.slice(0, 10).join(', ')}`)
  }
  lines.push(report.ok ? 'OK' : 'DRIFT')
  return lines.join('\n')
}
