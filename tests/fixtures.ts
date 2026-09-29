import type { FeedKind, Snapshot, Story } from '../shared/types.ts'
import type { Clock } from '../server/collector.ts'
import { openDatabase } from '../server/db.ts'
import type { HNItem, HNService } from '../server/hn.ts'
import { Store, type Observation } from '../server/store.ts'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
/** 2026-06-01T12:00:00Z */
export const BASE = Date.UTC(2026, 5, 1, 12)

export function at(minutes: number): number {
  return BASE + minutes * MINUTE
}

export function memoryStore(): Store {
  return new Store(openDatabase(':memory:'))
}

export function story(overrides: Partial<Story> = {}): Story {
  return {
    id: 1,
    title: 'Rust 2.0 released',
    type: 'story',
    url: 'https://example.com/rust',
    domain: 'example.com',
    author: 'alice',
    createdAt: at(-60),
    score: 100,
    comments: 10,
    available: true,
    firstSeenAt: at(-60),
    lastFetchedAt: BASE,
    ...overrides,
  }
}

export function snapshot(minutes: number, score: number | null, comments: number | null = null, topRank: number | null = null): Snapshot {
  return { observedAt: at(minutes), score, comments, topRank }
}

export function item(id: number, overrides: Partial<HNItem> = {}): HNItem {
  return { id, type: 'story', title: `Story ${id}`, by: `user${id}`, time: at(-30) / 1000, url: `https://example.com/${id}`, score: 10, descendants: 2, ...overrides }
}

export function observation(id: number, minutes: number, overrides: Partial<HNItem> = {}, topRank: number | null = null): Observation {
  const value = item(id, overrides)
  return { item: value, title: value.title ?? '', observedAt: at(minutes), topRank }
}

/** Deterministic clock: time moves only when the test advances it. */
export class ManualClock implements Clock {
  current: number
  readonly requested: number[] = []
  #sleepers: { deadline: number; resolve(): void }[] = []

  constructor(start = BASE) {
    this.current = start
  }

  now(): number {
    return this.current
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    this.requested.push(ms)
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason)
      const sleeper = { deadline: this.current + ms, resolve }
      this.#sleepers.push(sleeper)
      signal.addEventListener('abort', () => {
        this.#sleepers = this.#sleepers.filter((entry) => entry !== sleeper)
        reject(signal.reason)
      }, { once: true })
    })
  }

  advance(ms: number): void {
    this.current += ms
    const due = this.#sleepers.filter((entry) => entry.deadline <= this.current)
    this.#sleepers = this.#sleepers.filter((entry) => entry.deadline > this.current)
    for (const entry of due) entry.resolve()
  }
}

/** Scripted HN API. */
export class StubService implements HNService {
  feeds: Partial<Record<FeedKind, number[]>> = {}
  items = new Map<number, HNItem | null>()
  failingFeeds = new Set<FeedKind>()
  failingItems = new Set<number>()
  updates: number[] = []
  updatesFail = false
  itemCalls = new Map<number, number>()
  /** When set, item requests wait until the gate opens. */
  gate: Promise<void> | null = null

  async feedIds(kind: FeedKind): Promise<number[]> {
    if (this.failingFeeds.has(kind)) throw new Error(`${kind} unavailable`)
    return this.feeds[kind] ?? []
  }

  async item(id: number, signal?: AbortSignal): Promise<HNItem | null> {
    this.itemCalls.set(id, (this.itemCalls.get(id) ?? 0) + 1)
    if (this.gate) await this.gate
    if (signal?.aborted) throw signal.reason
    if (this.failingItems.has(id)) throw new Error(`item ${id} failed`)
    return this.items.get(id) ?? null
  }

  async updatedItemIds(): Promise<number[]> {
    if (this.updatesFail) throw new Error('updates unavailable')
    return this.updates
  }
}

export async function waitFor(condition: () => boolean, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}
