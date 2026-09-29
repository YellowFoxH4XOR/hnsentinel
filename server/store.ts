import { gunzipSync, gzipSync } from 'node:zlib'
import type { Brief, BriefSummary, FeedKind, Momentum, Signal, SignalKind, Snapshot, Story } from '../shared/types.ts'
import { FEED_KINDS } from '../shared/types.ts'
import { transaction, type Database } from './db.ts'
import type { HNItem } from './hn.ts'
import { evaluateMomentum, MOMENTUM_HISTORY_WINDOW } from './momentum.ts'
import { domainOf, safeUrl } from './titles.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Automatic signals fire at most once per story per hour. */
export const SIGNAL_COOLDOWN = HOUR
/** Score milestones announced as signals. */
export const MILESTONES = [100, 250, 500] as const
/** Longest a high-frequency story may go without an observation (under the 5-minute continuity limit). */
export const HIGH_FREQUENCY_MAX_AGE = 270_000
const SECONDARY_CADENCE = 15 * MINUTE
const BRIEF_PAYLOAD_VERSION = 1

/** A story's trajectory covers its first day and is archived once that day is over. */
export const TRAJECTORY_HORIZON = DAY
/** Sampling of an archived trajectory: fine while stories take off, coarse afterwards. */
const TRAJECTORY_FINE_WINDOW = 6 * HOUR
const TRAJECTORY_FINE_STEP = 5 * MINUTE
const TRAJECTORY_COARSE_STEP = 30 * MINUTE
/** Gaps longer than this don't count toward time on the front page. */
const FRONT_PAGE_GAP_CAP = 15 * MINUTE
export const FRONT_PAGE_RANK = 30
const TRAJECTORY_BATCH = 500
const TRAJECTORY_SERIES_VERSION = 1

/** One point of an archived trajectory: minutes since creation, score, comments, front-page rank. */
export type TrajectoryPoint = [minute: number, score: number | null, comments: number | null, rank: number | null]

/** The long-term record of one story's first day. */
export interface Trajectory {
  storyId: number
  type: string
  title: string
  domain: string | null
  author: string | null
  createdAt: number
  archivedAt: number
  /** Raw observations inside the horizon (before downsampling). */
  samples: number
  firstObservedAt: number
  lastObservedAt: number
  /** Longest pause between observations; large values mean partial coverage. */
  maxGapMinutes: number
  maxScore: number | null
  maxComments: number | null
  finalScore: number | null
  finalComments: number | null
  /** Best (lowest) front-page rank observed, or null if never listed on Top. */
  bestRank: number | null
  frontPageMinutes: number
  dead: boolean
  deleted: boolean
  points: TrajectoryPoint[]
}

export type RunOutcome = 'complete' | 'partial' | 'failed' | 'cancelled'

export interface RunRecord {
  id: string
  startedAt: number
  finishedAt: number | null
  intervalSeconds: number
  outcome: RunOutcome
  failedFeeds: number
  attempted: number
  succeeded: number
}

export interface FeedResult {
  kind: FeedKind
  ids: number[] | null
  error?: string
}

export interface FeedState {
  ids: number[]
  fetchedAt: number | null
  error: string | null
}

export interface Observation {
  item: HNItem
  title: string
  observedAt: number
  /** Front-page rank from this cycle's successful Top list, or null. */
  topRank: number | null
}

export interface CollectionPlan {
  itemIds: number[]
  /** Ranks from this cycle's Top list; empty when the Top fetch failed. */
  topRanks: Map<number, number>
}

interface StoryRow {
  id: number
  title: string
  type: string
  url: string | null
  author: string | null
  created_at: number | null
  score: number | null
  comments: number | null
  deleted: number
  dead: number
  first_seen_at: number
  last_fetched_at: number
}

interface SnapshotRow {
  story_id: number
  observed_at: number
  score: number | null
  comments: number | null
  top_rank: number | null
}

interface SignalRow {
  id: number
  story_id: number
  kind: SignalKind
  reason: string
  created_at: number
  score: number | null
  comments: number | null
  momentum: string | null
}

export function toStory(row: StoryRow): Story {
  const url = safeUrl(row.url)?.href ?? null
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    url,
    domain: domainOf(url),
    author: row.author,
    createdAt: row.created_at,
    score: row.score,
    comments: row.comments,
    available: !row.deleted && !row.dead && row.title !== '',
    firstSeenAt: row.first_seen_at,
    lastFetchedAt: row.last_fetched_at,
  }
}

function toSnapshot(row: SnapshotRow): Snapshot {
  return { observedAt: row.observed_at, score: row.score, comments: row.comments, topRank: row.top_rank }
}

/** UTC calendar date, `yyyy-mm-dd`. Everyone shares one brief per UTC day. */
export function utcDateKey(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

/**
 * Sole owner of the SQLite database. Every mutation runs in one transaction, so a failed batch
 * never commits partially.
 */
export class Store {
  readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  // MARK: - Feeds and planning

  feeds(): Record<FeedKind, FeedState> {
    const result = {} as Record<FeedKind, FeedState>
    for (const kind of FEED_KINDS) result[kind] = { ids: [], fetchedAt: null, error: null }
    const rows = this.db.prepare('SELECT kind, ids, fetched_at, error FROM feeds').all() as { kind: FeedKind; ids: string; fetched_at: number | null; error: string | null }[]
    for (const row of rows) {
      if (row.kind in result) result[row.kind] = { ids: JSON.parse(row.ids) as number[], fetchedAt: row.fetched_at, error: row.error }
    }
    return result
  }

  /**
   * Saves this cycle's feed lists and chooses which items to fetch.
   *
   * High-frequency set: Top's first 100 plus the 300 most recently created stories/polls under
   * six hours old. Each is fetched when /updates reports a change, or before its newest
   * observation would age past `HIGH_FREQUENCY_MAX_AGE`, keeping momentum's observation chain
   * unbroken without refetching unchanged stories every poll. Everything else listed or seen in
   * the last day refreshes every 15 minutes, or sooner when /updates mentions it.
   */
  planCollection(results: FeedResult[], changed: Set<number>, now: number, pollIntervalSeconds: number): CollectionPlan {
    return transaction(this.db, () => {
      const upsert = this.db.prepare(`
        INSERT INTO feeds (kind, ids, fetched_at, error) VALUES (?, ?, ?, NULL)
        ON CONFLICT(kind) DO UPDATE SET ids = excluded.ids, fetched_at = excluded.fetched_at, error = NULL`)
      const markError = this.db.prepare(`
        INSERT INTO feeds (kind, ids, fetched_at, error) VALUES (?, '[]', NULL, ?)
        ON CONFLICT(kind) DO UPDATE SET error = excluded.error`)
      for (const result of results) {
        if (result.ids) upsert.run(result.kind, JSON.stringify(unique(result.ids)), now)
        else markError.run(result.kind, result.error ?? 'Feed request failed')
      }

      const feeds = this.feeds()
      const topResult = results.find((result) => result.kind === 'top' && result.ids)
      const topList = topResult?.ids ? unique(topResult.ids) : feeds.top.ids
      const topRanks = new Map<number, number>(topResult ? topList.map((id, index) => [id, index + 1]) : [])

      const listed = unique(FEED_KINDS.flatMap((kind) => feeds[kind].ids))
      const known = new Map<number, StoryRow>()
      for (const row of this.#storyRows(listed)) known.set(row.id, row)
      const dayAgo = now - DAY
      for (const row of this.db
        .prepare('SELECT * FROM stories WHERE first_seen_at >= ? OR last_fetched_at >= ?')
        .all(dayAgo, dayAgo) as unknown as StoryRow[]) {
        known.set(row.id, row)
      }

      const recentlyCreated = [...known.values()]
        .filter((row) => (row.type === 'story' || row.type === 'poll') && row.created_at !== null && row.created_at >= now - 6 * HOUR && row.created_at <= now)
        .sort((a, b) => (b.created_at! - a.created_at!) || b.id - a.id)
      const highFrequency = unique([...topList.slice(0, 100), ...recentlyCreated.slice(0, 300).map((row) => row.id)]).slice(0, 400)
      const highFrequencySet = new Set(highFrequency)

      const observedWithinDay = [...known.values()]
        .filter((row) => {
          const anchor = row.created_at ?? row.first_seen_at
          return anchor >= dayAgo && anchor <= now
        })
        .sort((a, b) => ((b.created_at ?? b.first_seen_at) - (a.created_at ?? a.first_seen_at)) || b.id - a.id)
      const secondary = unique([...listed, ...observedWithinDay.map((row) => row.id)]).filter((id) => !highFrequencySet.has(id))

      const poll = Math.max(pollIntervalSeconds, 1) * 1000
      const highFrequencyDue = highFrequency.filter((id) => {
        const row = known.get(id)
        return changed.has(id) || !row || now - row.last_fetched_at + poll > HIGH_FREQUENCY_MAX_AGE
      })
      const secondaryDue = secondary.filter((id) => {
        const row = known.get(id)
        return changed.has(id) || !row || row.last_fetched_at <= now - SECONDARY_CADENCE
      })
      return { itemIds: [...highFrequencyDue, ...secondaryDue], topRanks }
    })
  }

  // MARK: - Runs

  beginRun(run: RunRecord): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO runs (id, started_at, finished_at, interval_seconds, outcome, failed_feeds, attempted, succeeded)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(run.id, run.startedAt, run.finishedAt, run.intervalSeconds, run.outcome, run.failedFeeds, run.attempted, run.succeeded)
  }

  finishRun(run: RunRecord): void {
    this.beginRun(run)
  }

  /** Runs left open by a crash are closed as partial on startup. */
  recoverInterruptedRuns(now: number): void {
    this.db.prepare(`UPDATE runs SET finished_at = ?, outcome = 'partial' WHERE finished_at IS NULL`).run(now)
  }

  runsSince(since: number): RunRecord[] {
    const rows = this.db.prepare('SELECT * FROM runs WHERE started_at >= ? ORDER BY started_at').all(since) as {
      id: string; started_at: number; finished_at: number | null; interval_seconds: number; outcome: RunOutcome; failed_feeds: number; attempted: number; succeeded: number
    }[]
    return rows.map((row) => ({
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      intervalSeconds: row.interval_seconds,
      outcome: row.outcome,
      failedFeeds: row.failed_feeds,
      attempted: row.attempted,
      succeeded: row.succeeded,
    }))
  }

  // MARK: - Ingest

  /**
   * Stores one batch of observations and evaluates automatic signals, atomically. Replaying the
   * same cycle/story pair commits nothing new. Returns the signals created.
   */
  ingest(observations: Observation[], cycleId: string, now: number): Signal[] {
    return transaction(this.db, () => {
      const seen = new Set<number>()
      const batch = observations.filter((observation) => observation.item.id > 0 && !seen.has(observation.item.id) && seen.add(observation.item.id))
      if (!batch.length) return []

      const processedRows = this.db
        .prepare('SELECT story_id FROM snapshots WHERE cycle_id = ? AND story_id IN (SELECT value FROM json_each(?))')
        .all(cycleId, JSON.stringify(batch.map((observation) => observation.item.id))) as { story_id: number }[]
      const alreadyProcessed = new Set(processedRows.map((row) => row.story_id))
      const pending = batch.filter((observation) => !alreadyProcessed.has(observation.item.id))
      if (!pending.length) return []

      const existing = new Map(this.#storyRows(pending.map((observation) => observation.item.id)).map((row) => [row.id, row]))
      const upsert = this.db.prepare(`
        INSERT INTO stories (id, title, type, url, author, created_at, score, comments, deleted, dead, first_seen_at, last_fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, type = excluded.type, url = excluded.url, author = excluded.author,
          created_at = excluded.created_at, score = excluded.score, comments = excluded.comments, deleted = excluded.deleted,
          dead = excluded.dead, last_fetched_at = excluded.last_fetched_at`)
      const insertSnapshot = this.db.prepare(`
        INSERT OR IGNORE INTO snapshots (story_id, cycle_id, observed_at, score, comments, top_rank) VALUES (?, ?, ?, ?, ?, ?)`)

      const stories: Story[] = []
      for (const observation of pending) {
        const row = mergeStory(existing.get(observation.item.id), observation)
        upsert.run(row.id, row.title, row.type, row.url, row.author, row.created_at, row.score, row.comments, row.deleted, row.dead, row.first_seen_at, row.last_fetched_at)
        if (!row.deleted) {
          insertSnapshot.run(row.id, cycleId, observation.observedAt, observation.item.score ?? null, observation.item.descendants ?? null, observation.topRank)
        }
        stories.push(toStory(row))
      }

      return this.#evaluateSignals(stories, now)
    })
  }

  #evaluateSignals(stories: Story[], now: number): Signal[] {
    const history = this.historyByStory(stories.map((story) => story.id), now - MOMENTUM_HISTORY_WINDOW)
    const stateRows = this.db
      .prepare('SELECT key, triggered, last_trigger_at FROM signal_state WHERE story_id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(stories.map((story) => story.id))) as { key: string; triggered: number; last_trigger_at: number | null }[]
    const states = new Map(stateRows.map((row) => [row.key, row]))
    const saveState = this.db.prepare(`
      INSERT INTO signal_state (key, story_id, triggered, last_trigger_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET triggered = excluded.triggered, last_trigger_at = excluded.last_trigger_at`)
    const insertSignal = this.db.prepare(`
      INSERT INTO signals (story_id, kind, reason, created_at, score, comments, momentum) VALUES (?, ?, ?, ?, ?, ?, ?)`)

    const created: Signal[] = []
    const emit = (story: Story, kind: SignalKind, reason: string, momentum: Momentum | null) => {
      const result = insertSignal.run(story.id, kind, reason, now, story.score, story.comments, momentum ? JSON.stringify(momentum) : null)
      created.push({ id: Number(result.lastInsertRowid), storyId: story.id, kind, reason, createdAt: now, score: story.score, comments: story.comments, momentum, story })
    }
    const coolingDown = (key: string) => {
      const last = states.get(key)?.last_trigger_at
      return last !== null && last !== undefined && now - last < SIGNAL_COOLDOWN
    }
    const trigger = (key: string, storyId: number) => {
      saveState.run(key, storyId, 1, now)
      states.set(key, { key, triggered: 1, last_trigger_at: now })
    }

    for (const story of stories) {
      const momentum = evaluateMomentum(story, history.get(story.id) ?? [], now)
      const fresh = (story.type === 'story' || story.type === 'poll') && story.createdAt !== null && story.createdAt <= now && now - story.createdAt < 6 * HOUR

      if (fresh && momentum) {
        const pointDelta = momentum.pointDelta ?? 0
        const rankGain = momentum.rankGain ?? 0
        const breakoutKey = `breakout:${story.id}`
        if ((pointDelta >= 20 || rankGain >= 15) && !coolingDown(breakoutKey)) {
          trigger(breakoutKey, story.id)
          emit(story, 'breakout', breakoutReason(momentum), momentum)
        }
        const discussionKey = `discussion:${story.id}`
        if ((momentum.commentDelta ?? 0) >= 15 && !coolingDown(discussionKey)) {
          trigger(discussionKey, story.id)
          emit(story, 'discussion', `Comments ${signed(momentum.commentDelta!)} in ${minutes(momentum.elapsedMinutes)}`, momentum)
        }
      }

      if (story.available && story.score !== null) {
        const keys = MILESTONES.map((milestone) => ({ milestone, key: `score:${milestone}:${story.id}` }))
        if (keys.every(({ key }) => !states.has(key))) {
          // First sighting: milestones already reached are consumed silently.
          for (const { milestone, key } of keys) {
            const reached = story.score >= milestone
            saveState.run(key, story.id, reached ? 1 : 0, reached ? now : null)
            states.set(key, { key, triggered: reached ? 1 : 0, last_trigger_at: reached ? now : null })
          }
        } else {
          const crossed = keys.filter(({ key, milestone }) => !states.get(key)?.triggered && story.score! >= milestone)
          if (crossed.length) {
            for (const { key } of crossed) trigger(key, story.id)
            emit(story, 'milestone', `Reached ${Math.max(...crossed.map(({ milestone }) => milestone))} points`, momentum)
          }
        }
      }
    }
    return created
  }

  // MARK: - Reads

  stories(ids: number[]): Story[] {
    return this.#storyRows(ids).map(toStory)
  }

  /** Stories first seen or refreshed since `since`. */
  recentStories(since: number): Story[] {
    return (this.db
      .prepare('SELECT * FROM stories WHERE first_seen_at >= ? OR last_fetched_at >= ?')
      .all(since, since) as unknown as StoryRow[]).map(toStory)
  }

  history(storyId: number, since: number): Snapshot[] {
    return (this.db
      .prepare('SELECT story_id, observed_at, score, comments, top_rank FROM snapshots WHERE story_id = ? AND observed_at >= ? ORDER BY observed_at')
      .all(storyId, since) as unknown as SnapshotRow[]).map(toSnapshot)
  }

  historyByStory(ids: number[], since: number): Map<number, Snapshot[]> {
    const result = new Map<number, Snapshot[]>()
    if (!ids.length) return result
    const rows = this.db
      .prepare(`SELECT story_id, observed_at, score, comments, top_rank FROM snapshots
                WHERE observed_at >= ? AND story_id IN (SELECT value FROM json_each(?)) ORDER BY observed_at`)
      .all(since, JSON.stringify(ids)) as unknown as SnapshotRow[]
    for (const row of rows) {
      const list = result.get(row.story_id)
      if (list) list.push(toSnapshot(row))
      else result.set(row.story_id, [toSnapshot(row)])
    }
    return result
  }

  signals(options: { since?: number; limit?: number; storyId?: number } = {}): Signal[] {
    const rows = (options.storyId !== undefined
      ? this.db.prepare('SELECT * FROM signals WHERE story_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(options.storyId, options.limit ?? 50)
      : this.db.prepare('SELECT * FROM signals WHERE created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?').all(options.since ?? 0, options.limit ?? 200)) as unknown as SignalRow[]
    const stories = new Map(this.stories(rows.map((row) => row.story_id)).map((story) => [story.id, story]))
    return rows.map((row) => ({
      id: row.id,
      storyId: row.story_id,
      kind: row.kind,
      reason: row.reason,
      createdAt: row.created_at,
      score: row.score,
      comments: row.comments,
      momentum: row.momentum ? (JSON.parse(row.momentum) as Momentum) : null,
      story: stories.get(row.story_id) ?? null,
    }))
  }

  storyCount(): number {
    return (this.db.prepare('SELECT count(*) AS count FROM stories').get() as { count: number }).count
  }

  // MARK: - Briefs

  saveBrief(brief: Brief): void {
    this.db
      .prepare('INSERT OR IGNORE INTO briefs (date_key, generated_at, payload_version, payload) VALUES (?, ?, ?, ?)')
      .run(brief.dateKey, brief.generatedAt, BRIEF_PAYLOAD_VERSION, JSON.stringify(brief))
  }

  hasBrief(dateKey: string): boolean {
    return this.db.prepare('SELECT 1 FROM briefs WHERE date_key = ?').get(dateKey) !== undefined
  }

  /** A stored brief; briefs written by an unknown payload version are skipped, never fatal. */
  brief(dateKey?: string): Brief | null {
    const row = (dateKey
      ? this.db.prepare('SELECT payload_version, payload FROM briefs WHERE date_key = ? AND payload_version = ?').get(dateKey, BRIEF_PAYLOAD_VERSION)
      : this.db.prepare('SELECT payload_version, payload FROM briefs WHERE payload_version = ? ORDER BY date_key DESC LIMIT 1').get(BRIEF_PAYLOAD_VERSION)) as
      { payload: string } | undefined
    return row ? (JSON.parse(row.payload) as Brief) : null
  }

  briefSummaries(limit = 60): BriefSummary[] {
    const rows = this.db
      .prepare('SELECT payload FROM briefs WHERE payload_version = ? ORDER BY date_key DESC LIMIT ?')
      .all(BRIEF_PAYLOAD_VERSION, limit) as { payload: string }[]
    return rows.map((row) => {
      const brief = JSON.parse(row.payload) as Brief
      return { dateKey: brief.dateKey, generatedAt: brief.generatedAt, entryCount: brief.entries.length, partial: brief.partial }
    })
  }

  // MARK: - Long-term trajectories

  /**
   * Archives the first day of every story or poll that has just finished it, while its raw
   * snapshots still exist (they are pruned after 48 hours). Each run handles a bounded batch and
   * is idempotent; returns how many trajectories were written.
   */
  archiveTrajectories(now: number): number {
    return transaction(this.db, () => {
      const rows = this.db
        .prepare(`SELECT s.* FROM stories s
                  WHERE s.type IN ('story', 'poll') AND s.created_at >= ? AND s.created_at <= ?
                    AND NOT EXISTS (SELECT 1 FROM trajectories t WHERE t.story_id = s.id)
                    AND EXISTS (SELECT 1 FROM snapshots n WHERE n.story_id = s.id AND n.observed_at >= s.created_at AND n.observed_at <= s.created_at + ?)
                  ORDER BY s.created_at LIMIT ?`)
        .all(now - 2 * DAY, now - TRAJECTORY_HORIZON, TRAJECTORY_HORIZON, TRAJECTORY_BATCH) as unknown as StoryRow[]
      if (!rows.length) return 0

      const oldest = Math.min(...rows.map((row) => row.created_at!))
      const history = this.historyByStory(rows.map((row) => row.id), oldest)
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO trajectories (story_id, type, title, domain, author, created_at, archived_at, samples,
          first_observed_at, last_observed_at, max_gap_minutes, max_score, max_comments, final_score, final_comments,
          best_rank, front_page_minutes, dead, deleted, series_version, series)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)

      let written = 0
      for (const row of rows) {
        const createdAt = row.created_at!
        const snapshots = (history.get(row.id) ?? []).filter(
          (snapshot) => snapshot.observedAt >= createdAt && snapshot.observedAt <= createdAt + TRAJECTORY_HORIZON,
        )
        if (!snapshots.length) continue
        const summary = summarizeTrajectory(snapshots)
        const series = gzipSync(JSON.stringify(downsampleTrajectory(snapshots, createdAt)))
        insert.run(
          row.id, row.type, row.title, domainOf(safeUrl(row.url)?.href ?? null), row.author, createdAt, now, snapshots.length,
          summary.firstObservedAt, summary.lastObservedAt, summary.maxGapMinutes, summary.maxScore, summary.maxComments,
          summary.finalScore, summary.finalComments, summary.bestRank, summary.frontPageMinutes, row.dead, row.deleted,
          TRAJECTORY_SERIES_VERSION, series,
        )
        written += 1
      }
      return written
    })
  }

  trajectory(storyId: number): Trajectory | null {
    const row = this.db.prepare('SELECT * FROM trajectories WHERE story_id = ?').get(storyId) as TrajectoryRow | undefined
    return row ? toTrajectory(row) : null
  }

  trajectoryCount(): number {
    return (this.db.prepare('SELECT count(*) AS count FROM trajectories').get() as { count: number }).count
  }

  // MARK: - Retention

  /** Daily retention, at most once per UTC day. */
  pruneIfNeeded(now: number): boolean {
    const today = utcDateKey(now)
    if (this.#meta('last_pruned_day') === today) return false
    this.prune(now)
    this.#setMeta('last_pruned_day', today)
    return true
  }

  /**
   * Snapshots and runs are kept 48 hours, signals 30 days, briefs 90 days. Stories are kept for
   * 60 days after their last observation, or while a feed or a retained signal references them.
   * Archived trajectories are kept indefinitely.
   */
  prune(now: number): void {
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM snapshots WHERE observed_at < ?').run(now - 2 * DAY)
      this.db.prepare('DELETE FROM runs WHERE started_at < ?').run(now - 2 * DAY)
      this.db.prepare('DELETE FROM signals WHERE created_at < ?').run(now - 30 * DAY)
      this.db.prepare('DELETE FROM briefs WHERE generated_at < ?').run(now - 90 * DAY)
      const listed = JSON.stringify(unique(Object.values(this.feeds()).flatMap((feed) => feed.ids)))
      this.db
        .prepare(`DELETE FROM stories WHERE last_fetched_at < ?
                  AND id NOT IN (SELECT story_id FROM signals)
                  AND id NOT IN (SELECT value FROM json_each(?))`)
        .run(now - 60 * DAY, listed)
      this.db.prepare('DELETE FROM signal_state WHERE story_id NOT IN (SELECT id FROM stories)').run()
    })
  }

  // MARK: - Helpers

  #storyRows(ids: number[]): StoryRow[] {
    if (!ids.length) return []
    return this.db
      .prepare('SELECT * FROM stories WHERE id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(ids)) as unknown as StoryRow[]
  }

  #meta(key: string): string | null {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
  }

  #setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }
}

/**
 * Applies one successful item fetch. Missing API fields keep their previous known value or stay
 * absent; no zero values are invented for score, comments, or creation time.
 */
function mergeStory(existing: StoryRow | undefined, observation: Observation): StoryRow {
  const item = observation.item
  const base: StoryRow = existing ?? {
    id: item.id,
    title: observation.title,
    type: item.type ?? '',
    url: null,
    author: item.by ?? null,
    created_at: null,
    score: null,
    comments: null,
    deleted: 0,
    dead: 0,
    first_seen_at: observation.observedAt,
    last_fetched_at: observation.observedAt,
  }
  return {
    ...base,
    title: observation.title || base.title,
    type: item.type || base.type,
    url: item.url !== undefined ? (safeUrl(item.url)?.href ?? null) : base.url,
    author: item.by ?? base.author,
    created_at: item.time !== undefined ? item.time * 1000 : base.created_at,
    score: item.score ?? null,
    comments: item.descendants ?? null,
    deleted: item.deleted ? 1 : 0,
    dead: item.dead ? 1 : 0,
    last_fetched_at: observation.observedAt,
  }
}

interface TrajectoryRow {
  story_id: number
  type: string
  title: string
  domain: string | null
  author: string | null
  created_at: number
  archived_at: number
  samples: number
  first_observed_at: number
  last_observed_at: number
  max_gap_minutes: number
  max_score: number | null
  max_comments: number | null
  final_score: number | null
  final_comments: number | null
  best_rank: number | null
  front_page_minutes: number
  dead: number
  deleted: number
  series_version: number
  series: Uint8Array
}

function toTrajectory(row: TrajectoryRow): Trajectory {
  if (row.series_version !== TRAJECTORY_SERIES_VERSION) {
    throw new Error(`Trajectory ${row.story_id} uses unsupported series version ${row.series_version}`)
  }
  return {
    storyId: row.story_id,
    type: row.type,
    title: row.title,
    domain: row.domain,
    author: row.author,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    samples: row.samples,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    maxGapMinutes: row.max_gap_minutes,
    maxScore: row.max_score,
    maxComments: row.max_comments,
    finalScore: row.final_score,
    finalComments: row.final_comments,
    bestRank: row.best_rank,
    frontPageMinutes: row.front_page_minutes,
    dead: row.dead === 1,
    deleted: row.deleted === 1,
    points: JSON.parse(gunzipSync(row.series).toString('utf8')) as TrajectoryPoint[],
  }
}

/** Keeps the last observation in each 5-minute bucket for six hours, then each 30-minute bucket. */
export function downsampleTrajectory(snapshots: Snapshot[], createdAt: number): TrajectoryPoint[] {
  const buckets = new Map<number, Snapshot>()
  for (const snapshot of [...snapshots].sort((a, b) => a.observedAt - b.observedAt)) {
    const offset = Math.max(0, snapshot.observedAt - createdAt)
    const bucket = offset < TRAJECTORY_FINE_WINDOW
      ? Math.floor(offset / TRAJECTORY_FINE_STEP)
      : 1_000_000 + Math.floor((offset - TRAJECTORY_FINE_WINDOW) / TRAJECTORY_COARSE_STEP)
    buckets.set(bucket, snapshot)
  }
  return [...buckets.values()].map((snapshot) => [
    Math.round(Math.max(0, snapshot.observedAt - createdAt) / MINUTE),
    snapshot.score,
    snapshot.comments,
    snapshot.topRank,
  ])
}

/** Outcome and coverage figures from the raw observations of a story's first day. */
export function summarizeTrajectory(snapshots: Snapshot[]) {
  const ordered = [...snapshots].sort((a, b) => a.observedAt - b.observedAt)
  const scores = ordered.flatMap((snapshot) => (snapshot.score === null ? [] : [snapshot.score]))
  const comments = ordered.flatMap((snapshot) => (snapshot.comments === null ? [] : [snapshot.comments]))
  const ranks = ordered.flatMap((snapshot) => (snapshot.topRank === null ? [] : [snapshot.topRank]))
  let maxGap = 0
  let frontPage = 0
  for (let index = 1; index < ordered.length; index++) {
    const gap = ordered[index].observedAt - ordered[index - 1].observedAt
    maxGap = Math.max(maxGap, gap)
    const rank = ordered[index - 1].topRank
    if (rank !== null && rank <= FRONT_PAGE_RANK) frontPage += Math.min(gap, FRONT_PAGE_GAP_CAP)
  }
  return {
    firstObservedAt: ordered[0].observedAt,
    lastObservedAt: ordered[ordered.length - 1].observedAt,
    maxGapMinutes: maxGap / MINUTE,
    maxScore: scores.length ? Math.max(...scores) : null,
    maxComments: comments.length ? Math.max(...comments) : null,
    finalScore: scores.length ? scores[scores.length - 1] : null,
    finalComments: comments.length ? comments[comments.length - 1] : null,
    bestRank: ranks.length ? Math.min(...ranks) : null,
    frontPageMinutes: frontPage / MINUTE,
  }
}

function breakoutReason(momentum: Momentum): string {
  const parts: string[] = []
  if ((momentum.pointDelta ?? 0) >= 20) parts.push(`Score ${signed(momentum.pointDelta!)} in ${minutes(momentum.elapsedMinutes)}`)
  if ((momentum.rankGain ?? 0) >= 15) parts.push(`Rank ${signed(momentum.rankGain!)} in ${minutes(momentum.elapsedMinutes)}`)
  return parts.join(' · ')
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : `${value}`
}

function minutes(value: number): string {
  return `${Math.max(1, Math.round(value))}m`
}

function unique(ids: number[]): number[] {
  return [...new Set(ids)]
}
