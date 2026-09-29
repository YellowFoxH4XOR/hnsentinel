import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type Database = DatabaseSync

/**
 * Ordered schema migrations; `PRAGMA user_version` records how many have run. Append new
 * migrations — never edit a shipped one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE stories (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    url TEXT,
    author TEXT,
    created_at INTEGER,
    score INTEGER,
    comments INTEGER,
    deleted INTEGER NOT NULL DEFAULT 0,
    dead INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    last_fetched_at INTEGER NOT NULL
  );
  CREATE INDEX stories_last_fetched ON stories(last_fetched_at);
  CREATE INDEX stories_first_seen ON stories(first_seen_at);

  CREATE TABLE snapshots (
    story_id INTEGER NOT NULL,
    cycle_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    score INTEGER,
    comments INTEGER,
    top_rank INTEGER,
    PRIMARY KEY (story_id, cycle_id)
  ) WITHOUT ROWID;
  CREATE INDEX snapshots_story_time ON snapshots(story_id, observed_at);
  CREATE INDEX snapshots_time ON snapshots(observed_at);
  CREATE INDEX snapshots_cycle ON snapshots(cycle_id);

  CREATE TABLE feeds (
    kind TEXT PRIMARY KEY,
    ids TEXT NOT NULL DEFAULT '[]',
    fetched_at INTEGER,
    error TEXT
  );

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    interval_seconds REAL NOT NULL,
    outcome TEXT NOT NULL,
    failed_feeds INTEGER NOT NULL DEFAULT 0,
    attempted INTEGER NOT NULL DEFAULT 0,
    succeeded INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX runs_started ON runs(started_at);

  CREATE TABLE signal_state (
    key TEXT PRIMARY KEY,
    story_id INTEGER NOT NULL,
    triggered INTEGER NOT NULL DEFAULT 0,
    last_trigger_at INTEGER
  );
  CREATE INDEX signal_state_story ON signal_state(story_id);

  CREATE TABLE signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    story_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    score INTEGER,
    comments INTEGER,
    momentum TEXT
  );
  CREATE INDEX signals_created ON signals(created_at);
  CREATE INDEX signals_story ON signals(story_id);

  CREATE TABLE briefs (
    date_key TEXT PRIMARY KEY,
    generated_at INTEGER NOT NULL,
    payload_version INTEGER NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 2: long-term story trajectories, kept after raw snapshots are pruned.
  `
  CREATE TABLE trajectories (
    story_id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    domain TEXT,
    author TEXT,
    created_at INTEGER NOT NULL,
    archived_at INTEGER NOT NULL,
    samples INTEGER NOT NULL,
    first_observed_at INTEGER NOT NULL,
    last_observed_at INTEGER NOT NULL,
    max_gap_minutes REAL NOT NULL,
    max_score INTEGER,
    max_comments INTEGER,
    final_score INTEGER,
    final_comments INTEGER,
    best_rank INTEGER,
    front_page_minutes REAL NOT NULL,
    dead INTEGER NOT NULL,
    deleted INTEGER NOT NULL,
    series_version INTEGER NOT NULL,
    series BLOB NOT NULL
  );
  CREATE INDEX trajectories_created ON trajectories(created_at);
  CREATE INDEX stories_created ON stories(created_at);
  `,
]

export function openDatabase(file: string): Database {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `)
  migrate(db)
  return db
}

function migrate(db: Database): void {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (version > MIGRATIONS.length) {
    throw new Error(`Database schema version ${version} is newer than this build supports (${MIGRATIONS.length})`)
  }
  for (let index = version; index < MIGRATIONS.length; index++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[index])
      db.exec(`PRAGMA user_version = ${index + 1}`)
    })
  }
}

/** Runs `body` in one write transaction, rolling back when it throws. Not re-entrant. */
export function transaction<T>(db: Database, body: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = body()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
