import { describe, expect, it } from 'vitest'
import { openDatabase } from '../server/db.ts'
import { Store, TRAJECTORY_HORIZON } from '../server/store.ts'
import { at, BASE, MINUTE, memoryStore, observation } from './fixtures.ts'

const DAY_MINUTES = TRAJECTORY_HORIZON / MINUTE

/**
 * A story created at BASE, observed every minute for six hours and every 15 minutes after that
 * until it is a day old. It sits at front-page rank 10 from minute 60 through 179.
 */
function observeFirstDay(store: Store, id = 1) {
  const minutes: number[] = []
  for (let minute = 0; minute < 360; minute++) minutes.push(minute)
  for (let minute = 360; minute <= DAY_MINUTES; minute += 15) minutes.push(minute)
  for (const minute of minutes) {
    const rank = minute >= 60 && minute <= 179 ? 10 : 50
    store.ingest(
      [observation(id, minute, { time: BASE / 1000, score: Math.floor(minute / 2) + 1, descendants: Math.floor(minute / 10) }, rank)],
      `cycle-${minute}`,
      at(minute),
    )
  }
  return minutes.length
}

describe('long-term trajectories', () => {
  it('archives a story once its first day is over, with downsampled points and outcome figures', () => {
    const store = memoryStore()
    const samples = observeFirstDay(store)

    expect(store.archiveTrajectories(at(DAY_MINUTES - 1))).toBe(0)
    expect(store.archiveTrajectories(at(DAY_MINUTES + 1))).toBe(1)

    const trajectory = store.trajectory(1)!
    expect(trajectory).toMatchObject({
      storyId: 1,
      type: 'story',
      title: 'Story 1',
      domain: 'example.com',
      createdAt: BASE,
      samples,
      firstObservedAt: BASE,
      lastObservedAt: at(DAY_MINUTES),
      maxGapMinutes: 15,
      maxScore: DAY_MINUTES / 2 + 1,
      finalScore: DAY_MINUTES / 2 + 1,
      maxComments: DAY_MINUTES / 10,
      bestRank: 10,
      frontPageMinutes: 120,
      dead: false,
      deleted: false,
    })
    // 72 five-minute buckets for the first six hours, then 30-minute buckets to the day's end.
    expect(trajectory.points).toHaveLength(72 + 37)
    expect(trajectory.points[0]).toEqual([4, 3, 0, 50])
    expect(trajectory.points[71][0]).toBe(359)
    expect(trajectory.points.at(-1)).toEqual([DAY_MINUTES, DAY_MINUTES / 2 + 1, DAY_MINUTES / 10, 50])
    expect(trajectory.points.every(([minute], index, all) => index === 0 || minute > all[index - 1][0])).toBe(true)
  })

  it('is idempotent and counts what it keeps', () => {
    const store = memoryStore()
    observeFirstDay(store)
    store.archiveTrajectories(at(DAY_MINUTES + 1))
    expect(store.archiveTrajectories(at(DAY_MINUTES + 2))).toBe(0)
    expect(store.trajectoryCount()).toBe(1)
  })

  it('skips jobs and stories never observed during their first day', () => {
    const store = memoryStore()
    store.ingest([observation(2, 0, { type: 'job', time: BASE / 1000 })], 'c-job', at(0))
    store.ingest([observation(3, DAY_MINUTES + 30, { time: BASE / 1000 })], 'c-late', at(DAY_MINUTES + 30))
    expect(store.archiveTrajectories(at(DAY_MINUTES + 31))).toBe(0)
    expect(store.trajectory(2)).toBeNull()
    expect(store.trajectory(3)).toBeNull()
  })

  it('records flagged stories and survives the pruning of their raw data', () => {
    const store = memoryStore()
    observeFirstDay(store)
    store.ingest([observation(1, DAY_MINUTES + 5, { time: BASE / 1000, dead: true })], 'c-dead', at(DAY_MINUTES + 5))
    store.archiveTrajectories(at(DAY_MINUTES + 10))
    store.prune(at(DAY_MINUTES + 90 * 24 * 60))
    expect(store.history(1, 0)).toEqual([])
    expect(store.stories([1])).toEqual([])
    const trajectory = store.trajectory(1)!
    expect(trajectory.dead).toBe(true)
    expect(trajectory.points.length).toBeGreaterThan(100)
  })

  it('applies the trajectory migration', () => {
    const db = openDatabase(':memory:')
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(version).toBe(2)
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'trajectories'`).get()).toBeTruthy()
  })
})
