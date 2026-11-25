import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  globalConfigPath,
  maskKey,
  projectConfigPath,
  resolveModelConfig,
  templateConfig,
  writeTemplate,
} from '../../src/adapters/llm-config.ts'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'graphfs-llm-'))
}

test('没有配置时给出可执行的下一步', async () => {
  const dir = await tempDir()
  const resolved = await resolveModelConfig(dir, { XDG_CONFIG_HOME: join(dir, 'cfg') }, join(dir, 'cwd'))
  assert.equal(resolved.config, null)
  assert.equal(resolved.source.kind, 'none')
  assert.match(resolved.problem!, /apiKey|API key/)
})

test('项目配置优先于全局配置', async () => {
  const dir = await tempDir()
  const project = projectConfigPath(dir)
  const global = join(dir, 'cfg/graphfs/llm.json')

  await writeTemplate(project)
  await writeTemplate(global)
  await writeFile(project, JSON.stringify({ baseUrl: 'https://p.test', model: 'pm', apiKey: 'project-key' }))
  await writeFile(global, JSON.stringify({ baseUrl: 'https://g.test', model: 'gm', apiKey: 'global-key' }))

  const resolved = await resolveModelConfig(dir, { XDG_CONFIG_HOME: join(dir, 'cfg') }, join(dir, 'cwd'))
  assert.equal(resolved.source.kind, 'project')
  assert.equal(resolved.config!.apiKey, 'project-key')
  assert.equal(resolved.config!.baseUrl, 'https://p.test')
})

test('环境变量优先于文件', async () => {
  const dir = await tempDir()
  await writeTemplate(projectConfigPath(dir))
  await writeFile(projectConfigPath(dir), JSON.stringify({ apiKey: 'file-key', model: 'file-model' }))
  const resolved = await resolveModelConfig(
    dir,
    { GRAPHFS_LLM_API_KEY: 'env-key', GRAPHFS_LLM_MODEL: 'env-model', XDG_CONFIG_HOME: join(dir, 'cfg') },
    join(dir, 'cwd'),
  )
  assert.equal(resolved.config!.apiKey, 'env-key')
  assert.equal(resolved.config!.model, 'env-model')
})

test('模板：apiKey 留空、权限 0600、已存在时不覆盖', async () => {
  const dir = await tempDir()
  const path = join(dir, '.graphfs/llm.json')

  assert.deepEqual(templateConfig(), { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: '' })
  assert.equal(await writeTemplate(path), 'written')
  assert.equal(JSON.parse(await readFile(path, 'utf8')).apiKey, '')
  assert.equal((await stat(path)).mode & 0o777, 0o600)

  assert.equal(await writeTemplate(path), 'exists')
  assert.equal(await writeTemplate(path, { force: true }), 'written')
})

test('maskKey 不泄露完整 key', () => {
  assert.equal(maskKey('short'), '***')
  assert.equal(maskKey('sk-1234567890abcdef'), 'sk-…cdef')
})

test('globalConfigPath 尊重 XDG_CONFIG_HOME', () => {
  assert.equal(globalConfigPath({ XDG_CONFIG_HOME: '/x' } as NodeJS.ProcessEnv), '/x/graphfs/llm.json')
})

test('目标工作区没有配置时，回落到当前目录（工具自己的配置）', async () => {
  const repo = await tempDir()
  const cwd = await tempDir()
  await writeTemplate(projectConfigPath(cwd))
  await writeFile(projectConfigPath(cwd), JSON.stringify({ apiKey: 'cwd-key' }))

  const resolved = await resolveModelConfig(repo, { XDG_CONFIG_HOME: join(repo, 'cfg') }, cwd)
  assert.equal(resolved.source.kind, 'cwd')
  assert.equal(resolved.config!.apiKey, 'cwd-key')
})
