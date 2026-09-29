# HN Sentinel

What's gaining momentum on Hacker News right now, the same for everyone: a Rising list,
Signals (breakouts, discussion spikes, and score milestones), and a Daily Brief.

A single container runs everything as one service:

- **Collector:** polls the official HN API around the clock and stores observations in SQLite.
- **API:** JSON endpoints, plus server-sent events so open browsers update live.
- **Web app:** the React client, built by Vite and served from the same port.

## Run it

```sh
docker compose up -d --build
open http://localhost:8080
```

Data lives in the `sentinel-data` volume, so it survives restarts and upgrades. Momentum
appears after about 20 minutes of continuous collection.

```sh
docker compose logs -f          # follow the service
docker compose down             # stop (data is kept)
docker compose down -v          # stop and delete all collected data
```

The image only builds if typecheck and the full test suite pass inside Docker.

### Configuration

Set these in the environment or a `.env` file next to `docker-compose.yml`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Host port |
| `POLL_INTERVAL_SECONDS` | `60` | Collection cadence (30–240) |
| `BRIEF_HOUR_UTC` | `13` | Hour the shared Daily Brief is published |
| `COLLECTOR_ENABLED` | `true` | `false` serves existing data without polling |

## How it works

| Path | Role |
| --- | --- |
| `server/collector.ts` | One cycle at a time; at most 8 concurrent item requests; backs off 2 → 4 → 10 minutes after cycles that fetch nothing |
| `server/store.ts` | SQLite (`node:sqlite`); planning, atomic ingest, signals, retention |
| `server/momentum.ts` | Pure momentum engine: measured deltas between real observations, never extrapolated |
| `server/brief.ts` | Pure daily-brief builder with honest coverage reporting |
| `server/dashboard.ts` | Cards, Rising list, and signals, computed once per cycle and shared by every request |
| `server/api.ts` | Read-only HTTP API, SSE, and static hosting with a strict CSP |
| `src/` | React client |
| `shared/types.ts` | API contract shared by server and client |

**Collection:**

- Top and New refresh every poll; Best, Ask, Show, and Jobs refresh every 5 minutes.
- Top's first 100 stories and up to 300 recent ones are refetched when `/updates` reports a
  change, or before their newest observation turns 270 seconds old.
- Everything else seen today refreshes every 15 minutes.

**Signals:**

- **Breakout:** +20 points or +15 front-page ranks in about 20 minutes, for stories under
  6 hours old.
- **Discussion spike:** +15 comments in about 20 minutes.
- **Milestone:** 100, 250, or 500 points.

Each story fires each signal at most once an hour. The Signals view groups them per story
per day.

**Retention:**

- Snapshots: 48 hours.
- Signals: 30 days.
- Briefs: 90 days.
- Stories: 60 days after they were last observed.
- Trajectories: kept indefinitely. When a story or poll turns a day old, its first 24 hours
  are archived (5-minute samples for 6 hours, then every 30 minutes) together with outcome
  figures such as peak score, best front-page rank, and time on the front page. This is the
  long-term dataset for future trend and prediction work.

**Per-reader state stays in the browser:** the Saved list, which Signals have been seen, and
the theme. There are no accounts.

## API

All endpoints are `GET`.

| Endpoint | Returns |
| --- | --- |
| `/api/stories?view=top\|new\|best\|ask\|show\|jobs\|rising` | Story cards with momentum and trend |
| `/api/stories?ids=1,2,3` | Specific stories (up to 200) |
| `/api/stories/:id` | Detail with 48 hours of history and signals |
| `/api/signals` | Recent signals |
| `/api/briefs`, `/api/briefs/latest`, `/api/briefs/:yyyy-mm-dd` | Daily briefs |
| `/api/status`, `/api/health` | Collector status, liveness |
| `/api/events` | Server-sent events: `status`, `update`, `brief` |

## Deploy (InstaCloud)

Every push to `main` deploys automatically: InstaCloud's GitHub App builds the Dockerfile
(typecheck and tests included; a failing build leaves the live version running) and rolls
the `app` service. The `/data` volume persists across deploys.

Manual `insta deploy .` uploads are refused while the service tracks this repository. Push to
`main` instead, or preview a change first on its own environment with
`insta branch create <name>`.

## Development

Everything runs in containers; nothing needs installing on the host. To run the checks
without producing an image:

```sh
docker build --target build .
```
