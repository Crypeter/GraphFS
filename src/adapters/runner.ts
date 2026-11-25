import { spawn } from 'node:child_process'
import type { Runner, RunResult } from '../ports/runner.ts'
import { GraphFSError } from '../types.ts'

/**
 * producer 执行器（CLI 版）：`node:child_process`，cwd 固定为工作区根。
 *
 * 三条约束（Spec §6.8）：
 *   1. 只跑图里声明的命令，不接受运行时拼接；
 *   2. 超时 + 可取消；
 *   3. 非零退出一律视为失败，附 stderr 尾部（决策要看原因，不是看"失败了"）。
 */
export class NodeRunner implements Runner {
  private readonly root: string
  private readonly timeoutMs: number

  constructor(root: string, timeoutMs = 120_000) {
    this.root = root
    this.timeoutMs = timeoutMs
  }

  async run(
    spec: { kind: 'shell' | 'npm' | 'node'; command: string; outputs: string[] },
    signal: AbortSignal,
  ): Promise<RunResult> {
    return await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(spec.command, {
        cwd: this.root,
        shell: true,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk)
        if (stdout.length > 64_000) stdout = stdout.slice(-64_000)
      })
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
        if (stderr.length > 64_000) stderr = stderr.slice(-64_000)
      })

      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new GraphFSError(`producer timed out after ${this.timeoutMs}ms: ${spec.command}`, 'GF_PRODUCER_FAILED'))
      }, this.timeoutMs)

      const onAbort = () => child.kill('SIGTERM')
      signal.addEventListener('abort', onAbort, { once: true })

      child.on('error', (error) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        reject(new GraphFSError(`cannot start producer: ${error.message}`, 'GF_PRODUCER_FAILED'))
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve({ code: code ?? 1, changed: [], stdout, stderr })
      })
    })
  }
}
