import { createHash } from 'node:crypto'

/** 与 DSH 既有 README.i18n.yaml 同口径：sha256 的十六进制前 16 位（8 字节）。 */
export const HASH_HEX_LENGTH = 16

/** 对**已规范化**的文本取指纹。本函数不 trim、不去空行——那是 normalize 的职责。 */
export function digest16(text        )         {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, HASH_HEX_LENGTH)
}

/** 对原始字节取指纹（binary / bytes 规范化时使用）。 */
export function digestBytes(bytes            )         {
  return createHash('sha256').update(bytes).digest('hex').slice(0, HASH_HEX_LENGTH)
}

/** 空指纹：表示「尚未校验」，不会与任何真实指纹相等。 */
export const NO_HASH = ''


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/core/hash.ts