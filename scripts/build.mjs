import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

/**
 * 零依赖构建：用 Node 自带的类型擦除把 src/**.ts 变成 lib/**.js。
 *
 * 为什么需要编译：DSH 跑在 node_modules 里，而 Node 的类型擦除**不作用于 node_modules**。
 * 为什么不用 tsc：本仓库零依赖，也不想为了构建引入工具链；
 * 我们的源码只用了可擦除语法（没有 enum / namespace / 参数属性），正好够用。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')
const OUT = join(ROOT, 'lib')

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(path)))
    else if (entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

/** 相对 specifier 的 `.ts` 要改成 `.js`——Node 的 ESM 解析要求真实文件名。 */
function rewriteSpecifiers(code) {
  return code.replace(/(from\s+['"]|import\s*\(\s*['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g, (_m, head, spec, tail) => `${head}${spec}.js${tail}`)
}

await rm(OUT, { recursive: true, force: true })
const files = await walk(SRC)
let written = 0

for (const file of files) {
  const source = await readFile(file, 'utf8')
  const js = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: file })
  const target = join(OUT, relative(SRC, file).replace(/\.ts$/, '.js'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, rewriteSpecifiers(js), 'utf8')
  written += 1
}

console.log(`built ${written} files → lib/`)
