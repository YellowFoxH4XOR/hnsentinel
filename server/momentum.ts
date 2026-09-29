import type { HeatLevel, Momentum, Snapshot, Story } from '../shared/types.ts'

// Pure, deterministic measurement of early growth for one story (a port of the macOS engine).
//
// Every reported value comes from two real observations joined by an unbroken chain of samples;
// the engine never extrapolates, never invents a rank jump, and reports the elapsed interval
// that actually occurred next to the deltas it measured.

const MINUTE = 60_000
const BASELINE_TARGET = 20 * MINUTE
const BASELINE_LOWER = 15 * MINUTE
const BASELINE_UPPER = 25 * MINUTE
export const CONTINUITY_LIMIT = 5 * MINUTE
const AUTOMATIC_AGE_LIMIT = 6 * 60 * MINUTE
const POINT_HEAT_SCALE = 20
const COMMENT_HEAT_SCALE = 15
const RANK_HEAT_SCALE = 15

/** How far back history must reach for `evaluate` (current window plus the previous one). */
export const MOMENTUM_HISTORY_WINDOW = 50 * MINUTE

export function signalEligible(story: Story): boolean {
  return story.available && story.createdAt !== null && ['story', 'poll', 'job'].includes(story.type)
}

/**
 * Measures momentum from a story's snapshot history, or returns `null` when the history cannot
 * support an honest measurement: no usable observation, a stale endpoint, a broken observation
 * chain, or no sample near the twenty-minute baseline.
 */
export function evaluateMomentum(story: Story, history: Snapshot[], now: number): Momentum | null {
  if (!signalEligible(story)) return null

  const observations = ordered(history)
  const endpointIndex = findLastIndex(observations, usable)
  if (endpointIndex < 0) return null
  const endpoint = observations[endpointIndex]
  const latest = observations[observations.length - 1]
  if (!fresh(endpoint.observedAt, now) || !fresh(latest.observedAt, now)) return null

  const baselineIndex = selectBaseline(observations, endpointIndex)
  if (baselineIndex === null) return null
  if (!continuous(observations, baselineIndex, observations.length - 1)) return null

  const baseline = observations[baselineIndex]
  const elapsedMinutes = (endpoint.observedAt - baseline.observedAt) / MINUTE
  const pointDelta = delta(endpoint.score, baseline.score)
  const commentDelta = delta(endpoint.comments, baseline.comments)
  const rankGain = rankGainBetween(observations, baselineIndex, endpointIndex)
  const pointVelocity = pointDelta === null ? null : pointDelta / elapsedMinutes
  const commentVelocity = commentDelta === null ? null : commentDelta / elapsedMinutes

  const previous = previousWindow(observations, baselineIndex)
  const pointAcceleration = subtract(pointVelocity, previous?.pointVelocity ?? null)
  const commentAcceleration = subtract(commentVelocity, previous?.commentVelocity ?? null)

  // Heat is limited to fresh stories and polls; the measured metrics stay available at any age.
  let heat = 0
  if (automaticallyEligible(story, now)) {
    const contributions: number[] = []
    if (pointDelta !== null) contributions.push(Math.max(0, pointDelta) / POINT_HEAT_SCALE)
    if (commentDelta !== null) contributions.push(Math.max(0, commentDelta) / COMMENT_HEAT_SCALE)
    if (rankGain !== null) contributions.push(Math.max(0, rankGain) / RANK_HEAT_SCALE)
    heat = contributions.length ? Math.max(...contributions) : 0
  }

  return {
    elapsedMinutes,
    pointDelta,
    commentDelta,
    rankGain,
    pointVelocity,
    commentVelocity,
    pointAcceleration,
    commentAcceleration,
    heat,
    level: levelFor(heat),
  }
}

/**
 * The Rising list: rising/breakout stories sorted by heat, then point velocity, then newer
 * creation time, then id.
 */
export function rising<T extends Story>(stories: T[], signals: Map<number, Momentum>): T[] {
  return stories
    .filter((story) => {
      const level = signals.get(story.id)?.level
      return signalEligible(story) && (level === 'rising' || level === 'breakout')
    })
    .sort((a, b) => {
      const sa = signals.get(a.id)!
      const sb = signals.get(b.id)!
      if (sa.heat !== sb.heat) return sb.heat - sa.heat
      const va = sa.pointVelocity ?? -Infinity
      const vb = sb.pointVelocity ?? -Infinity
      if (va !== vb) return vb - va
      const ca = a.createdAt ?? -Infinity
      const cb = b.createdAt ?? -Infinity
      if (ca !== cb) return cb - ca
      return a.id - b.id
    })
}

export function levelFor(heat: number): HeatLevel {
  if (heat >= 1) return 'breakout'
  if (heat >= 0.5) return 'rising'
  if (heat >= 0.25) return 'warm'
  return 'normal'
}

// MARK: - Observation window

/** Ascending, deduplicated observations; a repeated timestamp keeps the last one supplied. */
function ordered(history: Snapshot[]): Snapshot[] {
  const sorted = history.map((snapshot, order) => ({ snapshot, order })).sort((a, b) =>
    a.snapshot.observedAt !== b.snapshot.observedAt ? a.snapshot.observedAt - b.snapshot.observedAt : a.order - b.order,
  )
  const result: Snapshot[] = []
  for (const { snapshot } of sorted) {
    if (result.length && result[result.length - 1].observedAt === snapshot.observedAt) result[result.length - 1] = snapshot
    else result.push(snapshot)
  }
  return result
}

function usable(snapshot: Snapshot): boolean {
  return snapshot.score !== null || snapshot.comments !== null || snapshot.topRank !== null
}

function fresh(observedAt: number, now: number): boolean {
  const age = now - observedAt
  return age >= 0 && age <= CONTINUITY_LIMIT
}

/** Usable sample closest to 20 minutes before the endpoint (15–25 accepted, earlier wins ties). */
function selectBaseline(observations: Snapshot[], endpointIndex: number): number | null {
  const endpointTime = observations[endpointIndex].observedAt
  let best: number | null = null
  let bestDistance = Infinity
  for (let index = endpointIndex - 1; index >= 0; index--) {
    const elapsed = endpointTime - observations[index].observedAt
    if (elapsed < BASELINE_LOWER) continue
    if (elapsed > BASELINE_UPPER) break
    if (usable(observations[index])) {
      const distance = Math.abs(elapsed - BASELINE_TARGET)
      if (distance <= bestDistance) {
        best = index
        bestDistance = distance
      }
    }
  }
  return best
}

/** Every adjacent pair of observations in the range is at most five minutes apart. */
function continuous(observations: Snapshot[], start: number, end: number): boolean {
  for (let index = start + 1; index <= end; index++) {
    if (observations[index].observedAt - observations[index - 1].observedAt > CONTINUITY_LIMIT) return false
  }
  return true
}

function previousWindow(observations: Snapshot[], endIndex: number): { pointVelocity: number | null; commentVelocity: number | null } | null {
  const priorIndex = selectBaseline(observations, endIndex)
  if (priorIndex === null || !continuous(observations, priorIndex, endIndex)) return null
  const prior = observations[priorIndex]
  const end = observations[endIndex]
  const minutes = (end.observedAt - prior.observedAt) / MINUTE
  if (minutes <= 0) return null
  const points = delta(end.score, prior.score)
  const comments = delta(end.comments, prior.comments)
  return {
    pointVelocity: points === null ? null : points / minutes,
    commentVelocity: comments === null ? null : comments / minutes,
  }
}

// MARK: - Deltas and classification

function delta(next: number | null, previous: number | null): number | null {
  return next === null || previous === null ? null : next - previous
}

/** Requires a Top rank on every observation of the interval, so entering Top is never a "jump". */
function rankGainBetween(observations: Snapshot[], baselineIndex: number, endpointIndex: number): number | null {
  for (let index = baselineIndex; index <= endpointIndex; index++) {
    if (observations[index].topRank === null) return null
  }
  return observations[baselineIndex].topRank! - observations[endpointIndex].topRank!
}

function subtract(value: number | null, other: number | null): number | null {
  return value === null || other === null ? null : value - other
}

function automaticallyEligible(story: Story, now: number): boolean {
  if (story.type !== 'story' && story.type !== 'poll') return false
  if (story.createdAt === null) return false
  const age = now - story.createdAt
  return age >= 0 && age < AUTOMATIC_AGE_LIMIT
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) if (predicate(items[index])) return index
  return -1
}
