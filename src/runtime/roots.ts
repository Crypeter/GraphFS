import { GraphFS } from '../workspace/graphfs.ts'
import type { ConfigInputShape } from '../config-schema.ts'

/**
 * 工作区根目录必须**按会话解析**，不能在 apply 时定死：
 * DSH 是常驻进程，`process.cwd()` 是 profile 目录，一个 profile 服务多个工作区。
 *
 * 真实 API（`dsh-working-directory`）：
 *   ctx.workingDirectory.ensure(agent, signal) → 当前目录（并校验存在）
 *   ctx.workingDirectory.get(session)          → 同步读已提交的目录
 */
export class RootRegistry {
  private readonly ctx: any
  private readonly config: ConfigInputShape
  private readonly byRoot = new Map<string, Promise<GraphFS>>()
  private readonly fallbackRoot?: string

  constructor(ctx: any, config: ConfigInputShape, fallbackRoot?: string) {
    this.ctx = ctx
    this.config = config
    this.fallbackRoot = fallbackRoot
  }

  /** 从执行上下文拿 agent 的当前目录；拿不到才退回 fallback。 */
  async rootOf(agent: any, signal?: AbortSignal): Promise<string> {
    const wd = this.ctx?.workingDirectory
    try {
      if (agent && typeof wd?.ensure === 'function') return await wd.ensure(agent, signal)
      if (agent?.session && typeof wd?.get === 'function') return wd.get(agent.session)
    } catch {
      /* 目录不可用时退回 fallback，而不是把整个插件弄挂 */
    }
    return this.fallbackRoot ?? process.cwd()
  }

  async forAgent(agent: any, signal?: AbortSignal): Promise<GraphFS> {
    return await this.forRoot(await this.rootOf(agent, signal))
  }

  forRoot(root: string): Promise<GraphFS> {
    let pending = this.byRoot.get(root)
    if (!pending) {
      pending = GraphFS.open({
        root,
        graphPath: `${root.replace(/\/+$/, '')}/.graphfs/graph.yaml`,
        mode: this.config.mode,
        normalize: this.config.normalize,
        maxRounds: this.config.maxRounds,
        maxObligations: this.config.maxObligations,
        maxDepth: this.config.maxDepth,
        maxFileBytes: this.config.maxFileBytes,
        ignore: this.config.ignore,
        actor: 'plugin',
      }).catch((error: unknown) => {
        this.byRoot.delete(root)
        throw error
      })
      this.byRoot.set(root, pending)
    }
    return pending
  }

  has(root: string): boolean {
    return this.byRoot.has(root)
  }
}
