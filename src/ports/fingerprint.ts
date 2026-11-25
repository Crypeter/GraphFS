import type { Node, Unit } from '../types.ts'

export interface Fingerprint {
  hash: string
  size: number
  unit: Unit
}

export interface FingerprintSource {
  read(node: Node, signal?: AbortSignal): Promise<Fingerprint | null>
}
