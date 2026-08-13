# SHTM — Network Density Context

## Purpose

SHTM is a network-effect product. The most important new metric is
**Eligible Matching Density**: the number of users who can currently be
matched with one another.

## Snapshot mechanism

`api/index.js` injects a live snapshot provider into `api/growth.js`.
A snapshot runs at startup and every 30s (`growth.startSnapshots(30_000)`).

```json
{
  "timestamp": 0,
  "global":  { "connected": 0, "waiting": 0, "matched": 0, "eligible": 0 },
  "countries": { "AU": { "connected": 0, "waiting": 0, "eligible": 0 } },
  "languages": { "en": { "connected": 0, "waiting": 0, "eligible": 0 } }
}
```

Definitions:

- **connected** — sockets currently connected.
- **waiting** — sockets in `STATE.WAITING` (queued for a match).
- **matched** — sockets in `STATE.MATCHED` (in an active room).
- **eligible** — connected sockets **not currently in a room**
  (immediately matchable candidates).

Everything derives from **real live socket/matchmaking state** — never from
page views, never fabricated.

## Metric surfaces

`GET /api/growth` → `networkDensity`:

- `current` — latest snapshot.
- `peak` — maximums observed (`connected`, `waiting`, `matched`, `eligible`).
- `average` — rolling snapshot averages.
- `countries` — peak connected/waiting per country.
- `marketDensity` — per-country market diagnostics.

## Market density (per cohort country)

Calculated from live state and matchmaking data only:

- `peakConcurrentUsers` — peak simultaneous connected users for the country.
- `averageConcurrentUsers` — rolling average.
- `peakQueueSize` — peak simultaneous waiting users.
- `matchablePopulation` — latest eligible count for the country.
- `avgWaitMs` / `p50WaitMs` / `p95WaitMs` — match wait times.
- `matchSuccessRate` — `match_created / match_attempt` for the country.

## Concurrency correctness

- Peak concurrency is computed from snapshots, not from lifecycle counters.
- Eligible density is the **union** of waiting + idle-but-connected users
  (both can be matched immediately by the single-slot queue).
- No fake density. No fake online counts. The AU cohort message only asserts
  what is demonstrably true.

See `GROWTH.md`, `TRAFFIC.md`, and `EXPERIMENTS.md`.