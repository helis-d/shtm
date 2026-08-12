# SHTM — Deployment

## Platform

- **Vercel** (serverless functions) for production.
- Local: `npm run dev` (Vercel dev) or `npm start` (`node api/index.js`).

## Entry point

- `vercel.json` rewrites all `/(.*)` → `/api/index`.
- `api/index.js` exports the `http.Server` for Vercel; it only calls
  `.listen()` when run directly (`require.main === module`) for local dev.

## Environment variables

Currently **none required**. Reference points for future scale-out:

- `REDIS_URL`, `REDIS_TOKEN` — documented in `security.js` for a future
  Redis-backed rate-limit store.
- `PORT` — local dev port (default 3000).

## Runtime constraints

- Single instance, in-memory state. Everything resets on cold start.
- WebSocket-only Socket.IO attached to a single `http.Server`.
- No persistent DB, no message history, no user accounts.
- Vercel functions may be recycled; do not rely on long-lived timers surviving
  across invocations or on sticky sessions across instances.

## Build / verification

- No separate build step for the frontend (vanilla JS).
- No test framework currently configured.
- No lint/type-check script currently configured (JS, not TS).