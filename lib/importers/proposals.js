import { readFile } from 'node:fs/promises'
import { idFor } from '../workspace/graphfs.js'
import { GraphFSError } from '../types.js'
                                                                                             
                                                
                                             

/**
 * 模型提出的候选边（"AI 建议"）。
 *
 * 为什么走文件而不是进程内调用：CLI 没有模型路由；而插件里由 agent 在自己的回合产出提案，
 * 天然进入 session 日志、可回放（`dsh-llm` 明确要求「模型可见输入必须能从会话日志重建」）。
 *
 * 安全边界（全部强制，不信任提案本身）：
 *   - `policy` 一律降为 `advise`（模型不得授权执行 producer 命令）；
 *   - 置信度夹到 [0, 1]，`evidence` 必填；
 *   - 端点必须已存在于图中，否则整条丢弃（不自动建节点）；
 *   - 方向/环/粒度仍由 `link` 的建边校验兜底。
 */

                                
                      
                     
                 
               
                     
                   
                     
                       
                     
                      
                    
                        
                       
    
 

const RELATIONS                      = ['mirror', 'translates', 'generates', 'documents', 'constrains', 'related']
const AUTHORITIES                       = ['from', 'to', 'none']
const TRIGGERS                     = ['from', 'to', 'both', 'none']
const COUNTERPARTS                         = ['absorb', 'confirm', 'ignore']
const LEVELS                             = ['required', 'advisory', 'silent']

                                 
                         
                                                   
                      
 

/** 把提案文件解析成候选；不做任何 I/O，便于测试。 */
export function parseProposals(data         , graph                      )                 {
  if (!graph) {
    throw new GraphFSError(
      'proposals need an initialized graph to resolve node ids',
      'GF_GRAPH_INVALID',
      'run `graphfs init` first (or use --write, which initializes automatically)',
    )
  }
  const dropped                            = []
  const candidates              = []

  if (!data || typeof data !== 'object') {
    throw new GraphFSError('proposals file must be an object', 'GF_GRAPH_INVALID')
  }
  const input = data                 
  if (!Array.isArray(input.candidates)) {
    throw new GraphFSError('proposals.candidates must be an array', 'GF_GRAPH_INVALID')
  }

  input.candidates.forEach((raw, index) => {
    const relation = RELATIONS.includes(raw.relation            ) ? (raw.relation            ) : null
    if (!relation) {
      dropped.push({ index, reason: `unknown relation: ${String(raw.relation)}` })
      return
    }

    const from = resolveNode(raw.from, raw.fromPath, graph)
    const to = resolveNode(raw.to, raw.toPath, graph)
    if (!from || !to) {
      dropped.push({ index, reason: `unknown node: ${raw.from ?? raw.fromPath} / ${raw.to ?? raw.toPath}` })
      return
    }
    if (from === to) {
      dropped.push({ index, reason: 'self-loop: from and to are the same file' })
      return
    }
    if (!raw.evidence || raw.evidence.trim() === '') {
      dropped.push({ index, reason: 'evidence is required' })
      return
    }

    const confidence = clamp(Number(raw.confidence ?? 0.6))
    const fromNode = graph.nodes.get(from) 
    const toNode = graph.nodes.get(to) 

    candidates.push({
      from,
      to,
      source: 'model',
      fromPath: fromNode.path,
      toPath: toNode.path,
      relation,
      confidence,
      evidence: raw.evidence.trim(),
      authority: pick(raw.authority, AUTHORITIES),
      trigger: pick(raw.trigger, TRIGGERS),
      counterpart: pick(raw.counterpart, COUNTERPARTS),
      obligation: pick(raw.obligation, LEVELS),
    })
  })

  return { candidates, dropped, generatedBy: input.generatedBy }
}

export async function readProposals(path        , graph               )                          {
  let text        
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new GraphFSError(`cannot read proposals: ${path}`, 'GF_GRAPH_INVALID')
  }

  let data         
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new GraphFSError(`proposals is not valid JSON: ${(error         ).message}`, 'GF_GRAPH_INVALID')
  }
  return parseProposals(data, graph)
}

/** 合并启发式与模型候选：同一 (from,to,relation) 视为一条，标记 both 并取较高置信度。 */
export function mergeCandidates(...groups               )              {
  const merged = new Map                   ()
  for (const group of groups) {
    for (const candidate of group) {
      const key = `${candidate.from}|${candidate.to}|${candidate.relation}`
      const existing = merged.get(key)
      if (!existing) {
        merged.set(key, candidate)
        continue
      }
      merged.set(key, {
        ...(candidate.confidence >= existing.confidence ? candidate : existing),
        confidence: Math.max(existing.confidence, candidate.confidence),
        source: 'both',
        evidence: existing.evidence === candidate.evidence ? existing.evidence : `${existing.evidence}；${candidate.evidence}`,
      })
    }
  }
  return [...merged.values()].sort((a, b) => b.confidence - a.confidence || a.from.localeCompare(b.from))
}

function resolveNode(id                    , path                    , graph               )                {
  if (id && graph.nodes.has(id)) return id
  if (path) {
    const derived = idFor(path)
    if (graph.nodes.has(derived)) return derived
    for (const node of graph.nodes.values()) {
      if (node.path === path) return node.id
    }
  }
  return null
}

function clamp(value        )         {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

function pick                  (value                    , allowed              )                {
  return value && (allowed                     ).includes(value) ? (value     ) : undefined
}


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/importers/proposals.ts