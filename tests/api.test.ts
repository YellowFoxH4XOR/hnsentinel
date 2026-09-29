import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StoriesResponse, StoryDetail } from '../shared/types.ts'
import { createServer, EventHub } from '../server/api.ts'
import { buildDashboard } from '../server/dashboard.ts'
import type { Status } from '../shared/types.ts'
import { at, memoryStore, observation } from './fixtures.ts'

const status: Status = {
  refreshing: false,
  progress: null,
  lastRefreshAt: at(0),
  lastError: null,
  pollIntervalSeconds: 60,
  briefHourUtc: 13,
  storiesTracked: 2,
  risingCount: 0,
  latestSignalAt: null,
  trajectoriesArchived: 0,
}

let base = ''
let staticDir = ''
let close: () => Promise<void>

beforeAll(async () => {
  const store = memoryStore()
  store.planCollection([{ kind: 'top', ids: [2, 1] }], new Set(), at(0), 60)
  store.ingest([observation(1, 0, { title: 'Rust 2.0' }), observation(2, 0, { title: 'Postgres 18' }), observation(3, 0, { title: 'Unlisted' })], 'c1', at(0))
  const dashboard = buildDashboard(store, at(0))

  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-static-'))
  fs.mkdirSync(path.join(staticDir, 'assets'))
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>HN Sentinel</title>')
  fs.writeFileSync(path.join(staticDir, 'assets', 'app-abc123.js'), 'console.log(1)')
  fs.writeFileSync(path.join(os.tmpdir(), 'sentinel-secret.txt'), 'secret')

  const hub = new EventHub()
  const server = createServer({ store, dashboard: () => dashboard, status: () => status, now: () => at(0), staticDir }, hub)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = async () => {
    hub.closeAll()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

afterAll(async () => {
  await close()
  fs.rmSync(staticDir, { recursive: true, force: true })
})

describe('HTTP API', () => {
  it('serves feed views in HN order with ranks', async () => {
    const body = (await (await fetch(`${base}/api/stories?view=top`)).json()) as StoriesResponse
    expect(body.stories.map((story) => [story.id, story.rank, story.title])).toEqual([
      [2, 1, 'Postgres 18'],
      [1, 2, 'Rust 2.0'],
    ])
  })

  it('serves arbitrary stories by id, including ones outside every feed', async () => {
    const body = (await (await fetch(`${base}/api/stories?ids=3,1,999`)).json()) as StoriesResponse
    expect(body.stories.map((story) => story.id)).toEqual([3, 1])
  })

  it('serves story detail with history', async () => {
    const body = (await (await fetch(`${base}/api/stories/1`)).json()) as StoryDetail
    expect(body.story.frontPageRank).toBe(2)
    expect(body.history).toHaveLength(1)
    expect((await fetch(`${base}/api/stories/424242`)).status).toBe(404)
  })

  it('rejects bad input and unsupported methods', async () => {
    expect((await fetch(`${base}/api/stories?view=nope`)).status).toBe(400)
    expect((await fetch(`${base}/api/stories?ids=1,-2`)).status).toBe(400)
    expect((await fetch(`${base}/api/status`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${base}/api/unknown`)).status).toBe(404)
    expect((await fetch(`${base}/api/briefs/latest`)).status).toBe(404)
  })

  it('serves the client with immutable assets, SPA fallback, and no path traversal', async () => {
    const asset = await fetch(`${base}/assets/app-abc123.js`)
    expect(asset.headers.get('cache-control')).toContain('immutable')
    const route = await fetch(`${base}/rising?story=1`)
    expect(await route.text()).toContain('HN Sentinel')
    expect(route.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404)
    const traversal = await fetch(`${base}/..%2Fsentinel-secret.txt`)
    expect(await traversal.text()).not.toContain('secret')
  })

  it('opens an event stream that starts with the current status', async () => {
    const controller = new AbortController()
    const response = await fetch(`${base}/api/events`, { signal: controller.signal })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toContain('event: status')
    controller.abort()
  })
})
