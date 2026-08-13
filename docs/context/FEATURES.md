# SHTM — Feature Architecture

## Product expansion (Feature Wave v1)

The core loop has grown from LAND → CONNECT → MATCH → TALK → LEAVE to a
conversation-first product flow. All features are **additive** and respect
feature flags.

## Feature flags (environment)

| Flag | Default | Effect |
|------|---------|--------|
| `SHTM_INTERESTS_ENABLED` | on | Interest picker + interest-aware ranking |
| `SHTM_ICEBREAKERS_ENABLED` | on | Icebreaker selection + rotation |
| `SHTM_NEXT_MATCH_ENABLED` | on | `queue:next` flow |
| `SHTM_ONLINE_COUNT_ENABLED` | on | Presence ("people online") |

Disabling a flag reverts to the legacy safe path — matching, conversations,
analytics, and stats keep working.

## Feature module

`lib/features.js` holds the data model (interests, icebreakers, feedback,
milestones), feature flags, validation, and match helpers. It is outside
`api/` to avoid Vercel filesystem-routing collisions (see `DEPLOYMENT.md`).

## Feature endpoints

- `GET /api/features` → `{ interests, flags }` (machine-readable catalog).

## Additive product events (growth)

Tracked in `lib/growth.js` under `PRODUCT_STAGES` (independent of the core
15-stage funnel): `interest_selected`, `interest_skipped`,
`match_card_viewed`, `shared_interest_shown`, `icebreaker_shown`,
`icebreaker_changed`, `conversation_milestone`, `conversation_feedback`,
`next_match_clicked`, `share_prompt_shown`, `share_clicked`,
`session_conversation_completed`, `return_session`.