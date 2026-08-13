# SHTM — Retention

## Return behavior (existing)

`lib/growth.js` uses a random, non-identifying `localStorage` visitor id
(`?vid=`) to classify, in-memory only:

- first sessions
- second sessions
- returning sessions
- return within 24 hours
- return within 7 days
- reconnect connections

## Additions (Feature Wave v1)

- `return_session` product event on a returning visitor.
- `session:summary` exposes `conversations` count per session (no IDs).
- Session depth is tracked via `conversationCount` per socket for the
  dashboard's session-depth cohorts (1 / 2 / 3+ conversations).

## Return UX

A returning visitor sees a light continuation ("Ready to meet someone new?"),
without implying prior conversations are remembered. The accountless
architecture does not persist matches or message history.

## Privacy

No accounts, no persistent server-side identity, no raw IPs/user-agents in
analytics. Visitor identity is a random token and never exposed in stats.