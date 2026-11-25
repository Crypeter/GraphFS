import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ModelConfig } from './llm.ts'

/**
 * 模型配置的解析与生成。
 *
 * 优先级（高 → 低）：
 *   1. 环境变量 GRAPHFS_LLM_*
 *   2. 项目内 `<root>/.graphfs/llm.json`（应当 gitignore，别把 key 提交上去）
 *   3. 全局 `~/.config/graphfs/llm.json`（或 $XDG_CONFIG_HOME/graphfs/llm.json）
 *
 * 凭据只从这三处读；**不**读宿主的凭据文件，也不打印完整 key。
 */

export interface StoredModelConfig {
  baseUrl?: string
  model?: string
  apiKey?: string
  timeoutMs?: number
}

export interface ConfigSource {
  /** 配置文件路径（即使不存在也返回，用于提示"放这里"）。 */
  path: string
  kind: 'env' | 'explicit' | 'project' | 'cwd' | 'global' | 'none'
  exists: boolean
}

export interface ResolvedModel {
  config: ModelConfig | null
  source: ConfigSource
  /** 为什么没配好（给用户看的下一步）。 */
  problem?: string
}

export function projectConfigPath(root: string): string {
  return join(root, '.graphfs/llm.json')
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(base, 'graphfs/llm.json')
}

export function templateConfig(): Required<Pick<StoredModelConfig, 'baseUrl' | 'model' | 'apiKey'>> {
  return { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: '' }
}

export async function writeTemplate(path: string, opts: { force?: boolean } = {}): Promise<'written' | 'exists'> {
  if (!opts.force) {
    try {
      await readFile(path, 'utf8')
      return 'exists'
    } catch {
      /* 不存在，继续写 */
    }
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(templateConfig(), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(path, 0o600).catch(() => undefined)
  return 'written'
}

async function readStored(path: string): Promise<StoredModelConfig | null> {
  try {
    const text = await readFile(path, 'utf8')
    const data = JSON.parse(text) as StoredModelConfig
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

export async function resolveModelConfig(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<ResolvedModel> {
  const project = projectConfigPath(root)
  const local = projectConfigPath(cwd)
  const global = globalConfigPath(env)

  // 顺序：显式指定 > 目标工作区 > 当前目录（工具自己的配置）> 全局
  const candidates: Array<{ path: string; kind: ConfigSource['kind'] }> = []
  if (env.GRAPHFS_LLM_CONFIG) candidates.push({ path: env.GRAPHFS_LLM_CONFIG, kind: 'explicit' })
  candidates.push({ path: project, kind: 'project' })
  if (local !== project) candidates.push({ path: local, kind: 'cwd' })
  candidates.push({ path: global, kind: 'global' })

  let stored: StoredModelConfig | null = null
  let source: ConfigSource = { path: project, kind: 'none', exists: false }
  for (const candidate of candidates) {
    const data = await readStored(candidate.path)
    if (data) {
      stored = data
      source = { ...candidate, exists: true }
      break
    }
  }

  const apiKey = env.GRAPHFS_LLM_API_KEY ?? stored?.apiKey ?? ''
  if (!apiKey) {
    return {
      config: null,
      source,
      problem:
        `没有 API key。把 key 填进 ${project}、${local} 或 ${global}，` +
        '或设 GRAPHFS_LLM_API_KEY / GRAPHFS_LLM_CONFIG',
    }
  }

  return {
    config: {
      baseUrl: (env.GRAPHFS_LLM_BASE_URL ?? stored?.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
      apiKey,
      model: env.GRAPHFS_LLM_MODEL ?? stored?.model ?? 'deepseek-chat',
      timeoutMs: Number(env.GRAPHFS_LLM_TIMEOUT_MS ?? stored?.timeoutMs ?? '60000'),
    },
    source,
  }
}

/** 只露头尾，避免日志里出现完整 key。 */
export function maskKey(key: string): string {
  if (key.length <= 8) return '***'
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}
