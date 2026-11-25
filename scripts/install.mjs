import { cp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 把 GraphFS 装进一个 DSH profile。
 *
 * 这是**图形界面安装的兜底**：GUI 走 pnpm 装包并自动应用 dsh.bundle，
 * 本脚本则在没装 pnpm、或想离线/可重复时直接把包装进 profile，并手动登记 bundle。
 *
 *   node scripts/install.mjs --profile ~/.dsh/profiles/desktop --yes
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const yes = args.includes('--yes')
const method = flag('method', 'copy')
const profileArg = flag('profile', join(homedir(), '.dsh/profiles/desktop'))
const profile = profileArg.replace(/^~/, homedir())
const pkgDir = join(profile, 'node_modules/dsh-graphfs')
const stage = join(profile, '.graphfs-pkg')

const ROW = `- id: graphfs
  name: dsh-graphfs
  config:
    mode: advise
    maxObligations: 5
`

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function havePnpm() {
  try {
    execFileSync('pnpm', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function main() {
  console.log(`profile: ${profile}`)
  const patchPath = join(profile, 'cordis.patch.yml')
  void patchPath
  if (!(await exists(patchPath))) throw new Error(`不是 DSH profile 目录（缺 cordis.patch.yml）：${profile}`)

  if (method === 'pnpm' && !havePnpm()) {
    console.log('!! 没找到 pnpm；改用 copy（插件零依赖，不需要包管理器）')
  }

  console.log('1) build')
  execFileSync(process.execPath, ['--no-warnings', join(ROOT, 'scripts/build.mjs')], { stdio: 'inherit' })

  console.log(`2) install → ${pkgDir}`)
  if (!yes) {
    console.log('   (dry-run) 清掉旧副本与遗留 stage，然后复制 lib + package.json')
  } else {
    await rm(pkgDir, { recursive: true, force: true })
    await rm(stage, { recursive: true, force: true })
    await mkdir(pkgDir, { recursive: true })
    await cp(join(ROOT, 'lib'), join(pkgDir, 'lib'), { recursive: true })
    await cp(join(ROOT, 'package.json'), join(pkgDir, 'package.json'))
    await cp(join(ROOT, 'cordis.patch.yml'), join(pkgDir, 'cordis.patch.yml'))
    await cp(join(ROOT, 'README.md'), join(pkgDir, 'README.md')).catch(() => undefined)
    console.log(`   installed ${(await exists(join(pkgDir, 'lib/index.js'))) ? 'lib/index.js ✓' : 'FAILED'}`)
  }

  console.log('3) register bundle in profile package.json')
  const manifestPath = join(profile, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (bundles.includes('dsh-graphfs')) {
    console.log('   已登记，跳过')
  } else if (yes) {
    manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles: [...bundles, 'dsh-graphfs'] } }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    console.log('   已加入 dsh.profile.bundles')
  } else {
    console.log('   (dry-run) 把 dsh-graphfs 追加到 dsh.profile.bundles')
  }

  console.log(`
完成${yes ? '' : '（dry-run，未写任何文件）'}。下一步：
  1. 完全退出并重启 DeepSeek Harness（不是只关窗口）。
     插件自带的 cordis.patch.yml 会被当作 profile overlay 应用，不需要手改 profile 的补丁文件；
  2. 在任意工作区开一个会话，看是否出现「可以初始化」的提示；
  3. 让它调 graphfs_init → graphfs_suggest → graphfs_link。
排查：若没反应，在 DSH 日志里搜 "graphfs"；确认
  ${pkgDir}/lib/index.js 存在，且 ${profile}/package.json 的 dsh.profile.bundles 里有 dsh-graphfs。
`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
