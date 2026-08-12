# SHTM — Glossary

| Term | Definition |
|------|------------|
| **SHTM** | "Say Hello To Me" — the anonymous 30/60s chat app. |
| **waitingUser** | Single-slot in-memory matchmaking queue holding one socket. |
| **Room** | Socket.IO room (`room_<uuid>`) joining exactly two matched sockets. |
| **Matched** | State where two sockets share a room and an active 60s timer. |
| **Skip** | User action to leave a room early and return to finding a new partner. |
| **findAgain** | Client event to re-enter the matchmaking queue. |
| **Ghost user/match/room** | State the server believes is active but whose socket is gone. |
| **Icebreaker** | Random question shown once per match (20 in `lang.js`). |
| **Rate limiter** | In-memory per-concern throttling in `security.js`. |
| **Magic bytes** | Signature bytes at the start of a file used to verify image MIME. |
| **Data URL** | `data:<mime>;base64,...` representation used for images. |
| **Serverless** | Vercel function model; ephemeral, recyclable process memory. |
| **Idempotent cleanup** | Cleanup that is safe to run multiple times. |