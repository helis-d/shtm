/*
|==============================================================================
| SHTM — STRUCTURED LOGGER
|==============================================================================
|
| Centralized, JSON-structured logging with correlation IDs and safe metadata.
|
| Every important lifecycle event should go through this module instead of
| raw console.log("something happened").
|
| Usage:
|   const log = require("./logger");
|   log.info("connection", { socketId, ip });
|   log.error("validation_error", { category: "VALIDATION_ERROR" });
|
| DEBUG MODE:
|   SHTM_DEBUG=1  → enables debug() output and lifecycle tracing.
|   In production (NODE_ENV=production), debug() is silent unless SHTM_DEBUG=1.
|
| PRIVACY:
|   Never pass secrets, tokens, message bodies, or personal data into metadata.
|==============================================================================
*/

const DEBUG =
    process.env.SHTM_DEBUG === "1" ||
    (process.env.NODE_ENV !== "production" && !process.env.SHTM_DEBUG);

/*
|--------------------------------------------------------------------------
| ERROR TAXONOMY
|--------------------------------------------------------------------------
| Normalized internal error categories. Avoid random string errors.
|--------------------------------------------------------------------------
*/

const ERROR_CATEGORY = {
    CONNECTION_ERROR: "CONNECTION_ERROR",
    AUTH_ERROR: "AUTH_ERROR",
    VALIDATION_ERROR: "VALIDATION_ERROR",
    RATE_LIMIT_ERROR: "RATE_LIMIT_ERROR",
    MATCHMAKING_ERROR: "MATCHMAKING_ERROR",
    SESSION_ERROR: "SESSION_ERROR",
    ROOM_ERROR: "ROOM_ERROR",
    CONVERSATION_ERROR: "CONVERSATION_ERROR",
    INTERNAL_ERROR: "INTERNAL_ERROR",
    NETWORK_ERROR: "NETWORK_ERROR",
    TIMEOUT_ERROR: "TIMEOUT_ERROR"
};

/*
|--------------------------------------------------------------------------
| DISCONNECT REASON TAXONOMY
|--------------------------------------------------------------------------
| Normalized categories for disconnect forensics. See SOCKETS.md.
|--------------------------------------------------------------------------
*/

const DISCONNECT_REASON = {
    CLIENT_DISCONNECT: "client_disconnect",
    TRANSPORT_CLOSE: "transport_close",
    TRANSPORT_ERROR: "transport_error",
    TIMEOUT: "timeout",
    SERVER_SHUTDOWN: "server_shutdown",
    NETWORK_ERROR: "network_error",
    AUTHENTICATION_FAILURE: "authentication_failure",
    DUPLICATE_CONNECTION: "duplicate_connection",
    STALE_SOCKET: "stale_socket",
    UNKNOWN: "unknown"
};

function categorizeDisconnectReason(rawReason, serverDisconnectReason) {
    const reason =
        (serverDisconnectReason ? "server:" : "") +
        String(rawReason || "").toLowerCase();

    if (serverDisconnectReason) {
        if (/duplicate/i.test(serverDisconnectReason)) {
            return DISCONNECT_REASON.DUPLICATE_CONNECTION;
        }
        if (/stale/i.test(serverDisconnectReason)) {
            return DISCONNECT_REASON.STALE_SOCKET;
        }
    }

    if (/client namespace disconnect/.test(reason)) {
        return DISCONNECT_REASON.CLIENT_DISCONNECT;
    }
    if (/ping timeout/.test(reason)) {
        return DISCONNECT_REASON.TIMEOUT;
    }
    if (/transport close/.test(reason)) {
        return DISCONNECT_REASON.TRANSPORT_CLOSE;
    }
    if (/transport error/.test(reason)) {
        return DISCONNECT_REASON.TRANSPORT_ERROR;
    }
    if (
        /server shutting down/.test(reason) ||
        /forced (server )?close/.test(reason)
    ) {
        return DISCONNECT_REASON.SERVER_SHUTDOWN;
    }

    return DISCONNECT_REASON.UNKNOWN;
}

/*
|--------------------------------------------------------------------------
| LIFECYCLE STATES
|--------------------------------------------------------------------------
| Server-side per-socket lifecycle states (see SOCKETS.md).
|--------------------------------------------------------------------------
*/

const SOCKET_STATE = {
    CONNECTED: "connected",
    WAITING: "waiting",
    MATCHED: "matched",
    DISCONNECTED: "disconnected"
};

/*
|--------------------------------------------------------------------------
| LOGGING
|--------------------------------------------------------------------------
*/

function isPrimitive(value) {
    return (
        value === null ||
        (typeof value !== "object" && typeof value !== "function")
    );
}

/**
 * Strip out unsafe/unserializable values. Prevents circular refs and functions
 * from breaking JSON.stringify. Always returns a plain object.
 *
 * Only primitive values (string, number, boolean, null) are copied. Objects,
 * arrays, and functions are dropped to avoid accidentally serializing request
 * objects / socket internals / secrets.
 */
function sanitizeMeta(meta) {
    if (!meta || typeof meta !== "object") {
        return {};
    }

    const out = {};

    for (const [key, value] of Object.entries(meta)) {
        if (value === undefined) {
            continue;
        }

        if (isPrimitive(value)) {
            out[key] = value;
        }
    }

    return out;
}

function write(level, event, meta) {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        event,
        ...sanitizeMeta(meta)
    };

    const line = JSON.stringify(entry);

    if (level === "error" || level === "security") {
        console.error(line);
    } else if (level === "warn") {
        console.warn(line);
    } else {
        console.log(line);
    }
}

const logger = {
    debug: (event, meta = {}) => {
        if (DEBUG) write("debug", event, meta);
    },
    info: (event, meta = {}) => write("info", event, meta),
    warn: (event, meta = {}) => write("warn", event, meta),
    error: (event, meta = {}) => write("error", event, meta),
    security: (event, meta = {}) => write("security", event, meta),
    isDebug: () => DEBUG
};

module.exports = {
    ...logger,
    ERROR_CATEGORY,
    DISCONNECT_REASON,
    SOCKET_STATE,
    categorizeDisconnectReason
};