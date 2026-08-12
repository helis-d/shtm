# SHTM — Failure Modes

## Connection / Socket.IO

| Failure | Cause | Symptom | State left behind |
|---------|-------|---------|-------------------|
| High disconnect rate | Vercel function recycle, proxy idle timeout, mobile network, client tab close | `disconnect` fires, UI shows "Bağlantı koptu" | `waitingUser` / room must be cleaned |
| Connection rejected | >5 connections per IP in 10s | `messageError` + immediate disconnect | none |
| Large image rejected | `maxHttpBufferSize` (1 MiB) smaller than 5 MiB image limit | image silently never arrives / connection closes | partial room state |

## Matchmaking

| Failure | Cause | Symptom | State left behind |
|---------|-------|---------|-------------------|
| Ghost match | partner disconnects before/after pairing | no partner message, hanging room | room with 1 socket until cleanup |
| Double join | `queueUser` + `findAgain` race | duplicate entries | possible self-match / stale queue |
| Duplicate cleanup | shared `roomTimer` on both sockets | double `finishRoom` invocation | benign if idempotent |

## Conversation

| Failure | Cause | Symptom | State left behind |
|---------|-------|---------|-------------------|
| Message after end | client sends after timer expiry | dropped | none |
| Message loses room | `roomId` cleared by cleanup | `sendMessage` ignored | none |

## Metrics

| Failure | Cause | Symptom |
|---------|-------|---------|
| matchSuccessRate always 0% | `matchesCompleted` never incremented | misleading "failed" stats |
| connection success rate wrong | `(conn - disconn)/conn` conflation | misleading |
| avg WS latency 0 | never measured | misleading |
| unbounded maps | no TTL cleanup (security maps) | memory growth |

## Cleanup invariants

- Cleanup must be **idempotent** (safe to run twice).
- Disconnect must clear `waitingUser` reference and partner's room state.
- No timers left live after room termination.