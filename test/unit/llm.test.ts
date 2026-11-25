import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelConfigFromEnv, parseJsonPayload, requestCandidates } from '../../src/adapters/llm.ts'
import type { PromptPack } from '../../src/importers/pack.ts'

const pack: PromptPack = {
  root: '/r',
  generatedAt: 't0',
  budget: { maxFiles: 1, maxCandidates: 1 },
  files: [],
  heuristic: [],
  instructions: 'x',
  schema: {},
}

const config = { baseUrl: 'https://example.test', apiKey: 'k', model: 'm', timeoutMs: 1000 }

test('modelConfigFromEnv：没有 key 就返回 null', () => {
  assert.equal(modelConfigFromEnv({}), null)
  assert.deepEqual(modelConfigFromEnv({ GRAPHFS_LLM_API_KEY: 'k' }), {
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'k',
    model: 'deepseek-chat',
    timeoutMs: 60000,
  })
})

test('parseJsonPayload：容忍围栏与前后废话', () => {
  assert.deepEqual(parseJsonPayload('```json\n{"candidates":[]}\n```'), { candidates: [] })
  assert.deepEqual(parseJsonPayload('好的，结果如下：{"candidates":[]} 完毕'), { candidates: [] })
  assert.throws(() => parseJsonPayload('not json at all'), (e: unknown) => (e as { code?: string }).code === 'GF_MODEL_FAILED')
})

test('requestCandidates：注入 fetch，校验请求形状并解析 content', async () => {
  let seen: { url: string; body: unknown; auth: string } | null = null
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = {
      url,
      body: JSON.parse(String(init.body)),
      auth: String((init.headers as Record<string, string>).authorization),
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"candidates":[{"fromPath":"a","toPath":"b","relation":"constrains","confidence":0.9,"evidence":"e"}]}' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch

  const payload = (await requestCandidates(pack, config, { fetchImpl: fakeFetch })) as {
    candidates: Array<{ fromPath: string }>
  }
  assert.equal(payload.candidates[0]!.fromPath, 'a')
  assert.equal(seen!.url, 'https://example.test/chat/completions')
  assert.equal(seen!.auth, 'Bearer k')
  assert.equal((seen!.body as { model: string }).model, 'm')
})

test('requestCandidates：非 200 抛 GF_MODEL_FAILED', async () => {
  const fakeFetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
  await assert.rejects(
    () => requestCandidates(pack, config, { fetchImpl: fakeFetch }),
    (e: unknown) => (e as { code?: string }).code === 'GF_MODEL_FAILED',
  )
})
