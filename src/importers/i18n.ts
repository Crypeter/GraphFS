import { digest16 } from '../core/hash.ts'
import { normalizeI18nSection } from '../core/normalize.ts'
import type { Edge, GraphIssue, Node, Unit } from '../types.ts'

/**
 * `README.i18n.yaml` 导入器（M5，Spec §9.1）。
 *
 * 账本的结构（逆向自 DSH 0.2.2-rc.1，见 DSH_README双语一致性机制.md）：
 *   - 键 = 英文标题的 slug 路径（`/` 是第一个标题之前的前言）；**按文档顺序排列**；
 *   - 值 = 该节英文 / 中文正文的 16 位指纹（sha256 前 64 bit）；
 *   - 中文节**按位置**与英文节一一对应，不看标题文本。
 *
 * 两条实现上的关键决定：
 *
 * 1. **对齐用位置，不用键**。账本的 slug 实现在极端标题上与我们不同（重复空格、
 *    内联代码、撇号），13 个包里键与"按我们的 slug 复算"不一致，但顺序始终一致。
 *    因此按位置配对；键只用于命名与报错。
 * 2. **基线用账本值，复算只用于判定 verified**。这样"导入的 fromHash/toHash 与账本
 *    逐条相等"是可验证的事实；复算不上的记录（已知 26% 生成/链接区域）进 `unverified`，
 *    绝不静默改成一个"看起来对"的指纹（Spec §11.1）。
 */

export interface I18nSection {
  /** 账本键（英文 slug 路径，按我们的规则复算）。 */
  path: string
  /** 0 = 第一个标题之前，1.. = 第 n 个标题。 */
  index: number
  /** 参与哈希的文本（标题行 + 正文，已按 dsh-i18n-v1 归一）。 */
  text: string
  /** 1 起的原文行号范围（含标题行）。 */
  from: number
  to: number
  heading: string | null
}

export interface I18nPackageImport {
  packageDir: string
  nodes: Node[]
  edges: Edge[]
  issues: GraphIssue[]
  /** `path#key` 形式的未复现清单（不阻断导入）。 */
  unverified: string[]
  sections: number
  verified: number
}

export interface I18nImportInput {
  read: (path: string) => Promise<string | null>
  yamlPath: string
  enPath: string
  zhPath: string
  now?: string
  /** 节点 id 前缀（默认从 yamlPath 的目录推导）。 */
  idPrefix?: string
}

/** 与 DSH 账本同口径的标题 slug。 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/\//g, '-')
    .replace(/[\u2019']/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

interface RawSection {
  path: string
  heading: string | null
  lines: string[]
  from: number
  to: number
}

/**
 * 按 1~6 级标题切节；代码块整体不参与（围栏行也不参与）。
 * 节的范围是「本标题行 → 下一个标题之前」，所以标题前的 `<a id>` 与 `---` 属于上一节。
 */
export function sectionize(markdown: string): I18nSection[] {
  const raw: RawSection[] = []
  const stack: Array<{ level: number; slug: string }> = []
  let current: RawSection = { path: '/', heading: null, lines: [], from: 1, to: 0 }
  raw.push(current)

  const lines = markdown.split('\n')
  let inFence = false

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      current.to = i // 上一节的最后一行（1-based 的 i，因为当前行号是 i+1）
      const level = heading[1]!.length
      while (stack.length > 0 && stack.at(-1)!.level >= level) stack.pop()
      stack.push({ level, slug: slugifyHeading(heading[2]!.trim()) })
      current = {
        path: `/${stack.map((s) => s.slug).join('/')}`,
        heading: line,
        lines: [],
        from: i + 1,
        to: lines.length,
      }
      raw.push(current)
      continue
    }
    current.lines.push(line)
  }
  if (raw.length > 0) raw[raw.length - 1]!.to = lines.length

  return raw.map((section, index) => ({
    path: section.path,
    index,
    text: normalizeI18nSection(section.heading, section.lines),
    from: section.from,
    to: section.to,
    heading: section.heading,
  }))
}

export interface LedgerEntry {
  key: string
  en: string
  zh: string
}

/**
 * 解析账本；返回**按文件顺序**排列的记录（顺序就是文档顺序）。
 *
 * 这里故意不用通用 YAML 解析：16 位十六进制指纹有约 0.1% 的概率**全是数字**
 * （5,875 条记录里实测 9 条），YAML 会把它们当整数，前导零直接丢失。
 * 账本格式是固定的「键行 + en/zh 两行」，按行扫描既更稳，也保留了原始文本。
 */
export function parseLedger(source: string): LedgerEntry[] {
  const out: LedgerEntry[] = []
  let current: { key: string; en?: string; zh?: string } | null = null

  const flush = (): void => {
    if (current && current.en !== undefined && current.zh !== undefined) {
      out.push({ key: current.key, en: current.en, zh: current.zh })
    }
    current = null
  }

  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue

    const heading = /^(\/.*?):\s*$/.exec(line)
    if (heading) {
      flush()
      current = { key: heading[1]! }
      continue
    }

    const pair = /^(en|zh):\s*['"]?([0-9a-fA-F]{8,64})['"]?\s*$/.exec(line)
    if (pair && current) {
      current[pair[1] as 'en' | 'zh'] = pair[2]!.toLowerCase()
      continue
    }
    // 其它行（扩展字段、注释）忽略：账本只承诺 en/zh。
  }
  flush()
  return out
}

/** 单个包的导入（纯函数：只读入参给的 read）。 */
export async function importI18n(input: I18nImportInput): Promise<I18nPackageImport> {
  const now = input.now ?? new Date().toISOString()
  const result: I18nPackageImport = {
    packageDir: dirOf(input.yamlPath),
    nodes: [],
    edges: [],
    issues: [],
    unverified: [],
    sections: 0,
    verified: 0,
  }

  const [yamlText, enText, zhText] = await Promise.all([
    input.read(input.yamlPath),
    input.read(input.enPath),
    input.read(input.zhPath),
  ])
  if (yamlText === null || enText === null || zhText === null) {
    result.issues.push({
      code: 'GF_UNIT_MISMATCH',
      message: `${result.packageDir}: README.i18n.yaml / README.md / README.zh.md 缺一，跳过整包`,
    })
    return result
  }

  let ledger: LedgerEntry[]
  try {
    ledger = parseLedger(yamlText)
  } catch (error) {
    result.issues.push({
      code: 'GF_GRAPH_INVALID',
      message: `${result.packageDir}: ${(error as Error).message}`,
    })
    return result
  }

  const enSections = sectionize(enText)
  const zhSections = sectionize(zhText)
  result.sections = enSections.length

  if (enSections.length !== zhSections.length) {
    result.issues.push({
      code: 'GF_UNIT_MISMATCH',
      message: `${result.packageDir}: 英文 ${enSections.length} 节 vs 中文 ${zhSections.length} 节，结构漂移，跳过整包`,
    })
    return result
  }

  let sections = enSections
  if (ledger.length === sections.length) {
    // 顺序即文档顺序。
  } else if (ledger.length + 1 === sections.length && sections[0]?.path === '/') {
    // 少数账本不记前言（`/`）：跳过前言后按位置对齐。
    sections = sections.slice(1)
  } else {
    result.issues.push({
      code: 'GF_UNIT_MISMATCH',
      message: `${result.packageDir}: 账本 ${ledger.length} 条 vs 英文 ${sections.length} 节，无法按位置对齐，跳过整包`,
    })
    return result
  }

  const prefix = input.idPrefix ?? `i18n-${slugPath(result.packageDir)}`
  const zhByIndex = zhSections
  // 前言不在 sections 里时，索引要整体后移一位。
  const offset = sections === enSections ? 0 : 1

  for (let i = 0; i < ledger.length; i += 1) {
    const record = ledger[i]!
    const en = sections[i]!
    const zh = zhByIndex[i + offset]!
    if (!en || !zh) continue

    const enUnit = unitFor(en)
    const zhUnit = unitFor(zh)
    if (!enUnit || !zhUnit) {
      result.issues.push({
        code: 'GF_UNIT_MISMATCH',
        message: `${result.packageDir}#${record.key}: 前言为空，无法定位区域`,
      })
      continue
    }

    const enNode: Node = { id: `${prefix}-${i}`, path: input.enPath, unit: enUnit }
    const zhNode: Node = { id: `${prefix}-${i}-zh`, path: input.zhPath, unit: zhUnit }
    result.nodes.push(enNode, zhNode)

    const computedEn = digest16(en.text)
    const computedZh = digest16(zh.text)
    if (computedEn !== record.en || computedZh !== record.zh) {
      result.unverified.push(`${input.enPath}#${record.key}`)
      result.issues.push({
        code: 'GF_I18N_UNVERIFIED',
        message:
          `${input.enPath}#${record.key}: 账本 en=${record.en} zh=${record.zh}，` +
          `复算 en=${computedEn} zh=${computedZh}（生成/链接区域，按账本基线导入）`,
      })
    } else {
      result.verified += 1
    }

    const edgeId = `gf-i18n-${digest16(`${enNode.id}|${zhNode.id}`)}`
    result.edges.push({
      id: edgeId,
      from: enNode.id,
      to: zhNode.id,
      relation: 'translates',
      authority: 'from',
      trigger: 'from',
      counterpart: 'confirm',
      obligation: 'required',
      verdict: 'structural',
      policy: 'advise',
      fromHash: record.en,
      toHash: record.zh,
      verifiedAt: now,
    })
  }

  return result
}

/** 前言只能用行区间；其余节用标题序号（1 起）。 */
function unitFor(section: I18nSection): Unit | null {
  if (section.index > 0) return { kind: 'heading', index: section.index }
  if (section.to < section.from) return null
  return { kind: 'lines', from: section.from, to: section.to }
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '.' : path.slice(0, slash)
}

function slugPath(dir: string): string {
  return (
    dir
      .toLowerCase()
      .replace(/^[./]+/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'root'
  )
}
