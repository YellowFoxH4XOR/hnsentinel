import { ChevronUp, Flame, MessagesSquare, Star, TrendingUp, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { HeatLevel, SignalKind } from '../../shared/types.ts'
import { useLive } from '../api.ts'
import { HEAT_TITLES, relative } from '../format.ts'
import { useNow } from '../hooks.ts'

export const HEAT_ICONS: Record<HeatLevel, LucideIcon> = {
  breakout: Flame,
  rising: TrendingUp,
  warm: ChevronUp,
  normal: ChevronUp,
}

export const SIGNAL_ICONS: Record<SignalKind, LucideIcon> = {
  breakout: Flame,
  discussion: MessagesSquare,
  milestone: Star,
}

/**
 * A tiny line chart of observed scores. The vertical scale never shrinks below 5 points or 10% of
 * the score, so a one-point wobble reads as flat instead of a dramatic spike.
 */
export function Sparkline({ values, level, width = 40, height = 14 }: { values: number[]; level: HeatLevel; width?: number; height?: number }) {
  if (values.length < 3) return null
  const low = Math.min(...values)
  const high = Math.max(...values)
  const scale = Math.max(high - low, 5, high * 0.1)
  const center = (high + low) / 2
  const inset = 1.5
  const points = values
    .map((value, index) => {
      const x = inset + ((width - 2 * inset) * index) / (values.length - 1)
      const y = height / 2 - ((value - center) / scale) * (height - 2 * inset)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg className={`sparkline heat-${level}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={points} fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function HeatBadge({ level }: { level: HeatLevel }) {
  const Icon = HEAT_ICONS[level]
  return (
    <span className={`badge heat-${level}`}>
      <Icon size={12} strokeWidth={2.5} aria-hidden="true" />
      {HEAT_TITLES[level]}
    </span>
  )
}

export function Chip({ children, tone = 'signal' }: { children: ReactNode; tone?: 'signal' | 'breakout' | 'discussion' | 'milestone' | 'neutral' }) {
  return <span className={`chip tone-${tone}`}>{children}</span>
}

export function StatTile({ label, value, detail, tone }: { label: string; value: string; detail?: string | null; tone?: HeatLevel }) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      <span className={`stat-detail ${tone && tone !== 'normal' ? `heat-${tone}` : ''}`}>{detail ?? ' '}</span>
    </div>
  )
}

export function EmptyState({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state" role="status">
      <Icon size={36} strokeWidth={1.5} aria-hidden="true" />
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

export function GlyphTile({ icon: Icon, tone, size = 28 }: { icon: LucideIcon; tone: string; size?: number }) {
  return (
    <span className={`glyph tone-${tone}`} style={{ width: size, height: size }} aria-hidden="true">
      <Icon size={size * 0.52} strokeWidth={2.25} />
    </span>
  )
}

/** Live collection status: green healthy, orange collecting, red when the last cycle had problems. */
export function StatusLine() {
  const { status, connected } = useLive()
  const now = useNow(15_000)
  let tone = 'ok'
  let text = 'Connecting…'
  if (!connected && status) {
    tone = 'error'
    text = 'Reconnecting…'
  } else if (status) {
    if (status.refreshing) {
      tone = 'busy'
      text = status.progress ? `Collecting ${status.progress.completed} of ${status.progress.total}` : 'Collecting…'
    } else if (status.lastError) {
      tone = 'error'
      text = status.lastError
    } else {
      text = status.lastRefreshAt ? `Updated ${relative(status.lastRefreshAt, now)}` : 'Waiting for first collection'
    }
  }
  return (
    <span className="status-line" title={text}>
      <span className={`status-dot ${tone}`} aria-hidden="true" />
      <span className="status-text">{text}</span>
    </span>
  )
}
