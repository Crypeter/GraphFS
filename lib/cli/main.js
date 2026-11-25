#!/usr/bin/env node
import { parseArgs, USAGE } from './args.js'
import { GraphFS } from '../workspace/graphfs.js'
                                                                                    
                                                        
import { renderPackMarkdown } from '../importers/pack.js'
import { requestCandidates } from '../adapters/llm.js'
import { globalConfigPath, maskKey, projectConfigPath, resolveModelConfig, templateConfig, writeTemplate } from '../adapters/llm-config.js'
import { parseProposals } from '../importers/proposals.js'
import { GraphFSError } from '../types.js'
                                       
import { startUi } from '../ui/server.js'

// `graphfs check --json | head` 这类管道会提前关闭 stdout；忽略 EPIPE，别让它把命令打崩。
process.stdout.on('error', (error                       ) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

function indent(text        , pad        )         {
  return text
    .split('\n')
    .map((line) => `${pad}${line}`)
    .join('\n')
}

function printJson(value         )       {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function renderCheck(report             )         {
  const lines           = []
  lines.push(`root    ${report.root}`)
  lines.push(`graph   ${report.graphPath}`)
  lines.push(`nodes   ${report.counts.nodes}   edges ${report.counts.edges}`)
  lines.push('')
  lines.push(`✔ clean ${report.clean}`)

  if (report.drift.length > 0) {
    lines.push(`✘ drift ${report.drift.length}`)
    for (const item of report.drift) {
      const flag = item.bothMoved ? ' (两端都变，按权威重同步)' : ''
      lines.push(`   ${item.edgeId}  ${item.side} 变了${flag}`)
      lines.push(`      ${item.from} → ${item.to}  [${item.relation}]`)
    }
  }
  if (report.conflicts.length > 0) {
    lines.push(`✘ conflicts ${report.conflicts.length}`)
    for (const item of report.conflicts) lines.push(`   ${item.edgeId}  ${item.from} ↔ ${item.to}`)
  }
  if (report.dangling.length > 0) {
    lines.push(`✘ missing ${report.dangling.length}`)
    for (const item of report.dangling) lines.push(`   ${item.ref}  ${item.path ?? ''}`)
  }
  if (report.counterpart.length > 0) {
    lines.push(`· counterpart ${report.counterpart.length}`)
    for (const item of report.counterpart) lines.push(`   ${item.edgeId}  ${item.side} 侧变更 → ${item.action}`)
  }
  if (report.unhashable.length > 0) {
    lines.push(`· unhashable ${report.unhashable.length}`)
    for (const item of report.unhashable) lines.push(`   ${item.path}  ${item.reason}`)
  }
  if (report.orphans.length > 0) {
    lines.push(`· 未声明关系的文件 ${report.orphans.length}`)
    for (const item of report.orphans.slice(0, 10)) lines.push(`   ${item}`)
    if (report.orphans.length > 10) lines.push(`   …还有 ${report.orphans.length - 10} 个`)
    lines.push('   处理：graphfs attach <file> --to <node> --relation <r>  或  --unmanaged')
  }
  if (report.unlinked.length > 0) {
    lines.push(`· 孤立节点 ${report.unlinked.length}`)
    for (const item of report.unlinked.slice(0, 10)) lines.push(`   ${item}`)
  }
  if (report.issues.length > 0) {
    lines.push(`· issues ${report.issues.length}`)
    for (const item of report.issues) lines.push(`   [${item.code}] ${item.message}`)
  }
  lines.push('')
  lines.push(report.ok ? 'OK' : 'DRIFT')
  return lines.join('\n')
}

function renderPlan(plan      )         {
  const lines = [`staleness(required) ${plan.stalenessBefore}`, `obligations ${plan.obligations.length}${plan.truncated ? ' (截断)' : ''}`]
  for (const obligation of plan.obligations) {
    lines.push(
      `  [${obligation.severity}] ${obligation.edgeId}: 更新 ${obligation.target}（因 ${obligation.cause} 变了）`,
    )
  }
  for (const digested of plan.digested) {
    lines.push(`  [${digested.action}] ${digested.edgeId}: ${digested.node} 单侧变更，已按 counterpart 消化`)
  }
  return lines.join('\n')
}

function renderCandidates(candidates             )         {
  const lines = [`candidates ${candidates.length}`]
  for (const c of candidates) {
    lines.push(
      `  [${c.confidence.toFixed(2)}] ${c.relation.padEnd(10)} ${c.fromPath} → ${c.toPath}`,
    )
    lines.push(`           ${c.evidence}`)
  }
  return lines.join('\n')
}

function renderStatus(status              )         {
  const relations = Object.entries(status.byRelation)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  return [
    `root    ${status.root}`,
    `graph   ${status.graphPath}`,
    `nodes   ${status.nodes}`,
    `edges   ${status.edges}  ${relations}`,
    `未校验的边（缺基线）：${status.missingHash}`,
  ].join('\n')
}

function renderAudit(entries                                )         {
  if (entries.length === 0) return '审计日志为空'
  return entries
    .map((entry) => {
      const at = String(entry.at ?? '').replace('T', ' ').replace(/\..*$/, '')
      const kind = String(entry.kind ?? '?').padEnd(7)
      const target = entry.edgeId ? ` ${String(entry.edgeId)}` : entry.node ? ` ${String(entry.node)}` : ''
      const actor = entry.actor ? `  by ${String(entry.actor)}` : ''
      const detail = entry.detail ? `  ${JSON.stringify(entry.detail)}` : ''
      return `${at}  ${kind}${target}${actor}${detail}`
    })
    .join('\n')
}

function renderImport(report            )         {
  const lines = [
    `packages ${report.packages}  skipped ${report.skipped}`,
    `nodes ${report.nodes}  edges ${report.edges}`,
    `verified ${report.verified}  unverified ${report.unverified}`,
  ]
  if (report.unverifiedList.length > 0) {
    lines.push('')
    lines.push('未复现（账本与正文不一致，已按账本基线导入）：')
    for (const item of report.unverifiedList.slice(0, 20)) lines.push(`  ${item}`)
    if (report.unverifiedList.length > 20) lines.push(`  …还有 ${report.unverifiedList.length - 20} 条`)
  }
  const mismatched = report.issues.filter((issue) => issue.code === 'GF_UNIT_MISMATCH')
  if (mismatched.length > 0) {
    lines.push('')
    lines.push('跳过的包（结构漂移）：')
    for (const issue of mismatched.slice(0, 10)) lines.push(`  ${issue.message}`)
  }
  lines.push('')
  lines.push(report.write ? '已写入 graph.yaml' : '预览（未写盘）。确认后加 --write')
  return lines.join('\n')
}

async function main(argv          )                  {
  const args = parseArgs(argv)
  const normalize = (args.flags.get('normalize') ?? (args.command === 'import' ? 'dsh-i18n-v1' : undefined))   
            
             
                   
               
  const gfs = await GraphFS.open({
    root: args.root,
    graphPath: args.graph,
    actor: 'cli',
    ...(normalize ? { normalize } : {}),
    normalizeLocked: args.flags.has('normalize'),
  })

  switch (args.command) {
    case 'help': {
      console.log(USAGE)
      return 0
    }

    case 'init': {
      const auto = !args.flags.has('no-suggest')
      const result = auto
        ? await gfs.bootstrap({ force: args.force, minConfidence: 0.7 })
        : { ...(await gfs.init({ force: args.force })), linked: 0, candidates: 0, skipped: [] }
      console.log(
        auto
          ? `wrote ${result.path} (${result.nodes} nodes, ${result.totalEdges} edges; +${result.linked} new)`
          : `wrote ${result.path} (${result.nodes} nodes, 0 edges)`,
      )

      if (auto) {
        console.log(`relationships: ${result.candidates} candidates, adopted ${result.linked}`)
        for (const skipped of result.skipped.slice(0, 5)) {
          console.log(`  - ${skipped.candidate.fromPath} → ${skipped.candidate.toPath}: ${skipped.reason}`)
        }
        if (result.linked === 0) {
          console.log('没有自动发现关系（C/Go/Rust 的 #include/import 也提不出时，用 suggest --deep 让模型提）')
        }
        console.log('下一步：`graphfs check` 查看；`graphfs suggest` 补语义边')
      } else {
        console.log('下一步：`graphfs suggest` 发现候选边，或用 `graphfs link` 手工建边')
      }
      return 0
    }

    case 'check': {
      const report = await gfs.check()
      if (args.json) printJson(report)
      else console.log(renderCheck(report))
      return report.ok ? 0 : 1
    }

    case 'plan': {
      const plan = await gfs.plan()
      if (args.json) printJson(plan)
      else console.log(renderPlan(plan))
      return plan.obligations.length > 0 ? 1 : 0
    }

    case 'suggest': {
      if (args.flags.has('pack')) {
        const pack = await gfs.buildPack({
          maxFiles: Number(args.flags.get('max-files') ?? '40'),
          maxCandidates: Number(args.flags.get('max-candidates') ?? '10'),
        })
        console.log(args.json ? JSON.stringify(pack, null, 2) : renderPackMarkdown(pack))
        return 0
      }

      let extra                         
      if (args.flags.has('deep')) {
        const resolved = await resolveModelConfig(args.root)
        if (!resolved.config) {
          throw new GraphFSError('模型路由未配置', 'GF_MODEL_FAILED', resolved.problem)
        }
        const config = resolved.config
        if (!gfs.snapshot) {
          if (args.flags.has('write')) {
            const created = await gfs.init()
            process.stderr.write(`initialized ${created.path} (${created.nodes} nodes)\n`)
          } else {
            process.stderr.write('图还没建：本次只做预览，采纳请加 --write\n')
          }
        }

        const pack = await gfs.buildPack({
          maxFiles: Number(args.flags.get('max-files') ?? '40'),
          maxCandidates: Number(args.flags.get('max-candidates') ?? '10'),
        })
        process.stderr.write(`calling ${config.model} …\n`)
        const payload = await requestCandidates(pack, config)
        const parsed = parseProposals(payload, gfs.snapshot ?? (await gfs.previewGraph()))
        for (const dropped of parsed.dropped) {
          process.stderr.write(`dropped #${dropped.index}: ${dropped.reason}\n`)
        }
        extra = parsed.candidates
      }

      const candidates = await gfs.suggest({
        extra,
        proposalsPath: args.flags.get('from-file'),
        all: args.flags.has('all'),
      })
      const min = Number(args.flags.get('min-confidence') ?? '0.7')
      const selected = candidates.filter((c) => c.confidence >= min)

      if (!args.flags.has('write')) {
        if (args.json) printJson(selected)
        else console.log(renderCandidates(selected))
        if (selected.length > 0) {
          console.log('\n采纳：graphfs suggest --write [--min-confidence 0.8]')
        }
        return 0
      }

      const MAX_BULK = 50
      if (selected.length > MAX_BULK && !args.flags.has('force')) {
        throw new GraphFSError(
          `一次要采纳 ${selected.length} 条（上限 ${MAX_BULK}）`,
          'GF_BUDGET_EXHAUSTED',
          '提高 --min-confidence 缩小范围，或加 --force 确认批量采纳',
        )
      }

      const result = await gfs.applySuggestions(selected, { minConfidence: min })
      if (args.json) printJson(result)
      else {
        console.log(`linked ${result.linked.length}`)
        for (const edge of result.linked) {
          console.log(`  + ${edge.id}  ${edge.from} → ${edge.to} [${edge.relation}]`)
        }
        if (result.skipped.length > 0) {
          console.log(`skipped ${result.skipped.length}`)
          for (const item of result.skipped) {
            console.log(`  - ${item.candidate.fromPath} → ${item.candidate.toPath}: ${item.reason}`)
          }
        }
      }
      return 0
    }

    case 'llm': {
      const sub = args.rest[0] ?? 'status'
      const project = projectConfigPath(args.root)
      const global = globalConfigPath()

      if (sub === 'setup') {
        const target = args.flags.has('local') ? project : global
        const result = await writeTemplate(target, { force: args.flags.has('force') })
        if (result === 'exists') {
          console.log(`${target} 已存在（加 --force 覆盖）`)
          return 0
        }
        console.log(`已写入 ${target}`)
        console.log('把 "apiKey" 填上即可：node src/cli/main.ts suggest --deep --root <repo>')
        console.log(`（文件权限 0600；若是项目内配置，记得把它加进 .gitignore）`)
        return 0
      }

      const resolved = await resolveModelConfig(args.root)
      console.log(`config   ${resolved.source.path}${resolved.source.exists ? '' : '（不存在）'}`)
      console.log(`source   ${resolved.source.kind}`)
      if (!resolved.config) {
        console.log(`apiKey   <未配置>`)
        console.log(`\n下一步：${resolved.problem}`)
        return 1
      }
      console.log(`baseUrl  ${resolved.config.baseUrl}`)
      console.log(`model    ${resolved.config.model}`)
      console.log(`apiKey   ${maskKey(resolved.config.apiKey)}`)
      return 0
    }

    case 'apply': {
      if (!args.flags.has('yes') && args.flags.has('apply')) {
        throw new GraphFSError('--apply 必须同时给 --yes（真实写盘需要显式确认）', 'GF_GRAPH_INVALID')
      }
      const dryRun = !args.flags.has('apply')
      const plan = await gfs.plan()
      const only = args.flags.get('edge') ? [args.flags.get('edge') ] : undefined

      if (plan.obligations.length === 0) {
        console.log('没有待处理的义务')
        return 0
      }

      const report = await gfs.apply(plan, { dryRun, only })

      for (const outcome of report.outcomes) {
        const marker = outcome.status === 'applied' ? '✔' : outcome.status === 'preview' ? '·' : '✘'
        console.log(`${marker} ${outcome.edgeId}  ${outcome.target}  [${outcome.status}]${outcome.reason ? ` — ${outcome.reason}` : ''}`)
        for (const output of outcome.outputs) {
          console.log(`    ${output.path}  ${output.beforeBytes} → ${output.afterBytes} B  (+${output.diff.added}/-${output.diff.removed})`)
          if (!args.json) console.log(indent(output.diff.text, '      '))
        }
        if (outcome.stderr) console.log(indent(outcome.stderr, '      '))
      }

      const applied = report.outcomes.filter((o) => o.status === 'applied').length
      const previewed = report.outcomes.filter((o) => o.status === 'preview').length
      if (dryRun) console.log(`\n预览 ${previewed} 条（未写盘）。确认后：graphfs apply --apply --yes`)
      else console.log(`\n已执行 ${applied} 条`)
      return report.outcomes.some((o) => o.status === 'failed') ? 1 : 0
    }

    case 'ack': {
      const edgeId = args.rest[0]
      const reason = args.flags.get('reason')
      if (!edgeId || !reason) throw new GraphFSError('ack 需要 <edgeId> 与 --reason <text>', 'GF_GRAPH_INVALID')
      const edge = await gfs.ack(edgeId, reason)
      console.log(`acked ${edge.id}: ${edge.from} → ${edge.to} [${edge.relation}]`)
      console.log(`  baseline ${edge.fromHash}/${edge.toHash}`)
      console.log('  (已写入审计：.graphfs/audit/journal.jsonl)')
      return 0
    }

    case 'journal': {
      const raw = Number(args.flags.get('limit') ?? '50')
      const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 1000) : 50
      const entries = await gfs.auditTail(limit)
      if (args.json) printJson(entries)
      else console.log(renderAudit(entries                                             ))
      return 0
    }

    case 'import': {
      const what = args.rest[0]
      if (what !== 'i18n') {
        throw new GraphFSError(`未知的导入器：${what ?? '(空)'}`, 'GF_GRAPH_INVALID', '目前只有 `graphfs import i18n`')
      }
      const dirs = args.flags.get('dir') ? [args.flags.get('dir') ] : undefined
      const report = await gfs.importI18n({ dirs, write: args.flags.has('write') })
      if (args.json) printJson(report)
      else console.log(renderImport(report))
      return report.issues.some((issue) => issue.code === 'GF_UNIT_MISMATCH') && report.edges === 0 ? 1 : 0
    }

    case 'attach': {
      const path = args.rest[0]
      if (!path) throw new GraphFSError('attach 需要文件路径：graphfs attach <path> ...', 'GF_GRAPH_INVALID')

      if (args.flags.has('unmanaged')) {
        await gfs.attach(path, { unmanaged: true })
        console.log(`unmanaged: ${path}`)
        return 0
      }

      const to = args.multi.get('to') ?? []
      const relation = args.flags.get('relation')
      if (to.length === 0 || !relation) {
        throw new GraphFSError('attach 需要 --to <node> 与 --relation <r>（或 --unmanaged）', 'GF_GRAPH_INVALID')
      }

      const result = await gfs.attach(path, {
        to,
        relation: relation         ,
        as: (args.flags.get('as')                             ) ?? 'to',
      })
      console.log(`attached ${path} (node ${result.nodeId})`)
      for (const edge of result.edges) {
        console.log(`  ${edge.id}  ${edge.from} → ${edge.to}  [${edge.relation}]`)
      }
      return 0
    }

    case 'status': {
      const status = gfs.status()
      if (args.json) printJson(status)
      else console.log(renderStatus(status))
      return 0
    }

    case 'ui': {
      const port = Number(args.flags.get('port') ?? '8787')
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new GraphFSError(`非法端口：${args.flags.get('port')}`, 'GF_GRAPH_INVALID')
      }
      const server = await startUi({
        root: args.root,
        graphPath: args.graph,
        host: args.flags.get('host') ?? '127.0.0.1',
        port,
      })
      console.log(`GraphFS 面板：${server.url}`)
      console.log(`工作区：${args.root}`)
      console.log('Ctrl+C 退出（只读面板：不会修改任何文件）')
      await new Promise      ((resolve) => {
        process.once('SIGINT', () => resolve())
        process.once('SIGTERM', () => resolve())
      })
      await server.close()
      return 0
    }

    case 'link': {
      const from = args.flags.get('from')
      // `--to` 是可重复选项，统一收在 multi 里（attach 需要多个，link 只取第一个）。
      const to = args.multi.get('to')?.[0] ?? args.flags.get('to')
      const relation = args.flags.get('relation')
      if (!from || !to || !relation) throw new GraphFSError('link requires --from, --to, --relation', 'GF_GRAPH_INVALID')
      const command = args.flags.get('command')
      const outputs = args.flags.get('outputs')?.split(',').map((x) => x.trim()).filter(Boolean)
      if (command && (!outputs || outputs.length === 0)) {
        throw new GraphFSError('--command 需要同时给 --outputs a.md,b.md', 'GF_GRAPH_INVALID')
      }

      const edge = await gfs.link({
        from,
        to,
        relation: relation         ,
        authority: args.flags.get('authority')         ,
        trigger: args.flags.get('trigger')         ,
        counterpart: args.flags.get('counterpart')         ,
        obligation: args.flags.get('obligation')         ,
        policy: args.flags.get('policy')         ,
        producer: command ? { kind: 'shell', command, outputs: outputs  } : undefined,
      })
      console.log(`linked ${edge.id}: ${edge.from} → ${edge.to} [${edge.relation}] ${edge.fromHash}/${edge.toHash}`)
      return 0
    }

    default:
      throw new GraphFSError(`unknown command: ${args.command}\n\n${USAGE}`, 'GF_GRAPH_INVALID')
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error         ) => {
    if (error instanceof GraphFSError) {
      console.error(`error [${error.code}] ${error.message}`)
      if (error.remedy) console.error(`remedy: ${error.remedy}`)
      process.exitCode = 2
      return
    }
    console.error(error)
    process.exitCode = 2
  })


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/cli/main.ts