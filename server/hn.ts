import type { FeedKind } from '../shared/types.ts'

/** Raw item from the official HN Firebase API. Only `id` is guaranteed. */
export interface HNItem {
  id: number
  type?: string
  title?: string
  by?: string
  time?: number
  url?: string
  score?: number
  descendants?: number
  dead?: boolean
  deleted?: boolean
}

export interface HNService {
  feedIds(kind: FeedKind, signal?: AbortSignal): Promise<number[]>
  /** `null` when the API returns JSON null (the item is unavailable). */
  item(id: number, signal?: AbortSignal): Promise<HNItem | null>
  updatedItemIds(signal?: AbortSignal): Promise<number[]>
}

const ENDPOINTS: Record<FeedKind, string> = {
  top: 'topstories',
  new: 'newstories',
  best: 'beststories',
  ask: 'askstories',
  show: 'showstories',
  jobs: 'jobstories',
}

const REQUEST_TIMEOUT_MS = 15_000

export class HttpHNService implements HNService {
  readonly #base: string
  readonly #userAgent: string

  constructor(base: string, userAgent = 'HNSentinel/1.0 (+https://github.com)') {
    this.#base = base.endsWith('/') ? base : `${base}/`
    this.#userAgent = userAgent
  }

  async feedIds(kind: FeedKind, signal?: AbortSignal): Promise<number[]> {
    const ids = await this.#get(`${ENDPOINTS[kind]}.json`, signal)
    if (!Array.isArray(ids) || !ids.every(Number.isInteger)) throw new Error(`Malformed ${kind} list`)
    return ids as number[]
  }

  async item(id: number, signal?: AbortSignal): Promise<HNItem | null> {
    const item = await this.#get(`item/${id}.json`, signal)
    if (item === null) return null
    if (typeof item !== 'object' || typeof (item as HNItem).id !== 'number') throw new Error(`Malformed item ${id}`)
    return item as HNItem
  }

  async updatedItemIds(signal?: AbortSignal): Promise<number[]> {
    const payload = (await this.#get('updates.json', signal)) as { items?: unknown } | null
    const items = payload?.items
    return Array.isArray(items) ? items.filter(Number.isInteger) : []
  }

  async #get(path: string, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const response = await fetch(new URL(path, this.#base), {
      headers: { Accept: 'application/json', 'User-Agent': this.#userAgent },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!response.ok) throw new Error(`HN request for ${path} failed with HTTP ${response.status}`)
    try {
      return await response.json()
    } catch {
      throw new Error(`Malformed HN response for ${path}`)
    }
  }
}
