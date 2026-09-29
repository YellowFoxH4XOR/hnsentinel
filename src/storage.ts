import { useSyncExternalStore } from 'react'
import type { Story } from '../shared/types.ts'

// Per-browser state. Everyone sees the same stories; only a reader's own reading list, what
// they've already seen, and their theme stay in this browser.

const SAVED_KEY = 'hn-sentinel:saved'
const SIGNALS_SEEN_KEY = 'hn-sentinel:signals-seen'
const THEME_KEY = 'hn-sentinel:theme'

export interface SavedItem {
  id: number
  savedAt: number
  readAt: number | null
  /** Copy of the story when saved, so the list survives the server forgetting old stories. */
  story: Story
}

export type ThemePreference = 'system' | 'light' | 'dark'

const listeners = new Set<() => void>()
const cache = new Map<string, unknown>()

function read<T>(key: string, fallback: T): T {
  if (cache.has(key)) return cache.get(key) as T
  let value = fallback
  try {
    const raw = localStorage.getItem(key)
    if (raw !== null) value = JSON.parse(raw) as T
  } catch {
    // Private mode or corrupt data: fall back to the default.
  }
  cache.set(key, value)
  return value
}

function write<T>(key: string, value: T): void {
  cache.set(key, value)
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or unavailable: keep the in-memory value for this session.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith('hn-sentinel:')) {
      cache.delete(event.key)
      listener()
    }
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

const EMPTY: SavedItem[] = []

export function useSaved(): SavedItem[] {
  return useSyncExternalStore(subscribe, () => read(SAVED_KEY, EMPTY), () => EMPTY)
}

export function toggleSaved(story: Story): void {
  const items = read(SAVED_KEY, EMPTY)
  write(
    SAVED_KEY,
    items.some((item) => item.id === story.id)
      ? items.filter((item) => item.id !== story.id)
      : [{ id: story.id, savedAt: Date.now(), readAt: null, story }, ...items],
  )
}

export function markSavedRead(id: number, isRead = true): void {
  const items = read(SAVED_KEY, EMPTY)
  if (!items.some((item) => item.id === id && (item.readAt !== null) !== isRead)) return
  write(SAVED_KEY, items.map((item) => (item.id === id ? { ...item, readAt: isRead ? Date.now() : null } : item)))
}

/** On a reader's first visit nothing starts unread: Signals count from this moment on. */
export function initializeSignalsSeen(now = Date.now()): void {
  if (read<number | null>(SIGNALS_SEEN_KEY, null) === null) write(SIGNALS_SEEN_KEY, now)
}

/** When this reader last looked at Signals. */
export function useSignalsSeenAt(): number {
  return useSyncExternalStore(subscribe, () => read<number>(SIGNALS_SEEN_KEY, 0), () => 0)
}

export function markSignalsSeen(at = Date.now()): void {
  if (read<number>(SIGNALS_SEEN_KEY, 0) < at) write(SIGNALS_SEEN_KEY, at)
}

export function useTheme(): ThemePreference {
  return useSyncExternalStore(subscribe, () => read<ThemePreference>(THEME_KEY, 'system'), () => 'system')
}

export function setTheme(theme: ThemePreference): void {
  write(THEME_KEY, theme)
}
