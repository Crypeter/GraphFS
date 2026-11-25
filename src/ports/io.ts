/** 唯一的文件系统端口：插件用 ctx.fs 实现，CLI 用 node:fs 实现。路径一律相对 root。 */
export interface FileIo {
  readText(rel: string, signal?: AbortSignal): Promise<string | null>
  /** 返回写入后的版本（没有版本概念的后端返回空串）。 */
  writeText(rel: string, text: string, guard?: { expectedVersion?: string }): Promise<string>
  remove(rel: string): Promise<boolean>
  move(from: string, to: string): Promise<void>
  /** 递归列文件（相对路径，已排除目录）。 */
  list(relDir: string, opts?: { depth?: number }): Promise<string[]>
  /** 不可用时返回 null，调用方退化为轮询。 */
  watch?(relPath: string, onChange: () => void): Promise<(() => Promise<void>) | null>
}
