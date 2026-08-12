# SHTM — Architecture

## Components

```
Browser (public/)
  ├─ index.html          → DOM structure, loads scripts
  ├─ app.js              → socket client + UI state machine
  ├─ lang.js             → i18n (tr/en), icebreaker bank
  ├─ style.css           → visual styling
  └─ stats.html          → anonymous public stats page

Server (api/)
  ├─ index.js            → Express + http.Server + Socket.IO orchestration
  ├─ security.js         → rate limiters + payload/MIME validation
  └─ analytics.js        → anonymous aggregate metrics + stats computation
```

## Data flow

- HTTP: `vercel.json` rewrites `/*` → `/api/index`. Express serves static files,
  `/`, `/stats`, `/api/stats`, and `/speed-insights.mjs`.
- Realtime: Socket.IO over WebSocket only (`transports: ["websocket"]`).
  Server events are listed in `SOCKETS.md`.

## Serverless awareness

All state (`waitingUser`, room membership, rate-limit maps, analytics counters)
lives in Node process memory on a single instance. Vercel Platform Functions are
ephemeral and can be recycled. This is the **critical deployment constraint**:
the system must assume no cross-request memory, no sticky sessions guarantee at
scale, and that any in-memory map can vanish at any time.

## Invariants

1. A user cannot be in the waiting pool more than once.
2. A user cannot belong to two active matches.
3. A disconnected socket cannot remain indefinitely in a live matchmaking state.
4. An ended match cannot become active again.
5. A conversation cannot receive messages after termination.
6. Cleanup must be idempotent.
7. Metrics must never count the same lifecycle event twice.
8. Reconnect must not create a duplicate session.
9. Client-controlled state is never authoritative for security-sensitive transitions.

## Isolation strategy (adapters)

The code is intentionally kept in small modules (`security.js`, `analytics.js`)
with simple interfaces so pieces can be swapped (e.g. Redis-backed stores) without
rewriting `index.js`. Current interfaces:

- `security.js` — `check*` rate limiters, `.sanitizeMessage`, `.validateImagePayload`,
  `.checkPayloadSize`, metric counters.
- `analytics.js` — `track*` event recorders, `getStats`, `setActiveCountGetters`.

## Dangerous areas

- `waitingUser` global in `index.js` (single-slot matchmaking queue).
- Room/socket cleanup in the `disconnect` handler — must be idempotent.
- Timer ownership: `createMatch` stores the same room timer on both sockets.
- Rate-limit maps in `security.js` grow without bound until the 60s cleanup sweep.