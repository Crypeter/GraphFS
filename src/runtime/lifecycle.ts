import type { GraphFSConfig } from '../config.ts'
import type { Detector } from '../engine/detector.ts'
import type { WorkspaceGraph } from '../workspace/graphfs.ts'
import type { RootRegistry } from './roots.ts'
import { decideTurn, INIT_HINT } from './session.ts'
import type { Plan } from '../types.ts'

/**
 * 回合生命周期接线：宿主只提供五个能力，其余全在这层之外。
 *
 * 这样写的好处：DSH 适配器（adapters/dsh-host.ts）只剩几十行映射，
 * 而「什么时候问用户、什么时候 steer、问什么」可以在没有 DSH 的情况下用假 Host 测穷。
 */
export interface TurnContext {
  turnId: string
  /** 执行这次回合的 agent（根目录从它解析）。 */
  agent?: unknown
  /** 回合取消信号：弹给用户的确认框要跟着它一起取消。 */
  signal?: AbortSignal
  /** 把一句话交回模型并保持回合开启。 */
  steer(text: string): void
  /** 只往上下文里塞一句话，不唤醒。 */
  inject(text: string): void
}

export interface AskRequest {
  agent?: unknown
  signal?: AbortSignal
  header?: string
  question: string
  options: string[]
}

export interface Host {
  onObserved(handler: (relPath: string, agent?: unknown) => void): () => void
  onTurnStopping(handler: (context: TurnContext) => Promise<void> | void): () => void
  /** 有交互式 answerer 时弹出选择框；没有就返回 null，调用方退回 steer/注入。 */
  ask?(request: AskRequest): Promise<string | null>
  log?(level: 'info' | 'warn', message: string): void
}

export interface LifecycleDeps {
  host: Host
  /** 按会话解析工作区（同一 profile 可能有多个工作区）。 */
  roots: RootRegistry
  detector: Detector
  config: GraphFSConfig
}

const ASK_YES = '是，同步修改（推荐）'
const ASK_NO = '不，只提醒'
const INIT_YES = '现在建立（推荐）'
const INIT_NO = '稍后'
const MAX_REMEMBERED_DRIFTS = 500

export function installLifecycle(deps: LifecycleDeps): () => void {
  const { host, roots, detector, config } = deps
  const gfsFor = async (agent?: unknown): Promise<WorkspaceGraph | null> => {
    try {
      return await roots.forAgent(agent)
    } catch {
      return null
    }
  }

  /** 每个工作区只自动初始化/提示一次。 */
  const bootstrapped = new Set<string>()
  /** 同一次漂移只问一次：key = obligation.id（内容哈希，内容再变就会重新问）。 */
  const asked = new Map<string, 'yes' | 'no'>()
  /** 非义务变更（counterpart/absorb）按"节点 + 当前指纹"去重，同一内容只问一次。 */
  const askedRelations = new Set<string>()

  // 回合内状态：`steered` 就是「这个回合已经打断过几次」，同时充当轮次计数。
  let currentTurn = ''
  let steered = 0
  let lastStaleness: number | undefined

  const offObserved = host.onObserved((rawPath, agent) => {
    void gfsFor(agent).then((gfs) => {
      if (!gfs) return
      const relPath = relativeToRoot(gfs.config.root, rawPath)
      if (relPath === null) return
      const ids = gfs.snapshot?.pathIndex.get(relPath)
      if (!ids) return
      for (const id of ids) detector.onObserved(id)
    })
  })

  const initialize = async (gfs: WorkspaceGraph, context: TurnContext): Promise<void> => {
    try {
      const result = await gfs.bootstrap()
      context.inject(
        `[graphfs] 已建立一致性图：${result.nodes} 个节点，自动采纳 ${result.linked} 条高置信关系` +
          `（import / #include / 译文 / 同名测试）。用 graphfs_status 查看，用 graphfs_suggest 补语义边。`,
      )
    } catch (error) {
      host.log?.('warn', `graphfs: 初始化失败：${error instanceof Error ? error.message : String(error)}`)
      context.inject(INIT_HINT)
    }
  }

  const handleNoGraph = async (gfs: WorkspaceGraph, context: TurnContext): Promise<void> => {
    if (config.autoInit === 'never') return

    const root = gfs.config.root
    if (config.autoInit === 'always') {
      if (bootstrapped.has(root)) return
      bootstrapped.add(root)
      await initialize(gfs, context)
      return
    }

    if (bootstrapped.has(root)) return
    bootstrapped.add(root)

    if (!host.ask) {
      // 没有插件级提问通道：steer 一句，让模型用原生 ask_user_question 问用户。
      // inject 不会唤醒回合，模型可能整轮都看不到它——这是"初始化提示不稳定"的原因之一。
      context.steer(INIT_HINT)
      return
    }

    const answer = await host.ask({
      agent: context.agent,
      signal: context.signal,
      header: 'GraphFS 一致性图',
      question:
        '检测到本工作区还没有一致性图。要现在建立吗？' +
        '（会扫描文本文件，并自动发现 import / #include / 译文 / 同名测试等关系）',
      options: [INIT_YES, INIT_NO],
    })

    if (answer === null) {
      // 插件提问通道不可用（headless/子 agent/服务缺失）：让模型用原生工具去问。
      context.steer(INIT_HINT)
      return
    }
    if (isYes(answer)) {
      await initialize(gfs, context)
    } else {
      // 用户拒绝：只记日志。不要 inject 一条"用户说…"的消息——
      // 那会伪装成用户发言，既误导模型，也曾因缺少 role 让整轮请求 422。
      host.log?.('info', 'graphfs: 用户暂不建立一致性图')
    }
  }

  const offTurn = host.onTurnStopping(async (context) => {
    const gfs = await gfsFor(context.agent)
    if (!gfs) return

    // 图可能在会话期间被 CLI/其它会话/用户创建或删除；每回合以磁盘为准，
    // 否则缓存的 snapshot 会让"没有图"或"已经有图"的判断一直停在旧状态。
    await gfs.reload().catch(() => undefined)

    // 图不存在：询问/自动初始化，或退回提示（Spec §8.4）。
    if (!gfs.snapshot) {
      await handleNoGraph(gfs, context)
      return
    }

    if (context.turnId !== currentTurn) {
      currentTurn = context.turnId
      steered = 0
      lastStaleness = undefined
    }

    // dirty 来自门面写入，suspects 来自宿主事件/监听——两类都只当「检查触发信号」，
    // 真正的判定由 plan 重新算指纹完成（所以这里不必区分）。
    const touched = [...detector.drainDirty(), ...detector.drainSuspects()]
    if (touched.length === 0) return

    // observe：只记录，不打断、不弹框（Intent §"observe 只检测"）。
    if (config.mode === 'observe') {
      host.log?.('info', `graphfs: observe ${touched.length} 个节点有变更（未启用提醒）`)
      return
    }

    const plan: Plan = await gfs.plan()
    const labelOf = (id: string): string => gfs.snapshot?.nodes.get(id)?.path ?? id

    // 没有任何义务，但改到的文件确实有边：仍然问一次"要不要一起看"。
    // 否则用户改的是非权威端（例如 .c、译文）时，插件会完全沉默。
    // 用 plan.changed 而不是 touched：读文件也会触发 fs/observed，但读不算变更。
    if (plan.obligations.length === 0) {
      if (!config.askOnChange || !host.ask) return
      const changed = plan.changed
      if (changed.length === 0) return
      const relationKey = changed
        .map((id) => `${id}:${plan.changedHashes[id] ?? ''}`)
        .sort()
        .join('|')
      if (askedRelations.has(relationKey)) return
      const related = relatedEdges(gfs, changed)
      if (related.length === 0) return

      const answer = await host.ask({
        agent: context.agent,
        signal: context.signal,
        header: 'GraphFS 一致性',
        question: relationQuestion(related, changed, labelOf),
        options: [ASK_YES, ASK_NO],
      })
      if (answer !== null) {
        rememberRelation(askedRelations, relationKey)
        if (isYes(answer)) {
          steered += 1
          lastStaleness = plan.stalenessBefore
          context.steer(relationAdvice(related, labelOf))
        } else {
          host.log?.('info', 'graphfs: 用户选择只提醒（非权威端变更）')
        }
      } else {
        steered += 1
        lastStaleness = plan.stalenessBefore
        context.steer(askUserFallback(relationAdvice(related, labelOf)))
      }
      return
    }
    const decision = decideTurn({
      plan,
      steeredThisTurn: steered,
      roundsUsed: steered,
      maxRounds: config.maxRounds,
      lastStaleness,
      label: labelOf,
    })

    switch (decision.kind) {
      case 'clean':
        return
      case 'exhausted':
        host.log?.('info', `graphfs: ${decision.remaining} 条义务未处理，留给下一回合`)
        return
      case 'escalate':
        host.log?.('warn', `graphfs: escalate(${decision.reason})`)
        context.inject(decision.advice)
        return
      case 'dispatch': {
        // 先问用户：同意 → 继续本回合让模型改；拒绝 → 只记录，不打扰。
        if (config.askOnChange && host.ask) {
          const key = decision.obligations[0]!.id
          const remembered = asked.get(key)
          if (remembered === 'no') return
          if (remembered === undefined) {
            const answer = await host.ask({
              agent: context.agent,
              signal: context.signal,
              header: 'GraphFS 一致性',
              question: askQuestion(plan, labelOf),
              options: [ASK_YES, ASK_NO],
            })
            if (answer !== null) {
              remember(asked, key, isYes(answer) ? 'yes' : 'no')
              if (!isYes(answer)) {
                host.log?.('info', 'graphfs: 用户选择只提醒，不再追问')
                return
              }
            }
            if (answer === null) {
              // 弹框不可用：让模型自己问，而不是只给出义务清单就结束。
              steered += 1
              lastStaleness = plan.stalenessBefore
              context.steer(askUserFallback(decision.advice))
              return
            }
          }
        }

        steered += 1
        lastStaleness = plan.stalenessBefore
        context.steer(decision.advice)
        return
      }
    }
  })

  return () => {
    offObserved()
    offTurn()
  }
}

/** 宿主给的可能是绝对路径（`fs/observed`），也可能是相对路径。 */
export function relativeToRoot(root: string, path: string): string | null {
  const cleanRoot = root.replace(/\/+$/, '')
  if (path === cleanRoot) return ''
  if (path.startsWith(`${cleanRoot}/`)) return path.slice(cleanRoot.length + 1)
  if (path.startsWith('/')) return null // 工作区外的绝对路径，忽略
  return path.replace(/^\.\//, '')
}

interface RelatedEdge {
  edgeId: string
  relation: string
  from: string
  to: string
}

function relatedEdges(gfs: WorkspaceGraph, touched: string[]): RelatedEdge[] {
  const graph = gfs.snapshot
  if (!graph) return []
  const ids = new Set(touched)
  const out: RelatedEdge[] = []
  for (const edge of graph.edges.values()) {
    if (!ids.has(edge.from) && !ids.has(edge.to)) continue
    out.push({ edgeId: edge.id, relation: edge.relation, from: edge.from, to: edge.to })
    if (out.length >= 5) break
  }
  return out
}

function relationLines(related: RelatedEdge[], label: (id: string) => string): string[] {
  return related.map((edge) => {
    const other = label(edge.from) === label(edge.to) ? edge.to : `${label(edge.from)} ↔ ${label(edge.to)}`
    return `· ${other}（${edge.relation}）`
  })
}

function relationQuestion(related: RelatedEdge[], touched: string[], label: (id: string) => string): string {
  return [
    `你修改了 ${touched.map(label).join('、')}。`,
    '与它相关的文件：',
    ...relationLines(related, label),
    '',
    '要我一并检查/修改这些文件吗？',
  ].join('\n')
}

function relationAdvice(related: RelatedEdge[], label: (id: string) => string): string {
  return [
    '[graphfs] 用户要求一并检查这些相关文件：',
    ...relationLines(related, label),
    '请确认它们是否也需要更新；不需要就说明原因，不要默默结束。',
  ].join('\n')
}

function askUserFallback(advice: string): string {
  return (
    advice +
    '\n\n[graphfs] 插件无法自动弹框（没有可用的 userQuestions 通道）。' +
    '请先用 ask_user_question 询问用户是否同步修改，再按回答处理。'
  )
}

function askQuestion(plan: Plan, label: (id: string) => string): string {
  const items = plan.obligations.slice(0, 3).map((o) => `${label(o.target)}（因为 ${label(o.cause)} 改了）`)
  const more = plan.obligations.length > 3 ? `等 ${plan.obligations.length} 个文件` : ''
  return [
    '这次改动与以下文件存在一致性关系，它们可能已经过期：',
    ...items.map((item) => `· ${item}`),
    ...(more ? [`· ${more}`] : []),
    '',
    '要我一并修改吗？',
  ].join('\n')
}

function isYes(answer: string): boolean {
  return /^(是|y|yes|好|可以|同步|现在|建立|要)/i.test(answer.trim())
}

function remember(map: Map<string, 'yes' | 'no'>, key: string, value: 'yes' | 'no'): void {
  if (map.size >= MAX_REMEMBERED_DRIFTS) map.clear()
  map.set(key, value)
}

function rememberRelation(set: Set<string>, key: string): void {
  if (set.size >= MAX_REMEMBERED_DRIFTS) set.clear()
  set.add(key)
}
