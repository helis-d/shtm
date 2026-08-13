# SHTM — Experiment Context

## Framework

A **lightweight, in-memory** experiment framework in `api/growth.js`. Not a
platform — the smallest reliable system.

Each experiment defines:

- `experimentId`
- `name`
- `hypothesis`
- `cohort` (e.g. `{ "country": "AU" }`)
- `control` / `treatment`
- `primaryMetric`
- `secondaryMetrics`
- `successThreshold`
- `status` (`planned` / `active` / …)

Assignment is **server-side** from country (+ configured time window).
Client input never determines assignment.

## First experiment: Australia Density Test

`experimentId: "au-density-001"`

**Hypothesis:** Concentrating Australian users into the same time window
increases successful match rate and conversation start rate.

This experiment changes **timing + distribution**, **not core product logic**.

| Property | Value |
|----------|-------|
| Cohort | `country = AU` |
| Control | AU traffic outside the configured window |
| Treatment | AU traffic inside the configured window + cohort messaging |
| Primary metric | `matchSuccessRate` |
| Secondary metrics | `conversationStartRate`, `queueToMatchConversion`, `eligibleMatchingDensity` |

### Event window configuration

```
SHTM_AU_WINDOW_ENABLED=1
SHTM_AU_WINDOW="19:00-23:00@Australia/Sydney"
```

- Timezone is configurable (IANA), never assumed to be UTC.
- Cross-midnight windows are supported (e.g. `22:00-02:00`).
- When unset, the experiment stays `planned` and no assignment occurs.

### Messaging (cohort-specific, config-only)

AU treatment cohort may receive a different `searching` message via
`getCohortMessage(country, variant, stage)`:

- **Global:** "Looking for a stranger…" (default)
- **AU treatment:** "People around the world are online right now."

This must never overstate density. Only true statements are allowed.

## Success criteria (configurable thresholds, NOT claimed outcomes)

- ≥ 20 real Australian sessions
- ≥ 10 Australian queue joins
- ≥ 5 successful matches
- ≥ 3 conversations lasting > 2 minutes
- meaningful improvement in queue→match conversion vs. baseline

## Guardrails

- **Do not fake density** — no fake users, online counts, matches, or
  conversations. All density comes from real users.
- Experiments are measurement-first. Matchmaking, Socket.IO, and deployment
  architecture are not modified until data reveals a clear issue.

See `GROWTH.md` and `NETWORK_DENSITY.md`.