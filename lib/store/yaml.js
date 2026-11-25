import { GraphFSError } from '../types.js'

/**
 * 受限 YAML 子集：够描述 graph.yaml，且**可读可 diff**。
 *
 * 支持：
 *   - 块状映射、块状序列、序列里嵌映射（`- id: x` 起头）
 *   - 行内标量：字符串（可带单/双引号）、数字、布尔、null
 *   - 行内数组：`[a, b, c]`（元素只能是标量）
 *   - `#` 注释、空行
 *
 * 不支持（遇到就报 GF_GRAPH_INVALID，而不是猜）：
 *   - 行内映射 `{a: 1}`、锚点/别名、多行字符串 `|` `>`、Tab 缩进、重复键
 *
 * 为什么自己写：运行时零依赖是硬约束；YAML 规范太大，子集足够且边界明确。
 */

export class YamlError extends GraphFSError {
  constructor(message        , line         ) {
    super(line === undefined ? message : `line ${line}: ${message}`, 'GF_GRAPH_INVALID')
    this.name = 'YamlError'
  }
}

                
                
              
            
 

/** 拆出 `key: value` 里的冒号位置（忽略引号内的冒号）。 */
function splitIndex(text        )         {
  let quote                = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] 
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ':' && (i === text.length - 1 || text[i + 1] === ' ')) return i
  }
  return -1
}

function stripComment(text        )         {
  let quote                = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] 
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || text[i - 1] === ' ')) return text.slice(0, i)
  }
  return text
}

function unquote(text        )         {
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' || first === "'") && last === first) return text.slice(1, -1)
  }
  return text
}

function scalar(text        , line        )          {
  const trimmed = text.trim()
  if (trimmed === '') return null

  if (trimmed.startsWith('[')) {
    if (!trimmed.endsWith(']')) throw new YamlError('unterminated inline array', line)
    const inner = trimmed.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((part) => scalar(part, line))
  }
  if (trimmed.startsWith('{')) {
    throw new YamlError('inline maps are not supported; use block style', line)
  }
  if (trimmed.startsWith('|') || trimmed.startsWith('>')) {
    throw new YamlError('block scalars are not supported', line)
  }
  if (trimmed.startsWith('&') || trimmed.startsWith('*')) {
    throw new YamlError('anchors/aliases are not supported', line)
  }

  if (trimmed === 'null' || trimmed === '~') return null
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed)

  const unquoted = unquote(trimmed)
  if (unquoted !== trimmed) return unquoted
  return trimmed
}

class Parser {
          i = 0
                   lines        

  constructor(lines        ) {
    this.lines = lines
  }

  parse()          {
    if (this.lines.length === 0) return {}
    const first = this.lines[0] 
    if (first.indent !== 0) throw new YamlError('top level must start at column 0', first.no)
    const value = this.parseBlock(0)
    if (this.i < this.lines.length) {
      throw new YamlError('unexpected indentation', this.lines[this.i] .no)
    }
    return value
  }

          parseBlock(indent        )          {
    const line = this.lines[this.i]
    if (!line) return null
    if (line.indent !== indent) throw new YamlError('bad indentation', line.no)
    return line.text.startsWith('- ') ? this.parseList(indent) : this.parseMap(indent)
  }

          parseMap(indent        , first         )                          {
    const out                          = {}
    if (first !== undefined) this.assign(out, first, indent)
    while (this.i < this.lines.length) {
      const line = this.lines[this.i] 
      if (line.indent !== indent || line.text.startsWith('- ')) break
      this.i += 1
      this.assign(out, line.text, indent)
    }
    return out
  }

          assign(out                         , text        , indent        )       {
    const idx = splitIndex(text)
    if (idx <= 0) throw new YamlError(`expected "key: value", got ${JSON.stringify(text)}`)
    const key = unquote(text.slice(0, idx).trim())
    if (key === '') throw new YamlError('empty key')
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlError(`duplicate key ${key}`)
    const rest = text.slice(idx + 1).trim()

    if (rest !== '') {
      out[key] = scalar(rest, 0)
      return
    }
    const next = this.lines[this.i]
    if (next && next.indent > indent) out[key] = this.parseBlock(next.indent)
    else out[key] = null
  }

          parseList(indent        )            {
    const out            = []
    while (this.i < this.lines.length) {
      const line = this.lines[this.i] 
      if (line.indent !== indent || !line.text.startsWith('- ')) break
      const rest = line.text.slice(2).trim()
      this.i += 1
      if (rest === '') {
        const next = this.lines[this.i]
        out.push(next && next.indent > indent ? this.parseBlock(next.indent) : null)
        continue
      }
      if (splitIndex(rest) > 0) {
        out.push(this.parseMap(indent + 2, rest))
        continue
      }
      out.push(scalar(rest, line.no))
    }
    return out
  }
}

export function parseYaml(source        )          {
  const lines         = []
  const raw = source.split('\n')
  for (let i = 0; i < raw.length; i += 1) {
    const without = stripComment(raw[i] ).replace(/\s+$/, '')
    if (without.trim() === '') continue
    if (without.includes('\t')) throw new YamlError('tabs are not allowed for indentation', i + 1)
    const indent = without.length - without.trimStart().length
    if (indent % 2 !== 0) throw new YamlError('indentation must be a multiple of 2', i + 1)
    lines.push({ indent, text: without.trimStart(), no: i + 1 })
  }
  return new Parser(lines).parse()
}

const NEEDS_QUOTE = /^(?:$|[-?:,[\]{}#&*!|>'"%@`]|.*:\s|.*\s#|-?\d+(?:\.\d+)?$)/

function dumpScalar(value         )         {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') return String(value)
  const text = String(value)
  if (NEEDS_QUOTE.test(text) || text !== text.trim() || text.includes('\n')) {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return text
}

/** 输出块状 YAML；键序按对象自身顺序，便于 diff。 */
export function stringifyYaml(value         , indent = 0)         {
  const pad = ' '.repeat(indent)

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`
    const scalarsOnly = value.every((v) => v === null || typeof v !== 'object')
    if (scalarsOnly) return `${pad}[${value.map(dumpScalar).join(', ')}]`
    return value
      .map((item) => {
        if (item === null || typeof item !== 'object') return `${pad}- ${dumpScalar(item)}`
        const body = stringifyYaml(item, indent + 2)
        return `${pad}- ${body.trimStart()}`
      })
      .join('\n')
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value                           ).filter(([, v]) => v !== undefined)
    if (entries.length === 0) return `${pad}{}`
    return entries
      .map(([key, v]) => {
        if (v === null || typeof v !== 'object') return `${pad}${key}: ${dumpScalar(v)}`
        if (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object')) {
          return `${pad}${key}: ${stringifyYaml(v, 0).trim()}`
        }
        return `${pad}${key}:\n${stringifyYaml(v, indent + 2)}`
      })
      .join('\n')
  }

  return `${pad}${dumpScalar(value)}`
}


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/store/yaml.ts