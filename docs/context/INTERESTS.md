# SHTM — Interests

## Data model

Stable IDs (not display strings). 15 interests:

`gaming, music, movies, technology, sports, travel, anime, art, science,
fashion, books, food, memes, coding, photography`.

## Selection rules

- min 0 (skip allowed), preferred 3, max 5.
- Server-side `normalizeInterests` rejects unknown ids, duplicates, non-array
  payloads, and >5 selections.
- Interests are stored per-socket only; no persistence.

## Interest-aware matching

Interests are a **ranking signal**, never a hard filter:

- shared interest → higher priority
- some overlap → medium priority
- no overlap → still eligible

Language is a soft tie-breaker. Queue age prevents starvation. Users with zero
interests can still match immediately.

## Compatibility score

`compatibilityScore` (0–100): base 50 + 8 per shared interest (max 5) + 10 for
language match. Informational only — logged, not used to reject candidates.

## Intro + shared discovery

`match:intro` sends the partner's coarse, anonymous profile (country, language,
interests). Shared interests are surfaced (top 1–3) via
`match:shared-interests`.