import { describe, expect, it } from 'vitest'
import type { Brief } from '../shared/types.ts'
import { decodeTitle } from '../server/titles.ts'
import { HIGH_FREQUENCY_MAX_AGE } from '../server/store.ts'
import { at, BASE, memoryStore, MINUTE, observation } from './fixtures.ts'

/** Ingests one observation per minute for a story whose score grows by `step` a minute. */
function grow(store: ReturnType<typeof memoryStore>, id: number, from: number, to: number, start: number, step: number, comments = () => 2) {
  const created = []
  for (let minute = from; minute <= to; minute++) {
    created.push(
      ...store.ingest([observation(id, minute, { score: Math.round(start + (minute - from) * step), descendants: comments(), time: at(from - 10) / 1000 })], `cycle-${minute}`, at(minute)),
    )
  }
  return created
}

describe('store', () => {
  it('upserts stories, records snapshots, and ignores replays of the same cycle', () => {
    const store = memoryStore()
    store.ingest([observation(1, 0, { title: 'First' })], 'c1', at(0))
    store.ingest([observation(1, 0, { title: 'Replayed' })], 'c1', at(0))
    store.ingest([observation(1, 1, { score: 20, title: '' })], 'c2', at(1))
    const [story] = store.stories([1])
    expect(story.title).toBe('First')
    expect(story.score).toBe(20)
    expect(story.domain).toBe('example.com')
    expect(store.history(1, 0)).toHaveLength(2)
  })

  it('keeps unsafe URLs out and marks deleted or dead items unavailable', () => {
    const store = memoryStore()
    store.ingest([observation(1, 0, { url: 'javascript:alert(1)' }), observation(2, 0, { dead: true })], 'c1', at(0))
    const stories = new Map(store.stories([1, 2]).map((story) => [story.id, story]))
    expect(stories.get(1)!.url).toBeNull()
    expect(stories.get(2)!.available).toBe(false)
  })

  it('raises one breakout signal, then honors the hour-long cooldown', () => {
    const store = memoryStore()
    const signals = grow(store, 7, -40, 0, 10, 1.5)
    const breakouts = signals.filter((signal) => signal.kind === 'breakout')
    expect(breakouts).toHaveLength(1)
    expect(breakouts[0].reason).toMatch(/^Score \+\d+ in \d+m/)
    expect(store.signals({ storyId: 7 }).some((signal) => signal.kind === 'breakout')).toBe(true)
  })

  it('raises discussion spikes from comment growth', () => {
    const store = memoryStore()
    let comments = 0
    const signals = grow(store, 8, -25, 0, 10, 0, () => (comments += 1))
    expect(signals.map((signal) => signal.kind)).toContain('discussion')
  })

  it('consumes milestones silently on first sight and announces later crossings once', () => {
    const store = memoryStore()
    expect(store.ingest([observation(9, 0, { score: 120 })], 'c1', at(0))).toEqual([])
    const crossing = store.ingest([observation(9, 1, { score: 510 })], 'c2', at(1))
    expect(crossing.map((signal) => signal.reason)).toEqual(['Reached 500 points'])
    expect(store.ingest([observation(9, 2, { score: 520 })], 'c3', at(2))).toEqual([])
  })

  it('fetches high-frequency stories when changed or before they go stale', () => {
    const store = memoryStore()
    store.planCollection([{ kind: 'top', ids: [1, 2] }], new Set(), at(0), 60)
    store.ingest([observation(1, 0), observation(2, 0)], 'c1', at(0))

    const fresh = store.planCollection([{ kind: 'top', ids: [1, 2, 3] }], new Set([2]), at(1), 60)
    expect(fresh.itemIds).not.toContain(1)
    expect(fresh.itemIds).toContain(2)
    expect(fresh.itemIds).toContain(3)
    expect(fresh.topRanks.get(1)).toBe(1)

    const stale = store.planCollection([{ kind: 'top', ids: [1, 2] }], new Set(), BASE + HIGH_FREQUENCY_MAX_AGE - 60 * 1000 + 1000, 60)
    expect(stale.itemIds).toContain(1)
  })

  it('never reports ranks from a failed Top fetch', () => {
    const store = memoryStore()
    store.planCollection([{ kind: 'top', ids: [5, 6] }], new Set(), at(0), 60)
    const failed = store.planCollection([{ kind: 'top', ids: null, error: 'offline' }], new Set(), at(1), 60)
    expect(failed.topRanks.size).toBe(0)
    expect(store.feeds().top).toMatchObject({ ids: [5, 6], error: 'offline' })
  })

  it('refreshes other stories on a 15-minute cadence unless /updates mentions them', () => {
    const store = memoryStore()
    store.planCollection([{ kind: 'best', ids: [40] }], new Set(), at(0), 60)
    store.ingest([observation(40, 0, { time: at(-600) / 1000 })], 'c1', at(0))
    expect(store.planCollection([], new Set(), at(1), 60).itemIds).not.toContain(40)
    expect(store.planCollection([], new Set([40]), at(2), 60).itemIds).toContain(40)
    expect(store.planCollection([], new Set(), at(16), 60).itemIds).toContain(40)
  })

  it('prunes old data once a day but keeps stories still listed in a feed', () => {
    const store = memoryStore()
    grow(store, 11, -40, 0, 10, 1.5)
    store.planCollection([{ kind: 'top', ids: [13] }], new Set(), at(0), 60)
    store.ingest([observation(12, 0), observation(13, 0)], 'c-old', at(0))
    const later = BASE + 61 * 24 * 60 * MINUTE
    expect(store.pruneIfNeeded(later)).toBe(true)
    expect(store.pruneIfNeeded(later + MINUTE)).toBe(false)
    expect(store.stories([11, 12, 13]).map((story) => story.id)).toEqual([13])
    expect(store.signals({ storyId: 11 })).toEqual([])
    expect(store.history(13, 0)).toEqual([])
  })

  it('skips briefs written in an unknown payload version instead of failing', () => {
    const store = memoryStore()
    const brief: Brief = { dateKey: '2026-06-01', generatedAt: BASE, coverageStart: BASE, coverageEnd: BASE, partial: false, scannedCount: 1, signalCount: 0, entries: [] }
    store.saveBrief(brief)
    store.db.prepare(`INSERT INTO briefs (date_key, generated_at, payload_version, payload) VALUES ('2026-06-02', ?, 99, '{}')`).run(BASE + 1)
    expect(store.brief()?.dateKey).toBe('2026-06-01')
    expect(store.briefSummaries().map((summary) => summary.dateKey)).toEqual(['2026-06-01'])
    expect(store.hasBrief('2026-06-02')).toBe(true)
  })
})

describe('title decoding', () => {
  it('decodes entities without interpreting markup', () => {
    expect(decodeTitle('A &amp; B &#x2F; C')).toBe('A & B / C')
    expect(decodeTitle('&quot;Quoted&quot; and &#x27;apostrophes&#x27;')).toBe(`"Quoted" and 'apostrophes'`)
    expect(decodeTitle('<b>bold</b> &lt;i&gt;')).toBe('<b>bold</b> <i>')
    expect(decodeTitle('Caf&eacute; &mdash; 10&#8211;20&nbsp;ms')).toBe('Café — 10–20 ms')
    expect(decodeTitle('AT&T & friends; &unknown; &#0; &#xD800;')).toBe('AT&T & friends; &unknown; &#0; &#xD800;')
    expect(decodeTitle('  Line\nbreak\t and   spaces ')).toBe('Line break and spaces')
  })
})
