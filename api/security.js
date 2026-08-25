/*
|==============================================================================
| SHTM SECURITY MODULE
|==============================================================================
|
| Centralized application-layer security:
|
|   - Connection rate limiting (IP-based)
|   - Matchmaking abuse protection (cooldown per socket)
|   - Message burst protection (windowed rate limiter)
|   - Image upload rate limiting (per socket)
|   - Image MIME type validation (magic bytes from base64)
|   - Payload size limits
|
| DESIGN:
|   Current: In-memory Map/Set (works on single Vercel instance)
|   Migration path: Swap storage to Upstash Redis when scaling to multiple
|   instances. The interface is intentionally simple (get/set/incr/ttl) so
|   the swap is a find-replace, not a rewrite.
|
|   Environment variables (for future Redis):
|     REDIS_URL  — Redis connection string
|     REDIS_TOKEN — Redis auth token
|
|==============================================================================
*/

const crypto = require("crypto");
const log = require("./logger");

/* ---------------------------------------------------------------------------
   CONFIGURATION
   ---------------------------------------------------------------------------*/

const MAX_CONNECTIONS_PER_IP = 5;
const CONNECTION_WINDOW_MS = 10_000;

const MATCHMAKING_COOLDOWN_MS = 3_000;

const MESSAGE_BURST_MAX = 5;
const MESSAGE_BURST_WINDOW_MS = 4_000;
const MESSAGE_COOLDOWN_MS = 2_000;

const IMAGE_UPLOAD_COOLDOWN_MS = 10_000;

const ICEBREAKER_CHANGE_COOLDOWN_MS = 4_000;
const FEEDBACK_COOLDOWN_MS = 5_000;
const SHARE_COOLDOWN_MS = 5_000;

const MAX_MESSAGE_LENGTH = 500;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

const ALLOWED_IMAGE_MIME = new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/tiff",
    "image/svg+xml"
]);

// Aggressive image formats NOT allowed (raw/heavy, could be used for abuse):
// image/x-icon, image/vnd.*, image/avif (currently optional)

/* ---------------------------------------------------------------------------
   IN-MEMORY STORES
   (Future: Replace with Redis get/set/incr/expire/ttl)
   ---------------------------------------------------------------------------*/

const ipConnectionMap = new Map();
const matchmakingCooldowns = new Map();
const messageTracker = new Map();
const imageCooldowns = new Map();

const icebreakerCooldowns = new Map();
const feedbackCooldowns = new Map();
const shareCooldowns = new Map();

/* Periodic cleanup — prevent memory leak from stale entries */

const CLEANUP_INTERVAL = 60_000;

setInterval(() => {
    const now = Date.now();

    for (const [key, record] of ipConnectionMap) {
        if (now - record.startedAt > CONNECTION_WINDOW_MS * 2) {
            ipConnectionMap.delete(key);
        }
    }

    for (const [key, cooldownUntil] of matchmakingCooldowns) {
        if (now > cooldownUntil) {
            matchmakingCooldowns.delete(key);
        }
    }

    for (const [key, bursts] of messageTracker) {
        if (now - bursts.windowStart > MESSAGE_BURST_WINDOW_MS * 2) {
            messageTracker.delete(key);
        }
    }

    for (const [key, cooldownUntil] of imageCooldowns) {
        if (now > cooldownUntil) {
            imageCooldowns.delete(key);
        }
    }

    for (const [key, cooldownUntil] of icebreakerCooldowns) {
        if (now > cooldownUntil) {
            icebreakerCooldowns.delete(key);
        }
    }

    for (const [key, cooldownUntil] of feedbackCooldowns) {
        if (now > cooldownUntil) {
            feedbackCooldowns.delete(key);
        }
    }

    for (const [key, cooldownUntil] of shareCooldowns) {
        if (now > cooldownUntil) {
            shareCooldowns.delete(key);
        }
    }
}, CLEANUP_INTERVAL).unref();

/* ---------------------------------------------------------------------------
   IP EXTRACTION
   ---------------------------------------------------------------------------*/

function getClientIP(socket) {
    const headers =
        socket.request?.headers || socket.handshake?.headers || {};

    return (
        headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        headers["x-real-ip"] ||
        socket.handshake?.address ||
        "unknown"
    );
}

/* ---------------------------------------------------------------------------
   1. CONNECTION RATE LIMITING
   ---------------------------------------------------------------------------*/

function checkConnectionRate(socket) {
    const ip = getClientIP(socket);

    if (ip === "unknown") {
        return { allowed: true };
    }

    const now = Date.now();
    let record = ipConnectionMap.get(ip);

    if (
        !record ||
        now - record.startedAt > CONNECTION_WINDOW_MS
    ) {
        record = {
            count: 1,
            startedAt: now
        };

        ipConnectionMap.set(ip, record);

        return { allowed: true };
    }

    record.count += 1;

    if (record.count > MAX_CONNECTIONS_PER_IP) {
        return {
            allowed: false,
            message:
                "Çok fazla bağlantı. Lütfen biraz bekle."
        };
    }

    return { allowed: true };
}

function decrementConnection(ip) {
    const record = ipConnectionMap.get(ip);

    if (record && record.count > 0) {
        record.count -= 1;
    }
}

/* ---------------------------------------------------------------------------
   2. MATCHMAKING ABUSE PROTECTION
   ---------------------------------------------------------------------------*/

function checkMatchmakingRate(socketId) {
    const now = Date.now();
    const cooldownUntil =
        matchmakingCooldowns.get(socketId);

    if (cooldownUntil && now < cooldownUntil) {
        const waitSeconds =
            Math.ceil((cooldownUntil - now) / 1000);

        return {
            allowed: false,
            message:
                `Lütfen ${waitSeconds} saniye bekle.`
        };
    }

    matchmakingCooldowns.set(
        socketId,
        now + MATCHMAKING_COOLDOWN_MS
    );

    return { allowed: true };
}

/* ---------------------------------------------------------------------------
   3. MESSAGE BURST PROTECTION
   ---------------------------------------------------------------------------*/

function checkMessageRate(socketId) {
    const now = Date.now();
    let tracker = messageTracker.get(socketId);

    if (
        !tracker ||
        now - tracker.windowStart > MESSAGE_BURST_WINDOW_MS
    ) {
        tracker = {
            windowStart: now,
            count: 1,
            lastMessageAt: now
        };

        messageTracker.set(socketId, tracker);

        return { allowed: true };
    }

    if (
        now - tracker.lastMessageAt <
        MESSAGE_COOLDOWN_MS
    ) {
        return {
            allowed: false,
            message: "Biraz yavaş."
        };
    }

    tracker.count += 1;
    tracker.lastMessageAt = now;

    if (tracker.count > MESSAGE_BURST_MAX) {
        return {
            allowed: false,
            message:
                "Çok hızlı mesaj gönderiyorsun. Biraz bekle."
        };
    }

    return { allowed: true };
}

/* ---------------------------------------------------------------------------
   4. IMAGE UPLOAD RATE LIMITING
   ---------------------------------------------------------------------------*/

function checkImageUploadRate(socketId) {
    const now = Date.now();
    const cooldownUntil =
        imageCooldowns.get(socketId);

    if (cooldownUntil && now < cooldownUntil) {
        const waitSeconds =
            Math.ceil((cooldownUntil - now) / 1000);

        return {
            allowed: false,
            message:
                `Görsel göndermek için ${waitSeconds} saniye bekle.`
        };
    }

    imageCooldowns.set(
        socketId,
        now + IMAGE_UPLOAD_COOLDOWN_MS
    );

    return { allowed: true };
}

/* ---------------------------------------------------------------------------
   4b. FEATURE-EVENT RATE LIMITERS (icebreaker / feedback / share)
   ---------------------------------------------------------------------------*/

function cooldownCheck(map, key, now, limitMs, message) {
    const until = map.get(key);

    if (until && now < until) {
        const waitSeconds = Math.ceil((until - now) / 1000);
        return { allowed: false, message: message || `Lütfen ${waitSeconds} saniye bekle.` };
    }

    map.set(key, now + limitMs);
    return { allowed: true };
}

function checkIcebreakerRate(socketId) {
    return cooldownCheck(
        icebreakerCooldowns,
        socketId,
        Date.now(),
        ICEBREAKER_CHANGE_COOLDOWN_MS
    );
}

function checkFeedbackRate(socketId) {
    return cooldownCheck(
        feedbackCooldowns,
        socketId,
        Date.now(),
        FEEDBACK_COOLDOWN_MS
    );
}

function checkShareRate(socketId) {
    return cooldownCheck(
        shareCooldowns,
        socketId,
        Date.now(),
        SHARE_COOLDOWN_MS
    );
}

/* ---------------------------------------------------------------------------
   5. IMAGE MIME TYPE VALIDATION (magic bytes from base64)
   ---------------------------------------------------------------------------*/

/**
 * Detect MIME type from base64 data by checking magic bytes.
 * Only validates the first few bytes — lightweight, not a full parser.
 */
function detectMimeFromBase64(base64) {
    const buffer = Buffer.from(base64, "base64");

    if (buffer.length < 4) {
        return null;
    }

    // PNG: 89 50 4E 47
    if (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4E &&
        buffer[3] === 0x47
    ) {
        return "image/png";
    }

    // JPEG: FF D8 FF
    if (
        buffer[0] === 0xFF &&
        buffer[1] === 0xD8 &&
        buffer[2] === 0xFF
    ) {
        return "image/jpeg";
    }

    // GIF: 47 49 46 38
    if (
        buffer[0] === 0x47 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x38
    ) {
        return "image/gif";
    }

    // WebP: 52 49 46 46 ... 57 45 42 50
    if (
        buffer[0] === 0x52 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x46 &&
        buffer.length >= 12 &&
        buffer[8] === 0x57 &&
        buffer[9] === 0x45 &&
        buffer[10] === 0x42 &&
        buffer[11] === 0x50
    ) {
        return "image/webp";
    }

    // BMP: 42 4D
    if (
        buffer[0] === 0x42 &&
        buffer[1] === 0x4D
    ) {
        return "image/bmp";
    }

    // TIFF: 49 49 2A 00 (little-endian) or 4D 4D 00 2A (big-endian)
    if (
        (buffer[0] === 0x49 &&
         buffer[1] === 0x49 &&
         buffer[2] === 0x2A &&
         buffer[3] === 0x00) ||
        (buffer[0] === 0x4D &&
         buffer[1] === 0x4D &&
         buffer[2] === 0x00 &&
         buffer[3] === 0x2A)
    ) {
        return "image/tiff";
    }

    // SVG: starts with <svg or <?xml (text-based, checked as string)
    const head = buffer.toString("utf8", 0, 200).trim();

    if (
        /^\s*<svg\b/i.test(head) ||
        /^\s*<\?xml\b/i.test(head)
    ) {
        return "image/svg+xml";
    }

    return null;
}

function validateImagePayload(imageDataUrl) {
    if (typeof imageDataUrl !== "string") {
        return { valid: false, message: "Geçersiz görsel verisi." };
    }

    const trimmed = imageDataUrl.trim();

    if (!trimmed.startsWith("data:")) {
        return { valid: false, message: "Geçersiz görsel formatı." };
    }

    // Extract declared MIME type from data URL
    const mimeMatch = trimmed.match(
        /^data:([^;]+)/
    );

    const declaredMime =
        mimeMatch ? mimeMatch[1].toLowerCase() : null;

    if (
        !declaredMime ||
        !ALLOWED_IMAGE_MIME.has(declaredMime)
    ) {
        return {
            valid: false,
            message: "Desteklenmeyen görsel formatı."
        };
    }

    // Extract base64 portion
    if (!trimmed.includes("base64,")) {
        return { valid: false, message: "Geçersiz görsel verisi." };
    }

    const base64 = trimmed.split("base64,")[1];

    if (!base64 || base64.length === 0) {
        return { valid: false, message: "Geçersiz görsel verisi." };
    }

    // Check size
    const byteLength = Buffer.byteLength(base64, "base64");

    if (byteLength > MAX_IMAGE_SIZE) {
        return {
            valid: false,
            message: "Görsel 5 MB veya daha küçük olmalı."
        };
    }

    if (byteLength === 0) {
        return { valid: false, message: "Boş görsel gönderilemez." };
    }

    // Validate actual MIME type via magic bytes
    const detectedMime = detectMimeFromBase64(base64);

    if (!detectedMime) {
        return {
            valid: false,
            message: "Geçersiz görsel içeriği."
        };
    }

    if (!ALLOWED_IMAGE_MIME.has(detectedMime)) {
        return {
            valid: false,
            message: "Desteklenmeyen görsel formatı."
        };
    }

    // The declared type is untrusted; reject mismatches rather than forwarding
    // content that browsers may interpret differently.
    if (detectedMime !== declaredMime) {
        log.security("image_mime_mismatch", {
            declaredMime,
            detectedMime
        });
        return { valid: false, message: "Görsel içeriği doğrulanamadı." };
    }

    return { valid: true };
}

/* ---------------------------------------------------------------------------
   6. MESSAGE PAYLOAD VALIDATION
   ---------------------------------------------------------------------------*/

function sanitizeMessage(value) {
    if (typeof value !== "string") {
        return null;
    }

    const message = value
        .replace(/\u0000/g, "")
        .trim();

    if (!message || message.length > MAX_MESSAGE_LENGTH) {
        return null;
    }

    return message;
}

/* ---------------------------------------------------------------------------
   7. PAYLOAD SIZE GUARD (for Socket.IO event anti-flood)
   ---------------------------------------------------------------------------*/

function checkPayloadSize(data, maxBytes = 6 * 1024 * 1024) {
    try {
        const json = JSON.stringify(data || {});
        return Buffer.byteLength(json, "utf8") <= maxBytes;
    } catch {
        return false;
    }
}

/* ---------------------------------------------------------------------------
   8. MONITORING / METRICS (console-based for current MVP)
   ---------------------------------------------------------------------------*/

const metrics = {
    connections: 0,
    matchmakingAttempts: 0,
    messages: 0,
    imageUploads: 0,
    rateLimitViolations: 0,
    rejectedConnections: 0,
    rejectedMessages: 0,
    activeSessions: 0
};

function incrementMetric(key) {
    if (key in metrics) {
        metrics[key] += 1;
    }
}

function decrementMetric(key) {
    if (key in metrics && metrics[key] > 0) {
        metrics[key] -= 1;
    }
}

function getMetrics() {
    return {
        ...metrics,
        timestamp: new Date().toISOString()
    };
}

/* Periodic metrics dump — observable in structured Vercel logs */

setInterval(() => {
    log.info("security_metrics", getMetrics());
}, 60_000).unref();

/* ---------------------------------------------------------------------------
   EXPORT
   ---------------------------------------------------------------------------*/

module.exports = {
    // Config constants
    CHAT_DURATION: 60_000,
    MESSAGE_COOLDOWN_MS,
    MAX_MESSAGE_LENGTH,
    MAX_IMAGE_SIZE,

    // IP helpers
    getClientIP,
    decrementConnection,

    // Rate limiters
    checkConnectionRate,
    checkMatchmakingRate,
    checkMessageRate,
    checkImageUploadRate,
    checkIcebreakerRate,
    checkFeedbackRate,
    checkShareRate,

    // Validation
    validateImagePayload,
    sanitizeMessage,
    checkPayloadSize,

    // Metrics
    incrementMetric,
    decrementMetric,
    getMetrics
};
