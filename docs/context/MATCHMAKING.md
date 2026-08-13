# SHTM — Matchmaking

## Current model

Matchmaking is a **single-slot queue**: `waitingUser` holds one socket or `null`.

`queueUser(socket)`:
1. No-op if socket not connected or already in a room.
2. Enforces a per-socket 3s cooldown (`checkMatchmakingRate`).
3. If `waitingUser` exists and is connected and is a different socket → pair.
4. Otherwise, `waitingUser = socket` and emit `searching`.

Every new connection auto-joins the queue (the `connection` handler calls
`queueUser`). `findAgain` re-enters after a room ends.

## Match lifecycle

`createMatch(userA, userB)`:
- Counts `matchesStarted` + `conversationsStarted`.
- Creates `room_<uuid>`, joins both sockets.
- Sets `roomId`, `matchStartedAt`, and a shared 60s `roomTimer` on both sockets.
- Emits `matched` with duration + random icebreaker index.

Room termination (`finishRoom(roomId, reason)`) is the single cleanup path:
- Clears timers, emits `roomEnded`, leaves room, nulls per-socket room fields.

## Important gaps (current)

- No explicit state machine (WAITING / MATCHED / ENDED are implicit).
- No duplicate-join guard between `queueUser` and `findAgain`.
- No two-user-join race protection around `waitingUser` (still single-threaded,
  but the invariant is not encoded or tested).
- No ghost-user cleanup beyond the disconnect handler.
- Timer ownership duplicated on both sockets can lead to double-cleanup races.
- No disconnect-during-match-creation handling.

## Interest-aware ranking (Feature Wave v1)

Interests and language are **ranking signals**, never hard filters:

- shared interest → higher priority
- some overlap → medium priority
- no overlap → still eligible
- language match → soft preference
- queue age → prevents starvation

`compatibilityScore` (0-100) is informational (logged), not a rejection gate.

## Target state machine (see `DECISIONS.md`)

WAITING → MATCHED → ACTIVE → ENDED/EXPIRED, with CANCELLED on disconnect.

## Matchmaking context object

Every matchmaking attempt should expose `matchId`, `userIds`, `createdAt`,
`queuedAt`, `matchedAt`, `state`, `reason`. Currently these are implicit socket
fields; `DATA_MODEL.md` describes them.