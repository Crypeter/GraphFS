import type { Mode } from './types.ts'
import type { NormalizerId } from './core/normalize.ts'

/** 没有图时怎么办：问用户 / 直接建 / 什么都不做。 */
export type AutoInit = 'ask' | 'always' | 'never'

/** 工作区级配置。CLI 与插件共用同一份形状。 */
export interface GraphFSConfig {
  /** 工作区根（绝对路径）。节点路径都相对于它。 */
  root: string
  /** 图文件位置；默认 `<root>/.graphfs/graph.yaml`，允许放在 root 之外（便于只读挂载）。 */
  graphPath: string
  mode: Mode
  normalize: NormalizerId
  maxFileBytes: number
  maxObligations: number
  maxDepth: number
  maxRounds: number
  /** 相对 root 的忽略 glob（只支持前缀与 `**` 尾缀两种形式）。 */
  ignore: string[]
  /** 新工作区没有图时：询问用户（默认）、自动建立、或不动。 */
  autoInit: AutoInit
  /** 检测到一致性漂移时，是否先弹一次确认框（"要我一起改吗"）。 */
  askOnChange: boolean
}

export const DEFAULT_IGNORES = [
  '.git',
  '.graphfs',
  'node_modules',
  '.idea',
  '.DS_Store',
  'dist',
  'build',
  '__pycache__',
]

export const DEFAULTS = {
  mode: 'advise' as Mode,
  normalize: 'text' as NormalizerId,
  maxFileBytes: 2 * 1024 * 1024,
  maxObligations: 5,
  maxDepth: 3,
  maxRounds: 2,
  ignore: DEFAULT_IGNORES,
  autoInit: 'ask' as AutoInit,
  askOnChange: true,
}

export type ConfigInput = Partial<Omit<GraphFSConfig, 'root'>> & { root: string }

export function resolveConfig(input: ConfigInput): GraphFSConfig {
  const root = input.root
  if (!root.startsWith('/')) throw new Error(`root must be absolute: ${root}`)

  const maxFileBytes = input.maxFileBytes ?? DEFAULTS.maxFileBytes
  const maxObligations = input.maxObligations ?? DEFAULTS.maxObligations
  const maxDepth = input.maxDepth ?? DEFAULTS.maxDepth
  const maxRounds = input.maxRounds ?? DEFAULTS.maxRounds

  for (const [name, value] of Object.entries({ maxFileBytes, maxObligations, maxDepth, maxRounds })) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  }

  const graphPath = input.graphPath ?? `${root.replace(/\/+$/, '')}/.graphfs/graph.yaml`

  return {
    root,
    graphPath,
    mode: input.mode ?? DEFAULTS.mode,
    normalize: input.normalize ?? DEFAULTS.normalize,
    maxFileBytes,
    maxObligations,
    maxDepth,
    maxRounds,
    ignore: input.ignore ?? DEFAULTS.ignore,
    autoInit: input.autoInit ?? DEFAULTS.autoInit,
    askOnChange: input.askOnChange ?? DEFAULTS.askOnChange,
  }
}
