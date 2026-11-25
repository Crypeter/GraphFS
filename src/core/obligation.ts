import { digest16 } from './hash.ts'
import { gfError } from '../types.ts'
import type { Acceptance, Edge, Obligation, ObligationKind, ObligationStatus, Verdict } from '../types.ts'

/** 义务 id 由内容决定：同一因由重复规划得到同一 id，天然去重（Intent §4.4 G1）。 */
export function obligationId(edgeId: string, target: string, causeHash: string): string {
  return digest16(`${edgeId}|${target}|${causeHash}`)
}

export interface CreateObligationInput {
  edge: Edge
  target: string
  cause: string
  causeHash: string
  verdict: Verdict
  /** 目标端上次记录的指纹（用于完成判据的起点）。 */
  baseline: string
  /** ISO 时间；由调用方（clock）提供，避免这里依赖 Date.now。 */
  now: string
  /** 面向模型的额外说明（例如"派生物被直接改，应改源文件"）。 */
  detail?: string
}

function kindOf(edge: Edge, verdict: Verdict): ObligationKind {
  if (verdict.kind === 'conflict') return 'conflict'
  if (verdict.kind === 'dangling') return 'dangling'
  return edge.policy === 'auto' && edge.producer ? 'regenerate' : 'review'
}

function severityOf(edge: Edge, verdict: Verdict): Obligation['severity'] {
  if (verdict.kind === 'dangling') return edge.obligation === 'required' ? 'block' : 'warn'
  if (verdict.kind === 'conflict') return 'warn'
  return edge.obligation === 'required' ? 'warn' : 'info'
}

function acceptanceOf(edge: Edge, target: string, baseline: string): Acceptance {
  if (edge.verdict === 'mechanical' && edge.policy === 'auto') {
    // 期望值由 producer 产出决定，运行前留空。
    return { kind: 'mechanical', node: target, expected: '' }
  }
  return { kind: 'hash-changed', node: target, from: baseline }
}

export function createObligation(input: CreateObligationInput): Obligation {
  const { edge, target, cause, causeHash, verdict, baseline, now } = input
  return {
    id: obligationId(edge.id, target, causeHash),
    edgeId: edge.id,
    target,
    cause,
    causeHash,
    kind: kindOf(edge, verdict),
    severity: severityOf(edge, verdict),
    acceptance: acceptanceOf(edge, target, baseline),
    status: 'open',
    round: 0,
    createdAt: now,
    ...(input.detail ? { detail: input.detail } : {}),
  }
}

export type ObligationEvent =
  | { type: 'claim' }
  | { type: 'resolve' }
  | { type: 'defer'; until: string }
  | { type: 'ack'; reason: string }
  | { type: 'escalate'; reason: string }

const CLOSED: ReadonlySet<ObligationStatus> = new Set(['resolved', 'acked', 'escalated'])

export function isClosed(o: Obligation): boolean {
  return CLOSED.has(o.status)
}

/**
 * 义务状态机（GraphFS_Spec.md §4.9）：
 *
 *   open → claimed → resolved
 *        → deferred(until) → acked(reason) | escalated
 *   resolved / acked / escalated 为终态，不可再迁移。
 */
export function transition(o: Obligation, event: ObligationEvent): Obligation {
  if (isClosed(o)) {
    throw gfError('GF_STATE_INVALID', `obligation ${o.id} is already ${o.status}`, 'plan a fresh obligation instead')
  }

  switch (event.type) {
    case 'claim':
      if (o.status !== 'open') throw invalid(o, event.type)
      return { ...o, status: 'claimed' }

    case 'resolve':
      if (o.status !== 'open' && o.status !== 'claimed') throw invalid(o, event.type)
      return { ...o, status: 'resolved' }

    case 'defer':
      if (o.status !== 'open' && o.status !== 'claimed') throw invalid(o, event.type)
      return { ...o, status: 'deferred', expiresAt: event.until }

    case 'ack':
      if (o.status !== 'open' && o.status !== 'deferred') throw invalid(o, event.type)
      return { ...o, status: 'acked', detail: event.reason }

    case 'escalate':
      return { ...o, status: 'escalated', detail: event.reason }

    default: {
      const never: never = event
      throw new Error(`unknown event: ${JSON.stringify(never)}`)
    }
  }
}

function invalid(o: Obligation, type: string): Error {
  return gfError('GF_STATE_INVALID', `cannot ${type} obligation ${o.id} in state ${o.status}`)
}
