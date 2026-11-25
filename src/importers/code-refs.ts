import { posix } from 'node:path'

/**
 * 语言级的「引用」解析（M7）。
 *
 * 之前的 suggest 只看 Python import / TS import / Markdown 链接 / 译文对，
 * 在 C/C++、Go、Rust、Java 项目里基本提不出边——用户看到的就是"图里 0 条边"。
 *
 * 这里补的是**能从文本里逐字看到**的引用：
 *   - C/C++ `#include "x.h"` / `<x.h>`
 *   - Go `import "path"`
 *   - Rust `mod x;` / `use crate::a::b`
 *   - Java/Kotlin `import a.b.C`
 *   - Shell `source x` / `. x`
 *   - 头文件 ↔ 实现、实现 ↔ 同名测试
 *
 * 解析原则仍是"宁缺毋滥"：
 *   1. 先按相对路径/常见根目录直接命中；
 *   2. 否则按 basename 建索引，用**目录前缀重合度**选最近的那个；
 *   3. 有歧义（两个候选同样近）就不猜，直接放弃。
 */

export interface FileIndex {
  files: Set<string>
  byBasename: Map<string, string[]>
}

export function buildFileIndex(files: string[]): FileIndex {
  const index: FileIndex = { files: new Set(files), byBasename: new Map() }
  for (const file of files) {
    const base = file.slice(file.lastIndexOf('/') + 1)
    const list = index.byBasename.get(base)
    if (list) list.push(file)
    else index.byBasename.set(base, [file])
  }
  return index
}

/* ------------------------------------------------------------ C / C++ */

export interface Include {
  spec: string
  /** `"..."` 是本项目头文件；`<...>` 是系统/第三方，只在能解析到工作区文件时才用。 */
  quoted: boolean
}

export function parseIncludes(text: string): Include[] {
  const out: Include[] = []
  for (const line of text.split('\n')) {
    if (line.length > 400) continue
    const match = /^\s*#\s*include\s*([<"])([^>"]+)[>"]/.exec(line)
    if (match) out.push({ spec: match[2]!.trim(), quoted: match[1] === '"' })
  }
  return out
}

export function resolveInclude(dir: string, include: Include, index: FileIndex): string | null {
  const { spec } = include
  const direct = [
    posix.join(dir, spec),
    spec,
    posix.join('include', spec),
    posix.join('src', spec),
  ]
    .map((path) => posix.normalize(path).replace(/^\.\//, ''))
    .find((path) => index.files.has(path))
  if (direct) return direct

  return resolveBySuffix(dir, spec, index, include.quoted ? 1 : 0)
}

/* --------------------------------------------------------------- Go */

export function parseGoImports(text: string): string[] {
  const out: string[] = []
  let inBlock = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (inBlock) {
      if (trimmed.startsWith(')')) {
        inBlock = false
        continue
      }
      const quoted = /^["`]([^"`]+)["`]$/.exec(trimmed)
      if (quoted) out.push(quoted[1]!)
      continue
    }
    if (/^import\s*\($/.test(trimmed)) {
      inBlock = true
      continue
    }
    const single = /^import\s+(?:[\w.]+\s+)?["`]([^"`]+)["`]/.exec(trimmed)
    if (single) out.push(single[1]!)
  }
  return out
}

/** Go 的 import 指向目录：返回该目录下的源文件（最多 limit 个）。 */
export function resolveGoImport(dir: string, spec: string, index: FileIndex, limit = 3): string[] {
  const isGo = (file: string): boolean => file.endsWith('.go') && !file.endsWith('_test.go')

  if (spec.startsWith('.')) {
    const target = posix.normalize(posix.join(dir, spec)).replace(/^\.\//, '')
    return [...index.files].filter((file) => file.startsWith(`${target}/`) && isGo(file)).slice(0, limit)
  }

  // import 路径带模块域名（`example.com/x/pkg/foo`），工作区目录只保留尾巴；
  // 从最长的后缀开始试，命中即止。
  const parts = spec.split('/').filter(Boolean)
  for (let take = Math.min(parts.length, 4); take >= 1; take -= 1) {
    const suffix = parts.slice(-take).join('/')
    const hits = [...index.files].filter(
      (file) => isGo(file) && (file.startsWith(`${suffix}/`) || file.includes(`/${suffix}/`)),
    )
    if (hits.length === 0) continue

    // 同一个包目录里的多个 .go 文件共享一个分数；先按目录聚合，再选最近的目录。
    const byDir = new Map<string, number>()
    for (const file of hits) {
      const fileDir = file.slice(0, file.lastIndexOf('/'))
      const score = sharedPrefix(dir, file)
      if (!byDir.has(fileDir) || byDir.get(fileDir)! < score) byDir.set(fileDir, score)
    }
    const ranked = [...byDir.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const [bestDir, bestScore] = ranked[0]!
    if (ranked[1] && ranked[1][1] === bestScore) return [] // 两个目录一样近：不猜
    return [...index.files].filter((file) => file.startsWith(`${bestDir}/`) && isGo(file)).slice(0, limit)
  }
  return []
}

/* ------------------------------------------------------------- Rust */

export function parseRustRefs(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const mod = /^(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;/.exec(trimmed)
    if (mod) {
      out.push(mod[1]!)
      continue
    }
    const use = /^use\s+([^;]+);/.exec(trimmed)
    if (use) {
      const path = use[1]!.split('::{')[0]!.trim()
      if (!path.startsWith('std::') && !path.startsWith('core::') && !path.startsWith('alloc::')) {
        out.push(path)
      }
    }
  }
  return out
}

export function resolveRustRef(dir: string, spec: string, index: FileIndex): string | null {
  const segments = spec.split('::').filter(Boolean)
  if (segments[0] === 'crate' || segments[0] === 'self') segments.shift()
  else if (segments[0] === 'super') {
    segments.shift()
    return resolveRustPath(posix.join(dir, '..'), segments, index)
  }
  return resolveRustPath(dir, segments, index)
}

function resolveRustPath(base: string, segments: string[], index: FileIndex): string | null {
  const attempts: string[][] = []
  if (segments.length > 0) {
    attempts.push(segments)
    attempts.push(segments.slice(0, -1))
  }
  for (const parts of attempts) {
    if (parts.length === 0) continue
    const joined = parts.join('/')
    for (const root of ['', 'src/']) {
      const stem = posix.normalize(`${root}${joined}`).replace(/^\.\//, '')
      for (const candidate of [`${stem}.rs`, `${stem}/mod.rs`]) {
        if (index.files.has(candidate)) return candidate
        const relative = posix.normalize(posix.join(base, candidate)).replace(/^\.\//, '')
        if (index.files.has(relative)) return relative
      }
    }
  }
  return null
}

/* ------------------------------------------------------- Java / Kotlin */

export function parseJvmImports(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?\s*;?\s*$/.exec(line)
    if (match) out.push(match[1]!)
  }
  return out
}

const JVM_ROOTS = ['', 'src/main/java/', 'src/test/java/', 'src/main/kotlin/', 'src/test/kotlin/', 'app/src/main/java/']

export function resolveJvmImport(spec: string, index: FileIndex): string | null {
  const path = spec.replace(/\./g, '/')
  for (const root of JVM_ROOTS) {
    for (const ext of ['.java', '.kt']) {
      const candidate = `${root}${path}${ext}`
      if (index.files.has(candidate)) return candidate
    }
  }
  return null
}

/* ------------------------------------------------------------- Shell */

export function parseShellSources(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue
    const match = /^\s*(?:source|\.)\s+([^\s;|]+)/.exec(line)
    if (match) out.push(match[1]!)
  }
  return out
}

/* ------------------------------------------------------ 同源文件配对 */

const HEADER_SUFFIXES = /\.(h|hpp|hh)$/
const IMPL_SUFFIXES = ['c', 'cc', 'cpp', 'cxx']

export function headerImplPair(file: string, files: Set<string>): string | null {
  if (!HEADER_SUFFIXES.test(file)) return null
  const stem = file.replace(HEADER_SUFFIXES, '')
  for (const ext of IMPL_SUFFIXES) {
    const candidate = `${stem}.${ext}`
    if (files.has(candidate)) return candidate
  }
  return null
}

/** 实现 → 同名测试（用于提醒"改了实现，测试可能要跟着改"）。 */
export function testPair(file: string, files: Set<string>): string | null {
  const ts = /^(.*)\.([cm]?[jt]sx?)$/.exec(file)
  if (ts) {
    for (const suffix of ['.test', '.spec']) {
      const candidate = `${ts[1]}${suffix}.${ts[2]}`
      if (files.has(candidate)) return candidate
    }
  }
  if (file.endsWith('.go')) {
    const candidate = `${file.slice(0, -3)}_test.go`
    if (files.has(candidate)) return candidate
  }
  if (file.endsWith('.py')) {
    const stem = file.slice(0, -3)
    const dir = stem.includes('/') ? stem.slice(0, stem.lastIndexOf('/')) : '.'
    const base = stem.slice(stem.lastIndexOf('/') + 1)
    for (const candidate of [`${stem}_test.py`, dir === '.' ? `test_${base}.py` : `${dir}/test_${base}.py`]) {
      if (files.has(candidate)) return candidate
    }
  }
  if (file.endsWith('.java')) {
    const candidate = `${file.slice(0, -5)}Test.java`
    if (files.has(candidate)) return candidate
  }
  return null
}

/* -------------------------------------------------------------- 公共 */

function resolveBySuffix(dir: string, spec: string, index: FileIndex, minScore: number): string | null {
  const base = spec.slice(spec.lastIndexOf('/') + 1)
  const candidates = (index.byBasename.get(base) ?? []).filter(
    (file) => file === spec || file.endsWith(`/${spec}`),
  )
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]!

  const ranked = rankByProximity(dir, candidates)
  if (ranked.length < 2) return ranked[0]?.file ?? null
  const top = ranked[0]!
  if (top.score < minScore) return null
  if (ranked[1]!.score === top.score) return null
  return top.file
}

function rankByProximity(dir: string, files: string[]): Array<{ file: string; score: number }> {
  return files
    .map((file) => ({ file, score: sharedPrefix(dir, file) }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
}

/** 两个路径从根开始共有多少段目录。 */
function sharedPrefix(dir: string, file: string): number {
  const left = dir === '' || dir === '.' ? [] : dir.split('/')
  const right = file.split('/').slice(0, -1)
  let i = 0
  while (i < left.length && i < right.length && left[i] === right[i]) i += 1
  return i
}
