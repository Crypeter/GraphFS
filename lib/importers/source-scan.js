/** 源码结构扫描：抽顶层符号与工作区内 import。pack 与 suggest 共用，避免环形依赖。 */

/** 从文件内容里抽顶层符号（按语言选规则；抽不到就空数组）。 */
export function extractSymbols(path        , text        , max = 8)           {
  const out           = []
  const isDoc = /\.(md|markdown|rst)$/i.test(path)

  for (const line of text.split('\n')) {
    if (out.length >= max) break

    if (isDoc) {
      const heading = /^#{1,3}\s+(.+)$/.exec(line)
      if (heading) out.push(heading[1] .trim())
      continue
    }

    // 注释行一律跳过——否则 Python 的 `# Load CM scores` 会被当成标题。
    if (/^\s*(#|\/\/)/.test(line)) continue

    const py = /^(?:class|def|async def)\s+([A-Za-z_]\w*)/.exec(line)
    if (py) {
      out.push(py[1] )
      continue
    }
    const ts = /^export\s+(?:default\s+)?(?:class|function|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(line)
    if (ts) out.push(ts[1] )
  }
  return out
}

/** 抽 import：只保留能在工作区内解析到的目标。 */
export function extractImports(path        , text        , files             )           {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const out = new Set        ()

  const resolve = (raw        )                => {
    const target = raw.startsWith('.') ? joinPosix(dir, raw) : raw.replace(/^\/+/, '')
    for (const candidate of [target, `${target}.py`, `${target}.ts`, `${target}.js`, `${target}/__init__.py`, `${target}/index.ts`]) {
      if (files.has(candidate)) return candidate
    }
    return null
  }

  for (const line of text.split('\n')) {
    if (line.length > 300) continue
    const from = /^\s*from\s+([.\w/]+)\s+import\b/.exec(line)
    if (from && path.endsWith('.py')) {
      const dots = /^\.+/.exec(from[1] )?.[0].length ?? 0
      const rest = from[1] .slice(dots).replace(/\./g, '/')
      const base = dots > 0 ? joinPosix(dir, '../'.repeat(dots - 1)) : dir
      const resolved = base === '' ? resolve(rest) : resolve(`${base}/${rest}`)
      if (resolved) out.add(resolved)
      continue
    }
    const ts = /(?:from\s+|import\s*\()['"](\.[^'"]+)['"]/.exec(line)
    if (ts) {
      const resolved = resolve(ts[1] )
      if (resolved) out.add(resolved)
    }
  }
  return [...out]
}

function joinPosix(dir        , rel        )         {
  const parts = (dir === '' ? [] : dir.split('/')).concat(rel.split('/'))
  const stack           = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return stack.join('/')
}



//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/importers/source-scan.ts