import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DshHost } from '../../src/adapters/dsh-host.ts'
import type { TurnContext } from '../../src/runtime/lifecycle.ts'

/** 最小 DSH 上下文：记录 on 注册的 handler，手动 emit。 */
function fakeCtx(services: Record<string, unknown> = {}) {
  const handlers = new Map<string, (...args: any[]) => any>()
  const ctx = {
    fs: { processPath: (target: { displayPath?: string }) => target.displayPath },
    agents: { get: (_id: string) => undefined },
    get: (name: string) => services[name],
    on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, handler)
      return () => {
        handlers.delete(event)
      }
    },
    log: () => undefined,
  }
  return {
    ctx,
    emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
    has: (event: string) => handlers.has(event),
  }
}

function fakeAgent(id = 'a1') {
  const steers: string[] = []
  const injects: string[] = []
  const steerInputs: Array<Record<string, any>> = []
  const injectInputs: Array<Record<string, any>> = []
  const agent = {
    id,
    session: { id: `${id}-session` },
    steer(input: { id?: string; role?: string; content: Array<{ type: 'text'; text: string }> }) {
      steerInputs.push(input)
      steers.push(input.content[0]!.text)
    },
    inject(input: { id?: string; role?: string; content: Array<{ type: 'text'; text: string }> }) {
      injectInputs.push(input)
      injects.push(input.content[0]!.text)
    },
  }
  return { agent, steers, injects, steerInputs, injectInputs }
}

test('DshHost：turn-stopping 从 payload.agent 取 agent，turn 是数字', async () => {
  const fake = fakeCtx()
  const host = new DshHost(fake.ctx as never)
  const { agent, steers, steerInputs } = fakeAgent()

  const seen: TurnContext[] = []
  host.onTurnStopping((context) => {
    seen.push(context)
  })

  await fake.emit('agent/turn-stopping', { agent, turn: 7, signal: new AbortController().signal })

  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.agent, agent)
  assert.equal(seen[0]!.turnId, 'a1:7')

  seen[0]!.steer('hello')
  assert.deepEqual(steers, ['hello'])
  assert.equal(steerInputs[0]!.role, 'user', '消息必须带 role，否则下一次请求会 422')
  assert.equal(typeof steerInputs[0]!.id, 'string')
})

test('DshHost：注入/steer 的是完整 user 消息（缺 id/role 会写坏会话日志）', async () => {
  const fake = fakeCtx()
  const host = new DshHost(fake.ctx as never)
  const { agent, injectInputs, steerInputs } = fakeAgent()

  const seen: TurnContext[] = []
  host.onTurnStopping((context) => {
    seen.push(context)
  })
  await fake.emit('agent/turn-stopping', { agent, turn: 3, signal: new AbortController().signal })

  seen[0]!.inject('note')
  seen[0]!.steer('hint')

  const injected = injectInputs[0]!
  const steered = steerInputs[0]!
  for (const [message, text] of [
    [injected, 'note'],
    [steered, 'hint'],
  ] as const) {
    assert.deepEqual(Object.keys(message).sort(), ['content', 'id', 'role', 'source'])
    assert.equal(typeof message.id, 'string')
    assert.equal(message.id.length > 0, true)
    assert.equal(message.role, 'user')
    assert.deepEqual(message.content, [{ type: 'text', text }])
    assert.deepEqual(message.source, { kind: 'graphfs' })
  }
  assert.notEqual(injected.id, steered.id)
  // 必须能原样 JSON 往返：DSH 会把它直接写进会话日志。
  assert.deepEqual(JSON.parse(JSON.stringify(injected)), injected)
})

test('DshHost：没有 agent 的 turn-stopping 直接忽略', async () => {
  const fake = fakeCtx()
  const host = new DshHost(fake.ctx as never)
  let called = 0
  host.onTurnStopping(() => {
    called += 1
  })

  await fake.emit('agent/turn-stopping', { turn: 1, signal: new AbortController().signal })
  assert.equal(called, 0)
})

test('DshHost：fs/observed 把绝对路径与 actor.agent 交给处理器', () => {
  const fake = fakeCtx()
  const host = new DshHost(fake.ctx as never)
  const { agent } = fakeAgent()

  const seen: Array<{ path: string; agent?: unknown }> = []
  host.onObserved((path, actor) => {
    seen.push({ path, agent: actor })
  })

  fake.emit('fs/observed', { displayPath: '/repo/src/a.ts' }, { kind: 'present' }, { agent })
  assert.deepEqual(seen, [{ path: '/repo/src/a.ts', agent }])
})

test('DshHost：读文件不触发变更，写文件触发', () => {
  const fake = fakeCtx()
  const host = new DshHost(fake.ctx as never)
  const { agent } = fakeAgent()
  const seen: unknown[] = []
  host.onObserved((path) => seen.push(path))

  fake.emit('fs/observed', { displayPath: '/repo/a.ts' }, { kind: 'present' }, { name: 'read', agent })
  fake.emit('fs/observed', { displayPath: '/repo/a.ts' }, { kind: 'present' }, { name: 'grep', agent })
  assert.deepEqual(seen, [])

  fake.emit('fs/observed', { displayPath: '/repo/a.ts' }, { kind: 'present' }, { name: 'write', agent })
  assert.deepEqual(seen, ['/repo/a.ts'])
})

test('DshHost.ask：走 ctx.get("userQuestions")，返回选择的标签', async () => {
  const requests: any[] = []
  const fake = fakeCtx({
    userQuestions: {
      async ask(request: any) {
        requests.push(request)
        return { answers: [{ id: 'graphfs', selected: ['是，同步修改（推荐）'] }] }
      },
    },
  })
  const host = new DshHost(fake.ctx as never)
  const { agent } = fakeAgent()

  const answer = await host.ask({
    agent,
    header: 'GraphFS 一致性',
    question: '要我一并修改吗？',
    options: ['是，同步修改（推荐）', '不，只提醒'],
  })

  assert.equal(answer, '是，同步修改（推荐）')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].agent, agent)
  assert.deepEqual(
    requests[0].questions[0].options.map((option: { label: string }) => option.label),
    ['是，同步修改（推荐）', '不，只提醒'],
  )
})

test('DshHost.ask：服务缺失 / 没有 agent / 抛错 → null（调用方退回 steer）', async () => {
  const noService = new DshHost(fakeCtx().ctx as never)
  assert.equal(await noService.ask({ agent: {}, question: 'q', options: ['a'] }), null)

  const throwing = new DshHost(
    fakeCtx({
      userQuestions: {
        async ask() {
          throw new Error('CALLER_NOT_LIVE')
        },
      },
    }).ctx as never,
  )
  assert.equal(await throwing.ask({ agent: {}, question: 'q', options: ['a'] }), null)

  const noAgent = new DshHost(
    fakeCtx({ userQuestions: { async ask() { return { answers: [] } } } }).ctx as never,
  )
  assert.equal(await noAgent.ask({ question: 'q', options: ['a'] }), null)
})
