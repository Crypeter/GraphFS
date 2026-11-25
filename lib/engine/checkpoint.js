                                                 
                                              
                                                  
                                                   
import { emptyState } from '../ports/state.js'
import { transition } from '../core/obligation.js'
                                                                 

                           
                     
                                                   
                                                   
                                            
                                                                                                       

                                 
                   
                  
              
             
 

/**
 * 检查点（插件里叫"回合"）：把「规划结果」收敛成四种终态，并把状态落盘。
 *
 * G0/G1 在 plan 与 obligationId 里已经实现；这里负责 G3（进度必须下降）、
 * G4（预算）与 G5（震荡/无进展升级）。
 */
export class Checkpoint {
                   config               
                   deps                
          state               = emptyState()

  constructor(config               , deps                ) {
    this.config = config
    this.deps = deps
  }

  async beginTurn(turnId        )                {
    this.state = await this.deps.state.load(this.deps.key)
    if (this.state.round?.turnId !== turnId) {
      this.state = { ...this.state, round: { turnId, count: 0 } }
    }
    this.pruneExpired()
  }

  /** 决策：纯判定，不写文件（`finish` 才落盘）。 */
  decide(plan      )                {
    if (plan.obligations.length === 0) {
      return plan.stalenessBefore === 0 ? { kind: 'clean' } : { kind: 'deferred', obligations: [] }
    }

    const round = this.state.round
    if (round && round.count >= this.config.maxRounds) {
      return { kind: 'exhausted', remaining: plan.obligations.length }
    }

    if (this.oscillating()) {
      return { kind: 'escalate', reason: 'oscillation', obligations: plan.obligations }
    }

    const previous = round?.lastStaleness
    if (previous !== undefined && plan.stalenessBefore >= previous) {
      return { kind: 'escalate', reason: 'no-progress', obligations: plan.obligations }
    }

    return { kind: 'dispatch', obligations: plan.obligations.slice(0, this.config.maxObligations) }
  }

  /** 落盘：合并义务、推进轮次、记录本轮 staleness。 */
  async finish(decision               , stalenessAfter        )                {
    const now = this.deps.clock.now()
    const byId = new Map(this.state.obligations.map((o) => [o.id, o]))

    if (decision.kind === 'dispatch') {
      for (const obligation of decision.obligations) {
        byId.set(obligation.id, obligation)
        await this.deps.journal.append({
          at: now,
          kind: 'dispatch',
          edgeId: obligation.edgeId,
          node: obligation.target,
          detail: obligation.kind,
        })
      }
    }
    if (decision.kind === 'deferred') {
      for (const obligation of decision.obligations) {
        const deferred = transition(obligation, { type: 'defer', until: expiresAt(now) })
        byId.set(deferred.id, deferred)
      }
    }

    this.state = {
      ...this.state,
      obligations: [...byId.values()],
      round: this.state.round
        ? { ...this.state.round, count: this.state.round.count + 1, lastStaleness: stalenessAfter }
        : { turnId: 'adhoc', count: 1, lastStaleness: stalenessAfter },
    }
    await this.deps.state.save(this.deps.key, this.state)
  }

          oscillating()          {
    for (const history of Object.values(this.state.oscillation)) {
      if (history.length < 4) continue
      const tail = history.slice(-4)
      if (new Set(tail).size < tail.length) return true
    }
    return false
  }

          pruneExpired()       {
    const now = Date.parse(this.deps.clock.now())
    const kept = this.state.obligations.filter((o) => {
      if (o.status !== 'deferred') return true
      const until = o.expiresAt ? Date.parse(o.expiresAt) : Number.POSITIVE_INFINITY
      return until > now
    })
    if (kept.length !== this.state.obligations.length) {
      this.state = { ...this.state, obligations: kept }
    }
  }
}

function expiresAt(now        )         {
  const t = Date.parse(now) + 7 * 24 * 3600 * 1000
  return new Date(t).toISOString()
}


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/engine/checkpoint.ts