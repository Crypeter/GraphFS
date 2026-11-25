import type { Context } from '@deepseek-ai/cordis'
import { Config as ConfigSchema, normalizeConfig } from './config-schema.ts'
import type { ConfigInputShape } from './config-schema.ts'
import { RootRegistry } from './runtime/roots.ts'
import { DshHost } from './adapters/dsh-host.ts'
import { Detector } from './engine/detector.ts'
import { installLifecycle } from './runtime/lifecycle.ts'
import { registerTools } from './tools/index.ts'
import { projectConfigPath } from './adapters/llm-config.ts'

/**
 * DSH 插件入口（Spec §8）。
 *
 * 只做装配：配置 → FileIo（ctx.fs）→ 门面 → 生命周期 → 工具 → 一句静态提示。
 * 所有判断都在 workspace/engine/runtime 里，且都能在无宿主环境下测试。
 */

export const name = 'graphfs'
export const inject = ['tools', 'fs', 'systemPrompt', 'agents', 'workingDirectory']

export const Config = ConfigSchema

export function apply(ctx: Context, rawConfig: ConfigInputShape): void {
  const config = normalizeConfig(rawConfig)
  if (config.mode === 'off') return

  /**
   * 关键：根目录**按会话解析**，不在 apply 时定死。
   * DSH 是常驻进程，`process.cwd()` 是 profile 目录；一个 profile 服务多个工作区。
   * 真正的目录来自 `ctx.workingDirectory.ensure(agent, signal)`（见 runtime/roots.ts）。
   */
  const roots = new RootRegistry(ctx, config)

  const detector = new Detector()
  const host = new DshHost(ctx as never)
  const disposeLifecycle = installLifecycle({
    host,
    roots,
    detector,
    config: {
      ...config,
      root: '',
      graphPath: '',
    },
  })

  ctx.effect(() => disposeLifecycle, 'graphfs lifecycle teardown')
  registerTools(ctx, roots, { ...config, root: '', graphPath: '' } as never, () => ({
    interactive: host.hasUserQuestions(),
    lastAskError: host.lastAskError,
  }))

  // 只放一句静态提示；易变内容靠回合内 steer，避免每步打碎 KV cache。
  ctx.systemPrompt.section({
    name: 'graphfs',
    order: ctx.systemPrompt.getSectionOrder('TOOL_READ'),
    text: () =>
      '新建文件用 graphfs_create 并声明它与谁一致；确实不需要一致性的（图片、压缩包、生成物）用 unmanaged: true。' +
      '工作区还没有一致性图时，不要抢先调用 graphfs_init：插件会在回合结束时先询问用户。',
  })
}
