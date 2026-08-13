# SHTM — Socket.IO Contract

## Transport

- WebSocket only (`transports: ["websocket"]`).
- `allowEIO3: true` for legacy client compatibility.
- CORS `origin: "*"` (anonymous public app).
- Default `maxHttpBufferSize` limit (1 MiB) — see `FAILURE_MODES.md` re: images.

## Server → Client events (emit)

| Event | Direction | Payload | Meaning |
|-------|-----------|---------|---------|
| `searching` | S→C | `{ message }` | You are now queued for a match. |
| `matched` | S→C | `{ message, startedAt, duration, icebreaker }` | Match created; start timer. |
| `message` | S→C | `{ message, timestamp }` | Partner text message. |
| `image` | S→C | `{ image, timestamp }` | Partner image (base64 data URL). |
| `typing` | S→C | `{ active }` | Partner typing indicator. |
| `messageError` | S→C | `{ message }` | Rejected message/image/rate-limit. |
| `skipped` | S→C | `{ message }` | You skipped. |
| `partnerLeft` | S→C | `{ message }` | Partner left/disconnected. |
| `readyForNewMatch` | S→C | `{}` | You may find a new stranger. |
| `roomEnded` | S→C | `{ message, reason }` | Room terminated. |
| `reportSent` | S→C | `{ message }` | Report accepted. |
| `reportError` | S→C | `{ message }` | Report rejected (empty reason). |

## Client → Server events (on)

| Event | Direction | Payload | Meaning |
|-------|-----------|---------|---------|
| `sendMessage` | C→S | `{ message }` | Send text message (validated). |
| `sendImage` | C→S | `{ image }` | Send image data URL (validated). |
| `typing` | C→S | `boolean` | Typing indicator (rate-limited 300ms). |
| `skip` | C→S | — | Skip current partner. |
| `endChat` | C→S | — | End current room. |
| `findAgain` | C→S | — | Re-enter matchmaking (legacy). |
| `queue:next` | C→S | — | Next match (tracked `next_match_clicked`). |
| `interests:set` | C→S | array of ids | Set validated interests. |
| `icebreaker:next` | C→S | — | Rotate icebreaker (rate-limited 4s). |
| `conversation:feedback` | C→S | `{ rating }` | Post-term feedback (Good/Okay/Not great). |
| `share:clicked` | C→S | — | Share click (rate-limited 5s). |
| `report` | C→S | `{ reason }` | Report partner (max 300 chars). |

## Server → client additions (Feature Wave v1)

| Event | Payload | Meaning |
|-------|---------|---------|
| `match:intro` | `{ you, partner, sharedInterests }` | Anonymous coarse intro card. |
| `match:shared-interests` | `{ interests }` | Shared interest discovery (top 1-3). |
| `conversation:icebreaker` | `{ id, text, category }` | Curated conversation starter. |
| `conversation:milestone` | `{ level, atMs }` | Subtle milestone signal. |
| `conversation:ended` | `{ accepted }` | Feedback accepted. |
| `session:summary` | `{ conversations }` | Coarse session depth (no IDs). |
| `presence` | `{ eligible, connected, waiting }` | Real aggregate presence. |
| `share:prompt` | `{ visible }` | Optional share prompt after good feedback. |

## Client Socket.IO built-in events

- `connect` → sets UI to connected.
- `disconnect` → clears chat state + shows disconnected. (See `FAILURE_MODES.md`.)

## Validation

Server-side validation applies to every inbound payload. Text length, image MIME
(magic bytes), payload size, message burst/cooldown rate, image upload rate, and
global connection rate are all enforced in `security.js`.