# SHTM — Changelog

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