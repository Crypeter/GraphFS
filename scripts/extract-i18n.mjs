#!/usr/bin/env node
/**
 * 从 DSH 安装包里抽出 i18n 三件套（README.md / README.zh.md / README.i18n.yaml）。
 *
 * 用途：`graphfs import i18n` 的金标准回归——真实数据在 app.asar 里，
 * 不能直接当目录读，所以先铺到临时目录，再让导入器把它当成一个普通工作区。
 *
 *   node scripts/extract-i18n.mjs [--out .tmp/i18n] [--asar <path>]
 *
 * 只复制这三个文件；不依赖 asar 库（手写头部解析，见 verify_i18n.mjs 的同一套逻辑）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

/** 只读打开 asar：list() / read(path) / has(path)。 */
export function openAsar(file) {
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(4)
  const headerBuf = Buffer.alloc(headerSize)
  fs.readSync(fd, headerBuf, 0, headerSize, 8)
  const jsonSize = headerBuf.readUInt32LE(4)
  const root = JSON.parse(headerBuf.subarray(8, 8 + jsonSize).toString('utf8'))
  const dataStart = 8 + headerSize

  const index = new Map()
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const p = `${prefix}/${name}`
      if (value.files) walk(value, p)
      else index.set(p, value)
    }
  }
  walk(root, '')

  return {
    list: () => [...index.keys()],
    has: (p) => index.has(p),
    read(p) {
      const entry = index.get(p)
      if (!entry) return null
      const buf = Buffer.alloc(entry.size)
      fs.readSync(fd, buf, 0, entry.size, dataStart + Number(entry.offset))
      return buf.toString('utf8')
    },
    close: () => fs.closeSync(fd),
  }
}

/** 抽取到 outDir；返回 { packages, files, skipped }。 */
export function extractI18n(input) {
  const asar = input.asarFile ? openAsar(input.asarFile) : openAsar(DEFAULT_ASAR)
  let packages = 0
  let files = 0
  let skipped = 0
  try {
    const targets = asar
      .list()
      .filter((p) => p.endsWith('/README.i18n.yaml'))
      .map((p) => p.replace('/README.i18n.yaml', ''))

    for (const dir of targets) {
      // `/dsh/node_modules/@scope/pkg` → `@scope/pkg`：
      // 既去掉 asar 根下的 `dsh/`，也去掉 `node_modules/`（否则会被工作区的忽略规则吃掉）。
      const parts = dir.split('/').filter(Boolean).slice(1)
      if (parts[0] === 'node_modules') parts.shift()
      const rel = parts.join('/')
      const out = path.join(input.outDir, rel)
      const trio = ['README.md', 'README.zh.md', 'README.i18n.yaml']
      const texts = trio.map((name) => asar.read(`${dir}/${name}`))
      if (texts.some((text) => text === null)) {
        skipped += 1
        continue
      }
      fs.mkdirSync(out, { recursive: true })
      trio.forEach((name, i) => {
        fs.writeFileSync(path.join(out, name), texts[i], 'utf8')
        files += 1
      })
      packages += 1
    }
  } finally {
    asar.close()
  }
  return { packages, files, skipped }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const value = (name, fallback) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : fallback
  }
  const outDir = path.resolve(value('out', '.tmp/i18n'))
  const asarFile = value('asar', process.env.DSH_ASAR ?? DEFAULT_ASAR)
  if (!fs.existsSync(asarFile)) {
    console.error(`找不到 DSH 安装包：${asarFile}`)
    process.exit(1)
  }
  fs.rmSync(outDir, { recursive: true, force: true })
  const result = extractI18n({ outDir, asarFile })
  console.log(`extracted ${result.packages} packages, ${result.files} files → ${outDir}`)
  if (result.skipped > 0) console.log(`skipped ${result.skipped} (missing README pair)`)
}
