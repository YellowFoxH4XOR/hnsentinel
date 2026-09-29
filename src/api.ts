import { createContext, createElement, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Status } from '../shared/types.ts'

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' }, signal })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(response.status, body?.error ?? `Request failed (${response.status})`)
  }
  return (await response.json()) as T
}

interface LiveState {
  status: Status | null
  /** Bumps whenever the server finishes collecting, so views refetch. */
  version: number
  /** Bumps when a new daily brief is published. */
  briefVersion: number
  connected: boolean
}

const LiveContext = createContext<LiveState>({ status: null, version: 0, briefVersion: 0, connected: false })

/** One EventSource for the whole app: the server pushes status and "data changed" events. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LiveState>({ status: null, version: 0, briefVersion: 0, connected: false })

  useEffect(() => {
    const source = new EventSource('/api/events')
    const status = (event: MessageEvent<string>) => setState((current) => ({ ...current, status: JSON.parse(event.data) as Status, connected: true }))
    const update = (event: MessageEvent<string>) =>
      setState((current) => ({ ...current, status: JSON.parse(event.data) as Status, version: current.version + 1, connected: true }))
    const brief = () => setState((current) => ({ ...current, briefVersion: current.briefVersion + 1 }))
    source.addEventListener('status', status)
    source.addEventListener('update', update)
    source.addEventListener('brief', brief)
    source.onopen = () => setState((current) => ({ ...current, connected: true }))
    // EventSource reconnects on its own; when it does, refetch in case updates were missed.
    source.onerror = () => setState((current) => (current.connected ? { ...current, connected: false, version: current.version + 1 } : current))
    return () => source.close()
  }, [])

  return createElement(LiveContext.Provider, { value: state }, children)
}

export function useLive(): LiveState {
  return useContext(LiveContext)
}

export interface Resource<T> {
  data: T | null
  error: ApiError | Error | null
  loading: boolean
}

/**
 * Fetches `path` and refetches whenever the server publishes new data. Previous data stays on
 * screen while a refetch is in flight, so live updates never flash an empty state.
 */
export function useResource<T>(path: string | null, kind: 'data' | 'brief' = 'data'): Resource<T> {
  const live = useLive()
  const version = kind === 'brief' ? live.briefVersion : live.version
  const [state, setState] = useState<Resource<T>>({ data: null, error: null, loading: path !== null })
  const lastPath = useRef(path)

  useEffect(() => {
    if (path === null) {
      setState({ data: null, error: null, loading: false })
      return
    }
    const pathChanged = lastPath.current !== path
    lastPath.current = path
    const controller = new AbortController()
    setState((current) => ({ data: pathChanged ? null : current.data, error: null, loading: true }))
    getJson<T>(path, controller.signal)
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState((current) => ({ data: pathChanged ? null : current.data, error: error as Error, loading: false }))
      })
    return () => controller.abort()
  }, [path, version])

  return state
}
