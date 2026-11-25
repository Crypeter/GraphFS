export interface RunResult {
  code: number
  changed: string[]
  stdout?: string
  stderr?: string
}

export interface Runner {
  /** 只执行图里声明过的命令；实现方负责超时与取消。 */
  run(spec: { kind: 'shell' | 'npm' | 'node'; command: string; outputs: string[] }, signal: AbortSignal): Promise<RunResult>
}
