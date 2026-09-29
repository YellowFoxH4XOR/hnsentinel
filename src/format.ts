import type { HeatLevel, Momentum, SignalKind, Story, View } from '../shared/types.ts'

export const VIEW_TITLES: Record<View, string> = {
  top: 'Front Page',
  rising: 'Rising',
  new: 'New',
  best: 'Best',
  ask: 'Ask HN',
  show: 'Show HN',
  jobs: 'Jobs',
}

export const HEAT_TITLES: Record<HeatLevel, string> = {
  breakout: 'Breakout',
  rising: 'Rising',
  warm: 'Warming',
  normal: 'Steady',
}

export const SIGNAL_TITLES: Record<SignalKind, string> = {
  breakout: 'Breakout',
  discussion: 'Discussion spike',
  milestone: 'Milestone',
}

export function discussionUrl(id: number): string {
  return `https://news.ycombinator.com/item?id=${id}`
}

export function articleUrl(story: Story): string {
  return story.url ?? discussionUrl(story.id)
}

/** Compact age: `12m`, `3h`, `2d`. */
export function age(time: number | null, now = Date.now()): string {
  if (time === null) return '—'
  const seconds = Math.max(0, (now - time) / 1000)
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

/** `412`, `1.2k`, `18k`. */
export function compact(value: number | null): string {
  if (value === null) return '—'
  if (value < 1000) return `${value}`
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`
  return `${Math.floor(value / 1000)}k`
}

export function signed(value: number): string {
  return value > 0 ? `+${value}` : `${value}`
}

export function rate(value: number | null): string {
  return value === null ? '—' : value.toFixed(2)
}

export function windowText(momentum: Momentum): string {
  return `${Math.max(1, Math.round(momentum.elapsedMinutes))}m`
}

export function timeOfDay(time: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(time)
}

export function dateTime(time: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(time)
}

export function relative(time: number, now = Date.now()): string {
  const seconds = Math.round((time - now) / 1000)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (Math.abs(seconds) < 45) return 'just now'
  if (Math.abs(seconds) < 3600) return formatter.format(Math.round(seconds / 60), 'minute')
  if (Math.abs(seconds) < 86400) return formatter.format(Math.round(seconds / 3600), 'hour')
  return formatter.format(Math.round(seconds / 86400), 'day')
}

/** "Today", "Yesterday", or a weekday and date, for grouping. */
export function dayLabel(time: number, now = Date.now()): string {
  const day = (value: number) => new Date(value).toDateString()
  if (day(time) === day(now)) return 'Today'
  if (day(time) === day(now - 86_400_000)) return 'Yesterday'
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).format(time)
}
