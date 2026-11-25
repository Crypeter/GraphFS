import { GraphFSError } from '../types.ts'
import type { PromptPack } from '../importers/pack.ts'

/**
 * 模型接入（OpenAI 兼容 /chat/completions）。
 *
 * 为什么不直接依赖宿主：CLI 没有宿主；而插件里会改用 `ctx.llm.stream`（见 Spec §8.5）。
 * 这一层只做「给 pack，拿回 JSON」，不解析候选语义（那在 importers/proposals.ts）。
 *
 * 凭据只从环境变量来，不读取任何宿主的凭据文件。
 */

export interface ModelConfig {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
}

export function modelConfigFromEnv(env: Record<string, string | undefined> = process.env): ModelConfig | null {
  const apiKey = env.GRAPHFS_LLM_API_KEY
  if (!apiKey) return null
  return {
    baseUrl: (env.GRAPHFS_LLM_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
    apiKey,
    model: env.GRAPHFS_LLM_MODEL ?? 'deepseek-chat',
    timeoutMs: Number(env.GRAPHFS_LLM_TIMEOUT_MS ?? '60000'),
  }
}

export const MODEL_ENV_REMEDY =
  'export GRAPHFS_LLM_API_KEY=...  # 可选 GRAPHFS_LLM_BASE_URL / GRAPHFS_LLM_MODEL'

export interface ModelDeps {
  fetchImpl?: typeof fetch
}

/** 发一次结构化请求，返回模型给出的 JSON（未校验）。 */
export async function requestCandidates(
  pack: PromptPack,
  config: ModelConfig,
  deps: ModelDeps = {},
): Promise<unknown> {
  const doFetch = deps.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)

  let response: Response
  try {
    response = await doFetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: pack.instructions },
          { role: 'user', content: JSON.stringify(pack) },
        ],
      }),
      signal: controller.signal,
    })
  } catch (error) {
    throw new GraphFSError(
      `model request failed: ${(error as Error).message}`,
      'GF_MODEL_FAILED',
      'check network / base URL; 或改用 `graphfs suggest --pack` 手工传给模型',
    )
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new GraphFSError(
      `model returned ${response.status}: ${body.slice(0, 400)}`,
      'GF_MODEL_FAILED',
    )
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = payload.choices?.[0]?.message?.content
  if (!content) throw new GraphFSError('model returned no content', 'GF_MODEL_FAILED')

  return parseJsonPayload(content)
}

/** 容忍 ```json 围栏与前后废话——模型经常不老实。 */
export function parseJsonPayload(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = (fenced ? fenced[1]! : text).trim()
  try {
    return JSON.parse(body)
  } catch {
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1))
      } catch {
        /* fallthrough */
      }
    }
    throw new GraphFSError(`model output is not JSON: ${body.slice(0, 200)}`, 'GF_MODEL_FAILED')
  }
}
