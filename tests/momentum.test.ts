import { describe, expect, it } from 'vitest'
import { evaluateMomentum, levelFor, rising } from '../server/momentum.ts'
import { at, snapshot, story } from './fixtures.ts'

/** One observation per minute from `from` to `to` minutes, score rising by `step` each minute. */
function minuteHistory(
  from: number,
  to: number,
  start: number,
  step: number,
  options: { commentStep?: number; rank?: (minute: number) => number | null } = {},
) {
  const history = []
  for (let minute = from; minute <= to; minute++) {
    history.push(snapshot(minute, start + (minute - from) * step, 10 + (minute - from) * (options.commentStep ?? 0), options.rank?.(minute) ?? null))
  }
  return history
}

describe('momentum engine', () => {
  it('measures growth between real observations about 20 minutes apart', () => {
    const history = minuteHistory(-20, 0, 100, 1.5, { commentStep: 1 })
    const momentum = evaluateMomentum(story(), history, at(0))!
    expect(momentum.elapsedMinutes).toBe(20)
    expect(momentum.pointDelta).toBe(30)
    expect(momentum.commentDelta).toBe(20)
    expect(momentum.pointVelocity).toBeCloseTo(1.5)
    expect(momentum.heat).toBeCloseTo(1.5)
    expect(momentum.level).toBe('breakout')
  })

  it('returns nothing without a baseline 15–25 minutes back', () => {
    expect(evaluateMomentum(story(), minuteHistory(-10, 0, 100, 1), at(0))).toBeNull()
  })

  it('refuses to bridge gaps longer than five minutes', () => {
    const history = [...minuteHistory(-20, -12, 100, 1), ...minuteHistory(-5, 0, 120, 1)]
    expect(evaluateMomentum(story(), history, at(0))).toBeNull()
  })

  it('requires a fresh endpoint', () => {
    expect(evaluateMomentum(story(), minuteHistory(-30, -6, 100, 1), at(0))).toBeNull()
  })

  it('reports rank gain only when every observation in the window was on the front page', () => {
    const ranked = evaluateMomentum(story(), minuteHistory(-20, 0, 100, 0, { rank: (minute) => 20 - minute }), at(0))!
    expect(ranked.rankGain).toBe(20)
    const entered = evaluateMomentum(story(), minuteHistory(-20, 0, 100, 0, { rank: (minute) => (minute < -10 ? null : 30) }), at(0))!
    expect(entered.rankGain).toBeNull()
  })

  it('computes acceleration against the adjacent previous window', () => {
    const history = [...minuteHistory(-40, -20, 100, 0.5), ...minuteHistory(-19, 0, 111, 1.5)]
    const momentum = evaluateMomentum(story(), history, at(0))!
    expect(momentum.pointAcceleration).toBeGreaterThan(0)
  })

  it('keeps metrics but no heat for old stories, jobs, and undated items', () => {
    const history = minuteHistory(-20, 0, 100, 2)
    const old = evaluateMomentum(story({ createdAt: at(-7 * 60) }), history, at(0))!
    expect(old.pointDelta).toBe(40)
    expect(old.heat).toBe(0)
    expect(evaluateMomentum(story({ type: 'job' }), history, at(0))!.heat).toBe(0)
    expect(evaluateMomentum(story({ createdAt: null }), history, at(0))).toBeNull()
    expect(evaluateMomentum(story({ available: false }), history, at(0))).toBeNull()
  })

  it('classifies heat levels', () => {
    expect(levelFor(0.2)).toBe('normal')
    expect(levelFor(0.25)).toBe('warm')
    expect(levelFor(0.5)).toBe('rising')
    expect(levelFor(1)).toBe('breakout')
  })

  it('orders the Rising list by heat, then velocity, then recency', () => {
    const a = story({ id: 1 })
    const b = story({ id: 2 })
    const c = story({ id: 3 })
    const signals = new Map([
      [1, evaluateMomentum(a, minuteHistory(-20, 0, 100, 0.6), at(0))!],
      [2, evaluateMomentum(b, minuteHistory(-20, 0, 100, 1.2), at(0))!],
      [3, evaluateMomentum(c, minuteHistory(-20, 0, 100, 0.1), at(0))!],
    ])
    expect(rising([a, b, c], signals).map((entry) => entry.id)).toEqual([2, 1])
  })
})
