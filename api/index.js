const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { Server } = require("socket.io");
const sec = require("./security");
const anl = require("./analytics");
const log = require("./logger");

const app = express();

const httpServer = http.createServer(app);

/*
|--------------------------------------------------------------------------
| SOCKET.IO SERVER
|--------------------------------------------------------------------------
| WebSocket-only to avoid long-polling churn. Explicit heartbeat/timeout
| configuration so connection failures are deterministic and observable.
|
| maxHttpBufferSize matches the 5 MiB image limit (base64 expansion ≈ 6.7 MiB)
| so that a valid <=5 MiB image is not silently rejected by the 1 MiB default.
|--------------------------------------------------------------------------
*/

const io = new Server(httpServer, {
    cors: {
        origin: "*"
    },
    transports: ["websocket"],
    allowEIO3: true,
    // Heartbeat / timeout
    pingInterval: 25_000,
    pingTimeout: 20_000,
    // Handshake must complete within this window or the socket is dropped
    connectTimeout: 10_000,
    // Allow up to a valid 5 MiB image (base64 ~6.7 MiB) without overflow
    maxHttpBufferSize: 7 * 1024 * 1024
});

const CHAT_DURATION = sec.CHAT_DURATION;
const MESSAGE_COOLDOWN = sec.MESSAGE_COOLDOWN_MS;
const MAX_MESSAGE_LENGTH = sec.MAX_MESSAGE_LENGTH;

const STATE = log.SOCKET_STATE;

/*
|--------------------------------------------------------------------------
| MATCHMAKING STATE
|--------------------------------------------------------------------------
| Single-slot in-memory queue (documented limitation — see DEPLOYMENT.md).
|
| `waitingUser` holds exactly one socket awaiting a match, or null.
| `rooms` holds explicit match records keyed by room id. This is the
| authoritative per-match context object and the single source of truth for
| room teardown — not per-socket timer aliases.
|--------------------------------------------------------------------------
*/

let waitingUser = null;

/** roomId -> { matchId, roomId, userA, userB, startedAt, state, timer } */
const rooms = new Map();

/*
|--------------------------------------------------------------------------
| SECURITY HEADERS
|--------------------------------------------------------------------------
*/

app.use((req, res, next) => {
    res.setHeader(
        "Content-Security-Policy",
        [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "connect-src 'self' wss: ws:",
            "media-src 'none'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'"
        ].join("; ")
    );

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

    res.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=(), interest-cohort=()"
    );

    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("X-DNS-Prefetch-Control", "off");

    next();
});

/*
|--------------------------------------------------------------------------
| STATIC FRONTEND
|--------------------------------------------------------------------------
*/

const publicPath = path.join(__dirname, "..", "public");

app.use(express.static(publicPath));

app.get("/speed-insights.mjs", (req, res) => {
    res.type("text/javascript");

    res.sendFile(
        path.join(
            __dirname,
            "..",
            "node_modules",
            "@vercel",
            "speed-insights",
            "dist",
            "index.mjs"
        )
    );
});

app.get("/", (req, res) => {
    res.sendFile(path.join(publicPath, "index.html"));
});

app.get("/stats", (req, res) => {
    res.sendFile(path.join(publicPath, "stats.html"));
});

app.get("/api/stats", (req, res) => {
    res.json(anl.getStats());
});

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function isConnected(socket) {
    return (
        socket &&
        socket.connected &&
        io.sockets.sockets.has(socket.id)
    );
}

function send(socket, event, data = {}) {
    if (isConnected(socket)) {
        socket.emit(event, data);
    }
}

function getRoomUsers(roomId) {
    const room = io.sockets.adapter.rooms.get(roomId);

    if (!room) {
        return [];
    }

    return [...room]
        .map((id) => io.sockets.sockets.get(id))
        .filter(Boolean);
}

function getRoomRecord(roomId) {
    return rooms.get(roomId) || null;
}

/**
 * Find the other participant for a socket using the authoritative room record
 * (not the adapter, which races with disconnect cleanup).
 */
function getPartner(socket) {
    const record = getRoomRecord(socket.roomId);

    if (record) {
        return record.userA.id === socket.id ? record.userB : record.userA;
    }

    // Fallback for legacy/direct adapter lookup (should not normally hit)
    return (
        getRoomUsers(socket.roomId).find((user) => user.id !== socket.id) ||
        null
    );
}

function trackMatchWait(userA, userB) {
    const now = Date.now();
    if (userA._queuedAt) {
        anl.trackMatchWaitTime(now - userA._queuedAt);
    }
    if (userB._queuedAt) {
        anl.trackMatchWaitTime(now - userB._queuedAt);
    }
}

/**
 * Move a socket out of a room and clear all per-room ephemeral state.
 * Idempotent by design; safe to call more than once for the same room.
 */
function resetUserAfterRoom(user, roomId) {
    if (!user) {
        return;
    }

    if (user.roomId === roomId) {
        user.roomId = null;
    }

    user.roomTimer = null;
    user.matchStartedAt = null;
    user._queuedAt = null;
    user.typing = false;

    if (user.connected && user.connectionState === STATE.MATCHED) {
        user.connectionState = STATE.CONNECTED;
    }

    try {
        user.leave(roomId);
    } catch (_) {
        /* already left */
    }
}

/**
 * Stop the room timer stored on the authoritative room record.
 * Idempotent.
 */
function clearRecordTimer(record) {
    if (record && record.timer) {
        clearTimeout(record.timer);
        record.timer = null;
    }
}

/*
|--------------------------------------------------------------------------
| LATENCY MEASUREMENT
|--------------------------------------------------------------------------
| Lightweight server round-trip. Ping every 30s; the client echoes back
| `system:pong` with the original timestamp. Measured in analytics.
|--------------------------------------------------------------------------
*/

const PING_INTERVAL = 30_000;

function startPings(socket) {
    stopPings(socket);

    socket.pingTimer = setInterval(() => {
        if (!isConnected(socket)) {
            stopPings(socket);
            return;
        }

        socket.emit("system:ping", {
            t: Date.now()
        });
    }, PING_INTERVAL);

    if (socket.pingTimer.unref) {
        socket.pingTimer.unref();
    }
}

function stopPings(socket) {
    if (socket.pingTimer) {
        clearInterval(socket.pingTimer);
        socket.pingTimer = null;
    }
}

/*
|--------------------------------------------------------------------------
| MATCHMAKING
|--------------------------------------------------------------------------
*/

function queueUser(socket) {
    if (!isConnected(socket) || socket.roomId) {
        return;
    }

    // Guard: never allow a socket to be queued twice
    if (waitingUser === socket) {
        return;
    }

    const matchmakingCheck = sec.checkMatchmakingRate(socket.id);

    sec.incrementMetric("matchmakingAttempts");

    if (!matchmakingCheck.allowed) {
        sec.incrementMetric("rateLimitViolations");
        anl.trackRateLimitViolation();

        log.security("rate_limit", {
            event: "matchmaking_rate_limit",
            socketId: socket.id,
            sessionId: socket.sessionId
        });

        send(socket, "messageError", {
            message: matchmakingCheck.message
        });

        return;
    }

    if (waitingUser && !isConnected(waitingUser)) {
        waitingUser = null;
    }

    if (waitingUser && waitingUser.id !== socket.id) {
        const other = waitingUser;
        waitingUser = null;

        trackMatchWait(other, socket);

        createMatch(other, socket);

        return;
    }

    waitingUser = socket;
    socket._queuedAt = Date.now();
    socket.connectionState = STATE.WAITING;

    log.debug("queue_join", {
        socketId: socket.id,
        sessionId: socket.sessionId
    });

    send(socket, "searching", {
        message: "Bir yabancı aranıyor..."
    });
}

function createMatch(userA, userB) {
    anl.trackMatchStarted();
    anl.trackConversationStarted();

    const roomId = `room_${crypto.randomUUID()}`;

    const record = {
        matchId: roomId,
        roomId,
        userA,
        userB,
        startedAt: Date.now(),
        state: "active",
        timer: null
    };

    record.timer = setTimeout(() => {
        finishRoom(roomId, "timeout");
    }, CHAT_DURATION);

    if (record.timer.unref) {
        record.timer.unref();
    }

    rooms.set(roomId, record);

    userA.join(roomId);
    userB.join(roomId);

    userA.roomId = roomId;
    userB.roomId = roomId;

    userA.roomTimer = record.timer;
    userB.roomTimer = record.timer;

    userA.matchStartedAt = record.startedAt;
    userB.matchStartedAt = record.startedAt;

    userA._queuedAt = null;
    userB._queuedAt = null;

    userA.connectionState = STATE.MATCHED;
    userB.connectionState = STATE.MATCHED;

    const icebreakerIndex = Math.floor(Math.random() * 20);

    log.info("match_created", {
        matchId: roomId,
        socketA: userA.id,
        socketB: userB.id
    });

    io.to(roomId).emit("matched", {
        message: "Bir yabancıyla eşleştin.",
        startedAt: record.startedAt,
        duration: CHAT_DURATION,
        icebreaker: icebreakerIndex
    });
}

/**
 * End a room cleanly (timeout / endChat). Both participants conclude the
 * match. Emits `roomEnded` while they are still in the room, then resets.
 */
function finishRoom(roomId, reason = "manual") {
    const record = getRoomRecord(roomId);

    if (!record) {
        return;
    }

    clearRecordTimer(record);
    record.state = "ended";
    rooms.delete(roomId);

    const duration = record.startedAt
        ? Date.now() - record.startedAt
        : 0;

    anl.trackConversationEnded(duration);
    anl.trackMatchCompleted();

    let message = "Sohbet sona erdi.";

    if (reason === "timeout") {
        message = "60 saniye doldu.";
    }

    if (reason === "skip") {
        message = "Eşleşme atlandı.";
    }

    log.info("room_ended", {
        matchId: roomId,
        reason,
        durationMs: duration
    });

    io.to(roomId).emit("roomEnded", {
        message,
        reason
    });

    resetUserAfterRoom(record.userA, roomId);
    resetUserAfterRoom(record.userB, roomId);

    // Give participants a path to re-enter matchmaking after a clean end.
    send(record.userA, "readyForNewMatch");
    send(record.userB, "readyForNewMatch");
}

/*
|--------------------------------------------------------------------------
| SOCKET.IO
|--------------------------------------------------------------------------
*/

io.on("connection", (socket) => {
    // Every handshake that reaches this handler is a connection attempt,
    // whether or not the application-level IP rate limit accepts it.
    anl.trackConnectionAttempt();

    const connectionCheck = sec.checkConnectionRate(socket);

    sec.incrementMetric("connections");

    if (!connectionCheck.allowed) {
        sec.incrementMetric("rejectedConnections");
        sec.incrementMetric("rateLimitViolations");
        anl.trackConnectionRejected();
        anl.trackRateLimitViolation();

        const ip = sec.getClientIP(socket);

        log.security("connection_rejected", {
            socketId: socket.id,
            ip
        });

        socket.emit("messageError", {
            message: connectionCheck.message
        });

        socket.disconnect(true);

        return;
    }

    /*
    |----------------------------------------------------------------------
    | ACCEPTED CONNECTION → initialize lifecycle state
    |----------------------------------------------------------------------
    */

    socket.sessionId = crypto.randomUUID();
    socket.connectedAt = Date.now();
    socket.connectionState = STATE.CONNECTED;

    socket.roomId = null;
    socket.roomTimer = null;
    socket.matchStartedAt = null;
    socket._queuedAt = null;

    socket.lastMessageAt = 0;
    socket.lastTypingAt = 0;
    socket.typing = false;

    sec.incrementMetric("activeSessions");

    const country = anl.getCountryFromRequest(socket.request);
    const language = anl.getLanguageFromRequest(socket.request);

    anl.trackConnectionAccepted(country, language);

    log.info("connection", {
        socketId: socket.id,
        sessionId: socket.sessionId,
        country: country || undefined,
        language: language || undefined
    });

    /*
    |----------------------------------------------------------------------
    | LATENCY PING
    |----------------------------------------------------------------------
    */

    socket.on("system:pong", (data) => {
        const t = Number(data && data.t);

        if (!Number.isFinite(t) || t <= 0) {
            return;
        }

        const rtt = Math.max(0, Date.now() - t);

        anl.trackWSLatency(rtt);

        log.debug("latency", {
            socketId: socket.id,
            sessionId: socket.sessionId,
            rttMs: rtt
        });
    });

    startPings(socket);

    /*
    |----------------------------------------------------------------------
    | AUTO-QUEUE FOR MATCHMAKING
    |----------------------------------------------------------------------
    */

    queueUser(socket);

    /*
    |----------------------------------------------------------------------
    | IMAGE
    |----------------------------------------------------------------------
    */

    socket.on("sendImage", (data) => {
        if (!socket.roomId) {
            return;
        }

        const imageRateCheck = sec.checkImageUploadRate(socket.id);

        if (!imageRateCheck.allowed) {
            sec.incrementMetric("rateLimitViolations");
            anl.trackRateLimitViolation();

            send(socket, "messageError", {
                message: imageRateCheck.message
            });

            return;
        }

        if (!sec.checkPayloadSize(data)) {
            sec.incrementMetric("rejectedMessages");

            send(socket, "messageError", {
                message: "Görsel çok büyük."
            });

            return;
        }

        const validation = sec.validateImagePayload(data?.image);

        if (!validation.valid) {
            sec.incrementMetric("rejectedMessages");

            send(socket, "messageError", {
                message: validation.message
            });

            return;
        }

        const now = Date.now();

        if (now - socket.lastMessageAt < MESSAGE_COOLDOWN) {
            send(socket, "messageError", {
                message: "Biraz yavaş."
            });

            return;
        }

        socket.lastMessageAt = now;

        sec.incrementMetric("imageUploads");
        anl.trackImage();

        socket.typing = false;

        socket.to(socket.roomId).emit("typing", {
            active: false
        });

        socket.to(socket.roomId).emit("image", {
            image: data.image,
            timestamp: now
        });
    });

    /*
    |----------------------------------------------------------------------
    | MESSAGE
    |----------------------------------------------------------------------
    */

    socket.on("sendMessage", (data) => {
        if (!socket.roomId) {
            return;
        }

        if (!sec.checkPayloadSize(data, 64 * 1024)) {
            sec.incrementMetric("rejectedMessages");

            send(socket, "messageError", {
                message: "Mesaj çok büyük."
            });

            return;
        }

        const message = sec.sanitizeMessage(data?.message);

        if (!message) {
            send(socket, "messageError", {
                message: `Mesaj 1-${MAX_MESSAGE_LENGTH} karakter arasında olmalı.`
            });

            return;
        }

        const rateCheck = sec.checkMessageRate(socket.id);

        if (!rateCheck.allowed) {
            sec.incrementMetric("rateLimitViolations");
            anl.trackRateLimitViolation();

            send(socket, "messageError", {
                message: rateCheck.message
            });

            return;
        }

        sec.incrementMetric("messages");
        anl.trackMessage();

        socket.typing = false;

        socket.to(socket.roomId).emit("typing", {
            active: false
        });

        socket.to(socket.roomId).emit("message", {
            message,
            timestamp: Date.now()
        });
    });

    /*
    |----------------------------------------------------------------------
    | TYPING
    |----------------------------------------------------------------------
    */

    socket.on("typing", (active) => {
        if (!socket.roomId || typeof active !== "boolean") {
            return;
        }

        const now = Date.now();

        if (now - socket.lastTypingAt < 300) {
            return;
        }

        socket.lastTypingAt = now;
        socket.typing = active;

        socket.to(socket.roomId).emit("typing", {
            active
        });
    });

    /*
    |----------------------------------------------------------------------
    | SKIP
    |----------------------------------------------------------------------
    */

    socket.on("skip", () => {
        if (!socket.roomId) {
            return;
        }

        const roomId = socket.roomId;
        const record = getRoomRecord(roomId);

        let partner = null;

        if (record) {
            partner =
                record.userA.id === socket.id
                    ? record.userB
                    : record.userA;

            clearRecordTimer(record);
            record.state = "ended";
            rooms.delete(roomId);

            const duration = record.startedAt
                ? Date.now() - record.startedAt
                : 0;

            anl.trackConversationEnded(duration);
            anl.trackMatchCompleted();
        } else {
            partner = getPartner(socket);
        }

        resetUserAfterRoom(socket, roomId);

        send(socket, "skipped", {
            message: "Yabancıyı atladın."
        });

        if (partner) {
            resetUserAfterRoom(partner, roomId);

            send(partner, "partnerLeft", {
                message: "Karşı taraf sohbeti sonlandırdı."
            });

            send(partner, "readyForNewMatch");
        }

        send(socket, "readyForNewMatch");
    });

    /*
    |----------------------------------------------------------------------
    | END CHAT
    |----------------------------------------------------------------------
    */

    socket.on("endChat", () => {
        if (!socket.roomId) {
            return;
        }

        finishRoom(socket.roomId, "manual");
    });

    /*
    |----------------------------------------------------------------------
    | FIND AGAIN
    |----------------------------------------------------------------------
    */

    socket.on("findAgain", () => {
        if (socket.roomId) {
            return;
        }

        queueUser(socket);
    });

    /*
    |----------------------------------------------------------------------
    | REPORT
    |----------------------------------------------------------------------
    */

    socket.on("report", (data) => {
        const reason =
            typeof data?.reason === "string"
                ? data.reason.trim().slice(0, 300)
                : "";

        if (!reason) {
            send(socket, "reportError", {
                message: "Rapor nedeni gerekli."
            });

            return;
        }

        log.security("report", {
            reporterSocketId: socket.id,
            partnerSocketId: getPartner(socket)?.id || null,
            reasonLength: reason.length
        });

        send(socket, "reportSent", {
            message: "Rapor gönderildi."
        });
    });

    /*
    |----------------------------------------------------------------------
    | DISCONNECT
    |----------------------------------------------------------------------
    */

    socket.on("disconnect", (reason) => {
        stopPings(socket);

        const now = Date.now();
        const lifetimeMs = socket.connectedAt
            ? now - socket.connectedAt
            : undefined;

        const category = log.categorizeDisconnectReason(reason);

        socket.connectionState = STATE.DISCONNECTED;

        log.info("disconnect", {
            socketId: socket.id,
            sessionId: socket.sessionId,
            reason: String(reason || ""),
            category,
            lifetimeMs: Number.isFinite(lifetimeMs) ? lifetimeMs : undefined
        });

        sec.decrementConnection(sec.getClientIP(socket));
        sec.decrementMetric("activeSessions");

        anl.trackDisconnect(category);

        if (Number.isFinite(lifetimeMs)) {
            anl.trackSocketLifetime(lifetimeMs);
        }

        if (waitingUser === socket) {
            waitingUser = null;

            log.debug("queue_leave", {
                socketId: socket.id,
                sessionId: socket.sessionId,
                reason: "disconnect"
            });
        }

        if (socket.roomId) {
            const roomId = socket.roomId;
            const record = getRoomRecord(roomId);

            let partner = null;

            if (record) {
                partner =
                    record.userA.id === socket.id
                        ? record.userB
                        : record.userA;

                clearRecordTimer(record);
                record.state = "ended";
                rooms.delete(roomId);

                // Match ended due to a disconnect, not a clean conclusion.
                anl.trackMatchAborted();
            } else {
                partner = getPartner(socket);
            }

            resetUserAfterRoom(socket, roomId);

            if (partner) {
                resetUserAfterRoom(partner, roomId);

                send(partner, "partnerLeft", {
                    message: "Yabancı bağlantıyı kapattı."
                });

                send(partner, "readyForNewMatch");
            }
        }
    });
});

/*
|--------------------------------------------------------------------------
| ACTIVE COUNT GETTERS (injected into analytics once)
|--------------------------------------------------------------------------
*/

anl.setActiveCountGetters(
    () => io.sockets.sockets.size,
    () => {
        let matchRooms = 0;
        const adapterRooms = io.sockets.adapter.rooms;

        for (const [name, members] of adapterRooms) {
            if (name.startsWith("room_") && members.size === 2) {
                matchRooms += 1;
            }
        }

        return matchRooms;
    },
    () => (waitingUser && isConnected(waitingUser) ? 1 : 0)
);

/*
|--------------------------------------------------------------------------
| LOCAL DEVELOPMENT
|--------------------------------------------------------------------------
*/

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    httpServer.listen(PORT, () => {
        log.info("server_started", {
            port: Number(PORT)
        });
    });
}

module.exports = httpServer;