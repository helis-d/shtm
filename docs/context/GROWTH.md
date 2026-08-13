# SHTM — Growth Context

## Goal

SHTM is a network-effect product. The core growth equation:

```
REAL USERS × SIMULTANEOUS DENSITY × MATCH SUCCESS
  × CONVERSATION QUALITY × RETENTION
```

Growth instrumentation exists to make every term **measurable** — not to
maximize page views.

## Measured funnel

Implemented in `api/growth.js` (`FUNNEL_STAGES`):

```
landing_view
→ primary_cta_click
→ connection_attempt
→ connection_success
→ session_created
→ session_ready
→ queue_join
→ queue_leave
→ match_attempt
→ match_candidate_found
→ match_created
→ match_confirmed
→ conversation_started
→ conversation_message
→ conversation_ended
```

Each stage records a **global count** plus per-**country**, per-**language**,
per-**referrer**, and per-**experiment** attribution.

### Pair-stage counting rules

A match/conversation involves two participants. A pair stage
(`match_created`, `conversation_started`, `conversation_ended`) is counted:

- **once** globally (one match = one match), and
- **once per shared cohort value** — an AU↔AU match counts as one AU match,
  not two, so `matchSuccessRate = matches / matchAttempts` stays correct.

## Primary success metrics

| Metric | Numerator | Denominator |
|--------|-----------|-------------|
| Connection Success Rate | `connection_success` | `connection_attempt` |
| Queue Conversion | `queue_join` | `connection_success` |
| Match Success Rate | `match_created` | `match_attempt` |
| Conversation Start Rate | `conversation_started` | `match_created` |
| Conversation Completion Rate | `conversation_ended` | `conversation_started` |
| Network Effectiveness | conversations with ≥1 message | `connection_success` |
| Market Density | peak eligible concurrent users | — |

All denominators are explicit. Rates are never `NaN`.

## Cohorts

Cohorts are **dynamic** — the system supports every country. The dashboard
renders `GLOBAL`, `AU`, `TR`, `US`, and `OTHER`. Australia is just one cohort;
it is **not** hardcoded as the primary market.

## Return behavior (privacy-preserving)

Anonymous product, no accounts. Return measurement uses a **random,
client-generated visitor id** stored in `localStorage` (`shtm_vid`), passed to
the server as `?vid=`. The server tracks, in memory only:

- first sessions
- second sessions
- returning sessions
- return within 24 hours
- return within 7 days
- reconnect connections

No identity, no cross-site tracking, no fingerprinting.

## API

- `GET /api/growth` → machine-readable growth context (see below).
- `GET /api/stats` → legacy aggregate stats (unchanged).

Growth response shape:

```json
{
  "growth": { "totalSessions", "uniqueSessions", "connections", "queueJoins",
              "matches", "conversations", "conversationsCompleted",
              "conversationsWithMessages", "networkEffectiveness" },
  "funnel": [ { "stage", "count" } ],
  "cohorts": { "GLOBAL": {...}, "AU": {...}, "TR": {...}, "US": {...}, "OTHER": {...} },
  "trafficSources": { "referrers", "forensics", "utm" },
  "networkDensity": { "current", "peak", "average", "countries", "marketDensity" },
  "matchFailures": [ { "reason", "count" } ],
  "experiments": [ ... ],
  "returnBehavior": { "firstSessions", "secondSessions", "returningSessions",
                      "returnWithin24h", "returnWithin7d", "reconnectConnections" }
}
```

See `TRAFFIC.md`, `EXPERIMENTS.md`, and `NETWORK_DENSITY.md`.