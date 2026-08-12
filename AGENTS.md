# SHTM — AI Agent Orientation

Concise operating context for coding agents. Full reference material lives in
`docs/context/`.

## What SHTM is

Anonymous 1:1 60-second chat. Two strangers are matched into a Socket.IO room,
chat (text + images), then the room dissolves. No accounts, no message history,
no persistent DB.

## Architecture (one screen)

- **Frontend** — vanilla JS in `public/` (`app.js` = socket + UI, `lang.js` = i18n).
- **Backend** — `api/index.js`: Express 5 + `http.Server` + Socket.IO (WebSocket-only).
- **Security** — `api/security.js`: in-memory rate limiters + payload/MIME validation.
- **Analytics** — `api/analytics.js`: anonymous aggregate stats for `/api/stats`.
- **Logger** — `api/logger.js`: structured JSON log + lifecycle/disconnect enums.
- **Runtime** — Vercel serverless (single instance) or local `npm start`.

`vercel.json` rewrites all `/*` → `/api/index`.

## Critical invariants (do not break)

1. A socket must not be in the waiting pool and a room at the same time.
2. A socket must not belong to two rooms.
3. Room cleanup must be idempotent — it may run more than once.
4. Client-controlled state is never authoritative for security/transition
   decisions.
5. Metrics must use explicit, matching numerator/denominator pairs
   (rates are never `NaN`).

## How realtime works

- On `connection`, every socket is auto-queued (`queueUser`).
- `waitingUser` is a single-slot queue. Two waiting sockets → `createMatch`.
- `createMatch` creates `room_<uuid>`, joins both sockets, sets a 60s timer, and
  emits `matched`.
- `finishRoom(roomId, reason)` is the **single** teardown path for a clean room
  end (`timeout` / `endChat`).
- Disconnect and `skip` tear down the room record directly and notify the partner.

### Lifecycle states (server)

`connected → waiting → matched → disconnected` (defined in `api/logger.js`).

### Event contract

Full table in `docs/context/SOCKETS.md`. Client→server: `sendMessage`,
`sendImage`, `typing`, `skip`, `endChat`, `findAgain`, `report`, `system:pong`.
Server→client: `searching`, `matched`, `message`, `image`, `typing`,
`messageError`, `skipped`, `partnerLeft`, `readyForNewMatch`, `roomEnded`,
`reportSent`, `reportError`, `system:ping`.

## Matchmaking lifecycle (summary)

WAITING → MATCHED → ACTIVE → ENDED (clean) / ABORTED (disconnect).

## Testing

```bash
npm test              # Node built-in test runner (all suites)
npm run context:build # regenerate docs/context/current-state.json
npm run context:check # verify manifest is not stale
```

Tests are behavior-focused: `test/analytics.test.js`, `test/logger.test.js`,
`test/security.test.js`, `test/lifecycle.integration.test.js`.

## Deployment assumptions

- In-memory state resets on cold start. Treated as acceptable at current scale.
- No sticky sessions; do not add logic that assumes a permanent single process.
- Images up to 5 MiB base64 (~6.7 MiB) — `maxHttpBufferSize` is set to 7 MiB.

## Common failure modes (see `docs/context/FAILURE_MODES.md`)

- High disconnect rate is often Vercel recycle / proxy idle / mobile network,
  not a code bug — treat disconnect as a first-class lifecycle event.
- Ghost match/room = server believes a user is active but socket is gone;
  always clean the partner and room record on disconnect.

## Coding conventions

- CommonJS (`require`/`module.exports`). No TypeScript.
- Two-space indentation, no semicolon mandates.
- Every network payload is validated server-side (`security.js`).
- Never `console.log` raw events directly — use `log.info/debug/error/security` from
  `api/logger.js`.
- Never log secrets, tokens, message bodies, or personal data.

## Context files (durable, AI-readable)

`docs/context/SYSTEM.md`, `ARCHITECTURE.md`, `SOCKETS.md`, `MATCHMAKING.md`,
`DATA_MODEL.md`, `SECURITY.md`, `OBSERVABILITY.md`, `DEPLOYMENT.md`,
`FAILURE_MODES.md`, `DECISIONS.md`, `GLOSSARY.md`, `CHANGELOG.md`, and the
generated `current-state.json`.