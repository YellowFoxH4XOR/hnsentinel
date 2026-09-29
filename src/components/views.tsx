import { Bookmark, CalendarDays, CircleCheck, Clock3, Flame, MessagesSquare, Newspaper, Radio, SearchX, Sun, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import type { Brief, BriefEntry, BriefSummary, Signal, SignalKind, SignalsResponse, StoriesResponse, StoryCard, View } from '../../shared/types.ts'
import { ApiError, useLive, useResource } from '../api.ts'
import { compact, dateTime, dayLabel, relative, SIGNAL_TITLES, timeOfDay } from '../format.ts'
import { useNow, useSelectedStory } from '../hooks.ts'
import { markSignalsSeen, useSaved } from '../storage.ts'
import { StoryList } from './StoryList.tsx'
import { Chip, EmptyState, GlyphTile, SIGNAL_ICONS, StatTile } from './ui.tsx'

export function matchesSearch(story: { title: string; domain: string | null; author: string | null }, query: string): boolean {
  if (!query) return true
  const needle = query.toLocaleLowerCase()
  return [story.title, story.domain ?? '', story.author ?? ''].some((field) => field.toLocaleLowerCase().includes(needle))
}

function LoadError({ error }: { error: Error }) {
  return (
    <EmptyState icon={TriangleAlert} title="Couldn't load this view">
      {error.message}. It will retry automatically when the server publishes new data.
    </EmptyState>
  )
}

function Loading() {
  return (
    <div className="skeleton-list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="skeleton-row" />
      ))}
    </div>
  )
}

// MARK: - Feeds and Rising

export function FeedView({ view, search }: { view: View; search: string }) {
  const { data, error } = useResource<StoriesResponse>(`/api/stories?view=${view}`)
  const [selected, select] = useSelectedStory()
  const saved = useSaved()
  const savedIds = useMemo(() => new Set(saved.map((item) => item.id)), [saved])
  const stories = useMemo(() => (data?.stories ?? []).filter((story) => matchesSearch(story, search)), [data, search])

  if (!data) return error ? <LoadError error={error} /> : <Loading />
  if (!stories.length) {
    if (search) return <EmptyState icon={SearchX} title={`No results for “${search}”`}>Try a different title, site, or author.</EmptyState>
    if (view === 'rising') {
      return (
        <EmptyState icon={Flame} title="Watching for momentum">
          Stories appear here when 15–25 minutes of continuous observations show real growth.
        </EmptyState>
      )
    }
    return <EmptyState icon={Newspaper} title="No stories yet">The collector is fetching the latest from Hacker News.</EmptyState>
  }
  return <StoryList stories={stories} selectedId={selected} savedIds={savedIds} onSelect={select} label="Stories" />
}

// MARK: - Saved

export function SavedView({ search }: { search: string }) {
  const saved = useSaved()
  const [selected, select] = useSelectedStory()
  const ids = useMemo(() => saved.map((item) => item.id).sort((a, b) => a - b).slice(0, 200), [saved])
  const { data } = useResource<StoriesResponse>(ids.length ? `/api/stories?ids=${ids.join(',')}` : null)

  const cards = useMemo(() => {
    const fresh = new Map((data?.stories ?? []).map((card) => [card.id, card]))
    return saved
      .map((item): StoryCard => fresh.get(item.id) ?? { ...item.story, rank: null, frontPageRank: null, momentum: null, trend: [] })
      .filter((card) => matchesSearch(card, search))
  }, [saved, data, search])
  const unread = useMemo(() => new Set(saved.filter((item) => item.readAt === null).map((item) => item.id)), [saved])

  if (!saved.length) {
    return (
      <EmptyState icon={Bookmark} title="Nothing saved yet">
        Save a story from any list to keep it here. Your reading list stays in this browser.
      </EmptyState>
    )
  }
  if (!cards.length) return <EmptyState icon={SearchX} title={`No results for “${search}”`} />
  return <StoryList stories={cards} selectedId={selected} savedIds={new Set()} unreadIds={unread} onSelect={select} label="Saved stories" />
}

// MARK: - Signals

type SignalFilter = 'all' | SignalKind

interface SignalGroup {
  storyId: number
  latest: Signal
  kinds: SignalKind[]
  count: number
}

/**
 * Breakouts, discussion spikes, and milestones for everyone. Signals are grouped per story per
 * day, so one busy story is one row, not a wall of alerts.
 */
export function SignalsView({ signals, search }: { signals: SignalsResponse | null; search: string }) {
  const [selected, select] = useSelectedStory()
  const [filter, setFilter] = useState<SignalFilter>('all')
  const now = useNow()
  const newest = signals?.signals[0]?.createdAt ?? 0

  useEffect(() => {
    markSignalsSeen(Math.max(Date.now(), newest))
  }, [newest])

  const days = useMemo(() => {
    const result: { label: string; groups: SignalGroup[] }[] = []
    for (const signal of signals?.signals ?? []) {
      if (filter !== 'all' && signal.kind !== filter) continue
      if (signal.story && !matchesSearch(signal.story, search)) continue
      const label = dayLabel(signal.createdAt, now)
      let day = result[result.length - 1]
      if (!day || day.label !== label) {
        day = { label, groups: [] }
        result.push(day)
      }
      const group = day.groups.find((candidate) => candidate.storyId === signal.storyId)
      if (group) {
        group.count += 1
        if (!group.kinds.includes(signal.kind)) group.kinds.push(signal.kind)
      } else {
        day.groups.push({ storyId: signal.storyId, latest: signal, kinds: [signal.kind], count: 1 })
      }
    }
    return result
  }, [signals, filter, search, now])

  if (!signals) return <Loading />
  const filters: { value: SignalFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'breakout', label: 'Breakouts' },
    { value: 'discussion', label: 'Discussions' },
    { value: 'milestone', label: 'Milestones' },
  ]

  return (
    <div className="signals-view">
      <div className="segmented" role="radiogroup" aria-label="Filter signals">
        {filters.map((option) => (
          <button key={option.value} role="radio" aria-checked={filter === option.value} className={filter === option.value ? 'on' : ''} onClick={() => setFilter(option.value)}>
            {option.label}
          </button>
        ))}
      </div>
      {!days.length ? (
        <EmptyState icon={Radio} title={search ? `No signals match “${search}”` : 'No signals yet'}>
          Breakouts (+20 points or 15 ranks in ~20 minutes), discussion spikes (+15 comments), and 100/250/500-point milestones show up here.
        </EmptyState>
      ) : (
        days.map((day) => (
          <section key={day.label} className="signal-day" aria-label={day.label}>
            <h2 className="day-heading">{day.label}</h2>
            <ul className="signal-list">
              {day.groups.map((group) => (
                <li key={`${day.label}-${group.storyId}`}>
                  <button
                    type="button"
                    className={`signal-row${selected === group.storyId ? ' selected' : ''}`}
                    aria-current={selected === group.storyId ? 'true' : undefined}
                    onClick={() => select(selected === group.storyId ? null : group.storyId)}
                  >
                    <GlyphTile icon={SIGNAL_ICONS[group.latest.kind]} tone={group.latest.kind} />
                    <span className="signal-body">
                      <span className="signal-kinds">
                        {group.kinds.map((kind) => (
                          <span key={kind} className={`signal-kind tone-${kind}`}>{SIGNAL_TITLES[kind]}</span>
                        ))}
                        {group.count > group.kinds.length && <span className="muted">×{group.count}</span>}
                      </span>
                      <span className="signal-title">{group.latest.story?.title ?? `Item ${group.storyId}`}</span>
                      <span className="signal-reason">{group.latest.reason}</span>
                      <span className="story-meta">
                        <span>{group.latest.story?.domain ?? 'news.ycombinator.com'}</span>
                        <span className="sep" aria-hidden="true">·</span>
                        <span>{compact(group.latest.score)} pts</span>
                        <span className="sep" aria-hidden="true">·</span>
                        <span>{compact(group.latest.comments)} comments</span>
                      </span>
                    </span>
                    <time className="signal-time" dateTime={new Date(group.latest.createdAt).toISOString()} title={dateTime(group.latest.createdAt)}>
                      {timeOfDay(group.latest.createdAt)}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  )
}

// MARK: - Daily Brief

export function BriefView() {
  const { date } = useParams()
  const navigate = useNavigate()
  const { status } = useLive()
  const [, select] = useSelectedStory()
  const brief = useResource<Brief>(date ? `/api/briefs/${date}` : '/api/briefs/latest', 'brief')
  const archive = useResource<{ briefs: BriefSummary[] }>('/api/briefs', 'brief')

  if (!brief.data) {
    if (brief.error instanceof ApiError && brief.error.status === 404) {
      const hour = status?.briefHourUtc ?? 13
      const due = new Date()
      due.setUTCHours(hour, 0, 0, 0)
      return (
        <EmptyState icon={Sun} title={date ? 'No brief for that day' : 'The first brief is on its way'}>
          A new brief is published every day at {timeOfDay(due.getTime())} (your time): the day's biggest breakouts, discussions, and milestones, ranked the same for everyone.
        </EmptyState>
      )
    }
    return brief.error ? <LoadError error={brief.error} /> : <Loading />
  }

  const value = brief.data
  const featured = value.entries.filter((entry) => entry.biggestBreakout || entry.biggestDiscussion)
  const published = new Date(value.generatedAt)
  const pastBriefs = archive.data?.briefs ?? []

  return (
    <article className="brief">
      <header className="brief-masthead">
        <div>
          <p className="eyebrow">{new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(published)}</p>
          <h1>Daily Brief</h1>
        </div>
        {pastBriefs.length > 1 && (
          <label className="brief-archive">
            <CalendarDays size={15} aria-hidden="true" />
            <span className="visually-hidden">Past briefs</span>
            <select
              value={value.dateKey}
              onChange={(event) => navigate(`/brief/${event.target.value}`)}
            >
              {pastBriefs.map((summary) => (
                <option key={summary.dateKey} value={summary.dateKey}>
                  {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(summary.generatedAt)}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      <div className="stat-grid">
        <StatTile label="Stories scanned" value={value.scannedCount.toLocaleString()} />
        <StatTile label="Signals" value={value.signalCount.toLocaleString()} />
        <StatTile label="In this brief" value={value.entries.length.toLocaleString()} />
      </div>

      {value.partial ? (
        <p className="callout">
          <Clock3 size={16} aria-hidden="true" />
          <span>
            <strong>Partial coverage.</strong> Observed {dateTime(value.coverageStart)} – {timeOfDay(value.coverageEnd)}; the collector wasn't running for part of the day.
          </span>
        </p>
      ) : (
        <p className="coverage">
          <CircleCheck size={14} aria-hidden="true" /> Observed continuously {dateTime(value.coverageStart)} – {timeOfDay(value.coverageEnd)}
        </p>
      )}

      {featured.length > 0 && (
        <div className="featured">
          {featured.map((entry) => (
            <button key={entry.story.id} type="button" className="featured-card" onClick={() => select(entry.story.id)}>
              {entry.biggestBreakout ? (
                <span className="signal-kind tone-breakout"><Flame size={13} aria-hidden="true" /> Biggest breakout</span>
              ) : (
                <span className="signal-kind tone-discussion"><MessagesSquare size={13} aria-hidden="true" /> Biggest discussion</span>
              )}
              <span className="featured-title">{entry.story.title}</span>
              <span className="muted small">
                {entry.biggestDiscussion && !entry.biggestBreakout ? `+${entry.commentGain} comments` : `${compact(entry.story.score)} points`} · {entry.story.domain ?? 'news.ycombinator.com'}
              </span>
            </button>
          ))}
        </div>
      )}

      {value.entries.length ? (
        <ol className="brief-list">
          {value.entries.map((entry, index) => (
            <BriefRow key={entry.story.id} entry={entry} index={index + 1} onSelect={() => select(entry.story.id)} />
          ))}
        </ol>
      ) : (
        <EmptyState icon={Sun} title="A quiet day">No breakouts, discussion spikes, or milestones in the last 24 hours.</EmptyState>
      )}
      <p className="muted small brief-footnote">Published {relative(value.generatedAt)} · same for everyone · ranked by momentum, engagement, and freshness</p>
    </article>
  )
}

function BriefRow({ entry, index, onSelect }: { entry: BriefEntry; index: number; onSelect(): void }) {
  return (
    <li>
      <button type="button" className="brief-row" onClick={onSelect}>
        <span className="brief-index">{index}</span>
        <span className="brief-body">
          <span className="brief-title">{entry.story.title}</span>
          <span className="story-meta">
            <span>{entry.story.domain ?? 'news.ycombinator.com'}</span>
            <span className="sep" aria-hidden="true">·</span>
            <span>{compact(entry.story.score)} points</span>
            <span className="sep" aria-hidden="true">·</span>
            <span>{compact(entry.story.comments)} comments</span>
          </span>
          {entry.signals.length > 0 && (
            <span className="chips">
              {entry.signals.map((kind) => (
                <Chip key={kind} tone={kind}>{SIGNAL_TITLES[kind]}</Chip>
              ))}
            </span>
          )}
        </span>
      </button>
    </li>
  )
}
