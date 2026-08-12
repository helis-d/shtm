# SHTM — System Context

## What SHTM is

SHTM ("Say Hello To Me") is a small anonymous 1:1 chat web app. Two strangers are
matched, placed into a private 60-second conversation, and may exchange text and
images. When the timer ends, the match dissolves. No account, no persistent
identity, no message history.

## System boundaries

| Layer | Technology | Location |
|-------|-----------|----------|
| Frontend | Vanilla JS + HTML + CSS | `public/` |
| Realtime transport | Socket.IO 4.8 (WebSocket-only) | `api/index.js` |
| HTTP / static | Express 5 | `api/index.js` |
| Security module | In-memory rate limiters + validation | `api/security.js` |
| Analytics / metrics | In-memory aggregates | `api/analytics.js` |
| Runtime | Vercel serverless + local Node | `vercel.json` |

## Runtime model

- `vercel.json` rewrites every request `/(.*)` to `/api/index`.
- `api/index.js` is the single HTTP entry point; it creates an Express app, wraps
  it in an `http.Server`, attaches Socket.IO, serves static files, and exports the
  `httpServer`.
- Local development: `npm run dev` (`vercel dev`) or `node api/index.js`
  (PORT env, default 3000).
- **All server state is in-process memory.** There is no database and no external
  persistence. In Vercel serverless this means state is ephemeral per instance and
  is lost on cold start. This is acceptable at current single-instance scale but is
  a known architectural limitation (see `DEPLOYMENT.md`).

## Core loop (happy path)

1. Browser loads `/` → `index.html` → loads `socket.io.js`, `lang.js`, `app.js`.
2. `app.js` opens a Socket.IO connection (WebSocket only).
3. On `connection`, the server rate-limits the IP, records the session, and
   **immediately calls `queueUser(socket)`** — every new connection auto-joins the
   matchmaking pool.
4. When two sockets are waiting, they are paired into `room_<uuid>` and receive
   `matched` with a 60s timer and an icebreaker.
5. Users exchange `message` / `image` / `typing` events within the room.
6. A room ends via 60s timeout, `endChat`, `skip`, or one user disconnecting.
7. A "find again" button re-enters the queue.

## Key invariants (see `ARCHITECTURE.md` for the full list)

- A socket must not be in the waiting pool and a room at the same time.
- A socket must not belong to two rooms.
- Room cleanup must be idempotent.
- Client-controlled state is never authoritative for security/transition decisions.

## Important files

- `api/index.js` — HTTP + Socket.IO server, lifecycle, matchmaking, message routing.
- `api/security.js` — rate limiting, payload/MIME validation, basic metrics.
- `api/analytics.js` — anonymous aggregate stats + `/api/stats` response.
- `public/app.js` — client state, socket event wiring, UI rendering.
- `public/lang.js` — i18n (TR/EN) and icebreakers.
- `public/index.html` / `public/stats.html` / `public/style.css` — pages/styles.