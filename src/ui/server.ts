import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { GraphFS } from '../workspace/graphfs.ts'
import { renderDashboard } from './page.ts'

/**
 * 只读监控面板（M6）。
 *
 * 为什么是本地 HTTP 而不是 DSH 里的一个面板：插件跑在宿主进程里，而"看状态"这件事
 * 不该被宿主是否打开、会话是否活跃所约束。一个零依赖的 `node:http` 服务，
 * CLI 能起、CI 能起、在任何浏览器里能看，也不引入前端构建链。
 *
 * 安全边界：
 *   - 只读：唯一的写操作是 `check` 重新算指纹（不改任何文件）；
 *   - 默认绑定 127.0.0.1；
 *   - 只服务内嵌页面与 JSON API，没有静态文件路由，因此没有路径穿越面。
 */

export interface UiOptions {
  root: string
  graphPath?: string
  host?: string
  port?: number
  /** 打开时的额外忽略规则（与 CLI 的 --root 一致）。 */
  ignore?: string[]
}

export interface UiServer {
  url: string
  host: string
  port: number
  close(): Promise<void>
}

export async function startUi(opts: UiOptions): Promise<UiServer> {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 8787
  const gfs = await GraphFS.open({
    root: opts.root,
    graphPath: opts.graphPath,
    actor: 'ui',
    ...(opts.ignore ? { ignore: opts.ignore } : {}),
  })

  const server: Server = createServer((req, res) => {
    void handle(req, res, gfs).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) sendJson(res, 500, { error: message })
      else res.end()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port

  return {
    host,
    port: actualPort,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}/`,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, gfs: GraphFS): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }

  if (path === '/') {
    sendText(res, 200, renderDashboard(), 'text/html; charset=utf-8')
    return
  }

  if (path === '/api/health') {
    sendJson(res, 200, { ok: true })
    return
  }

  if (path === '/api/overview') {
    if (!gfs.snapshot) {
      sendJson(res, 200, {
        root: gfs.config.root,
        graphPath: gfs.config.graphPath,
        hasGraph: false,
        journal: await gfs.auditTail(30),
        generatedAt: new Date().toISOString(),
      })
      return
    }
    const status = gfs.status()
    const report = await gfs.check()
    sendJson(res, 200, {
      ...status,
      hasGraph: true,
      ok: report.ok,
      counts: report.counts,
      clean: report.clean,
      drift: report.drift,
      conflicts: report.conflicts,
      dangling: report.dangling,
      counterpart: report.counterpart,
      unhashable: report.unhashable,
      orphans: report.orphans,
      unlinked: report.unlinked,
      issues: report.issues,
      journal: await gfs.auditTail(30),
      generatedAt: new Date().toISOString(),
    })
    return
  }

  if (path === '/api/graph') {
    if (!gfs.snapshot) {
      sendJson(res, 200, { hasGraph: false, nodes: [], edges: [] })
      return
    }
    const graph = gfs.snapshot
    sendJson(res, 200, {
      hasGraph: true,
      hash: graph.hashConfig,
      unmanaged: [...graph.unmanaged].sort(),
      nodes: [...graph.nodes.values()].map((node) => ({
        id: node.id,
        path: node.path,
        unit: node.unit,
      })),
      edges: [...graph.edges.values()].map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        relation: edge.relation,
        authority: edge.authority,
        trigger: edge.trigger,
        obligation: edge.obligation,
        policy: edge.policy,
        fromHash: edge.fromHash,
        toHash: edge.toHash,
        hasProducer: Boolean(edge.producer),
      })),
    })
    return
  }

  if (path === '/api/journal') {
    const raw = Number(url.searchParams.get('limit') ?? '100')
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 1000) : 100
    sendJson(res, 200, { entries: await gfs.auditTail(limit) })
    return
  }

  if (path === '/api/check') {
    if (!gfs.snapshot) {
      sendJson(res, 409, { error: 'no graph', code: 'GF_GRAPH_INVALID' })
      return
    }
    sendJson(res, 200, await gfs.check())
    return
  }

  sendJson(res, 404, { error: `not found: ${path}` })
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendText(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
