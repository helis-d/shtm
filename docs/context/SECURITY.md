# SHTM — Security Model

## Trust boundary

Everything from the network is untrusted. All Socket.IO events and the HTTP
stats route are treated as attacker-controlled.

## Rate limiting (per-concern, in-memory)

| Concern | Limit | Window / cooldown |
|---------|-------|-------------------|
| Connections (IP) | max 5 | 10s window |
| Matchmaking attempts (socket) | 1 | 3s cooldown |
| Messages (socket) | burst 5 | 4s window, 2s cooldown |
| Image uploads (socket) | 1 | 10s cooldown |
| Typing (socket) | 1 emit | 300ms throttle |

## Validation

- **Text messages**: `sanitizeMessage` strips NUL bytes, trims, enforces
  1–500 chars.
- **Images**: `validateImagePayload` checks declared MIME against an allowlist,
  extracts base64, enforces 5 MiB, and verifies magic bytes
  (`detectMimeFromBase64` supports PNG/JPEG/GIF/WebP/BMP/TIFF/SVG).
- **Payload size**: `checkPayloadSize` size-guards messages/images before
  processing (anti-flood).

## Headers (HTTP)

- CSP (self + inline + data/blob images; wss:/ws: for connect).
- `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
  `Permissions-Policy` (camera/mic/geo off), `X-Frame-Options: SAMEORIGIN`,
  `X-DNS-Prefetch-Control: off`.

## Privacy

- No PII is stored. Analytics is aggregate-only.
- Small counts (<3) are suppressed in the stats response/UI.

## Known limitations / future work

- Rate-limit state is per-instance memory; not shared across Vercel instances.
- No server-side authentication (intentionally anonymous).
- Report content is only logged to console, not persisted to a store.
- `origin: "*"` CORS is acceptable for an anonymous app but reduces
  cross-origin abuse protection.