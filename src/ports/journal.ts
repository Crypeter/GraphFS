export interface JournalEntry {
  at: string
  kind: string
  edgeId?: string
  node?: string
  detail?: unknown
}

export interface Journal {
  append(entry: JournalEntry): Promise<void>
  tail(n: number): Promise<JournalEntry[]>
}
