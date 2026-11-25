/**
 * 内容规范化：决定「什么算变」。
 *
 * 三种口径（GraphFS_Spec.md §4.2）：
 *  - text        ：去 BOM、CRLF→LF、逐行 rstrip、末尾统一单换行。默认值，避免换行/空白造成的假漂移。
 *  - bytes       ：原样返回（调用方改用 digestBytes）。
 *  - dsh-i18n-v1 ：与 DSH 的 README.i18n.yaml 逐字对齐——逐行 trim、丢空行、剔除代码块、末尾不加换行。
 */

export type NormalizerId = 'text' | 'bytes' | 'dsh-i18n-v1'

const BOM = '\uFEFF'

/** 去掉行尾空白（只处理空格与制表符，不动全角空格）。 */
function rstrip(line: string): string {
  return line.replace(/[ \t]+$/, '')
}

/** 统一换行并去 BOM。 */
function toLf(input: string): string {
  const noBom = input.startsWith(BOM) ? input.slice(BOM.length) : input
  return noBom.replace(/\r\n?/g, '\n')
}

/**
 * text 口径：换行、行尾空白、末尾换行的差异都不算变更。
 * 空输入返回空串（不是 "\n"）。
 */
export function normalizeText(input: string): string {
  const body = toLf(input)
    .split('\n')
    .map(rstrip)
    .join('\n')
    .replace(/\n+$/, '')
  return body === '' ? '' : `${body}\n`
}

/**
 * dsh-i18n-v1：逐行 trim → 丢空行 → 剔除 ``` 围栏（含围栏行本身）→ '\n' 连接、末尾无换行。
 * heading 行作为普通行参与（调用方把它放在最前）。
 */
export function normalizeI18nText(input: string): string {
  const out: string[] = []
  let inFence = false
  for (const raw of toLf(input).split('\n')) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const line = raw.trim()
    if (line === '') continue
    out.push(line)
  }
  return out.join('\n')
}

/** 便于按「标题 + 正文行」组装一个节。 */
export function normalizeI18nSection(headingLine: string | null, bodyLines: string[]): string {
  const parts = headingLine === null ? bodyLines : [headingLine, ...bodyLines]
  return normalizeI18nText(parts.join('\n'))
}

export function normalize(input: string, id: NormalizerId): string {
  switch (id) {
    case 'text':
      return normalizeText(input)
    case 'dsh-i18n-v1':
      return normalizeI18nText(input)
    case 'bytes':
      return input
    default: {
      const never: never = id
      throw new Error(`unknown normalizer: ${String(never)}`)
    }
  }
}
