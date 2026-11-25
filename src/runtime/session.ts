import type { Obligation, Plan } from '../types.ts'

/**
 * 回合收口：把「规划结果」变成「要不要打断模型、说什么」。
 *
 * 纯函数，不碰宿主也不碰磁盘——所以能在没有 DSH 的情况下把对话策略测穷。
 * 与 engine/checkpoint 的分工：checkpoint 管状态与预算（要不要落盘、轮次+1），
 * 这里管**呈现**（说哪几句、说多长）。两者都读同一个 Plan。
 */

export interface DecideInput {
  plan: Plan
  /** 本回合已经 steer 过几次（防乒乓：默认最多 1 次）。 */
  steeredThisTurn: number
  maxSteersPerTurn?: number
  /** 本会话累计轮次（用于预算）。 */
  roundsUsed: number
  maxRounds: number
  /** 把节点 id 换成人类可读路径（默认原样）。 */
  label?: (id: string) => string
  oscillating?: boolean
  lastStaleness?: number
}

export type TurnDecision =
  | { kind: 'clean' }
  | { kind: 'dispatch'; advice: string; obligations: Obligation[] }
  | { kind: 'exhausted'; remaining: number }
  | { kind: 'escalate'; reason: 'oscillation' | 'no-progress' | 'conflict'; advice: string }

const MAX_LINES = 5

/** 一句话说清「谁因为谁要改」，并且必须有可执行动作。 */
export function renderAdvice(
  plan: Plan,
  opts: { maxLines?: number; label?: (id: string) => string } = {},
): string {
  const maxLines = opts.maxLines ?? MAX_LINES
  const label = opts.label ?? ((id: string) => id)
  const lines: string[] = []
  const shown = plan.obligations.slice(0, maxLines)

  for (const obligation of shown) {
    if (obligation.detail) lines.push(`- ${obligation.detail}（${obligation.kind}）`)
    else lines.push(`- ${label(obligation.target)} ← ${label(obligation.cause)} 变了（${obligation.kind}）`)
  }

  const rest = plan.obligations.length - shown.length
  if (rest > 0) lines.push(`- 还有 ${rest} 条，用 graphfs_check 查看`)

  const header = `[graphfs] 本回合产生 ${plan.obligations.length} 条一致性义务：`
  const footer = '处理完再结束；确实不改就用 graphfs_ack 显式接受漂移。'
  return [header, ...lines, '', footer].join('\n')
}

export function decideTurn(input: DecideInput): TurnDecision {
  const { plan } = input
  const maxSteers = input.maxSteersPerTurn ?? 1

  if (plan.obligations.length === 0) return { kind: 'clean' }

  if (input.steeredThisTurn >= maxSteers) {
    return { kind: 'exhausted', remaining: plan.obligations.length }
  }

  if (input.roundsUsed >= input.maxRounds) {
    return { kind: 'exhausted', remaining: plan.obligations.length }
  }

  if (input.oscillating) {
    return {
      kind: 'escalate',
      reason: 'oscillation',
      advice: '[graphfs] 检测到反复修改同一节点，已停止继续派发。请人工确认后再继续。',
    }
  }

  const previous = input.lastStaleness
  if (previous !== undefined && plan.stalenessBefore >= previous) {
    return {
      kind: 'escalate',
      reason: 'no-progress',
      advice: '[graphfs] 上一轮没有减少任何失配，已停止派发，避免空转。',
    }
  }

  return { kind: 'dispatch', advice: renderAdvice(plan, { label: input.label }), obligations: plan.obligations }
}

/** 图不存在时的首次提示（每个会话只注入一次）。 */
export const INIT_HINT =
  '[graphfs] 本工作区还没有一致性图。先问用户是否现在建立（建议建立）：同意后调用 graphfs_init——它会扫描工作区并自动采纳 import / #include / 译文 / 同名测试等高置信关系；之后可用 graphfs_suggest 补语义边。'
