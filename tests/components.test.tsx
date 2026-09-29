// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Momentum, StoryCard } from '../shared/types.ts'
import { StoryRow } from '../src/components/StoryList.tsx'
import { Sparkline } from '../src/components/ui.tsx'
import { matchesSearch } from '../src/components/views.tsx'
import { age, compact, dayLabel, signed } from '../src/format.ts'
import { at, BASE, story } from './fixtures.ts'

afterEach(cleanup)

function card(overrides: Partial<StoryCard> = {}): StoryCard {
  return { ...story(), rank: 3, frontPageRank: 3, momentum: null, trend: [], ...overrides }
}

const breakout: Momentum = {
  elapsedMinutes: 20, pointDelta: 38, commentDelta: 12, rankGain: null, pointVelocity: 1.9, commentVelocity: 0.6,
  pointAcceleration: null, commentAcceleration: null, heat: 1.9, level: 'breakout',
}

describe('StoryRow', () => {
  it('shows rank, title, source, score, and the measured change', () => {
    render(<ul><StoryRow story={card({ momentum: breakout, trend: [100, 110, 120, 138] })} selected={false} saved now={BASE} onSelect={() => {}} /></ul>)
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByText('Rust 2.0 released')).toBeTruthy()
    expect(screen.getByText('example.com')).toBeTruthy()
    expect(screen.getByText('+38')).toBeTruthy()
    expect(screen.getByLabelText('Breakout')).toBeTruthy()
    expect(screen.getByLabelText('Saved')).toBeTruthy()
  })

  it('marks the selected row for assistive technology', () => {
    render(<ul><StoryRow story={card()} selected saved={false} now={BASE} onSelect={() => {}} /></ul>)
    expect(screen.getByRole('button').getAttribute('aria-current')).toBe('true')
  })
})

describe('Sparkline', () => {
  it('needs at least three samples', () => {
    const { container } = render(<Sparkline values={[1, 2]} level="normal" />)
    expect(container.querySelector('svg')).toBeNull()
  })

  it('draws small wobbles nearly flat', () => {
    const { container } = render(<Sparkline values={[400, 401, 400, 401]} level="normal" height={14} />)
    const ys = container.querySelector('polyline')!.getAttribute('points')!.split(' ').map((point) => Number(point.split(',')[1]))
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1)
  })
})

describe('formatting and search', () => {
  it('formats compact figures', () => {
    expect(compact(412)).toBe('412')
    expect(compact(1234)).toBe('1.2k')
    expect(compact(18_400)).toBe('18k')
    expect(compact(null)).toBe('—')
    expect(signed(5)).toBe('+5')
    expect(age(at(-90), BASE)).toBe('1h')
    expect(dayLabel(BASE, BASE)).toBe('Today')
  })

  it('searches titles, domains, and authors case-insensitively', () => {
    const value = story()
    expect(matchesSearch(value, 'RUST')).toBe(true)
    expect(matchesSearch(value, 'example.com')).toBe(true)
    expect(matchesSearch(value, 'alice')).toBe(true)
    expect(matchesSearch(value, 'golang')).toBe(false)
  })
})
