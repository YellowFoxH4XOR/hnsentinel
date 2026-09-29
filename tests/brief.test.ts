import { describe, expect, it } from 'vitest'
import type { Momentum, Signal, SignalKind } from '../shared/types.ts'
import { briefDueAt, buildBrief, type BriefInput } from '../server/brief.ts'
import type { RunRecord } from '../server/store.ts'
import { at, BASE, HOUR, MINUTE, story } from './fixtures.ts'

function momentum(heat: number, commentDelta = 0): Momentum {
  return { elapsedMinutes: 20, pointDelta: Math.round(heat * 20), commentDelta, rankGain: null, pointVelocity: heat, commentVelocity: null, pointAcceleration: null, commentAcceleration: null, heat, level: heat >= 1 ? 'breakout' : 'rising' }
}

let nextSignal = 1
function signal(storyId: number, kind: SignalKind, minutesAgo: number, value: Momentum | null = null): Signal {
  return { id: nextSignal++, storyId, kind, reason: kind, createdAt: at(-minutesAgo), score: null, comments: null, momentum: value, story: null }
}

function minuteRuns(from: number, to: number, overrides: (index: number) => Partial<RunRecord> = () => ({})): RunRecord[] {
  const runs: RunRecord[] = []
  for (let time = from, index = 0; time < to; time += MINUTE, index++) {
    runs.push({ id: `r${index}`, startedAt: time, finishedAt: time + 20_000, intervalSeconds: 60, outcome: 'complete', failedFeeds: 0, attempted: 400, succeeded: 400, ...overrides(index) })
  }
  return runs
}

function input(overrides: Partial<BriefInput> = {}): BriefInput {
  return { stories: [], signals: [], momentum: new Map(), runs: minuteRuns(BASE - 24 * HOUR - MINUTE, BASE), scannedCount: 0, pollIntervalSeconds: 60, ...overrides }
}

describe('daily brief', () => {
  it('features the biggest breakout and discussion and ranks the rest', () => {
    const stories = [
      story({ id: 1, title: 'Hot', createdAt: at(-120), score: 300, comments: 40 }),
      story({ id: 2, title: 'Talky', createdAt: at(-300), score: 90, comments: 200 }),
      story({ id: 3, title: 'Milestone', createdAt: at(-600), score: 510, comments: 60 }),
    ]
    const brief = buildBrief(
      input({
        stories,
        signals: [signal(1, 'breakout', 100, momentum(2.4)), signal(2, 'discussion', 200, momentum(0.4, 40)), signal(3, 'milestone', 30)],
      }),
      BASE,
    )
    expect(brief.dateKey).toBe('2026-06-01')
    expect(brief.entries.map((entry) => entry.story.id)).toEqual(expect.arrayContaining([1, 2, 3]))
    expect(brief.entries.find((entry) => entry.biggestBreakout)?.story.id).toBe(1)
    expect(brief.entries.find((entry) => entry.biggestDiscussion)?.story.id).toBe(2)
    expect(brief.entries[0].story.id).toBe(1)
    expect(brief.signalCount).toBe(3)
    expect(brief.partial).toBe(false)
  })

  it('fills a quiet day with the most engaged new stories and skips jobs and old stories', () => {
    const stories = [
      story({ id: 1, createdAt: at(-60), score: 50, comments: 5 }),
      story({ id: 2, createdAt: at(-60), score: 400, comments: 80 }),
      story({ id: 3, type: 'job', createdAt: at(-60), score: 999 }),
      story({ id: 4, createdAt: at(-3000), score: 999 }),
    ]
    const brief = buildBrief(input({ stories }), BASE)
    expect(brief.entries.map((entry) => entry.story.id)).toEqual([2, 1])
    expect(brief.entries.every((entry) => entry.signals.length === 0)).toBe(true)
  })

  it('caps the brief at ten stories', () => {
    const stories = Array.from({ length: 15 }, (_, index) => story({ id: index + 1, createdAt: at(-60), score: index * 10 }))
    expect(buildBrief(input({ stories }), BASE).entries).toHaveLength(10)
  })

  it('reports partial coverage for real gaps but not for isolated failures', () => {
    const start = BASE - 24 * HOUR - MINUTE
    const flaky = minuteRuns(start, BASE, (index) => (index % 97 === 0 ? { outcome: 'partial', succeeded: 398 } : {}))
    expect(buildBrief(input({ runs: flaky }), BASE).partial).toBe(false)

    const withRetry = minuteRuns(start, BASE).filter((_, index) => index !== 700 && index !== 701)
    expect(buildBrief(input({ runs: withRetry }), BASE).partial).toBe(false)

    const outage = minuteRuns(start, BASE).filter((_, index) => index < 600 || index > 620)
    expect(buildBrief(input({ runs: outage }), BASE).partial).toBe(true)

    const lateStart = minuteRuns(BASE - 2 * HOUR, BASE)
    const brief = buildBrief(input({ runs: lateStart }), BASE)
    expect(brief.partial).toBe(true)
    expect(brief.coverageStart).toBe(BASE - 2 * HOUR)
  })

  it('is due at the configured UTC hour', () => {
    expect(briefDueAt(Date.UTC(2026, 5, 1, 20, 30), 13)).toBe(Date.UTC(2026, 5, 1, 13))
  })
})
