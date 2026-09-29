import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import type { SignalsResponse, Status, StoriesResponse, StoryDetail } from '../shared/types.ts'
import { cardsFor, isView, viewCards, type Dashboard } from './dashboard.ts'
import type { Store } from './store.ts'

export interface AppContext {
  store: Store
  dashboard(): Dashboard
  status(): Status
  now(): number
  /** Absolute path of the built client, or null to serve the API only. */
  staticDir: string | null
}

const HISTORY_WINDOW = 48 * 60 * 60_000
const MAX_IDS = 200
const SSE_KEEPALIVE_MS = 25_000

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
}

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Live-update fan-out: every connected browser hears about each finished cycle. */
export class EventHub {
  readonly #clients = new Set<http.ServerResponse>()

  get size(): number {
    return this.#clients.size
  }

  add(response: http.ServerResponse): void {
    this.#clients.add(response)
    response.on('close', () => this.#clients.delete(response))
  }

  broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of this.#clients) client.write(payload)
  }

  keepAlive(): void {
    for (const client of this.#clients) client.write(': keep-alive\n\n')
  }

  closeAll(): void {
    for (const client of this.#clients) client.end()
    this.#clients.clear()
  }
}

export function createServer(context: AppContext, hub: EventHub): http.Server {
  const server = http.createServer((request, response) => {
    try {
      handle(context, hub, request, response)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      if (status === 500) console.error('Request failed', request.url, error)
      if (!response.headersSent) sendJson(request, response, status, { error: status === 500 ? 'Internal error' : (error as Error).message })
      else response.end()
    }
  })
  const keepAlive = setInterval(() => hub.keepAlive(), SSE_KEEPALIVE_MS)
  keepAlive.unref()
  server.on('close', () => clearInterval(keepAlive))
  return server
}

function handle(context: AppContext, hub: EventHub, request: http.IncomingMessage, response: http.ServerResponse): void {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const route = url.pathname

  // Read-only service: collection runs on the server's own schedule, never on request.
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Method not allowed')
  if (route.startsWith('/api/')) return api(context, hub, route, url.searchParams, request, response)
  if (!context.staticDir) throw new HttpError(404, 'Not found')
  serveStatic(context.staticDir, route, request, response)
}

function api(
  context: AppContext,
  hub: EventHub,
  route: string,
  query: URLSearchParams,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): void {
  const dashboard = context.dashboard()

  if (route === '/api/health') return sendJson(request, response, 200, { ok: true })
  if (route === '/api/status') return sendJson(request, response, 200, context.status())

  if (route === '/api/events') {
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    response.write(`retry: 5000\nevent: status\ndata: ${JSON.stringify(context.status())}\n\n`)
    hub.add(response)
    return
  }

  if (route === '/api/stories') {
    const idsParam = query.get('ids')
    if (idsParam !== null) {
      const ids = [...new Set(idsParam.split(',').filter(Boolean).map(Number))]
      if (ids.length > MAX_IDS || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new HttpError(400, `ids must be up to ${MAX_IDS} positive integers`)
      const missing = context.store.stories(ids.filter((id) => !dashboard.cards.has(id)))
      const extra = cardsFor(missing, context.store, context.now(), dashboard.ranks.top).cards
      const stories = ids.flatMap((id) => {
        const card = dashboard.cards.get(id) ?? extra.get(id)
        return card ? [card] : []
      })
      return sendJson(request, response, 200, { view: 'ids', stories, updatedAt: dashboard.builtAt } satisfies StoriesResponse)
    }
    const view = query.get('view') ?? 'top'
    if (!isView(view)) throw new HttpError(400, `Unknown view "${view}"`)
    return sendJson(request, response, 200, { view, stories: viewCards(dashboard, view), updatedAt: dashboard.builtAt } satisfies StoriesResponse)
  }

  const storyMatch = /^\/api\/stories\/(\d+)$/.exec(route)
  if (storyMatch) {
    const id = Number(storyMatch[1])
    let card = dashboard.cards.get(id)
    if (!card) {
      const [story] = context.store.stories([id])
      if (!story) throw new HttpError(404, 'Story not tracked')
      card = cardsFor([story], context.store, context.now(), dashboard.ranks.top).cards.get(id)!
    }
    const detail: StoryDetail = {
      story: card,
      history: context.store.history(id, context.now() - HISTORY_WINDOW),
      signals: context.store.signals({ storyId: id, limit: 20 }),
    }
    return sendJson(request, response, 200, detail)
  }

  if (route === '/api/signals') {
    const limit = Math.min(Math.max(Number(query.get('limit') ?? 200) || 200, 1), 300)
    return sendJson(request, response, 200, { signals: dashboard.signals.slice(0, limit), updatedAt: dashboard.builtAt } satisfies SignalsResponse)
  }

  if (route === '/api/briefs') return sendJson(request, response, 200, { briefs: context.store.briefSummaries() })
  if (route === '/api/briefs/latest') {
    const brief = context.store.brief()
    if (!brief) throw new HttpError(404, 'No brief yet')
    return sendJson(request, response, 200, brief)
  }
  const briefMatch = /^\/api\/briefs\/(\d{4}-\d{2}-\d{2})$/.exec(route)
  if (briefMatch) {
    const brief = context.store.brief(briefMatch[1])
    if (!brief) throw new HttpError(404, 'No brief for that date')
    return sendJson(request, response, 200, brief)
  }

  throw new HttpError(404, 'Not found')
}

function sendJson(request: http.IncomingMessage, response: http.ServerResponse, status: number, body: unknown): void {
  let payload: Buffer = Buffer.from(JSON.stringify(body))
  const headers: http.OutgoingHttpHeaders = {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    Vary: 'Accept-Encoding',
  }
  if (payload.length > 1024 && /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''))) {
    payload = gzipSync(payload)
    headers['Content-Encoding'] = 'gzip'
  }
  headers['Content-Length'] = payload.length
  response.writeHead(status, headers)
  response.end(request.method === 'HEAD' ? undefined : payload)
}

/** Serves the built client. Hashed assets are immutable; anything else falls back to the SPA shell. */
function serveStatic(root: string, route: string, request: http.IncomingMessage, response: http.ServerResponse): void {
  let decoded: string
  try {
    decoded = decodeURIComponent(route)
  } catch {
    throw new HttpError(400, 'Bad path')
  }
  const resolved = path.resolve(root, `.${decoded}`)
  if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) throw new HttpError(400, 'Bad path')

  let file = resolved
  let stat = fs.statSync(file, { throwIfNoEntry: false })
  if (!stat?.isFile()) {
    // Unknown asset files are real 404s; every other path is a client-side route.
    if (decoded.startsWith('/assets/') || path.extname(decoded)) throw new HttpError(404, 'Not found')
    file = path.join(root, 'index.html')
    stat = fs.statSync(file, { throwIfNoEntry: false })
    if (!stat?.isFile()) throw new HttpError(404, 'Client not built')
  }

  const immutable = file.includes(`${path.sep}assets${path.sep}`)
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  if (request.method === 'HEAD') return void response.end()
  fs.createReadStream(file).pipe(response)
}
