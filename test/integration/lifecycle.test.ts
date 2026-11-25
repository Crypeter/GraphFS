import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphFS } from '../../src/workspace/graphfs.ts'
import { Detector } from '../../src/engine/detector.ts'
import { installLifecycle } from '../../src/runtime/lifecycle.ts'
import { RootRegistry } from '../../src/runtime/roots.ts'
import { DshHost } from '../../src/adapters/dsh-host.ts'
import type { AskRequest, Host, TurnContext } from '../../src/runtime/lifecycle.ts'
import { resolveConfig } from '../../src/config.ts'

/** 假宿主：记录 steer / inject / ask，手动触发 observed 与 turn-stopping。 */
function fakeHost(opts: { answer?: string | null } = {}) {
  const steers: string[] = []
  const injects: string[] = []
  const logs: string[] = []
  const asks: AskRequest[] = []
  let observed: ((p: string) => void) | null = null
  let turn: ((c: TurnContext) => Promise<void> | void) | null = null

  const host: Host = {
    onObserved(handler) {
      observed = handler
      return () => {
        observed = null
      }
    },
    onTurnStopping(handler) {
      turn = handler
      return () => {
        turn = null
      }
    },
    log(level, message) {
      logs.push(`${level}: ${message}`)
    },
  }

  if (opts.answer !== undefined) {
    host.ask = async (request) => {
      asks.push(request)
      return opts.answer ?? null
    }
  }

  return {
    host,
    steers,
    injects,
    logs,
    asks,
    fireObserved: (p: string) => observed?.(p),
    endTurn: async (turnId: string) => {
      await turn?.({ turnId, steer: (t) => steers.push(t), inject: (t) => injects.push(t) })
    },
  }
}

async function workspace(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'graphfs-life-'))
  for (const [path, text] of Object.entries(files)) {
    const abs = join(root, path)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, text, 'utf8')
  }
  return { root, graph: join(root, '.graphfs/graph.yaml') }
}

const CONFIG = (root: string) => resolveConfig({ root, maxRounds: 2, maxObligations: 5 })

/** 测试用：固定 root 的注册表，避免真的走 workingDirectory。 */
function registryFor(gfs: GraphFS, root: string): RootRegistry {
  const registry = new RootRegistry({}, CONFIG(root) as never, root)
  ;(registry as unknown as { byRoot: Map<string, Promise<GraphFS>> }).byRoot.set(root, Promise.resolve(gfs))
  return registry
}

test('没有图 + 没有提问通道：steer 一次让模型去问，不建文件', async () => {
  const { root, graph } = await workspace({ 'a.md': '# a\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  const fake = fakeHost()
  installLifecycle({ host: fake.host, roots: registryFor(gfs, root), detector: new Detector(), config: CONFIG(root) })

  await fake.endTurn('t1')
  await fake.endTurn('t2')

  assert.equal(fake.injects.length, 0, 'inject 不会唤醒回合，初始化提示必须用 steer')
  assert.equal(fake.steers.length, 1)
  assert.match(fake.steers[0]!, /graphfs_init/)
  assert.match(fake.steers[0]!, /现在建立/)
  assert.equal(gfs.snapshot, null, '不应该自动建图')
})

test('有图 + 漂移：steer 一次，内容是「谁因为谁要改」', async () => {
  const { root, graph } = await workspace({ 'models.py': 'class M: pass\n', 'main.py': 'from models import M\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await gfs.link({ from: 'models', to: 'main', relation: 'constrains' })

  await writeFile(join(root, 'models.py'), 'class M:\n    x = 1\n', 'utf8')

  const fake = fakeHost()
  const detector = new Detector()
  installLifecycle({ host: fake.host, roots: registryFor(gfs, root), detector, config: CONFIG(root) })

  fake.fireObserved('models.py')
  await fake.endTurn('turn-1')

  assert.equal(fake.steers.length, 1)
  assert.match(fake.steers[0]!, /main\.py ← models\.py/)
  assert.match(fake.steers[0]!, /graphfs_ack/)
})

test('同一回合最多 steer 一次（防乒乓）', async () => {
  const { root, graph } = await workspace({ 'a.py': 'x = 1\n', 'b.py': 'from a import x\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await gfs.link({ from: 'a', to: 'b', relation: 'constrains' })
  await writeFile(join(root, 'a.py'), 'x = 2\n', 'utf8')

  const fake = fakeHost()
  installLifecycle({ host: fake.host, roots: registryFor(gfs, root), detector: new Detector(), config: CONFIG(root) })

  fake.fireObserved('a.py')
  await fake.endTurn('same-turn')
  fake.fireObserved('a.py')
  await fake.endTurn('same-turn')

  assert.equal(fake.steers.length, 1, '第二次应当被预算拦下')
  assert.match(fake.logs.join('\n'), /义务未处理/)
})

test('新回合重新计数', async () => {
  const { root, graph } = await workspace({ 'a.py': 'x = 1\n', 'b.py': 'from a import x\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await gfs.link({ from: 'a', to: 'b', relation: 'constrains' })
  await writeFile(join(root, 'a.py'), 'x = 2\n', 'utf8')

  const fake = fakeHost()
  installLifecycle({ host: fake.host, roots: registryFor(gfs, root), detector: new Detector(), config: CONFIG(root) })

  fake.fireObserved('a.py')
  await fake.endTurn('turn-1')
  fake.fireObserved('a.py')
  await fake.endTurn('turn-2')

  assert.equal(fake.steers.length, 2)
})

test('无变化时回合结束不打扰', async () => {
  const { root, graph } = await workspace({ 'a.py': 'x = 1\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()

  const fake = fakeHost()
  installLifecycle({ host: fake.host, roots: registryFor(gfs, root), detector: new Detector(), config: CONFIG(root) })
  await fake.endTurn('t1')

  assert.equal(fake.steers.length, 0)
  assert.equal(fake.injects.length, 0)
})

test('dispose 之后不再响应', async () => {
  const { root, graph } = await workspace({ 'a.py': 'x = 1\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  const fake = fakeHost()
  const dispose = installLifecycle({ host: fake.host, roots: registryFor(gfs, root), detector: new Detector(), config: CONFIG(root) })

  dispose()
  await fake.endTurn('t1')
  assert.equal(fake.injects.length, 0)
})

/* ------------------------------------------------ 自动化：询问与弹框 */

test('没有图 + 用户确认“现在建立” → 自动建图并采纳高置信关系', async () => {
  const { root, graph } = await workspace({
    'src/a.h': 'int f(void);\n',
    'src/b.c': '#include "a.h"\nint f(void) { return 1; }\n',
  })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  const fake = fakeHost({ answer: '现在建立（推荐）' })
  installLifecycle({ host: fake.host, roots: registryFor(gfs, root), detector: new Detector(), config: CONFIG(root) })

  await fake.endTurn('t1')

  assert.equal(fake.asks.length, 1)
  assert.match(fake.asks[0]!.question, /一致性图/)
  assert.match(fake.asks[0]!.question, /#include/)
  assert.ok(gfs.snapshot, '应当自动建立图')
  assert.ok(gfs.snapshot!.edges.size >= 1, '应当自动采纳 a.h → b.c')
  assert.match(fake.injects.join('\n'), /已建立一致性图/)
})

test('没有图 + 用户选“稍后” → 不建图，且只问一次', async () => {
  const { root, graph } = await workspace({ 'a.md': '# a\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  const fake = fakeHost({ answer: '稍后' })
  installLifecycle({ host: fake.host, roots: registryFor(gfs, root), detector: new Detector(), config: CONFIG(root) })

  await fake.endTurn('t1')
  await fake.endTurn('t2')

  assert.equal(fake.asks.length, 1)
  assert.equal(gfs.snapshot, null)
  assert.equal(fake.injects.length, 0, '拒绝后不能再 inject 一条"用户说…"的伪消息')
  assert.ok(fake.logs.some((line) => line.includes('暂不建立')))
})

test('漂移 + 用户同意同步 → steer 一次，提示里带关系', async () => {
  const { root, graph } = await workspace({ 'models.py': 'class M: pass\n', 'main.py': 'from models import M\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await gfs.link({ from: 'models', to: 'main', relation: 'constrains' })
  await writeFile(join(root, 'models.py'), 'class M:\n    x = 1\n', 'utf8')

  const fake = fakeHost({ answer: '是，同步修改（推荐）' })
  installLifecycle({ host: fake.host, roots: registryFor(gfs, root), detector: new Detector(), config: CONFIG(root) })

  fake.fireObserved('models.py')
  await fake.endTurn('t1')

  assert.equal(fake.asks.length, 1)
  assert.match(fake.asks[0]!.question, /main\.py/)
  assert.deepEqual(fake.asks[0]!.options, ['是，同步修改（推荐）', '不，只提醒'])
  assert.equal(fake.steers.length, 1)
  assert.match(fake.steers[0]!, /main\.py ← models\.py/)
})

test('漂移 + 用户选“只提醒” → 不 steer，同一漂移不再追问', async () => {
  const { root, graph } = await workspace({ 'a.py': 'x = 1\n', 'b.py': 'from a import x\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await gfs.link({ from: 'a', to: 'b', relation: 'constrains' })
  await writeFile(join(root, 'a.py'), 'x = 2\n', 'utf8')

  const fake = fakeHost({ answer: '不，只提醒' })
  installLifecycle({ host: fake.host, roots: registryFor(gfs, root), detector: new Detector(), config: CONFIG(root) })

  fake.fireObserved('a.py')
  await fake.endTurn('t1')
  await fake.endTurn('t2')

  assert.equal(fake.asks.length, 1, '同样的漂移不应该反复弹框')
  assert.equal(fake.steers.length, 0)

  // 内容再变一次 → 新的漂移（新的 obligation id）→ 可以再问
  await writeFile(join(root, 'a.py'), 'x = 3\n', 'utf8')
  fake.fireObserved('a.py')
  await fake.endTurn('t3')
  assert.equal(fake.asks.length, 2)
})

test('没有交互式 answerer（ask 返回 null）→ 退回 steer', async () => {
  const { root, graph } = await workspace({ 'a.py': 'x = 1\n', 'b.py': 'from a import x\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await gfs.link({ from: 'a', to: 'b', relation: 'constrains' })
  await writeFile(join(root, 'a.py'), 'x = 2\n', 'utf8')

  const fake = fakeHost({ answer: null })
  installLifecycle({ host: fake.host, roots: registryFor(gfs, root), detector: new Detector(), config: CONFIG(root) })

  fake.fireObserved('a.py')
  await fake.endTurn('t1')

  assert.equal(fake.asks.length, 1)
  assert.equal(fake.steers.length, 1, '没有 UI 时仍要 steer')
})

test('observed 收到绝对路径也能映射回工作区节点', async () => {
  const { root, graph } = await workspace({ 'models.py': 'class M: pass\n', 'main.py': 'from models import M\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await gfs.link({ from: 'models', to: 'main', relation: 'constrains' })
  await writeFile(join(root, 'models.py'), 'class M:\n    y = 1\n', 'utf8')

  const fake = fakeHost()
  installLifecycle({ host: fake.host, roots: registryFor(gfs, root), detector: new Detector(), config: CONFIG(root) })

  fake.fireObserved(join(root, 'models.py'))
  await fake.endTurn('t1')

  assert.equal(fake.steers.length, 1)
})

test('没有义务但改到的文件有边：也会问一次（非权威端变更）', async () => {
  const { root, graph } = await workspace({ 'fw.py': 'VERSION = 1\n', 'code.py': 'from fw import VERSION\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  // constrains：权威端是 fw，改 code 只走 counterpart(absorb)
  await gfs.link({ from: 'fw', to: 'code', relation: 'constrains' })
  await writeFile(join(root, 'code.py'), 'from fw import VERSION\nprint(VERSION)\n', 'utf8')

  const fake = fakeHost({ answer: '是，同步修改（推荐）' })
  installLifecycle({ host: fake.host, roots: registryFor(gfs, root), detector: new Detector(), config: CONFIG(root) })

  fake.fireObserved('code.py')
  await fake.endTurn('t1')

  assert.equal((await gfs.plan()).obligations.length, 0, '非权威端变更不应产生义务')
  assert.equal(fake.asks.length, 1)
  assert.match(fake.asks[0]!.question, /code\.py/)
  assert.match(fake.asks[0]!.question, /fw\.py/)
  assert.equal(fake.steers.length, 1)
  assert.match(fake.steers[0]!, /一并检查/)

  // 同样的内容再被"观察"一次：不再追问
  fake.fireObserved('code.py')
  await fake.endTurn('t2')
  assert.equal(fake.asks.length, 1)

  // 内容再变 → 新的指纹 → 可以再问
  await writeFile(join(root, 'code.py'), 'from fw import VERSION\nprint(VERSION + 1)\n', 'utf8')
  fake.fireObserved('code.py')
  await fake.endTurn('t3')
  assert.equal(fake.asks.length, 2)
})

test('没有义务、没有关系：不弹框', async () => {
  const { root, graph } = await workspace({ 'solo.md': '# solo\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await writeFile(join(root, 'solo.md'), '# solo v2\n', 'utf8')

  const fake = fakeHost({ answer: '是，同步修改（推荐）' })
  installLifecycle({ host: fake.host, roots: registryFor(gfs, root), detector: new Detector(), config: CONFIG(root) })

  fake.fireObserved('solo.md')
  await fake.endTurn('t1')

  assert.equal(fake.asks.length, 0)
  assert.equal(fake.steers.length, 0)
})

test('observe 模式：不弹框、不 steer', async () => {
  const { root, graph } = await workspace({ 'a.py': 'x = 1\n', 'b.py': 'from a import x\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await gfs.link({ from: 'a', to: 'b', relation: 'constrains' })
  await writeFile(join(root, 'a.py'), 'x = 2\n', 'utf8')

  const fake = fakeHost({ answer: '是，同步修改（推荐）' })
  installLifecycle({
    host: fake.host,
    roots: registryFor(gfs, root),
    detector: new Detector(),
    config: { ...CONFIG(root), mode: 'observe' },
  })

  fake.fireObserved('a.py')
  await fake.endTurn('t1')

  assert.equal(fake.asks.length, 0)
  assert.equal(fake.steers.length, 0)
})


/* ------------------------------------------- 真实载荷形状的端到端接线 */

function dshHarness(root: string, askAnswer: string, gfs: GraphFS) {
  const handlers = new Map<string, (...args: any[]) => any>()
  const asks: any[] = []
  const agent = {
    id: 'agent-1',
    session: { id: 'session-1' },
    steers: [] as string[],
    steer(input: { content: Array<{ type: 'text'; text: string }> }) {
      this.steers.push(input.content[0]!.text)
    },
    inject() {},
  }
  const ctx = {
    fs: { processPath: (target: { displayPath?: string }) => target.displayPath },
    agents: { get: () => agent },
    get: (name: string) =>
      name === 'userQuestions'
        ? {
            async ask(request: unknown) {
              asks.push(request)
              return { answers: [{ id: 'graphfs', selected: [askAnswer] }] }
            },
          }
        : undefined,
    on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    log: () => undefined,
  }
  const roots = new RootRegistry(
    { workingDirectory: { ensure: async () => root } },
    CONFIG(root) as never,
    root,
  )
  ;(roots as unknown as { byRoot: Map<string, Promise<GraphFS>> }).byRoot.set(root, Promise.resolve(gfs))
  const host = new DshHost(ctx as never)
  return { ctx, host, roots, agent, asks, emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args) }
}

test('DshHost 端到端：写文件 → 回合结束 → 弹框 → 同意 → steer', async () => {
  const { root, graph } = await workspace({ 'a.py': 'x = 1\n', 'b.py': 'from a import x\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await gfs.link({ from: 'a', to: 'b', relation: 'constrains' })
  await writeFile(join(root, 'a.py'), 'x = 2\n', 'utf8')

  const harness = dshHarness(root, '是，同步修改（推荐）', gfs)
  installLifecycle({
    host: harness.host,
    roots: harness.roots,
    detector: new Detector(),
    config: CONFIG(root),
  })

  harness.emit(
    'fs/observed',
    { displayPath: join(root, 'a.py') },
    { kind: 'present' },
    { name: 'write', agent: harness.agent },
  )
  await new Promise((resolve) => setTimeout(resolve, 20))

  await harness.emit('agent/turn-stopping', {
    agent: harness.agent,
    turn: 1,
    signal: new AbortController().signal,
  })

  assert.equal(harness.asks.length, 1, '回合结束应当弹出确认框')
  assert.equal(harness.agent.steers.length, 1, '同意后应当 steer 回模型')
})

test('DshHost 端到端：没有图 → 回合结束弹「要现在建立吗」→ 建图', async () => {
  const { root, graph } = await workspace({ 'a.h': 'int f(void);\n', 'b.c': '#include "a.h"\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  const harness = dshHarness(root, '现在建立（推荐）', gfs)
  installLifecycle({
    host: harness.host,
    roots: harness.roots,
    detector: new Detector(),
    config: CONFIG(root),
  })

  await harness.emit('agent/turn-stopping', {
    agent: harness.agent,
    turn: 1,
    signal: new AbortController().signal,
  })

  assert.equal(harness.asks.length, 1)
  assert.ok(gfs.snapshot, '同意后应当建立图')
  assert.ok(gfs.snapshot!.edges.size >= 1)
})

test('每回合以磁盘为准：别的实例刚建好图，本回合不再询问', async () => {
  const { root, graph } = await workspace({ 'a.md': '# a\n' })
  const cached = await GraphFS.open({ root, graphPath: graph }) // snapshot = null
  const other = await GraphFS.open({ root, graphPath: graph })
  await other.init() // 模拟 CLI/另一个会话建图；cached 仍是旧快照

  const fake = fakeHost({ answer: '现在建立（推荐）' })
  installLifecycle({
    host: fake.host,
    roots: registryFor(cached, root),
    detector: new Detector(),
    config: CONFIG(root),
  })

  await fake.endTurn('t1')
  assert.equal(fake.asks.length, 0, 'reload 之后应该看到图已经存在')
})

test('每回合以磁盘为准：图被删掉后会重新询问', async () => {
  const { root, graph } = await workspace({ 'a.md': '# a\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()

  const fake = fakeHost({ answer: '现在建立（推荐）' })
  installLifecycle({
    host: fake.host,
    roots: registryFor(gfs, root),
    detector: new Detector(),
    config: CONFIG(root),
  })

  const { rm } = await import('node:fs/promises')
  await rm(graph)

  await fake.endTurn('t1')
  assert.equal(fake.asks.length, 1, '图被删后应该重新询问')
})

test('autoInit: always —— 不问，直接建图', async () => {
  const { root, graph } = await workspace({ 'a.h': 'int f(void);\n', 'b.c': '#include "a.h"\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  const fake = fakeHost() // 没有 ask
  installLifecycle({
    host: fake.host,
    roots: registryFor(gfs, root),
    detector: new Detector(),
    config: { ...CONFIG(root), autoInit: 'always' },
  })

  await fake.endTurn('t1')

  assert.equal(fake.asks.length, 0)
  assert.ok(gfs.snapshot, 'always 模式应当直接建图')
  assert.ok(gfs.snapshot!.edges.size >= 1)
  assert.match(fake.injects.join('\n'), /已建立一致性图/)
})
