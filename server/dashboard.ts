import type { FeedKind, Momentum, Signal, Story, StoryCard, View } from '../shared/types.ts'
import { FEED_KINDS } from '../shared/types.ts'
import { evaluateMomentum, MOMENTUM_HISTORY_WINDOW, rising } from './momentum.ts'
import type { Store } from './store.ts'

const DAY = 24 * 60 * 60_000

/**
 * Everything the list views need, computed once after each collection cycle and shared by every
 * request — everyone sees exactly the same Rising list, momentum, and signals.
 */
export interface Dashboard {
  builtAt: number
  cards: Map<number, StoryCard>
  views: Record<View, number[]>
  /** HN's own 1-based position of each story in each feed, before unavailable items are hidden. */
  ranks: Record<FeedKind, Map<number, number>>
  signals: Signal[]
  momentum: Map<number, Momentum>
}

export function buildDashboard(store: Store, now: number): Dashboard {
  const feeds = store.feeds()
  const byId = new Map<number, Story>()
  for (const story of store.recentStories(now - DAY)) byId.set(story.id, story)
  const listed = FEED_KINDS.flatMap((kind) => feeds[kind].ids).filter((id) => !byId.has(id))
  for (const story of store.stories(listed)) byId.set(story.id, story)

  const ranks = {} as Record<FeedKind, Map<number, number>>
  for (const kind of FEED_KINDS) ranks[kind] = new Map(feeds[kind].ids.map((id, index) => [id, index + 1]))
  const { cards, momentum } = cardsFor([...byId.values()], store, now, ranks.top)

  const views = {} as Record<View, number[]>
  for (const kind of FEED_KINDS) views[kind] = feeds[kind].ids.filter((id) => cards.get(id)?.available)
  views.rising = rising([...cards.values()], momentum).map((card) => card.id)

  return { builtAt: now, cards, views, ranks, signals: store.signals({ since: now - 7 * DAY, limit: 300 }), momentum }
}

/** Builds cards (momentum plus score trend) for arbitrary stories, e.g. a reader's saved list. */
export function cardsFor(
  stories: Story[],
  store: Store,
  now: number,
  frontPage: Map<number, number>,
): { cards: Map<number, StoryCard>; momentum: Map<number, Momentum> } {
  const history = store.historyByStory(stories.map((story) => story.id), now - MOMENTUM_HISTORY_WINDOW)
  const cards = new Map<number, StoryCard>()
  const momentum = new Map<number, Momentum>()
  for (const story of stories) {
    const snapshots = history.get(story.id) ?? []
    const signal = evaluateMomentum(story, snapshots, now)
    if (signal) momentum.set(story.id, signal)
    const trend = snapshots.flatMap((snapshot) => (snapshot.score === null ? [] : [snapshot.score]))
    cards.set(story.id, {
      ...story,
      rank: null,
      frontPageRank: frontPage.get(story.id) ?? null,
      momentum: signal,
      trend: trend.length >= 2 ? trend : [],
    })
  }
  return { cards, momentum }
}

/** Cards for one view, in order, with the view's own rank column where it is meaningful. */
export function viewCards(dashboard: Dashboard, view: View): StoryCard[] {
  const ranks = view === 'rising' || view === 'new' || view === 'jobs' ? null : dashboard.ranks[view]
  return dashboard.views[view].flatMap((id) => {
    const card = dashboard.cards.get(id)
    return card ? [{ ...card, rank: ranks?.get(id) ?? null }] : []
  })
}

export function isView(value: string): value is View {
  return value === 'rising' || (FEED_KINDS as readonly string[]).includes(value)
}
