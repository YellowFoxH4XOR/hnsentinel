import { describe, expect, it } from 'vitest'
import { BACKOFF_MS, Collector, MAX_CONCURRENT_ITEMS, type CycleResult } from '../server/collector.ts'
import { item, ManualClock, memoryStore, StubService, waitFor } from './fixtures.ts'

function setup() {
  const store = memoryStore()
  const clock = new ManualClock()
  const service = new StubService()
  const results: CycleResult[] = []
  const collector = new Collector({ service, store, clock, pollIntervalSeconds: 60, events: { cycleFinished: (result) => results.push(result) } })
  return { store, clock, service, results, collector }
}

describe('collector', () => {
  it('collects listed items, skips unavailable ones, and records ranks from the Top list', async () => {
    const { store, service, results, collector } = setup()
    service.feeds.top = [101, 102, 103]
    service.items.set(101, item(101, { title: 'A &amp; B' }))
    service.items.set(102, null)
    service.items.set(103, item(103))
    collector.start()
    await waitFor(() => results.length === 1)
    await collector.stop()

    expect(results[0]).toMatchObject({ outcome: 'complete', error: null, receivedData: true })
    expect(store.stories([101, 102, 103]).map((story) => story.id).sort()).toEqual([101, 103])
    expect(store.stories([101])[0].title).toBe('A & B')
    expect(store.history(101, 0)[0].topRank).toBe(1)
    expect(store.feeds().top.ids).toEqual([101, 102, 103])
  })

  it('tolerates isolated item failures but reports widespread ones', async () => {
    const { service, results, collector } = setup()
    service.feeds.top = Array.from({ length: 20 }, (_, index) => index + 1)
    for (const id of service.feeds.top) service.items.set(id, item(id))
    service.failingItems = new Set([1])
    collector.start()
    await waitFor(() => results.length === 1)
    await collector.stop()
    expect(results[0]).toMatchObject({ outcome: 'partial', error: null, receivedData: true })

    const second = setup()
    second.service.feeds.top = [1, 2, 3, 4]
    for (const id of [1, 2, 3, 4]) second.service.items.set(id, item(id))
    second.service.failingItems = new Set([1, 2])
    second.collector.start()
    await waitFor(() => second.results.length === 1)
    await second.collector.stop()
    expect(second.results[0].error).toBe('2 of 4 stories failed')
  })

  it('backs off after cycles that fetch nothing, then resumes the normal cadence', async () => {
    const { clock, service, results, collector } = setup()
    service.failingFeeds = new Set(['top', 'new', 'best', 'ask', 'show', 'jobs'])
    service.updatesFail = true
    collector.start()
    await waitFor(() => results.length === 1)
    expect(results[0]).toMatchObject({ outcome: 'failed', receivedData: false, error: 'No Hacker News data could be fetched' })
    await waitFor(() => clock.requested.length === 1)
    expect(clock.requested[0]).toBe(BACKOFF_MS[0])

    clock.advance(BACKOFF_MS[0])
    await waitFor(() => clock.requested.length === 2)
    expect(clock.requested[1]).toBe(BACKOFF_MS[1])

    service.failingFeeds = new Set()
    service.feeds.top = [1]
    service.items.set(1, item(1))
    clock.advance(BACKOFF_MS[1])
    await waitFor(() => clock.requested.length === 3)
    expect(results[2].receivedData).toBe(true)
    expect(clock.requested[2]).toBe(60_000)
    await collector.stop()
  })

  it('never runs more than the allowed number of item requests at once', async () => {
    const { service, results, collector } = setup()
    service.feeds.top = Array.from({ length: 40 }, (_, index) => index + 1)
    let active = 0
    let peak = 0
    service.item = async (id: number) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      return item(id)
    }
    collector.start()
    await waitFor(() => results.length === 1)
    await collector.stop()
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_ITEMS)
    expect(peak).toBeGreaterThan(1)
  })

  it('stopping mid-cycle discards the uncommitted batch and records a cancelled run', async () => {
    const { store, service, results, collector } = setup()
    service.feeds.top = [1, 2]
    service.items.set(1, item(1))
    service.items.set(2, item(2))
    let open!: () => void
    service.gate = new Promise((resolve) => (open = resolve))
    collector.start()
    await waitFor(() => (service.itemCalls.get(1) ?? 0) > 0)
    const stopping = collector.stop()
    open()
    await stopping
    expect(results.at(-1)?.outcome).toBe('cancelled')
    expect(store.stories([1, 2])).toEqual([])
    expect(store.runsSince(0).at(-1)?.outcome).toBe('cancelled')
  })

  it('a refresh request during a wait starts the next cycle immediately', async () => {
    const { service, results, collector } = setup()
    service.feeds.top = [1]
    service.items.set(1, item(1))
    collector.start()
    await waitFor(() => results.length === 1)
    collector.requestRefresh()
    await waitFor(() => results.length === 2)
    await collector.stop()
  })
})
