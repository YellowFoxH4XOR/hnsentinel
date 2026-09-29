import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'

/** Current time, re-rendering every `interval` ms so relative labels stay honest. */
export function useNow(interval = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(timer)
  }, [interval])
  return now
}

/** The selected story lives in the URL (`?story=123`), so any view with a story open can be shared. */
export function useSelectedStory(): [number | null, (id: number | null) => void] {
  const [params, setParams] = useSearchParams()
  const raw = params.get('story')
  const selected = raw && /^\d+$/.test(raw) ? Number(raw) : null
  const select = useCallback(
    (id: number | null) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current)
          if (id === null) next.delete('story')
          else next.set('story', String(id))
          return next
        },
        { replace: selected !== null && id !== null },
      )
    },
    [setParams, selected],
  )
  return [selected, select]
}

/** True when the editable element has focus, so global shortcuts leave typing alone. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}
