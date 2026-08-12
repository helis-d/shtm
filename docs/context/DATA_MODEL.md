# SHTM — Data Model

## Server-side (in-memory)

### Socket augmentation (per-client ephemeral state)

Attached directly to each `socket` object in `api/index.js`:

| Field | Type | Meaning |
|-------|------|---------|
| `roomId` | string|null | Current room, null when idle. |
| `roomTimer` | Timeout|null | Shared 60s room timer. |
| `matchStartedAt` | number|null | Epoch ms when match began. |
| `lastMessageAt` | number | Last send timestamp (cooldown). |
| `lastTypingAt` | number | Last typing emit (300ms throttle). |
| `typing` | boolean | Current typing state. |
| `_queuedAt` | number|null | Epoch ms when queued for match. |

### Global state

- `waitingUser` — single socket awaiting a match (or `null`).

### Security stores (`api/security.js`)

- `ipConnectionMap` — IP → `{ count, startedAt }` (connection rate limit).
- `matchmakingCooldowns` — socketId → cooldown-until ts.
- `messageTracker` — socketId → `{ windowStart, count, lastMessageAt }`.
- `imageCooldowns` — socketId → cooldown-until ts.
- `metrics` — cumulative counters (`connections`, `messages`, etc.).

### Analytics stores (`api/analytics.js`)

- `events` — cumulative counters.
- `countries`, `languages` — distribution maps.
- `matchWaitTimes`, `conversationDurations`, `wsLatencies` — ring buffers (≤1000).
- `connectionStartTimes` — ring buffer (≤500) for session length.

## Client-side (browser)

- `inChat`, `countdown`, `typingTimeout`, `isTyping`, `lastSentAt` in `app.js`.
- `currentLang` in `lang.js`, persisted in `localStorage.shtm_lang`.

## Data URL / image representation

Images are transmitted as base64 data URLs (`data:<mime>;base64,...`). The server
validates the declared MIME, extracts the base64 payload, checks magic bytes, and
enforces a 5 MiB limit.

## IDs

- Socket IDs: Socket.IO generated (e.g. short random).
- Room IDs: `room_<uuid>` via `crypto.randomUUID()`.
- No persistent user IDs (anonymous). No session/correlation IDs are currently
  issued (see `DECISIONS.md`).