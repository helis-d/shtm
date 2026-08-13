# SHTM — Traffic Context

## What is tracked

Attribution only — no personal data, no raw IPs, no invasive fingerprinting.

| Dimension | Source | Fields |
|-----------|--------|--------|
| Referrer | `document.referrer` (client `?ref=`) or `Referer` header | `referrer` |
| Referrer domain | normalized hostname | `referrer` (e.g. `reddit.com`, `direct`) |
| UTM source | `?utm_source=` | `utmSource` |
| UTM medium | `?utm_medium=` | `utmMedium` |
| UTM campaign | `?utm_campaign=` | `utmCampaign` |
| Landing page | `?landing=` or pathname | `landing` |
| Country | Vercel `x-vercel-ip-country` / `cf-ipcountry` | `country` (ISO code) |
| Language | `Accept-Language` | `language` |
| Device category | coarse UA parse | `device` (`mobile`/`tablet`/`desktop`/`other`) |
| Browser category | coarse UA parse | `browser` (`chrome`/`safari`/…/`bot`/`other`) |
| Session start | server timestamp | via stage timestamps |

Only aggregate counts and distributions are exposed. Search parameters are
length-capped (UTM 64 chars, landing 128 chars). Raw user-agent strings are
never stored.

## Referrer forensics

The system can answer: *"Why are Australians discovering SHTM?"*

Structure (`trafficSources.forensics`):

```
Country → Referrer → { sessions, connections, queueJoins, matches, conversations }
```

Example (illustrative only — **do not invent values**):

```json
{ "country": "AU", "referrer": "reddit.com",
  "sessions": 0, "connections": 0, "queueJoins": 0,
  "matches": 0, "conversations": 0 }
```

## Traffic sources view

`trafficSources.referrers` is a flat list by referrer domain:

```
{ domain, landingViews, connections, sessions, queueJoins, matches, conversations }
```

`trafficSources.utm` lists campaign tuples:

```
{ source, medium, campaign, landingViews, connections, sessions,
  queueJoins, matches, conversations }
```

## Distinguishing real users from artifacts

Three distinct numbers are measured separately:

1. **connection count** — every accepted handshake.
2. **unique session count** — distinct `vid` tokens seen.
3. **reconnect count** — connections where the same `vid` returned.

Bots/crawlers/monitoring agents are categorized coarsely as `browser: "bot"`
for forensics only; they are not excluded from counts automatically.

## Privacy guarantees

- No raw IP addresses in analytics.
- No raw user-agent in analytics.
- No persistent server-side storage.
- Visitor id is a random, non-identifying token.
- Small-count privacy (`<3`) remains in the dashboard UI.

See `GROWTH.md` and `NETWORK_DENSITY.md`.