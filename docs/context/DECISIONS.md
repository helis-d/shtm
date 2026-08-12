# SHTM — Architecture Decisions

## Current decisions (derived from code)

- **WebSocket-only** transport to avoid long-polling churn.
- **Anonymous, no accounts** — simplest trust model for a 30s chat.
- **Single-slot matchmaking queue** — `waitingUser` is enough at tiny scale.
- **In-memory analytics** — privacy by not persisting; loses on restart.
- **60s fixed chat duration** — server-authoritative via room timer.
- **Server sends Turkish strings; client translates** via `lang.js`.
- **Small-count privacy** — counts of 1–2 rendered as `<3`.

## Upgrade decisions (this change set)

- **Correct metrics denominators** instead of the existing conflation:
  - `connectionSuccessRate = successful / attempts` (attempts = accepted + rejected).
  - `matchSuccessRate = matchesCompleted / matchesStarted`.
  - `disconnectRate` = `disconnects / connections` but explicitly labeled as
    *churn*, not failure. Meaningful failure metrics (rejections) reported
    separately.
- **Introduce a connection lifecycle state machine** with explicit CONNECTING /
  CONNECTED / DISCONNECTED/reconnecting states, disconnect reason taxonomy,
  and deterministic reconnect backoff with jitter (cap attempts to avoid storms).
- **Idempotent room/socket cleanup** as the single source of truth for
  matchmaking teardown.
- **Server-side payload validation** already exists; keep and extend the same
  mental model (type/length/structure/allowed values).
- **No new runtime dependencies**. Tests will use Node's built-in test runner
  so nothing needs installing for CI compatibility.

## Trade-offs acknowledged

- Keeping in-memory state keeps the app simple but is unsafe for multi-instance
  Vercel scale. Documented, not silently fixed — requires external infra (Redis)
  to truly solve.
- No session persistence means reconnect cannot restore a prior match; reconnect
  starts a fresh anonymous chat.