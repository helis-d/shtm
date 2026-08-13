# SHTM — UX Flows

## Expanded loop

DISCOVER → CONNECT → PERSONALIZE → MATCH → BREAK THE ICE → TALK → RATE →
NEXT MATCH → RETURN → INVITE → REPEAT.

## Interest picker

- Optional (min 0, preferred 3, max 5, skippable).
- Chips rendered from `/api/features`.
- Stored server-side only; client input is validated.

## Match intro card

- Coarse anonymous profile: country flag + code, language, interests.
- Shared interests highlighted (top 1–3).
- Never exposes name/email/ip/location.

## Icebreakers

- Priority: shared interest → selected interest → universal.
- Safe prompts only (no political/medical/financial/sexual/identity).
- Rotation with server-side throttle (4s).

## Conversation

- Elapsed countdown retained (communicates remaining minutes, not elapsed).
- Milestones at 30s/2m/5m/10m for analytics + optional subtle UX.

## End flow

- Feedback (Good / Okay / Not great) after termination only.
- Positive feedback may show an optional share prompt (never forced).
- "Next match" returns to matchmaking with clean state and session counter.

## Presence

- "people online" uses real eligible-concurrency only; never fabricated.