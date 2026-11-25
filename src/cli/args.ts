import { resolve as resolvePath } from 'node:path'
import { GraphFSError } from '../types.ts'

export interface Args {
  command: string
  root: string
  graph?: string
  json: boolean
  force: boolean
  flags: Map<string, string>
  /** 可重复的选项（如 --to）。 */
  multi: Map<string, string[]>
  /** 位置参数。 */
  rest: string[]
}

export const USAGE = `graphfs —— 工作区一致性图

用法：
  graphfs <command> --root <dir> [--graph <file>] [--json]

命令：
  init        扫描工作区、生成 .graphfs/graph.yaml，并自动采纳高置信关系
              （import / #include / 译文 / 同名测试；默认开）
              --force            覆盖已有图
              --no-suggest       只建节点骨架，不自动建边
  suggest     发现候选边（只读；没有图也能跑）
              --write            采纳（默认只打印；单次最多 50 条，需 --force 突破）
              --min-confidence   采纳阈值，默认 0.7
              --from-file <json> 并入模型提案（需要已有图）
              --all              全量重扫（默认只提「未覆盖的文件」）
              --pack             输出提示包（给模型看，不调用模型）
              --deep             调用模型提边（需 GRAPHFS_LLM_API_KEY）
  check       只读校验，有漂移/冲突/缺失时退出码 1
  plan        规划义务（谁该因为谁而更新）
  apply       执行确定性边（policy: auto + producer）
              graphfs apply                预览：真跑命令、看 diff、再恢复原状
              graphfs apply --apply --yes  真实写盘并重录基线
              --edge <id>                  只处理某条边
  ack         认可漂移并用当前指纹重录基线（写审计：谁/何时/为什么）
              graphfs ack <edgeId> --reason "<为什么接受>"
  journal     查看审计日志（.graphfs/audit/journal.jsonl）
              graphfs journal [--limit 50] [--json]
  import      批量导入（目前只有 i18n）
              graphfs import i18n --root <dsl-repo> [--dir packages] [--write]
              --normalize dsh-i18n-v1    i18n 账本必须用这个口径（导入器会强制）
  ui          启动只读监控面板（本地 HTTP，默认 127.0.0.1:8787）
              graphfs ui [--port 8787] [--host 127.0.0.1]
  status      图概览
  attach      把新文件接进图（新建文件必须做这一步）
              graphfs attach <path> --to <node|path> [--to ...] --relation <r> [--as from|to]
              graphfs attach <path> --unmanaged       声明「不需要关系」
  link        手工建边
              --from <node> --to <node> --relation <mirror|translates|generates|documents|constrains|related>
              [--authority from|to|none] [--trigger from|to|both|none]
              [--counterpart absorb|confirm|ignore] [--obligation required|advisory|silent]
              [--policy auto --command "<shell cmd>" --outputs a.md,b.md]   确定性边
  llm         模型配置（给 suggest --deep 用）
              graphfs llm setup [--local] [--force]   生成配置模板（apiKey 留空）
              graphfs llm status                      查看生效的配置（key 只显示掩码）
  help        显示本帮助

全局选项：
  --root <dir>   工作区根；默认当前目录（相对路径会转绝对）
  --graph <file> 图文件；默认 <root>/.graphfs/graph.yaml
  --normalize <text|bytes|dsh-i18n-v1>  哈希口径（默认 text；i18n 导入必须是 dsh-i18n-v1）
  --json         机器可读输出

示例：
  graphfs init --root ~/code/myproj --suggest
  graphfs check --root ~/code/myproj
  graphfs suggest --root ~/code/myproj
  graphfs plan --root ~/code/myproj --json
  graphfs apply --root ~/code/myproj --edge gf-1a2b3c4d --apply --yes
`

export function parseArgs(argv: string[]): Args {
  const command = argv[0]
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return {
      command: 'help',
      root: process.cwd(),
      json: false,
      force: false,
      flags: new Map(),
      multi: new Map(),
      rest: [],
    }
  }
  if (command.startsWith('-')) {
    throw new GraphFSError('缺少命令；运行 `graphfs help` 查看用法', 'GF_GRAPH_INVALID')
  }
  const flags = new Map<string, string>()
  const multi = new Map<string, string[]>()
  const rest: string[] = []
  let graph: string | undefined
  let root = process.cwd()

  // 反过来列：**只有这里列出的 flag 才吃下一个参数**，其余一律当布尔。
  // 之前是"列出布尔"，结果每加一个开关（--deep / --pack / --yes）都会吞掉后面的参数，
  // 已经踩过三次；反过来之后，漏写只会让参数落进 rest，不会静默改变别的选项。
  const VALUED = new Set([
    'root', 'graph', 'to', 'from', 'relation', 'authority', 'trigger', 'counterpart',
    'obligation', 'policy', 'command', 'outputs', 'from-file', 'min-confidence',
    'max-files', 'max-candidates', 'reason', 'edge', 'as', 'path',
    'normalize', 'limit', 'dir', 'port', 'host',
  ])

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) {
      rest.push(arg)
      continue
    }
    const [rawKey, inline] = arg.slice(2).split('=')
    const key = rawKey!
    const value = inline ?? (VALUED.has(key) ? (argv[i + 1] ?? '') : '')
    if (inline === undefined && VALUED.has(key)) i += 1

    if (key === 'root') root = resolvePath(value)
    else if (key === 'graph') graph = value
    else if (key === 'to') {
      const list = multi.get('to') ?? []
      list.push(value)
      multi.set('to', list)
    } else flags.set(key, value)
  }

  return {
    command,
    root,
    graph,
    json: argv.includes('--json'),
    force: argv.includes('--force'),
    flags,
    multi,
    rest,
  }
}

