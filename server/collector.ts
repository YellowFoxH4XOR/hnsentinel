import { randomUUID } from 'node:crypto'
import type { FeedKind } from '../shared/types.ts'
import { FEED_KINDS } from '../shared/types.ts'
import type { HNItem, HNService } from './hn.ts'
import type { FeedResult, Observation, RunOutcome, Store } from './store.ts'
import { decodeTitle } from './titles.ts'

export interface Clock {
  now(): number
  /** Resolves after `ms`, or rejects with an AbortError when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason)
      const timer = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(signal.reason)
      }, { once: true })
    }),
}

export interface CycleResult {
  outcome: RunOutcome
  /** User-facing diagnostic, or null for a healthy cycle (isolated item failures are tolerated). */
  error: string | null
  receivedData: boolean
  signalCount: number
  finishedAt: number
}

export interface CollectorEvents {
  cycleStarted?(at: number): void
  progress?(completed: number, total: number): void
  committed?(): void
  cycleFinished?(result: CycleResult): void
}

export interface CollectorOptions {
  service: HNService
  store: Store
  pollIntervalSeconds: number
  clock?: Clock
  events?: CollectorEvents
}

/** Simultaneous item requests. */
export const MAX_CONCURRENT_ITEMS = 8
/** Best/Ask/Show/Jobs refresh on this cadence; Top and New refresh every poll. */
export const SLOW_LIST_INTERVAL = 5 * 60_000
/** Observations committed per transaction. */
export const BATCH_SIZE = 32
/** Delays after consecutive cycles that fetched nothing. */
export const BACKOFF_MS = [120_000, 240_000, 600_000]
const TOLERABLE_ITEM_FAILURE_RATIO = 0.1

/**
 * The single collector for everyone. Exactly one cycle runs at a time; refresh requests during
 * a cycle coalesce into at most one extra cycle. Cycles that fetch nothing back off
 * 120 → 240 → 600 seconds and any success resets the cadence. `stop()` cancels the running
 * cycle, discards its uncommitted batch, and records the run as cancelled.
 */
export class Collector {
  readonly #service: HNService
  readonly #store: Store
  readonly #clock: Clock
  readonly #events: CollectorEvents
  readonly #pollMs: number
  #loop: Promise<void> | null = null
  #stopping = new AbortController()
  #wake = new AbortController()
  #refreshRequested = false
  #backoffStep = 0
  #lastListFetch = new Map<FeedKind, number>()

  constructor(options: CollectorOptions) {
    this.#service = options.service
    this.#store = options.store
    this.#clock = options.clock ?? systemClock
    this.#events = options.events ?? {}
    this.#pollMs = options.pollIntervalSeconds * 1000
  }

  start(): void {
    if (this.#loop || this.#stopping.signal.aborted) return
    this.#loop = this.#run()
  }

  /** Runs a cycle now (or right after the current one), skipping any pending wait or backoff. */
  requestRefresh(): void {
    this.#refreshRequested = true
    this.#wake.abort()
  }

  async stop(): Promise<void> {
    this.#stopping.abort(new Error('Collector stopped'))
    this.#wake.abort()
    await this.#loop
  }

  async #run(): Promise<void> {
    while (!this.#stopping.signal.aborted) {
      this.#refreshRequested = false
      const startedAt = this.#clock.now()
      const result = await this.#cycle()
      if (this.#stopping.signal.aborted) break
      let delay: number
      if (!result.receivedData) {
        this.#backoffStep = Math.min(this.#backoffStep + 1, BACKOFF_MS.length)
        delay = BACKOFF_MS[this.#backoffStep - 1]
      } else {
        this.#backoffStep = 0
        delay = Math.max(1000, this.#pollMs - (this.#clock.now() - startedAt))
      }
      if (this.#refreshRequested) continue
      this.#wake = new AbortController()
      try {
        await this.#clock.sleep(delay, AbortSignal.any([this.#wake.signal, this.#stopping.signal]))
      } catch {
        // Woken by a refresh request or stop; the loop condition decides which.
      }
    }
  }

  async #cycle(): Promise<CycleResult> {
    const signal = this.#stopping.signal
    const runId = randomUUID()
    const startedAt = this.#clock.now()
    const intervalSeconds = this.#pollMs / 1000
    let failedFeeds = 0
    let attempted = 0
    let succeeded = 0
    let failedItems = 0
    let committedBatches = 0
    let signalCount = 0

    const finish = (outcome: RunOutcome, error: string | null, receivedData: boolean): CycleResult => {
      const finishedAt = this.#clock.now()
      try {
        this.#store.finishRun({ id: runId, startedAt, finishedAt, intervalSeconds, outcome, failedFeeds, attempted, succeeded })
      } catch {
        // The run record is diagnostic only; a failure to write it must not mask the cycle's result.
      }
      const result = { outcome, error, receivedData, signalCount, finishedAt }
      this.#events.cycleFinished?.(result)
      return result
    }

    this.#events.cycleStarted?.(startedAt)
    try {
      this.#store.beginRun({ id: runId, startedAt, finishedAt: null, intervalSeconds, outcome: 'partial', failedFeeds: 0, attempted: 0, succeeded: 0 })
    } catch (error) {
      return finish('failed', `Could not start a collection run: ${message(error)}`, false)
    }

    // Feed lists (Top/New every poll, the rest on the slow cadence) plus the /updates hint.
    const kinds = FEED_KINDS.filter((kind) => this.#listDue(kind, startedAt))
    const [feedSettled, updatesSettled] = await Promise.all([
      Promise.allSettled(kinds.map((kind) => this.#service.feedIds(kind, signal))),
      this.#service.updatedItemIds(signal).then((ids) => new Set(ids), () => new Set<number>()),
    ])
    if (signal.aborted) return finish('cancelled', null, false)
    const feedResults: FeedResult[] = kinds.map((kind, index) => {
      const settled = feedSettled[index]
      if (settled.status === 'fulfilled') {
        this.#lastListFetch.set(kind, this.#clock.now())
        return { kind, ids: settled.value }
      }
      failedFeeds += 1
      return { kind, ids: null, error: message(settled.reason) }
    })

    let plan
    try {
      plan = this.#store.planCollection(feedResults, updatesSettled, this.#clock.now(), intervalSeconds)
    } catch (error) {
      return finish('failed', `Could not plan collection: ${message(error)}`, false)
    }

    // Fetch items with bounded concurrency, committing in batches as results arrive.
    const ids = plan.itemIds
    let pending: Observation[] = []
    let next = 0
    let storageError: unknown = null
    const commit = () => {
      if (!pending.length || storageError) return
      try {
        signalCount += this.#store.ingest(pending, runId, this.#clock.now()).length
        committedBatches += 1
        this.#events.committed?.()
      } catch (error) {
        storageError = error
      }
      pending = []
    }
    const worker = async () => {
      while (next < ids.length && !signal.aborted && !storageError) {
        const id = ids[next++]
        let item: HNItem | null
        try {
          item = await this.#service.item(id, signal)
        } catch {
          if (signal.aborted) return
          attempted += 1
          failedItems += 1
          continue
        }
        if (signal.aborted) return
        attempted += 1
        succeeded += 1
        if (item) {
          pending.push({ item, title: decodeTitle(item.title ?? ''), observedAt: this.#clock.now(), topRank: plan.topRanks.get(item.id) ?? null })
        }
        if (pending.length >= BATCH_SIZE) commit()
        this.#events.progress?.(attempted, ids.length)
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_ITEMS, ids.length) }, worker))

    if (signal.aborted) return finish('cancelled', null, committedBatches > 0)
    commit()
    if (storageError) return finish('failed', `Collection could not be saved: ${message(storageError)}`, committedBatches > 0)

    const receivedData = kinds.length > failedFeeds || succeeded > 0
    const outcome: RunOutcome = !receivedData ? 'failed' : failedFeeds > 0 || failedItems > 0 ? 'partial' : 'complete'
    const problems: string[] = []
    if (failedFeeds > 0) problems.push(`${failedFeeds} feed list${failedFeeds === 1 ? '' : 's'} failed`)
    if (failedItems > attempted * TOLERABLE_ITEM_FAILURE_RATIO) problems.push(`${failedItems} of ${attempted} stories failed`)
    const error = !receivedData ? 'No Hacker News data could be fetched' : problems.length ? problems.join(', ') : null
    return finish(outcome, error, receivedData)
  }

  #listDue(kind: FeedKind, now: number): boolean {
    if (kind === 'top' || kind === 'new') return true
    const last = this.#lastListFetch.get(kind)
    return last === undefined || now - last >= SLOW_LIST_INTERVAL
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
