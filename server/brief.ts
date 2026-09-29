import type { Brief, BriefEntry, Momentum, Signal, SignalKind, Story } from '../shared/types.ts'
import type { RunRecord } from './store.ts'
import { utcDateKey } from './store.ts'

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const MAX_ENTRIES = 10
const BREAKOUT_HEAT_FLOOR = 1
const DISCUSSION_GAIN_FLOOR = 15
const MIN_GAP_TOLERANCE = 5 * 60_000
const TOLERABLE_ITEM_FAILURE_RATIO = 0.1

export interface BriefInput {
  stories: Story[]
  signals: Signal[]
  momentum: Map<number, Momentum>
  runs: RunRecord[]
  scannedCount: number
  pollIntervalSeconds: number
}

interface Candidate {
  story: Story
  signals: SignalKind[]
  heat: number
  commentGain: number
  score: number
}

/**
 * Builds the shared daily brief for the 24 hours ending at `now`. Pure and deterministic.
 *
 * Stories that produced a signal (breakout, discussion spike, milestone) in the window are the
 * candidates; if that yields fewer than ten, the most-engaged stories created in the window fill
 * the rest. The biggest breakout and biggest discussion are always included. Coverage is
 * reported honestly from recorded collection runs.
 */
export function buildBrief(input: BriefInput, now: number): Brief {
  const windowStart = now - DAY
  const stories = new Map(input.stories.map((story) => [story.id, story]))
  const periodSignals = input.signals.filter((signal) => signal.createdAt >= windowStart && signal.createdAt <= now)

  const bySignal = new Map<number, Signal[]>()
  for (const signal of periodSignals) {
    const list = bySignal.get(signal.storyId)
    if (list) list.push(signal)
    else bySignal.set(signal.storyId, [signal])
  }

  const candidates: Candidate[] = []
  for (const [storyId, signals] of bySignal) {
    const story = stories.get(storyId) ?? signals[0].story
    if (story && eligible(story, now)) candidates.push(candidate(story, signals, input.momentum.get(storyId), now))
  }
  const ranked = candidates.sort(precedes)

  const breakout = largest(candidates.filter((c) => c.heat >= BREAKOUT_HEAT_FLOOR), (c) => c.heat)
  const discussion = largest(candidates.filter((c) => c.commentGain >= DISCUSSION_GAIN_FLOOR), (c) => c.commentGain)

  const selection: Candidate[] = []
  const chosen = new Set<number>()
  const add = (c: Candidate | null) => {
    if (c && !chosen.has(c.story.id) && selection.length < MAX_ENTRIES) {
      chosen.add(c.story.id)
      selection.push(c)
    }
  }
  add(breakout)
  add(discussion)
  for (const c of ranked) add(c)

  // Quiet day: fill with the day's most engaged new stories.
  if (selection.length < MAX_ENTRIES) {
    const fillers = [...stories.values()]
      .filter((story) => !chosen.has(story.id) && eligible(story, now) && story.createdAt! >= windowStart)
      .map((story) => candidate(story, [], input.momentum.get(story.id), now))
      .sort((a, b) => engagement(b.story) - engagement(a.story) || precedes(a, b))
    for (const filler of fillers) add(filler)
  }

  selection.sort(precedes)
  const coverage = coverageOf(input, now, windowStart)
  const entries: BriefEntry[] = selection.map((c) => ({
    story: c.story,
    score: c.score,
    heat: c.heat,
    commentGain: c.commentGain,
    signals: c.signals,
    biggestBreakout: c.story.id === breakout?.story.id,
    biggestDiscussion: c.story.id === discussion?.story.id,
  }))

  return {
    dateKey: utcDateKey(now),
    generatedAt: now,
    coverageStart: coverage.start,
    coverageEnd: now,
    partial: coverage.partial,
    scannedCount: input.scannedCount,
    signalCount: periodSignals.length,
    entries,
  }
}

/** When today's brief is due: `hourUtc`:00 on the UTC day containing `now`. */
export function briefDueAt(now: number, hourUtc: number): number {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hourUtc)
}

function eligible(story: Story, now: number): boolean {
  return (story.type === 'story' || story.type === 'poll') && story.available && story.createdAt !== null && story.createdAt <= now
}

function candidate(story: Story, signals: Signal[], current: Momentum | undefined, now: number): Candidate {
  const heats = signals.flatMap((signal) => (signal.momentum ? [signal.momentum.heat] : []))
  const gains = signals.flatMap((signal) => (signal.momentum?.commentDelta != null ? [signal.momentum.commentDelta] : []))
  if (current) {
    heats.push(current.heat)
    if (current.commentDelta !== null) gains.push(current.commentDelta)
  }
  const heat = Math.max(0, ...heats)
  const commentGain = Math.max(0, ...gains)
  const ageHours = Math.max(0, now - story.createdAt!) / HOUR
  const momentumFactor = 1 + Math.min(heat, 3)
  const freshness = 1 / (1 + ageHours / 12)
  return {
    story,
    signals: [...new Set(signals.map((signal) => signal.kind))].sort(),
    heat,
    commentGain,
    score: momentumFactor * (1 + Math.log10(1 + engagement(story))) * freshness,
  }
}

function engagement(story: Story): number {
  return Math.max(story.score ?? 0, 0) + 2 * Math.max(story.comments ?? 0, 0)
}

/** Brief score descending, then newer creation, then id. */
function precedes(a: Candidate, b: Candidate): number {
  if (a.score !== b.score) return b.score - a.score
  if (a.story.createdAt !== b.story.createdAt) return (b.story.createdAt ?? 0) - (a.story.createdAt ?? 0)
  return a.story.id - b.story.id
}

function largest(candidates: Candidate[], measure: (c: Candidate) => number): Candidate | null {
  return [...candidates].sort((a, b) => measure(b) - measure(a) || precedes(a, b))[0] ?? null
}

// MARK: - Coverage

/**
 * Only runs that observed HN count: complete runs, or partial runs with every feed fetched and
 * nearly every item answered. The brief is partial when observing runs are further apart than
 * the tolerance (two polls, at least five minutes) or started after the window opened.
 */
function coverageOf(input: BriefInput, now: number, windowStart: number): { start: number; partial: boolean } {
  const runs = input.runs
    .filter((run) => observes(run) && run.startedAt <= now && (run.finishedAt ?? run.startedAt) >= windowStart)
    .sort((a, b) => a.startedAt - b.startedAt)
  const tolerance = (run: RunRecord) => Math.max(2 * (run.intervalSeconds > 0 ? run.intervalSeconds : input.pollIntervalSeconds) * 1000, MIN_GAP_TOLERANCE)

  const first = runs[0]
  if (!first) {
    const seen = input.stories.map((story) => story.firstSeenAt).filter((time) => time >= windowStart && time <= now)
    return { start: seen.length ? Math.max(windowStart, Math.min(...seen)) : now, partial: true }
  }
  let partial = first.startedAt - windowStart > tolerance(first)
  for (let index = 1; index < runs.length; index++) {
    const previous = runs[index - 1]
    if (runs[index].startedAt - (previous.finishedAt ?? previous.startedAt) > tolerance(previous)) partial = true
  }
  const last = runs[runs.length - 1]
  if (now - (last.finishedAt ?? last.startedAt) > tolerance(last)) partial = true
  return { start: Math.max(windowStart, first.startedAt), partial }
}

function observes(run: RunRecord): boolean {
  if (run.outcome === 'complete') return true
  if (run.outcome !== 'partial' || run.failedFeeds > 0 || run.attempted === 0) return false
  return run.succeeded >= run.attempted * (1 - TOLERABLE_ITEM_FAILURE_RATIO)
}
