import fs from 'node:fs'
import path from 'node:path'
import type { Status } from '../shared/types.ts'
import { createServer, EventHub } from './api.ts'
import { briefDueAt, buildBrief } from './brief.ts'
import { Collector } from './collector.ts'
import { loadConfig } from './config.ts'
import { buildDashboard, type Dashboard } from './dashboard.ts'
import { openDatabase } from './db.ts'
import { HttpHNService } from './hn.ts'
import { Store, utcDateKey } from './store.ts'

const DAY = 24 * 60 * 60_000
const DASHBOARD_REBUILD_INTERVAL = 5_000
const PROGRESS_BROADCAST_INTERVAL = 1_000
const BRIEF_CHECK_INTERVAL = 60_000
const SHUTDOWN_TIMEOUT = 10_000

function log(message: string, detail?: unknown): void {
  const line = `${new Date().toISOString()} ${message}`
  if (detail === undefined) console.log(line)
  else console.error(line, detail)
}

const config = loadConfig()
const store = new Store(openDatabase(config.databasePath))
store.recoverInterruptedRuns(Date.now())
store.pruneIfNeeded(Date.now())

const hub = new EventHub()
let dashboard: Dashboard = buildDashboard(store, Date.now())
let lastDashboardBuild = Date.now()

const status: Status = {
  refreshing: false,
  progress: null,
  lastRefreshAt:
    store
      .runsSince(Date.now() - DAY)
      .reverse()
      .find((run) => run.outcome === 'complete' || run.outcome === 'partial')?.finishedAt ?? null,
  lastError: null,
  pollIntervalSeconds: config.pollIntervalSeconds,
  briefHourUtc: config.briefHourUtc,
  storiesTracked: 0,
  risingCount: 0,
  latestSignalAt: null,
}

function rebuildDashboard(): void {
  const now = Date.now()
  dashboard = buildDashboard(store, now)
  lastDashboardBuild = now
  status.storiesTracked = dashboard.cards.size
  status.risingCount = dashboard.views.rising.length
  status.latestSignalAt = dashboard.signals[0]?.createdAt ?? null
}
rebuildDashboard()

/**
 * Builds today's shared brief once it is due. Late starts catch up the same day, but only after
 * a collection cycle has produced data, and an empty brief is never frozen for the day.
 */
function checkBrief(): void {
  const now = Date.now()
  const dateKey = utcDateKey(now)
  if (now < briefDueAt(now, config.briefHourUtc) || status.lastRefreshAt === null || store.hasBrief(dateKey)) return
  try {
    const windowStart = now - DAY
    const stories = store.recentStories(windowStart)
    const brief = buildBrief(
      {
        stories,
        signals: store.signals({ since: windowStart, limit: 10_000 }),
        momentum: dashboard.momentum,
        runs: store.runsSince(windowStart - 2 * config.pollIntervalSeconds * 1000),
        scannedCount: stories.filter((story) => story.lastFetchedAt >= windowStart).length,
        pollIntervalSeconds: config.pollIntervalSeconds,
      },
      now,
    )
    if (!brief.entries.length) return
    store.saveBrief(brief)
    log(`Daily brief ${dateKey} ready: ${brief.entries.length} stories${brief.partial ? ' (partial coverage)' : ''}`)
    hub.broadcast('brief', { dateKey })
  } catch (error) {
    log('Could not build the daily brief', error)
  }
}

let lastProgressBroadcast = 0
const collector = new Collector({
  service: new HttpHNService(config.hnApiBase),
  store,
  pollIntervalSeconds: config.pollIntervalSeconds,
  events: {
    cycleStarted() {
      status.refreshing = true
      status.progress = null
      hub.broadcast('status', status)
    },
    progress(completed, total) {
      status.progress = { completed, total }
      const now = Date.now()
      if (now - lastProgressBroadcast >= PROGRESS_BROADCAST_INTERVAL) {
        lastProgressBroadcast = now
        hub.broadcast('status', status)
      }
    },
    committed() {
      // Keep the first minutes after a cold start useful without rebuilding on every batch.
      if (Date.now() - lastDashboardBuild >= DASHBOARD_REBUILD_INTERVAL) {
        rebuildDashboard()
        hub.broadcast('update', status)
      }
    },
    cycleFinished(result) {
      status.refreshing = false
      status.progress = null
      status.lastError = result.error
      if (result.receivedData) status.lastRefreshAt = result.finishedAt
      if (result.error) log(`Cycle ${result.outcome}: ${result.error}`)
      try {
        rebuildDashboard()
        store.pruneIfNeeded(Date.now())
      } catch (error) {
        log('Could not rebuild the dashboard', error)
      }
      checkBrief()
      hub.broadcast('update', status)
    },
  },
})

const staticDir = fs.existsSync(path.join(config.staticDir, 'index.html')) ? config.staticDir : null
const server = createServer(
  {
    store,
    dashboard: () => dashboard,
    status: () => status,
    now: () => Date.now(),
    staticDir,
  },
  hub,
)

server.listen(config.port, config.host, () => {
  log(`HN Sentinel listening on http://${config.host}:${config.port}${staticDir ? '' : ' (API only; client not built)'}`)
  if (config.collectorEnabled) collector.start()
  else log('Collector disabled (COLLECTOR_ENABLED=false)')
})
const briefTimer = setInterval(checkBrief, BRIEF_CHECK_INTERVAL)
checkBrief()

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log(`${signal} received, shutting down`)
  clearInterval(briefTimer)
  const timeout = setTimeout(() => {
    log('Shutdown timed out; exiting')
    process.exit(1)
  }, SHUTDOWN_TIMEOUT)
  timeout.unref()
  await collector.stop()
  hub.closeAll()
  const closed = new Promise<void>((resolve) => server.close(() => resolve()))
  server.closeAllConnections()
  await closed
  store.db.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
