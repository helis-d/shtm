# SHTM — Observability

## What exists

- `api/analytics.js` — anonymous aggregate counters tracked into memory and
  exposed via `GET /api/stats` (private in-memory JSON) and rendered by
  `public/stats.html`.
- `api/security.js` — a lightweight `metrics` object (connection/message counts)
  dumped to console every 60s.
- `console.log` lines for connect/disconnect, security rejections, and reports.

## Event catalog (current)

### Matchmaking / connection
- `trackConnection(country, language)`
- `trackDisconnect()`
- `trackMatchStarted()`
- `trackMatchWaitTime(ms)`
- `trackConversationStarted()`
- `trackConversationEnded(durationMs)`
- `trackMessage()`
- `trackImage()`

### Security metrics
- `connections`, `matchmakingAttempts`, `messages`, `imageUploads`,
  `rateLimitViolations`, `rejectedConnections`, `rejectedMessages`,
  `activeSessions` (in `security.js`).

## Stats response shape (`/api/stats`)

```json
{
  "timestamp": 0,
  "global": {
    "totalConnections": 0, "totalMatches": 0, "totalConversations": 0,
    "activeUsers": 0, "activeMatches": 0, "waitingUsers": 0,
    "avgMatchWaitMs": 0, "avgConversationDurationMs": 0
  },
  "countries": [],
  "languages": [],
  "matching": {
    "successfulMatches": 0, "avgWaitMs": 0, "medianWaitMs": 0,
    "longestWaitMs": 0, "matchSuccessRate": "0.0%", "activeMatches": 0
  },
  "conversation": {
    "started": 0, "completed": 0, "avgDurationMs": 0,
    "medianDurationMs": 0, "avgMessagesPerConversation": "0.0"
  },
  "system": {
    "avgResponseTimeMs": 0, "avgWSLatencyMs": 0,
    "connectionSuccessRate": "0.0%", "disconnectRate": "0.0%",
    "apiErrors": 0
  }
}
```

## Known metric correctness issues (do not trust blindly)

- `matchSuccessRate` uses `matchesCompleted / matchesStarted`, but
  `matchesCompleted` is never incremented anywhere → always 0%.
- `connectionSuccessRate` = `(connections - disconnects)/connections` is a
  conflation of "currently connected" with "connection succeeded".
- `disconnectRate` = `disconnects/connections` is impacted by normal churn and
  is not a meaningful "failure" rate.
- `avgWSLatencyMs` is never fed data (`wsLatencies` always empty) → 0.
- No percentile (p50/p95/p99) metrics exist; only mean/median/max.

See `DECISIONS.md` for the metrics-model upgrade plan.