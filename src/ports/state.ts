import type { RuntimeState } from '../types.ts'

export interface StateStore {
  load(key: string): Promise<RuntimeState>
  save(key: string, state: RuntimeState): Promise<void>
}

export function emptyState(): RuntimeState {
  return { version: 1, dirty: [], obligations: [], round: null, oscillation: {} }
}
