import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphFS } from '../../src/workspace/graphfs.ts'

/** 生产者：把 src.md 变大写写进 out.md。 */
const UPPER = `node -e "const fs=require('fs');fs.writeFileSync('out.md',fs.readFileSync('src.md','utf8').toUpperCase())"`

async function workspace(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'graphfs-apply-'))
  for (const [path, text] of Object.entries(files)) {
    const abs = join(root, path)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, text, 'utf8')
  }
  return { root, graph: join(root, '.graphfs/graph.yaml') }
}

async function scenario(command = UPPER) {
  const { root, graph } = await workspace({ 'src.md': 'hello\n', 'out.md': 'HELLO\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await gfs.link({
    from: 'src',
    to: 'out',
    relation: 'generates',
    policy: 'auto',
    producer: { kind: 'shell', command, outputs: ['out.md'] },
  })
  // 改源：让生成物过期
  await writeFile(join(root, 'src.md'), 'hello world\n', 'utf8')
  return { root, graph, gfs }
}

test('dry-run：真跑命令、给出 diff、然后恢复原状', async () => {
  const { root, gfs } = await scenario()
  const plan = await gfs.plan()
  assert.equal(plan.obligations[0]!.kind, 'regenerate')

  const report = await gfs.apply(plan, { dryRun: true })
  const outcome = report.outcomes[0]!
  assert.equal(outcome.status, 'preview')
  assert.equal(outcome.outputs.length, 1)
  assert.equal(outcome.outputs[0]!.path, 'out.md')
  assert.match(outcome.outputs[0]!.diff.text, /\+HELLO WORLD/)

  assert.equal(await readFile(join(root, 'out.md'), 'utf8'), 'HELLO\n', '预览后必须恢复原文件')
  assert.equal((await gfs.check()).drift.length, 1, '预览不改变一致性状态')
})

test('真实执行：产物更新、基线重录、漂移消失', async () => {
  const { root, gfs } = await scenario()
  const plan = await gfs.plan()

  const report = await gfs.apply(plan, { dryRun: false })
  assert.equal(report.outcomes[0]!.status, 'applied')
  assert.equal(await readFile(join(root, 'out.md'), 'utf8'), 'HELLO WORLD\n')

  const after = await gfs.check()
  assert.equal(after.drift.length, 0)
  assert.equal(after.ok, true)
})

test('生成器失败：报 stderr，文件不动，状态仍是漂移', async () => {
  const { root, gfs } = await scenario('node -e "console.error(\'boom\'); process.exit(3)"')
  const plan = await gfs.plan()

  const report = await gfs.apply(plan, { dryRun: false })
  const outcome = report.outcomes[0]!
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.reason ?? '', /exited 3/)
  assert.match(outcome.stderr ?? '', /boom/)
  assert.equal(await readFile(join(root, 'out.md'), 'utf8'), 'HELLO\n')
  assert.equal((await gfs.check()).drift.length, 1)
})

test('非确定性边（policy 不是 auto）被跳过', async () => {
  const { root, graph } = await workspace({ 'a.md': '# a\n', 'b.md': '# b\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await gfs.link({ from: 'a', to: 'b', relation: 'translates' })
  await writeFile(join(root, 'a.md'), '# a2\n', 'utf8')

  const plan = await gfs.plan()
  const report = await gfs.apply(plan, { dryRun: true })
  assert.equal(report.outcomes[0]!.status, 'skipped')
  assert.match(report.outcomes[0]!.reason ?? '', /deterministic/)
})

test('二进制文件不会被建成节点，因此不能当生成物目标', async () => {
  const { root, graph } = await workspace({ 'src.md': 'x\n', 'out.bin': '\u0000binary' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()

  assert.equal(gfs.snapshot!.unmanaged.has('out.bin'), true, 'init 应把二进制标成 unmanaged')
  await assert.rejects(
    () =>
      gfs.link({
        from: 'src',
        to: 'out',
        relation: 'generates',
        policy: 'auto',
        producer: { kind: 'shell', command: 'node -e "0"', outputs: ['out.bin'] },
      }),
    /unknown node/,
  )
})

test('--edge 只处理指定边', async () => {
  const { root, graph } = await workspace({ 'src.md': 'a\n', 'out.md': 'A\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  const edge = await gfs.link({
    from: 'src',
    to: 'out',
    relation: 'generates',
    policy: 'auto',
    producer: { kind: 'shell', command: UPPER, outputs: ['out.md'] },
  })
  await writeFile(join(root, 'src.md'), 'b\n', 'utf8')

  const plan = await gfs.plan()
  const report = await gfs.apply(plan, { dryRun: true, only: ['gf-nope'] })
  assert.equal(report.outcomes.length, 0)

  const chosen = await gfs.apply(plan, { dryRun: true, only: [edge.id] })
  assert.equal(chosen.outcomes.length, 1)
})

/* ------------------------------------------------ F5：非确定性生成器降级 */

const RANDOM = `node -e "const fs=require('fs');fs.writeFileSync('out.md','v-'+Math.random()+'-'+Date.now())"`

test('F5：两次执行结果不同 → 标记 unstable，不写盘', async () => {
  const { root, gfs } = await scenario(RANDOM)
  const plan = await gfs.plan()

  const report = await gfs.apply(plan, { dryRun: false })
  const outcome = report.outcomes[0]!
  assert.equal(outcome.status, 'unstable')
  assert.match(outcome.reason ?? '', /not deterministic/)

  assert.equal(await readFile(join(root, 'out.md'), 'utf8'), 'HELLO\n', '不确定的生成器不能写盘')
  assert.equal((await gfs.check()).drift.length, 1, '基线不推进')
})

test('F5：显式 allowUnstable 才允许写回', async () => {
  const { root, gfs } = await scenario(RANDOM)
  const plan = await gfs.plan()

  const report = await gfs.apply(plan, { dryRun: false, allowUnstable: true })
  assert.equal(report.outcomes[0]!.status, 'applied')
  assert.match(await readFile(join(root, 'out.md'), 'utf8'), /^v-/)
})

test('F5：dry-run 也会做两次一致，预览不写盘', async () => {
  const { root, gfs } = await scenario(RANDOM)
  const plan = await gfs.plan()

  const report = await gfs.apply(plan, { dryRun: true })
  assert.equal(report.outcomes[0]!.status, 'unstable')
  assert.equal(await readFile(join(root, 'out.md'), 'utf8'), 'HELLO\n')
})

test('场景 3：直接改派生物 → 义务指向产物，apply 从源重新生成', async () => {
  const { root, graph } = await workspace({ 'src.md': 'hello\n', 'out.md': 'HELLO\n' })
  const gfs = await GraphFS.open({ root, graphPath: graph })
  await gfs.init()
  await gfs.link({
    from: 'src',
    to: 'out',
    relation: 'generates',
    policy: 'auto',
    producer: { kind: 'shell', command: UPPER, outputs: ['out.md'] },
  })

  // 绕过源文件，直接篡改产物
  await writeFile(join(root, 'out.md'), 'TAMPERED\n', 'utf8')
  const plan = await gfs.plan()
  assert.equal(plan.obligations.length, 1)
  assert.equal(plan.obligations[0]!.target, 'out')
  assert.equal(plan.obligations[0]!.kind, 'regenerate')

  const report = await gfs.apply(plan, { dryRun: false })
  assert.equal(report.outcomes[0]!.status, 'applied')
  assert.equal(await readFile(join(root, 'out.md'), 'utf8'), 'HELLO\n')
  assert.equal((await gfs.check()).drift.length, 0)
})
