# SHTM — Conversation Model

## Existing model (unchanged)

Two matched sockets join `room_<uuid>` for a fixed `CHAT_DURATION` (60s),
exchange text/images, then the room dissolves. No history is persisted.

## Additions (Feature Wave v1)

- **Elapsed timer** — existing countdown reused; presentation communicates
  "you have X left" not "you've talked X".
- **Milestones** — 30s / 2m / 5m / 10m; emitted as `conversation:milestone`
  plus a `conversation_milestone` growth event. Only reachable milestones are
  emitted under the default 60s duration (so only level 1 fires by default).
  Timer handles are owned by the room record and cleared idempotently.
- **Quality feedback** — Good / Okay / Not great, aggregate-only, after
  termination. Rate-limited (5s). Per-socket feedback state is isolated per
  conversation.
- **Session counter** — `session:summary` reports `conversations` count (no
  internal IDs).

## Lifecycle safety

- `createMatch` sets `roomId`, `matchStartedAt`, shared 60s timer, clears
  queue state, increments `conversationCount`, and resets feedback/icebreaker
  state per match.
- `finishRoom(roomId, reason)` is still the single clean-teardown path; it now
  clears milestone timers and emits `session:summary`.
- Disconnect/`skip` teardown remain direct and idempotent.

## Data stored

No message content is stored. Only aggregate counters + coarse cohort signals.