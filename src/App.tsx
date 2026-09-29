import {
  Bookmark,
  Briefcase,
  Clock,
  Flame,
  Monitor,
  Moon,
  Newspaper,
  Radio,
  Search,
  Sparkles,
  Star,
  Sun,
  SunMedium,
  MessageCircleQuestion,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, NavLink, Route, Routes, useLocation, useParams } from 'react-router'
import type { SignalsResponse, View } from '../shared/types.ts'
import { useLive, useResource } from './api.ts'
import { Inspector } from './components/Inspector.tsx'
import { StatusLine } from './components/ui.tsx'
import { BriefView, FeedView, SavedView, SignalsView } from './components/views.tsx'
import { VIEW_TITLES } from './format.ts'
import { isTyping, useSelectedStory } from './hooks.ts'
import { setTheme, useSaved, useSignalsSeenAt, useTheme, type ThemePreference } from './storage.ts'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

const FEEDS: NavItem[] = [
  { to: '/', label: 'Front Page', icon: Newspaper },
  { to: '/rising', label: 'Rising', icon: Flame },
  { to: '/new', label: 'New', icon: Clock },
  { to: '/best', label: 'Best', icon: Star },
  { to: '/ask', label: 'Ask HN', icon: MessageCircleQuestion },
  { to: '/show', label: 'Show HN', icon: Sparkles },
  { to: '/jobs', label: 'Jobs', icon: Briefcase },
]

const LIBRARY: NavItem[] = [
  { to: '/signals', label: 'Signals', icon: Radio },
  { to: '/saved', label: 'Saved', icon: Bookmark },
  { to: '/brief', label: 'Daily Brief', icon: SunMedium },
]

const SECONDARY_VIEWS: View[] = ['new', 'best', 'ask', 'show', 'jobs']

export function App() {
  const location = useLocation()
  const { status } = useLive()
  const signals = useResource<SignalsResponse>('/api/signals')
  const saved = useSaved()
  const seenAt = useSignalsSeenAt()
  const [selected, select] = useSelectedStory()
  const [search, setSearch] = useState('')
  const theme = useTheme()

  // Search is scoped to the current view.
  useEffect(() => setSearch(''), [location.pathname])

  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
  }, [theme])

  const counts: Record<string, number> = {
    '/rising': status?.risingCount ?? 0,
    '/signals': location.pathname === '/signals' ? 0 : (signals.data?.signals.filter((signal) => signal.createdAt > seenAt).length ?? 0),
    '/saved': saved.filter((item) => item.readAt === null).length,
  }
  const heading = headingFor(location.pathname)

  return (
    <div className={`app${selected !== null ? ' has-selection' : ''}`}>
      <a className="skip-link" href="#main">Skip to stories</a>
      <aside className="sidebar" aria-label="Sections">
        <Link to="/" className="brand" aria-label="HN Sentinel home">
          <img src="/favicon.svg" alt="" width={26} height={26} />
          <span>HN Sentinel</span>
        </Link>
        <nav>
          <NavGroup title="Hacker News" items={FEEDS} counts={counts} />
          <NavGroup title="Library" items={LIBRARY} counts={counts} />
        </nav>
        <footer className="sidebar-footer">
          <StatusLine />
          <ThemeButton theme={theme} />
        </footer>
      </aside>

      <main className="content" id="main">
        <header className="toolbar">
          <div className="title-block">
            <h1>{heading.title}</h1>
            {heading.subtitle && <p>{heading.subtitle}</p>}
          </div>
          {heading.searchable && <SearchField value={search} onChange={setSearch} />}
        </header>
        {heading.chips && <FeedChips />}
        <div className="scroll-area">
          <Routes>
            <Route path="/" element={<FeedView view="top" search={search} />} />
            <Route path="/signals" element={<SignalsView signals={signals.data} search={search} />} />
            <Route path="/saved" element={<SavedView search={search} />} />
            <Route path="/brief" element={<BriefView />} />
            <Route path="/brief/:date" element={<BriefView />} />
            <Route path="/:view" element={<FeedRoute search={search} />} />
          </Routes>
        </div>
      </main>

      <aside className="inspector" aria-label="Story details" data-open={selected !== null}>
        <Inspector storyId={selected} onClose={() => select(null)} />
      </aside>
      {selected !== null && <button className="scrim" aria-label="Close story" onClick={() => select(null)} />}

      <nav className="tabbar" aria-label="Sections">
        {[FEEDS[0], FEEDS[1], LIBRARY[0], LIBRARY[2], LIBRARY[1]].map((item) => (
          <NavLink key={item.to} to={item.to} end className="tab">
            <item.icon size={20} aria-hidden="true" />
            <span>{item.label === 'Front Page' ? 'Front' : item.label === 'Daily Brief' ? 'Brief' : item.label}</span>
            {counts[item.to] ? <span className="tab-badge">{counts[item.to] > 99 ? '99+' : counts[item.to]}</span> : null}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

function FeedRoute({ search }: { search: string }) {
  const { view } = useParams()
  if (!view || !(SECONDARY_VIEWS as string[]).concat('rising').includes(view)) return <Navigate to="/" replace />
  return <FeedView view={view as View} search={search} />
}

function headingFor(pathname: string): { title: string; subtitle?: string; searchable: boolean; chips: boolean } {
  if (pathname === '/') return { title: VIEW_TITLES.top, subtitle: 'Live from Hacker News, with momentum', searchable: true, chips: true }
  if (pathname === '/rising') return { title: 'Rising', subtitle: 'Stories gaining fastest over the last ~20 minutes', searchable: true, chips: true }
  if (pathname === '/signals') return { title: 'Signals', subtitle: 'Breakouts, discussion spikes, and milestones', searchable: true, chips: false }
  if (pathname === '/saved') return { title: 'Saved', subtitle: 'Your reading list, kept in this browser', searchable: true, chips: false }
  if (pathname.startsWith('/brief')) return { title: 'Daily Brief', searchable: false, chips: false }
  const view = pathname.slice(1) as View
  return { title: VIEW_TITLES[view] ?? 'Hacker News', searchable: true, chips: true }
}

function NavGroup({ title, items, counts }: { title: string; items: NavItem[]; counts: Record<string, number> }) {
  return (
    <div className="nav-group">
      <h2>{title}</h2>
      <ul>
        {items.map((item) => (
          <li key={item.to}>
            <NavLink to={item.to} end={item.to === '/'} className="nav-item">
              <item.icon size={17} aria-hidden="true" />
              <span>{item.label}</span>
              {counts[item.to] ? <span className="count" aria-label={`${counts[item.to]} new`}>{counts[item.to]}</span> : null}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Feed switcher shown above lists on narrow screens, where the sidebar is hidden. */
function FeedChips() {
  return (
    <nav className="feed-chips" aria-label="Feeds">
      {FEEDS.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.to === '/'} className="feed-chip">
          {item.label}
        </NavLink>
      ))}
    </nav>
  )
}

function SearchField({ value, onChange }: { value: string; onChange(value: string): void }) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === '/' && !isTyping(event.target)) {
        event.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="search-field">
      <Search size={15} aria-hidden="true" />
      <input
        ref={input}
        type="search"
        placeholder="Search titles, sites, authors"
        aria-label="Search this view"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onChange('')
            input.current?.blur()
          }
        }}
      />
      {value ? (
        <button className="icon-button" onClick={() => onChange('')} aria-label="Clear search">
          <X size={14} />
        </button>
      ) : (
        <kbd aria-hidden="true">/</kbd>
      )}
    </div>
  )
}

const THEME_ORDER: ThemePreference[] = ['system', 'light', 'dark']
const THEME_ICONS: Record<ThemePreference, LucideIcon> = { system: Monitor, light: Sun, dark: Moon }

function ThemeButton({ theme }: { theme: ThemePreference }) {
  const Icon = THEME_ICONS[theme]
  const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]
  const label = useMemo(() => `Theme: ${theme}. Switch to ${next}`, [theme, next])
  return (
    <button className="icon-button" onClick={() => setTheme(next)} aria-label={label} title={label}>
      <Icon size={15} />
    </button>
  )
}
