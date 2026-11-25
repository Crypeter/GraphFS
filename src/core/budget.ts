/**
 * 回合内配额（Intent §4.4 G4）。
 *
 * 注意：这是**兜底**，不是主手段——主手段是 G0（深度 1 才下发）与 G3（进度必须下降）。
 * 单边单回合最多 1 次、单节点最多 3 次，都是防「同一件事反复派发」的最低成本闸门。
 */

export type BudgetExhaustion = 'rounds' | 'obligations' | null

export interface BudgetLimits {
  rounds: number
  obligations: number
  /** 单节点每回合上限，默认 3。 */
  perNode?: number
}

export class Budget {
  readonly limits: Required<BudgetLimits>
  private roundsStarted = 0
  private dispatchedCount = 0
  private readonly perEdge = new Map<string, number>()
  private readonly perNode = new Map<string, number>()

  constructor(limits: BudgetLimits) {
    this.limits = {
      rounds: Math.max(1, limits.rounds),
      obligations: Math.max(1, limits.obligations),
      perNode: Math.max(1, limits.perNode ?? 3),
    }
  }

  get dispatched(): number {
    return this.dispatchedCount
  }

  /** 还有轮数空间吗；返回 true 即占用一轮（调用即生效，避免「检查-使用」之间再判断一次）。 */
  tryBeginRound(): boolean {
    if (this.roundsStarted >= this.limits.rounds) return false
    this.roundsStarted += 1
    return true
  }

  canDispatch(edgeId: string, nodeId: string): boolean {
    if (this.dispatchedCount >= this.limits.obligations) return false
    if ((this.perEdge.get(edgeId) ?? 0) >= 1) return false
    if ((this.perNode.get(nodeId) ?? 0) >= this.limits.perNode) return false
    return true
  }

  /** 必须在派发**之前**调用：失败也要占额度，防止重试风暴。 */
  consume(edgeId: string, nodeId: string): void {
    this.dispatchedCount += 1
    this.perEdge.set(edgeId, (this.perEdge.get(edgeId) ?? 0) + 1)
    this.perNode.set(nodeId, (this.perNode.get(nodeId) ?? 0) + 1)
  }

  get exhausted(): BudgetExhaustion {
    if (this.dispatchedCount >= this.limits.obligations) return 'obligations'
    if (this.roundsStarted >= this.limits.rounds) return 'rounds'
    return null
  }
}
