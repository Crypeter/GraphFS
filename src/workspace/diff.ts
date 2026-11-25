/**
 * 最小 unified diff（LCS），只为「写回前给人看」。
 * 超过 MAX_LINES 就退化成摘要——diff 不该成为新的 token 黑洞。
 */

const MAX_LINES = 400

export interface DiffSummary {
  path: string
  added: number
  removed: number
  text: string
  truncated: boolean
}

export function unifiedDiff(path: string, before: string, after: string): DiffSummary {
  const a = before.split('\n')
  const b = after.split('\n')

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return {
      path,
      added: Math.max(0, b.length - a.length),
      removed: Math.max(0, a.length - b.length),
      text: `(文件太大，只报行数变化：${a.length} → ${b.length} 行)`,
      truncated: true,
    }
  }

  const lcs = longestCommonSubsequence(a, b)
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`]
  let added = 0
  let removed = 0
  let i = 0
  let j = 0

  for (const [ai, bi] of lcs) {
    while (i < ai) {
      lines.push(`-${a[i]}`)
      removed += 1
      i += 1
    }
    while (j < bi) {
      lines.push(`+${b[j]}`)
      added += 1
      j += 1
    }
    lines.push(` ${a[ai]}`)
    i = ai + 1
    j = bi + 1
  }
  while (i < a.length) {
    lines.push(`-${a[i]}`)
    removed += 1
    i += 1
  }
  while (j < b.length) {
    lines.push(`+${b[j]}`)
    added += 1
    j += 1
  }

  return { path, added, removed, text: lines.join('\n'), truncated: false }
}

/** 返回匹配对（a 下标, b 下标）；O(n*m) 内存，所以调用方先做行数上限。 */
function longestCommonSubsequence(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length
  const m = b.length
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }

  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1
    else j += 1
  }
  return pairs
}
