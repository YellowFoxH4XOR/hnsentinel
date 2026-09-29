import { Bookmark, MessageSquare } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { StoryCard } from '../../shared/types.ts'
import { age, articleUrl, compact, HEAT_TITLES, signed, windowText } from '../format.ts'
import { isTyping, useNow } from '../hooks.ts'
import { HEAT_ICONS, Sparkline } from './ui.tsx'

interface StoryRowProps {
  story: StoryCard
  selected: boolean
  saved: boolean
  unread?: boolean
  now: number
  onSelect(): void
}

export function StoryRow({ story, selected, saved, unread = false, now, onSelect }: StoryRowProps) {
  const level = story.momentum?.level ?? 'normal'
  const HeatIcon = HEAT_ICONS[level]
  const delta = story.momentum?.pointDelta ?? 0
  return (
    <li>
      <button
        type="button"
        className={`story-row${selected ? ' selected' : ''}`}
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
        data-story-id={story.id}
      >
        <span className="story-rail">
          {story.rank !== null ? <span className="story-rank">{story.rank}</span> : unread ? <span className="unread-dot" aria-label="Unread" /> : null}
        </span>
        <span className="story-main">
          <span className="story-title">
            {level !== 'normal' && (
              <span className={`heat-icon heat-${level}`} title={HEAT_TITLES[level]}>
                <HeatIcon size={13} strokeWidth={2.75} aria-label={HEAT_TITLES[level]} />
              </span>
            )}
            {story.available ? story.title : <span className="muted">{story.title || 'Unavailable item'}</span>}
          </span>
          <span className="story-meta">
            <span className="story-domain">{story.domain ?? 'news.ycombinator.com'}</span>
            {story.author && (
              <>
                <span className="sep" aria-hidden="true">·</span>
                <span className="story-author">{story.author}</span>
              </>
            )}
            <span className="sep" aria-hidden="true">·</span>
            <span>{age(story.createdAt, now)}</span>
            <span className="sep" aria-hidden="true">·</span>
            <span className="story-comments">
              <MessageSquare size={11} aria-hidden="true" />
              {compact(story.comments)}
              <span className="visually-hidden"> comments</span>
            </span>
            {saved && <Bookmark className="saved-mark" size={11} fill="currentColor" aria-label="Saved" />}
          </span>
        </span>
        <span className="story-score">
          <span className="score-value">
            {compact(story.score)}
            <span className="visually-hidden"> points</span>
          </span>
          <span className="score-trend">
            <Sparkline values={story.trend} level={level} />
            {delta !== 0 && story.momentum && (
              <span className={`score-delta heat-${level}`} title={`${signed(delta)} points in ${windowText(story.momentum)}`}>
                {signed(delta)}
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  )
}

interface StoryListProps {
  stories: StoryCard[]
  selectedId: number | null
  savedIds: Set<number>
  unreadIds?: Set<number>
  onSelect(id: number | null): void
  label: string
}

/**
 * The story list. Keyboard: j/k or ↓/↑ move the selection, Enter or o opens the article,
 * Escape clears the selection.
 */
export function StoryList({ stories, selectedId, savedIds, unreadIds, onSelect, label }: StoryListProps) {
  const now = useNow()
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey || !stories.length) return
      const index = stories.findIndex((story) => story.id === selectedId)
      let next: number | null = null
      if (event.key === 'j' || event.key === 'ArrowDown') next = Math.min(stories.length - 1, index + 1)
      else if (event.key === 'k' || event.key === 'ArrowUp') next = Math.max(0, index < 0 ? 0 : index - 1)
      else if ((event.key === 'o' || event.key === 'Enter') && index >= 0 && !(event.target instanceof HTMLButtonElement && event.key === 'Enter')) {
        window.open(articleUrl(stories[index]), '_blank', 'noopener,noreferrer')
        event.preventDefault()
        return
      } else if (event.key === 'Escape' && selectedId !== null) {
        onSelect(null)
        return
      }
      if (next === null) return
      event.preventDefault()
      onSelect(stories[next].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stories, selectedId, onSelect])

  useEffect(() => {
    if (selectedId === null) return
    listRef.current?.querySelector(`[data-story-id="${selectedId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  return (
    <ul className="story-list" ref={listRef} aria-label={label}>
      {stories.map((story) => (
        <StoryRow
          key={story.id}
          story={story}
          selected={story.id === selectedId}
          saved={savedIds.has(story.id)}
          unread={unreadIds?.has(story.id)}
          now={now}
          onSelect={() => onSelect(story.id === selectedId ? null : story.id)}
        />
      ))}
    </ul>
  )
}
