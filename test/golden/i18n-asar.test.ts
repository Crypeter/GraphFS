import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphFS } from '../../src/workspace/graphfs.ts'
import { parseLedger } from '../../src/importers/i18n.ts'
import { DEFAULT_ASAR, extractI18n } from '../../scripts/extract-i18n.mjs'

/**
 * 金标准（M5 / Intent §11.1）：
 * 拿 DSH 安装包里**全部** README.i18n.yaml 跑一遍导入，验证
 *   1. 每个账本记录都变成一条边，且 fromHash/toHash 与账本逐字相等（多重集比较，不依赖顺序假设）；
 *   2. `check` 的 clean / drift 数量与导入器自报的 verified / unverified 完全一致
 *      ——这两条代码路径不同（一个走 sectionize，一个走 sliceUnit+FsFingerprint），
 *      数量对得上才说明区域定位没有偏差；
 *   3. 重复导入幂等。
 *
 * 没有安装 DSH 的机器上自动跳过（不把本机路径变成 CI 的硬依赖）。
 */
test('金标准：DSH 的 README.i18n.yaml 全量导入零差异', async (t) => {
  if (!existsSync(DEFAULT_ASAR)) {
    t.skip(`没有 DSH 安装包：${DEFAULT_ASAR}`)
    return
  }

  const outDir = await mkdtemp(join(tmpdir(), 'graphfs-golden-'))
  try {
    const extracted = extractI18n({ outDir, asarFile: DEFAULT_ASAR })
    assert.ok(extracted.packages >= 300, `只抽到 ${extracted.packages} 个包`)

    const gfs = await GraphFS.open({ root: outDir, actor: 'golden', normalize: 'dsh-i18n-v1' })
    const report = await gfs.importI18n({ write: true })

    // 1) 账本记录 → 边，逐条比哈希
    const expected = new Map<string, number>()
    let records = 0
    for (const yamlPath of await listLedgers(outDir)) {
      const source = await readFile(join(outDir, yamlPath), 'utf8')
      for (const entry of parseLedger(source)) {
        records += 1
        const key = `${entry.en}:${entry.zh}`
        expected.set(key, (expected.get(key) ?? 0) + 1)
      }
    }

    assert.equal(report.packages, extracted.packages)
    assert.equal(report.edges, records, '每条账本记录都应有且只有一条边')

    const actual = new Map<string, number>()
    for (const edge of gfs.snapshot!.edges.values()) {
      const key = `${edge.fromHash}:${edge.toHash}`
      actual.set(key, (actual.get(key) ?? 0) + 1)
    }
    assert.equal(actual.size, expected.size, '哈希对的多重集大小应相等')
    for (const [key, count] of expected) {
      assert.equal(actual.get(key), count, `账本记录未按原值导入：${key}`)
    }

    // 2) 复算路径与导入路径对账
    const check = await gfs.check()
    assert.equal(check.dangling.length, 0)
    assert.equal(check.unhashable.length, 0)
    assert.equal(check.conflicts.length, 0)
    assert.equal(check.clean, report.verified, 'clean 必须等于 verified')
    assert.equal(check.drift.length, report.unverified, 'drift 必须等于 unverified')

    const rate = report.verified / report.edges
    console.log(
      `golden: ${report.packages} packages / ${report.edges} edges, ` +
        `verified ${report.verified} (${(rate * 100).toFixed(1)}%), unverified ${report.unverified}`,
    )
    // 与 DSH_README双语一致性机制.md 记录的 73.8% 同一个量级（生成/链接区域不可复现）。
    assert.ok(rate > 0.7, `复现率过低：${(rate * 100).toFixed(1)}%`)
    assert.ok(rate < 0.8, `复现率异常偏高：${(rate * 100).toFixed(1)}%`)

    // 3) 幂等
    const again = await gfs.importI18n({ write: true })
    assert.equal(again.nodes, 0)
    assert.equal(again.edges, 0)
    assert.equal((await gfs.check()).clean, check.clean)
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

async function listLedgers(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await listLedgers(root, rel)))
    else if (entry.name === 'README.i18n.yaml') out.push(rel)
  }
  return out
}
