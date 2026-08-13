# SHTM — Changelog

## 2026-08-13 — Growth Context Engineering + Network Density

### What changed

- Added `lib/growth.js`: anonymous, aggregate growth instrumentation.
- Added `GET /api/growth` and a tabbed growth dashboard in `public/stats.html`.
- Measured a full funnel (landing → CTA → connect → ready → queue → match →
  conversation → completion) with correct denominators.
- Added traffic source instrumentation: referrer domain, UTM source/medium/
  campaign, landing page, country, language, coarse device/browser.
- Added dynamic country + language cohorts (GLOBAL/AU/TR/US/OTHER). Australia
  is one cohort, not a hardcoded primary market.
- Added network density metrics: concurrent connected/waiting/matched/eligible
  users, peak/average, per-country and per-language, and per-country market
  density (peak concurrent, wait times, matchable population).
- Added normalized match-failure taxonomy and per-country wait times.
- Added a lightweight experiment framework and the **Australia Density Test**
  (`au-density-001`), configurable via `SHTM_AU_WINDOW_ENABLED` and
  `SHTM_AU_WINDOW`.
- Added privacy-preserving return behavior (first/second/returning sessions,
  24h/7d returns, reconnects) via a random `localStorage` visitor id.
- Added a lightweight share/referral pathway that preserves UTM metadata.
- Added matchmaking debug traces (`SHTM_MATCH_DEBUG=1`, dev/controlled only).
- Added `docs/context/GROWTH.md`, `TRAFFIC.md`, `EXPERIMENTS.md`,
  `NETWORK_DENSITY.md`, and regenerated `current-state.json`.

### Why

- The prior dashboard showed connections/matches/conversations but not what
  happened between them. The funnel now exposes the full lifecycle.
- A disproportionate share of traffic appeared to originate from Australia.
  The new instrumentation distinguishes real sessions vs. reconnects vs.
  artifacts and attributes referrers, without assuming Australia is the
  target market.

### Decisions / guardrails

- No fake density: no fake users, online counts, matches, or conversations.
- Match/conversation pair events are counted once globally and once per shared
  cohort dimension, so per-country rates stay correct.
- Experiments change timing + distribution first, not core matchmaking logic.

---

## 2026-08-12 — Context-Engineered Reliability & Observability Upgrade

### What changed

- Added a structured logging layer (`api/logger.js`) with JSON output, a
  normalized error taxonomy, socket lifecycle state enums, and disconnect
  reason categories.
- Rewrote `api/analytics.js` so every rate is computed from an explicit,
  matching numerator/denominator pair. Added p50/p95/p99 percentiles for
  match wait, conversation duration, WS latency, and socket lifetime.
- Refactored `api/index.js` to:
  - track an explicit `connectionState` (`connected → waiting → matched → disconnected`);
  - keep a single authoritative room record map (`rooms`) for teardown;
  - make room/socket cleanup idempotent;
  - record disconnect reason categories and socket lifetimes;
  - measure server round-trip latency via `system:ping` / `system:pong`;
  - set explicit `pingInterval`, `pingTimeout`, `connectTimeout`, and
    `maxHttpBufferSize` (7 MiB) so large-but-valid images are not silently dropped.
- Hardened `api/security.js`: fixed the message cooldown to arm on the first
  message (previously the first message bypassed the 2s cooldown).
- Added client connection UX in `public/app.js` with explicit
  `connecting/connected/reconnecting/disconnected` states, capped reconnect
  attempts with jitter, and latency pong support.
- Updated `public/stats.html` to surface the new correct metrics and a
  disconnect-reason distribution table.

### Why it changed

- `matchSuccessRate` previously divided by `matchesCompleted`, which was
  never incremented → always 0%. Metrics conflated "currently connected"
  with "connection succeeded". These are now corrected.
- Disconnect forensics were missing; the high observed disconnect rate could
  not be attributed to a cause. It is now categorized.
- The default Socket.IO `maxHttpBufferSize` (1 MiB) was smaller than the
  documented 5 MiB image limit, causing valid uploads to fail.

### Important architectural decisions

- Single-slot in-memory matchmaking remains; documented as a scale limitation,
  not silently fixed (would require Redis / shared state).
- Clean room-end via `finishRoom` is the single teardown path; disconnect and
  skip tear down the record directly because those are asymmetric exits.
- WS latency uses a minimal ping every 30s (not per-event) to avoid excessive
  heartbeat traffic.

### Migration concerns

- `package.json` added `socket.io-client@4.8.3` as a devDependency for the
  integration test suite. No production dependency changes.
- `/api/stats` response shape changed (added fields, renamed `medianWaitMs`
  to `p50WaitMs`, added `disconnectReasons`). `public/stats.html` was updated
  in lockstep. Any external consumers of `/api/stats` should migrate.

### Known limitations

- In-memory metrics still reset on Vercel cold start.
- Multi-instance scaling still requires external shared state (out of scope).
- Reconnect does not restore a prior match (anonymous chat by design).