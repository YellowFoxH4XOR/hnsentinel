import path from 'node:path'

export interface Config {
  port: number
  host: string
  databasePath: string
  staticDir: string
  pollIntervalSeconds: number
  briefHourUtc: number
  hnApiBase: string
  collectorEnabled: boolean
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`)
  }
  return value
}

export function loadConfig(): Config {
  const dataDir = process.env.DATA_DIR ?? path.resolve('data')
  return {
    port: integer('PORT', 8080, 1, 65535),
    host: process.env.HOST ?? '0.0.0.0',
    databasePath: process.env.DATABASE_PATH ?? path.join(dataDir, 'sentinel.db'),
    staticDir: process.env.STATIC_DIR ?? path.resolve('dist'),
    // Momentum needs an observation at least every five minutes; faster than 30s adds load for nothing.
    pollIntervalSeconds: integer('POLL_INTERVAL_SECONDS', 60, 30, 240),
    briefHourUtc: integer('BRIEF_HOUR_UTC', 13, 0, 23),
    hnApiBase: process.env.HN_API_BASE ?? 'https://hacker-news.firebaseio.com/v0/',
    collectorEnabled: process.env.COLLECTOR_ENABLED !== 'false',
  }
}
