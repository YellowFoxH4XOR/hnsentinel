import { Bookmark, Check, ExternalLink, Link2, MessagesSquare, PanelRightClose, TriangleAlert, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Snapshot, StoryDetail } from '../../shared/types.ts'
import { useResource } from '../api.ts'
import { age, articleUrl, compact, dateTime, discussionUrl, rate, relative, signed, SIGNAL_TITLES, timeOfDay, windowText } from '../format.ts'
import { useNow } from '../hooks.ts'
import { markSavedRead, toggleSaved, useSaved } from '../storage.ts'
import { EmptyState, GlyphTile, HeatBadge, SIGNAL_ICONS, StatTile } from './ui.tsx'

export function Inspector({ storyId, onClose }: { storyId: number | null; onClose(): void }) {
  const { data, error, loading } = useResource<StoryDetail>(storyId === null ? null : `/api/stories/${storyId}`)
  const saved = useSaved()
  const now = useNow()
  const [copied, setCopied] = useState(false)

  useEffect(() => setCopied(false), [storyId])

  if (storyId === null) {
    return (
      <EmptyState icon={PanelRightClose} title="No story selected">
        Pick a story to see its momentum, history, and signals.
      </EmptyState>
    )
  }
  if (!data) {
    if (error) {
      return (
        <EmptyState icon={TriangleAlert} title="Story unavailable" action={<button className="button" onClick={onClose}>Close</button>}>
          {error.message}
        </EmptyState>
      )
    }
    return <div className="inspector-loading" aria-busy={loading}>Loading…</div>
  }

  const { story, history, signals } = data
  const momentum = story.momentum
  const isSaved = saved.some((item) => item.id === story.id)
  const openedArticle = () => markSavedRead(story.id)
  const share = async () => {
    const url = articleUrl(story)
    if (navigator.share) {
      await navigator.share({ title: story.title, url }).catch(() => undefined)
      return
    }
    await navigator.clipboard.writeText(url)
    setCopied(true)
  }

  return (
    <article className="inspector-content" aria-labelledby="inspector-title">
      <header className="inspector-header">
        <div className="inspector-topline">
          {momentum && momentum.level !== 'normal' ? <HeatBadge level={momentum.level} /> : <span />}
          <button className="icon-button" onClick={onClose} aria-label="Close story" title="Close (Esc)">
            <X size={17} />
          </button>
        </div>
        <h2 id="inspector-title">{story.title || 'Unavailable item'}</h2>
        <p className="inspector-source">
          {story.url ? (
            <a href={story.url} target="_blank" rel="noopener noreferrer" onClick={openedArticle}>
              {story.domain}
            </a>
          ) : (
            <span>news.ycombinator.com</span>
          )}
          {story.author && <span> · by {story.author}</span>}
          <span> · {age(story.createdAt, now)} ago</span>
        </p>
        {!story.available && <p className="notice">No longer available on Hacker News.</p>}
      </header>

      <div className="inspector-actions">
        <a className="button primary" href={articleUrl(story)} target="_blank" rel="noopener noreferrer" onClick={openedArticle}>
          <ExternalLink size={15} aria-hidden="true" /> Open
        </a>
        <a className="button" href={discussionUrl(story.id)} target="_blank" rel="noopener noreferrer">
          <MessagesSquare size={15} aria-hidden="true" /> Discuss
        </a>
        <button className={`button square${isSaved ? ' active' : ''}`} onClick={() => toggleSaved(story)} aria-pressed={isSaved} title={isSaved ? 'Remove from Saved' : 'Save for later'}>
          <Bookmark size={15} fill={isSaved ? 'currentColor' : 'none'} aria-hidden="true" />
          <span className="visually-hidden">{isSaved ? 'Remove from Saved' : 'Save for later'}</span>
        </button>
        <button className="button square" onClick={() => void share()} title="Share link">
          {copied ? <Check size={15} aria-hidden="true" /> : <Link2 size={15} aria-hidden="true" />}
          <span className="visually-hidden">{copied ? 'Link copied' : 'Share link'}</span>
        </button>
      </div>

      <div className="stat-grid">
        <StatTile
          label="Points"
          value={compact(story.score)}
          detail={momentum?.pointDelta != null ? `${signed(momentum.pointDelta)} in ${windowText(momentum)}` : null}
          tone={momentum?.level}
        />
        <StatTile
          label="Comments"
          value={compact(story.comments)}
          detail={momentum?.commentDelta != null ? `${signed(momentum.commentDelta)} in ${windowText(momentum)}` : null}
        />
        <StatTile
          label="Front page"
          value={story.frontPageRank ? `#${story.frontPageRank}` : '—'}
          detail={momentum?.rankGain != null ? (momentum.rankGain === 0 ? 'steady' : `${momentum.rankGain > 0 ? '↑' : '↓'}${Math.abs(momentum.rankGain)} ranks`) : null}
        />
      </div>

      <section className="inspector-section" aria-labelledby="momentum-heading">
        <div className="section-heading">
          <h3 id="momentum-heading">Momentum</h3>
          {momentum && <span className="muted">last {windowText(momentum)}</span>}
        </div>
        {momentum ? (
          <dl className="figures">
            <div><dt>Points per minute</dt><dd>{rate(momentum.pointVelocity)}</dd></div>
            <div><dt>Comments per minute</dt><dd>{rate(momentum.commentVelocity)}</dd></div>
            {momentum.pointAcceleration !== null && (
              <div>
                <dt>Acceleration</dt>
                <dd className={momentum.pointAcceleration > 0 ? 'positive' : ''}>{`${momentum.pointAcceleration > 0 ? '+' : ''}${momentum.pointAcceleration.toFixed(2)} pts/min`}</dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="muted small">
            {history.length < 2 ? 'Collecting history… ' : 'Not enough continuous history. '}
            Momentum needs an unbroken 15–25 minute window of observations.
          </p>
        )}
        {history.length >= 2 && <HistoryChart history={history.slice(-180)} />}
      </section>

      {signals.length > 0 && (
        <section className="inspector-section" aria-labelledby="signals-heading">
          <div className="section-heading">
            <h3 id="signals-heading">Signals</h3>
          </div>
          <ul className="mini-signals">
            {signals.map((signal) => (
              <li key={signal.id}>
                <GlyphTile icon={SIGNAL_ICONS[signal.kind]} tone={signal.kind} size={22} />
                <div>
                  <strong>{SIGNAL_TITLES[signal.kind]}</strong>
                  <span className="muted"> · {relative(signal.createdAt, now)}</span>
                  <p>{signal.reason}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="inspector-footer">
        <span>Last observed {dateTime(story.lastFetchedAt)}</span>
        <span>
          First seen {dateTime(story.firstSeenAt)} ·{' '}
          <a href={discussionUrl(story.id)} target="_blank" rel="noopener noreferrer">item {story.id}</a>
        </span>
      </footer>
    </article>
  )
}

/** Observed points (filled) and comments (dashed). Only real samples are plotted. */
function HistoryChart({ history }: { history: Snapshot[] }) {
  const width = 320
  const height = 132
  const pad = { top: 22, right: 34, bottom: 20, left: 4 }
  const start = history[0].observedAt
  const end = history[history.length - 1].observedAt
  const span = Math.max(end - start, 1)
  const values = history.flatMap((snapshot) => [snapshot.score, snapshot.comments]).filter((value): value is number => value !== null)
  const max = niceMax(Math.max(1, ...values))
  const x = (time: number) => pad.left + ((time - start) / span) * (width - pad.left - pad.right)
  const y = (value: number) => pad.top + (1 - value / max) * (height - pad.top - pad.bottom)
  const line = (key: 'score' | 'comments') =>
    history
      .filter((snapshot) => snapshot[key] !== null)
      .map((snapshot) => `${x(snapshot.observedAt).toFixed(1)},${y(snapshot[key]!).toFixed(1)}`)
      .join(' ')
  const points = line('score')
  const scored = history.filter((snapshot) => snapshot.score !== null)
  const area = scored.length
    ? `M${x(scored[0].observedAt)},${y(0)} L${points.replaceAll(' ', ' L')} L${x(scored[scored.length - 1].observedAt)},${y(0)} Z`
    : ''
  const ticks = [0, max / 2, max]

  return (
    <figure className="history-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Observed points and comments, ${history.length} samples`}>
        <defs>
          <linearGradient id="points-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--signal)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--signal)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="grid" x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} />
            <text className="axis" x={width - pad.right + 6} y={y(tick) + 3.5}>{compact(Math.round(tick))}</text>
          </g>
        ))}
        {area && <path d={area} fill="url(#points-fill)" />}
        <polyline className="line-points" points={points} />
        <polyline className="line-comments" points={line('comments')} />
        <text className="axis" x={pad.left} y={height - 4}>{timeOfDay(start)}</text>
        <text className="axis" x={width - pad.right} y={height - 4} textAnchor="end">{timeOfDay(end)}</text>
      </svg>
      <figcaption>
        <span className="legend points">Points</span>
        <span className="legend comments">Comments</span>
      </figcaption>
    </figure>
  )
}

function niceMax(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude
  }
  return 10 * magnitude
}
