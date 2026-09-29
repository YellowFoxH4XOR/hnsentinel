// API contract shared by the server and the React client. All timestamps are epoch milliseconds.

export type FeedKind = 'top' | 'new' | 'best' | 'ask' | 'show' | 'jobs'
export const FEED_KINDS: readonly FeedKind[] = ['top', 'new', 'best', 'ask', 'show', 'jobs']

export type View = FeedKind | 'rising'

export type HeatLevel = 'normal' | 'warm' | 'rising' | 'breakout'

export type SignalKind = 'breakout' | 'discussion' | 'milestone'

/** Growth measured between two real observations; never extrapolated. */
export interface Momentum {
  elapsedMinutes: number
  pointDelta: number | null
  commentDelta: number | null
  rankGain: number | null
  pointVelocity: number | null
  commentVelocity: number | null
  pointAcceleration: number | null
  commentAcceleration: number | null
  heat: number
  level: HeatLevel
}

export interface Story {
  id: number
  title: string
  type: string
  url: string | null
  domain: string | null
  author: string | null
  createdAt: number | null
  score: number | null
  comments: number | null
  available: boolean
  firstSeenAt: number
  lastFetchedAt: number
}

/** A story as shown in lists: its current momentum, recent score series, and ranks. */
export interface StoryCard extends Story {
  /** Position in the list being viewed (feed views only). */
  rank: number | null
  /** Current position on the HN front page, if listed there. */
  frontPageRank: number | null
  momentum: Momentum | null
  trend: number[]
}

export interface Snapshot {
  observedAt: number
  score: number | null
  comments: number | null
  topRank: number | null
}

export interface Signal {
  id: number
  storyId: number
  kind: SignalKind
  reason: string
  createdAt: number
  score: number | null
  comments: number | null
  momentum: Momentum | null
  story: Story | null
}

export interface StoryDetail {
  story: StoryCard
  history: Snapshot[]
  signals: Signal[]
}

export interface StoriesResponse {
  view: View | 'ids'
  stories: StoryCard[]
  updatedAt: number | null
}

export interface SignalsResponse {
  signals: Signal[]
  updatedAt: number | null
}

export interface BriefEntry {
  story: Story
  score: number
  heat: number
  commentGain: number
  signals: SignalKind[]
  biggestBreakout: boolean
  biggestDiscussion: boolean
}

export interface Brief {
  dateKey: string
  generatedAt: number
  coverageStart: number
  coverageEnd: number
  partial: boolean
  scannedCount: number
  signalCount: number
  entries: BriefEntry[]
}

export interface BriefSummary {
  dateKey: string
  generatedAt: number
  entryCount: number
  partial: boolean
}

export interface Status {
  refreshing: boolean
  progress: { completed: number; total: number } | null
  lastRefreshAt: number | null
  lastError: string | null
  pollIntervalSeconds: number
  briefHourUtc: number
  storiesTracked: number
  risingCount: number
  latestSignalAt: number | null
}
