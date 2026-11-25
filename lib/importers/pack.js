import { looksBinary } from '../workspace/graphfs.js'
import { extractImports, extractSymbols } from './source-scan.js'

export { extractImports, extractSymbols }
                                             

/**
 * 提示包（prompt pack）：把「让模型提边」所需要的一切压成一份有界、可复现的输入。
 *
 * 为什么不是直接把整个仓库塞给模型：
 *   1. token 有预算，仓库存不下；
 *   2. 模型要的是**结构线索**（顶层符号、import、标题），不是全文；
 *   3. 输入必须可复现——同一份 pack 重放应当得到同一批候选，便于排查"模型为什么提了这条"。
 *
 * 这个类不调用模型，只负责准备输入；调用在 adapters/llm.ts。
 */

                           
              
               
              
                            
                   
                                    
                   
 

                             
              
                     
                                                     
                   
                                                                                                   
                      
                                 
 

                                 
              
                 
                                               
                        
             
                                                                             
 

const KIND                         = {
  '.py': 'python',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.rst': 'rst',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.sh': 'shell',
}

const SCHEMA = {
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['fromPath', 'toPath', 'relation', 'confidence', 'evidence'],
        properties: {
          fromPath: { type: 'string', description: '工作区相对路径，事实源一侧' },
          toPath: { type: 'string', description: '工作区相对路径，被影响一侧' },
          relation: {
            type: 'string',
            enum: ['mirror', 'translates', 'generates', 'documents', 'constrains', 'related'],
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          evidence: { type: 'string', description: '必须引用具体代码/文档位置，不能是泛泛而谈' },
        },
      },
    },
  },
}

const INSTRUCTIONS = `你在为一个工作区建立「一致性图」：节点是文件，边表示「改了 A，B 可能必须跟着改」。

请只提出**有证据**的边。宁可少提，也不要猜。

方向约定（很重要）：
- constrains：A 是模块/框架，B 使用它 → from=A（模块），to=B（使用方）
- documents：A 是代码，B 是描述它的文档 → from=A（代码），to=B（文档）
- generates：A 是源，B 是产物 → from=A，to=B
- translates：A 是原文，B 是译文 → from=A，to=B
- mirror：两份内容必须逐字节/逐节一致（双向）
- related：只是相关、说不清方向时用这个（最弱）

必须避免：
1. 无证据的边（"它们看起来相关"不算证据）
2. 目录层级关系（同目录不等于一致）
3. 猜测性的 imports（解析不到的文件不要提）

输出：只输出 JSON，形如 {"candidates":[...]}，字段见 schema。`

/**
 * 按目录轮流取样：否则 200 个文件的仓库只会喂给模型字母序前 40 个（全在 include/ 里），
 * src/ 与 test/ 一个都看不到——而跨目录关系恰恰最需要模型判断。
 */
export function sampleAcrossDirs(files          , maxFiles        )           {
  const buckets = new Map                  ()
  for (const file of files) {
    const top = file.includes('/') ? file.slice(0, file.indexOf('/')) : '.'
    const bucket = buckets.get(top)
    if (bucket) bucket.push(file)
    else buckets.set(top, [file])
  }

  const queues = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, list]) => list)
  const picked           = []
  let index = 0

  while (picked.length < maxFiles) {
    let progressed = false
    for (const queue of queues) {
      if (index < queue.length) {
        picked.push(queue[index] )
        progressed = true
        if (picked.length >= maxFiles) break
      }
    }
    if (!progressed) break
    index += 1
  }
  return picked
}

export async function buildPack(input                )                      {
  const maxFiles = input.limits?.maxFiles ?? 40
  const maxCandidates = input.limits?.maxCandidates ?? 10
  const maxSymbols = input.limits?.maxSymbols ?? 8
  const fileSet = new Set(input.files)

  const files             = []
  for (const path of sampleAcrossDirs(input.files, maxFiles)) {
    if (files.length >= maxFiles) break
    if (looksBinary(path)) continue
    const text = await input.read(path)
    if (text === null) continue
    const ext = path.slice(path.lastIndexOf('.'))
    files.push({
      path,
      bytes: Buffer.byteLength(text, 'utf8'),
      kind: KIND[ext] ?? 'text',
      symbols: extractSymbols(path, text, maxSymbols),
      imports: extractImports(path, text, fileSet),
    })
  }

  return {
    root: input.root,
    generatedAt: input.now,
    budget: { maxFiles, maxCandidates },
    files,
    heuristic: input.heuristic.slice(0, maxCandidates).map((c) => ({
      fromPath: c.fromPath,
      toPath: c.toPath,
      relation: c.relation,
      confidence: c.confidence,
      evidence: c.evidence,
    })),
    instructions: INSTRUCTIONS,
    schema: SCHEMA,
  }
}

/** 人读版（也方便直接粘进对话里让模型拟边）。 */
export function renderPackMarkdown(pack            )         {
  const lines           = []
  lines.push(`# 一致性图 · 候选边任务`)
  lines.push('')
  lines.push(pack.instructions)
  lines.push('')
  lines.push(`## 工作区 ${pack.root}`)
  lines.push(`预算：最多读 ${pack.budget.maxFiles} 个文件、最多提 ${pack.budget.maxCandidates} 条边。`)
  lines.push('')
  lines.push('## 文件')
  for (const file of pack.files) {
    const symbols = file.symbols.length > 0 ? ` — ${file.symbols.join(', ')}` : ''
    const imports = file.imports.length > 0 ? `   ← ${file.imports.join(', ')}` : ''
    lines.push(`- ${file.path} (${file.kind}, ${file.bytes}B)${symbols}${imports}`)
  }
  lines.push('')
  if (pack.heuristic.length > 0) {
    lines.push('## 规则已经发现的候选（可复用证据，也可推翻）')
    for (const c of pack.heuristic) {
      lines.push(`- [${c.confidence.toFixed(2)}] ${c.relation}: ${c.fromPath} → ${c.toPath}（${c.evidence}）`)
    }
    lines.push('')
  }
  lines.push('## 输出')
  lines.push('```json')
  lines.push('{"candidates":[{"fromPath":"...","toPath":"...","relation":"constrains","confidence":0.8,"evidence":"..."}]}')
  lines.push('```')
  return lines.join('\n')
}


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/importers/pack.ts