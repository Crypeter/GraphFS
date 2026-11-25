import { posix } from 'node:path'
import { idFor } from '../workspace/graphfs.js'
import { extractImports } from './source-scan.js'
import {
  buildFileIndex,
  headerImplPair,
  parseGoImports,
  parseIncludes,
  parseJvmImports,
  parseRustRefs,
  parseShellSources,
  resolveGoImport,
  resolveInclude,
  resolveJvmImport,
  resolveRustRef,
  testPair,
} from './code-refs.js'
                                                                                             

/**
 * 候选边发现：只**提议**，不自动写图。
 *
 * 四种来源（都是"能从文本里看出来"的硬证据）：
 *   1. `@generated from <path>`  → generates（产物由源生成）
 *   2. 同名译文 `<stem>.zh.md`    → translates（严格对应）
 *   3. 语言引用 → constrains（被引用方 → 引用方）
 *      Python import / TS import / C `#include` / Go import / Rust mod·use /
 *      Java·Kotlin import / Shell source
 *   4. Markdown 链接 `[t](./x.py)` → documents（代码 → 文档）
 *   5. 同名头文件 ↔ 实现、实现 ↔ 同名测试 → constrains
 *
 * 原则：宁缺毋滥。每条候选都必须能说出「证据」，且置信度可解释。
 */

                                                            

                            
              
            
                                 
                         
                                 
                  
                
                    
                    
                  
                       
                   
                           
                              
 

                               
                         
                 
                                               
 

const LANG_SUFFIXES = ['zh', 'cn', 'ja', 'de', 'fr', 'es', 'ru', 'ko']
const DOC_EXTS = ['.md', '.markdown', '.rst', '.txt']
const MAX_SCAN_BYTES = 256 * 1024

export async function suggestEdges(input              )                       {
  const fileSet = new Set(input.files)
  const index = buildFileIndex(input.files)
  const out = new Map                   ()

  const add = (candidate           )       => {
    const key = `${candidate.from}|${candidate.to}|${candidate.relation}`
    const existing = out.get(key)
    if (!existing || existing.confidence < candidate.confidence) out.set(key, candidate)
  }

  for (const file of input.files) {
    const self = idFor(file)

    // 同源文件配对只看文件名，不需要读内容。
    const impl = headerImplPair(file, fileSet)
    if (impl) {
      add({
        from: self,
        to: idFor(impl),
        source: 'heuristic',
        fromPath: file,
        toPath: impl,
        relation: 'constrains',
        confidence: 0.9,
        evidence: `头文件 ${file} 与实现 ${impl} 同名`,
        authority: 'from',
        trigger: 'from',
        counterpart: 'absorb',
        obligation: 'advisory',
      })
    }

    const test = testPair(file, fileSet)
    if (test) {
      add({
        from: self,
        to: idFor(test),
        source: 'heuristic',
        fromPath: file,
        toPath: test,
        relation: 'constrains',
        confidence: 0.9,
        evidence: `实现 ${file} 有同名测试 ${test}`,
        authority: 'from',
        trigger: 'from',
        counterpart: 'absorb',
        obligation: 'advisory',
      })
    }

    if (!isTextSource(file)) continue
    const text = await input.read(file)
    if (text === null || text.length > MAX_SCAN_BYTES) continue

    const dir = posix.dirname(file)

    if (file.endsWith('.py')) {
      for (const spec of parsePythonImports(text)) {
        const target = resolvePythonModule(dir, spec, fileSet)
        if (!target || target === file) continue
        add({
          from: idFor(target),
          to: self,
          source: 'heuristic',
          fromPath: target,
          toPath: file,
          relation: 'constrains',
          confidence: 0.8,
          evidence: `import ${spec.raw}`,
          // 模块是权威侧：改模块要求改使用方；改使用方不要求动模块。
          authority: 'from',
          trigger: 'from',
          counterpart: 'absorb',
          obligation: 'advisory',
        })
      }
    }

    if (/\.(ts|tsx|js|mjs|cjs)$/.test(file)) {
      for (const target of extractImports(file, text, fileSet)) {
        if (target === file) continue
        add({
          from: idFor(target),
          to: self,
          source: 'heuristic',
          fromPath: target,
          toPath: file,
          relation: 'constrains',
          confidence: 0.8,
          evidence: `import ${target}`,
          authority: 'from',
          trigger: 'from',
          counterpart: 'absorb',
          obligation: 'advisory',
        })
      }
    }

    if (/\.(c|cc|cpp|cxx|h|hpp|hh|S|s|asm|inc)$/.test(file)) {
      for (const include of parseIncludes(text)) {
        const target = resolveInclude(dir, include, index)
        if (!target || target === file) continue
        add({
          from: idFor(target),
          to: self,
          source: 'heuristic',
          fromPath: target,
          toPath: file,
          relation: 'constrains',
          confidence: include.quoted ? 0.85 : 0.7,
          evidence: `#include ${include.quoted ? '"' : '<'}${include.spec}${include.quoted ? '"' : '>'}`,
          authority: 'from',
          trigger: 'from',
          counterpart: 'absorb',
          obligation: 'advisory',
        })
      }
    }

    if (file.endsWith('.go')) {
      for (const spec of parseGoImports(text)) {
        for (const target of resolveGoImport(dir, spec, index)) {
          if (target === file) continue
          add({
            from: idFor(target),
            to: self,
            source: 'heuristic',
            fromPath: target,
            toPath: file,
            relation: 'constrains',
            confidence: 0.8,
            evidence: `import "${spec}"`,
            authority: 'from',
            trigger: 'from',
            counterpart: 'absorb',
            obligation: 'advisory',
          })
        }
      }
    }

    if (file.endsWith('.rs')) {
      for (const spec of parseRustRefs(text)) {
        const target = resolveRustRef(dir, spec, index)
        if (!target || target === file) continue
        add({
          from: idFor(target),
          to: self,
          source: 'heuristic',
          fromPath: target,
          toPath: file,
          relation: 'constrains',
          confidence: 0.8,
          evidence: `use/mod ${spec}`,
          authority: 'from',
          trigger: 'from',
          counterpart: 'absorb',
          obligation: 'advisory',
        })
      }
    }

    if (/\.(java|kt)$/.test(file)) {
      for (const spec of parseJvmImports(text)) {
        const target = resolveJvmImport(spec, index)
        if (!target || target === file) continue
        add({
          from: idFor(target),
          to: self,
          source: 'heuristic',
          fromPath: target,
          toPath: file,
          relation: 'constrains',
          confidence: 0.8,
          evidence: `import ${spec}`,
          authority: 'from',
          trigger: 'from',
          counterpart: 'absorb',
          obligation: 'advisory',
        })
      }
    }

    if (/\.(sh|bash|zsh)$/.test(file)) {
      for (const spec of parseShellSources(text)) {
        const target =
          resolveRelative(dir, spec, fileSet) ??
          resolveRelative(dir, `${spec}.sh`, fileSet) ??
          resolveRelative('.', spec, fileSet) ??
          resolveRelative('.', `${spec}.sh`, fileSet)
        if (!target || target === file) continue
        add({
          from: idFor(target),
          to: self,
          source: 'heuristic',
          fromPath: target,
          toPath: file,
          relation: 'constrains',
          confidence: 0.8,
          evidence: `source ${spec}`,
          authority: 'from',
          trigger: 'from',
          counterpart: 'absorb',
          obligation: 'advisory',
        })
      }
    }

    if (DOC_EXTS.some((ext) => file.endsWith(ext))) {
      for (const link of parseMarkdownLinks(text)) {
        const target = resolveRelative(dir, link, fileSet)
        if (!target || target === file) continue
        add({
          from: idFor(target),
          to: self,
          source: 'heuristic',
          fromPath: target,
          toPath: file,
          relation: 'documents',
          confidence: 0.7,
          evidence: `link ${link}`,
          // 代码是权威侧：改代码要检查文档；改文档不要求动代码。
          authority: 'from',
          trigger: 'from',
          counterpart: 'confirm',
          obligation: 'advisory',
        })
      }
    }

    const generated = parseGeneratedHeader(text)
    if (generated) {
      const target = resolveRelative(dir, generated, fileSet) ?? resolveRelative('.', generated, fileSet)
      if (target && target !== file) {
        add({
          from: idFor(target),
          to: self,
          source: 'heuristic',
          fromPath: target,
          toPath: file,
          relation: 'generates',
          confidence: 0.95,
          evidence: `@generated from ${generated}`,
          authority: 'from',
          trigger: 'from',
          counterpart: 'confirm',
          // 没有 producer 命令，只能提醒，不能自动重算。
          obligation: 'advisory',
        })
      }
    }

    const localized = localizedPair(file, fileSet)
    if (localized) {
      add({
        from: idFor(localized.base),
        to: idFor(localized.translation),
        source: 'heuristic',
        fromPath: localized.base,
        toPath: localized.translation,
        relation: 'translates',
        confidence: 0.9,
        evidence: `同名译文件 ${localized.translation}`,
        authority: 'from',
        trigger: 'from',
        counterpart: 'confirm',
        obligation: 'required',
      })
    }
  }

  return [...out.values()].sort((a, b) => b.confidence - a.confidence || a.from.localeCompare(b.from))
}

function isTextSource(file        )          {
  return /\.(py|md|markdown|rst|txt|ts|tsx|js|mjs|cjs|json|ya?ml|c|cc|cpp|cxx|h|hpp|hh|S|s|asm|inc|go|rs|java|kt|kts|sh|bash|zsh)$/i.test(file)
}

/* ------------------------------------------------------------ Python */

                      
                                  
                
             
 

export function parsePythonImports(text        )               {
  const out               = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) continue

    const fromImport = /^from\s+([.\w]+)\s+import\b/.exec(trimmed)
    if (fromImport) {
      out.push({ module: fromImport[1] , raw: fromImport[1]  })
      continue
    }
    const plain = /^import\s+(.+)$/.exec(trimmed)
    if (plain) {
      for (const part of plain[1] .split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0] .trim()
        if (name) out.push({ module: name, raw: name })
      }
    }
  }
  return out
}

/** 只在工作区内解析：先按相对导入，再按 root 相对，最后按「同目录同名」。 */
export function resolvePythonModule(dir        , spec            , files             )                {
  const dots = /^\.+/.exec(spec.module)?.[0].length ?? 0
  const rest = spec.module.slice(dots).replace(/\./g, '/')
  const baseDir = dots > 0 ? posix.join(dir, '../'.repeat(dots - 1)) : dir
  const candidates           = []

  if (rest !== '') {
    candidates.push(posix.join(baseDir, `${rest}.py`), posix.join(baseDir, rest, '__init__.py'))
    candidates.push(`${rest}.py`, posix.join(rest, '__init__.py'))
  }

  for (const candidate of candidates) {
    const normalized = posix.normalize(candidate).replace(/^\.\//, '')
    if (files.has(normalized)) return normalized
  }
  return null
}

/* ---------------------------------------------------------- Markdown */

export function parseMarkdownLinks(text        )           {
  const out           = []
  const pattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  let match                        
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1] .trim()
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue // http:, mailto:, file:
    if (raw.startsWith('#')) continue
    out.push(raw)
  }
  return out
}

function resolveRelative(dir        , link        , files             )                {
  const withoutAnchor = link.split('#')[0] .split('?')[0] 
  if (withoutAnchor === '' || withoutAnchor.endsWith('/')) return null
  const decoded = safeDecode(withoutAnchor)
  const candidate = posix.normalize(posix.join(dir === '.' ? '' : dir, decoded)).replace(/^\.\//, '')
  if (candidate.startsWith('..')) return null
  return files.has(candidate) ? candidate : null
}

function safeDecode(text        )         {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/* --------------------------------------------------------- generated */

export function parseGeneratedHeader(text        )                {
  const head = text.split('\n').slice(0, 15)
  for (const line of head) {
    const match = /@generated\b[^\n]*?\bfrom\s+[`"']?([^\s`"',;)]+)/i.exec(line)
    if (match) return match[1] 
  }
  return null
}

/* ----------------------------------------------------------- 译文对 */

export function localizedPair(file        , files             )                                               {
  const match = /^(.*)\.([a-z]{2})\.(md|markdown|rst|txt)$/.exec(file)
  if (match && LANG_SUFFIXES.includes(match[2] )) {
    const base = `${match[1]}.${match[3]}`
    if (files.has(base)) return { base, translation: file }
  }
  const baseMatch = /^(.*)\.(md|markdown|rst|txt)$/.exec(file)
  if (baseMatch) {
    for (const lang of LANG_SUFFIXES) {
      const translation = `${baseMatch[1]}.${lang}.${baseMatch[2]}`
      if (files.has(translation)) return { base: file, translation }
    }
  }
  return null
}


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/importers/suggest.ts