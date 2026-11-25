import type { Arc } from '../types.ts'

/**
 * 环检测与连通分量。**只接受有效弧表**（G_t），调用方负责先过滤（如只留 required 边）。
 * 在存储图 G 上跑会把「一条单向边 + 它的反向边」误判成环（Intent §3.2）。
 */

/** 迭代版 Tarjan：避免深链把调用栈打爆（真实仓库里 5k 节点可能连成一条链）。 */
export function stronglyConnected(nodes: string[], outArcs: Map<string, Arc[]>): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0

  for (const start of nodes) {
    if (index.has(start)) continue

    const work: Array<{ v: string; i: number }> = [{ v: start, i: 0 }]
    index.set(start, counter)
    low.set(start, counter)
    counter += 1
    stack.push(start)
    onStack.add(start)

    while (work.length > 0) {
      const frame = work[work.length - 1]!
      const arcs = outArcs.get(frame.v) ?? []

      if (frame.i < arcs.length) {
        const w = arcs[frame.i]!.target
        frame.i += 1
        if (!index.has(w)) {
          index.set(w, counter)
          low.set(w, counter)
          counter += 1
          stack.push(w)
          onStack.add(w)
          work.push({ v: w, i: 0 })
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!))
        }
        continue
      }

      work.pop()
      if (work.length > 0) {
        const parent = work[work.length - 1]!
        low.set(parent.v, Math.min(low.get(parent.v)!, low.get(frame.v)!))
      }
      if (low.get(frame.v) === index.get(frame.v)) {
        const comp: string[] = []
        for (;;) {
          const w = stack.pop()!
          onStack.delete(w)
          comp.push(w)
          if (w === frame.v) break
        }
        components.push(comp)
      }
    }
  }

  return components
}

/**
 * 返回一条具体环路径（首尾同节点），用于错误信息；无环返回 null。
 * 迭代 DFS + 栈内回边检测，复杂度 O(V+E)。
 */
export function findCycle(nodes: string[], outArcs: Map<string, Arc[]>): string[] | null {
  const state = new Map<string, 0 | 1 | 2>() // 0 未访问 / 1 在栈上 / 2 已完成
  const parent = new Map<string, string>()

  for (const start of nodes) {
    if ((state.get(start) ?? 0) !== 0) continue

    const work: Array<{ v: string; i: number }> = [{ v: start, i: 0 }]
    state.set(start, 1)

    while (work.length > 0) {
      const frame = work[work.length - 1]!
      const arcs = outArcs.get(frame.v) ?? []

      if (frame.i < arcs.length) {
        const w = arcs[frame.i]!.target
        frame.i += 1
        const s = state.get(w) ?? 0
        if (s === 1) {
          const cycle = [frame.v]
          let cur = frame.v
          while (cur !== w) {
            const p = parent.get(cur)
            if (p === undefined) break
            cur = p
            cycle.push(cur)
          }
          cycle.reverse()
          cycle.push(w)
          return cycle
        }
        if (s === 0) {
          parent.set(w, frame.v)
          state.set(w, 1)
          work.push({ v: w, i: 0 })
        }
        continue
      }

      state.set(frame.v, 2)
      work.pop()
    }
  }

  return null
}
