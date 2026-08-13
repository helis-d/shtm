const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { Server } = require("socket.io");
const sec = require("./security");
const anl = require("./analytics");
const growth = require("../lib/growth");
const feat = require("../lib/features");
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
    growth.trackLandingView(growth.ctxFromRequest(req));
    res.sendFile(path.join(publicPath, "index.html"));
});

app.get("/stats", (req, res) => {
    res.sendFile(path.join(publicPath, "stats.html"));
});

/*
 |--------------------------------------------------------------------------
 | STATS ENDPOINTS (safe response contract)
 |--------------------------------------------------------------------------
 | These endpoints must never crash on empty state and must always return
 | JSON. Unexpected internal errors map to HTTP 500 with a sanitized body.
 |--------------------------------------------------------------------------
 */

function sendStats(req, res, getPayload, endpoint) {
    try {
        res.json(getPayload());
    } catch (err) {
        log.error("stats_endpoint_error", {
            requestId: req.headers["x-request-id"] || undefined,
            endpoint: endpoint || req.path,
            category: err && err.name ? String(err.name) : "Error",
            message: err && err.message ? String(err.message) : "unknown"
        });

        res.status(500).json({
            error: "internal_error",
            message: "Statistics are temporarily unavailable."
        });
    }
}

app.get("/api/stats", (req, res) => {
    sendStats(req, res, () => anl.getStats(), "/api/stats");
});

app.get("/api/growth", (req, res) => {
    sendStats(req, res, () => growth.getStats(), "/api/growth");
});

app.get("/api/features", (req, res) => {
    res.json({
        interests: feat.INTEREST_LIST,
        flags: feat.FLAGS
    });
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
        const ms = now - userA._queuedAt;
        anl.trackMatchWaitTime(ms);
        if (userA.growthCtx && userA.growthCtx.country) {
            growth.trackMatchWaitTime(userA.growthCtx.country, ms);
        }
    }
    if (userB._queuedAt) {
        const ms = now - userB._queuedAt;
        anl.trackMatchWaitTime(ms);
        if (userB.growthCtx && userB.growthCtx.country) {
            growth.trackMatchWaitTime(userB.growthCtx.country, ms);
        }
    }
}

/**
 * Development/controlled-environment matchmaking trace. Never exposed to end
 * users; emits only when SHTM_MATCH_DEBUG=1.
 */
function matchDebug(socket, meta = {}) {
    if (process.env.SHTM_MATCH_DEBUG !== "1") {
        return;
    }

    log.debug("matchmaking_debug", {
        socketId: socket.id,
        sessionId: socket.sessionId,
        connectionState: socket.connectionState,
        candidateCount: waitingUser && waitingUser !== socket ? 1 : 0,
        ...meta
    });
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

    if (record && Array.isArray(record.milestoneTimers)) {
        for (const t of record.milestoneTimers) {
            clearTimeout(t);
        }
        record.milestoneTimers = [];
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

    const ctx = socket.growthCtx || {};

    growth.trackMatchAttempt(ctx);

    const matchmakingCheck = sec.checkMatchmakingRate(socket.id);

    sec.incrementMetric("matchmakingAttempts");

    if (!matchmakingCheck.allowed) {
        sec.incrementMetric("rateLimitViolations");
        anl.trackRateLimitViolation();

        growth.trackMatchFailure("SESSION_EXPIRED", ctx);

        log.security("rate_limit", {
            event: "matchmaking_rate_limit",
            socketId: socket.id,
            sessionId: socket.sessionId
        });

        matchDebug(socket, { failure: "SESSION_EXPIRED" });

        send(socket, "messageError", {
            message: matchmakingCheck.message
        });

        return;
    }

    if (waitingUser && !isConnected(waitingUser)) {
        matchDebug(socket, {
            failure: "CANDIDATE_DISCONNECTED",
            discardedCandidate: waitingUser ? waitingUser.id : null
        });

        growth.trackMatchFailure("CANDIDATE_DISCONNECTED", ctx);

        waitingUser = null;
    }

    if (waitingUser && waitingUser.id !== socket.id) {
        const other = waitingUser;
        waitingUser = null;

        growth.trackMatchCandidateFound(ctx);
        growth.trackMatchCandidateFound(other.growthCtx || {});

        matchDebug(socket, {
            event: "candidate_selected",
            candidateId: other.id
        });

        trackMatchWait(other, socket);

        createMatch(other, socket);

        return;
    }

    waitingUser = socket;
    socket._queuedAt = Date.now();
    socket.connectionState = STATE.WAITING;

    growth.trackQueueJoin(ctx);

    matchDebug(socket, {
        event: "queue_join",
        candidateCount: 0,
        matchingCriteria: { mode: "global-any" }
    });

    log.debug("queue_join", {
        socketId: socket.id,
        sessionId: socket.sessionId
    });

    // Cohorts may override the searching message via configuration only.
    const cohortMessage = growth.getCohortMessage(
        ctx.country,
        ctx.variant,
        "searching"
    );

    send(socket, "searching", {
        message: cohortMessage || "Bir yabancı aranıyor..."
    });
}

function createMatch(userA, userB) {
    anl.trackMatchStarted();
    anl.trackConversationStarted();

    const ctxA = userA.growthCtx || {};
    const ctxB = userB.growthCtx || {};

    // A match produces a single match + conversation; attribute to both.
    growth.trackMatchCreatedPair(ctxA, ctxB);
    growth.trackConversationStartedPair(ctxA, ctxB);

    const roomId = `room_${crypto.randomUUID()}`;

    const shared = feat.sharedInterests(userA.interests, userB.interests);
    const compatibility = feat.compatibilityScore(
        { interests: userA.interests, language: userA.language },
        { interests: userB.interests, language: userB.language }
    );

    const record = {
        matchId: roomId,
        roomId,
        userA,
        userB,
        startedAt: Date.now(),
        state: "active",
        timer: null,
        milestoneTimers: [],
        sharedInterests: shared,
        compatibility
    };

    record.timer = setTimeout(() => {
        finishRoom(roomId, "timeout");
    }, CHAT_DURATION);

    if (record.timer.unref) {
        record.timer.unref();
    }

    for (const milestone of feat.MILESTONES) {
        if (milestone.atMs >= CHAT_DURATION) continue;

        const timer = setTimeout(() => {
            if (getRoomRecord(roomId) === record) {
                growth.trackProductEvent("conversation_milestone", ctxA || ctxB);
                io.to(roomId).emit("conversation:milestone", {
                    level: milestone.level,
                    atMs: milestone.atMs
                });
            }
        }, milestone.atMs);

        if (timer.unref) timer.unref();
        record.milestoneTimers.push(timer);
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

    userA.conversationCount = (userA.conversationCount || 0) + 1;
    userB.conversationCount = (userB.conversationCount || 0) + 1;

    // Isolate feedback + icebreaker state per conversation.
    userA._feedbackSubmitted = false;
    userB._feedbackSubmitted = false;
    userA._lastIcebreakerId = null;
    userB._lastIcebreakerId = null;

    // Anonymous, coarse intro (country + language + interests). No PII.
    const introA = feat.buildIntroProfile(userA);
    const introB = feat.buildIntroProfile(userB);

    const seed = Date.now() % 100000;

    const icebreaker = feat.pickInitialIcebreaker({
        shared,
        selected: userA.interests,
        seed
    });

    log.info("match_created", {
        matchId: roomId,
        socketA: userA.id,
        socketB: userB.id,
        sharedInterestsCount: shared.length,
        compatibility
    });

    // Backward-compatible matched event (English/TR handled client-side).
    io.to(roomId).emit("matched", {
        message: "Bir yabancıyla eşleştin.",
        startedAt: record.startedAt,
        duration: CHAT_DURATION,
        icebreaker: 0
    });

    // Per-user anonymous intro card. Each user sees the partner's coarse
    // profile plus the shared interests, never the partner's private state.
    send(userA, "match:intro", {
        you: introA,
        partner: introB,
        sharedInterests: shared
    });

    send(userB, "match:intro", {
        you: introB,
        partner: introA,
        sharedInterests: shared
    });

    if (shared.length > 0) {
        io.to(roomId).emit("match:shared-interests", {
            interests: shared.slice(0, 3)
        });

        growth.trackProductEvent("shared_interest_shown", ctxA || ctxB);
    }

    if (icebreaker) {
        io.to(roomId).emit("conversation:icebreaker", icebreaker);
        growth.trackProductEvent("icebreaker_shown", ctxA || ctxB);
    }

    growth.trackProductEvent("match_card_viewed", ctxA);
    growth.trackProductEvent("match_card_viewed", ctxB);
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

    growth.trackConversationEndedPair(
        record.userA.growthCtx || {},
        record.userB.growthCtx || {}
    );

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

    // Coarse session depth (no internal IDs exposed).
    send(record.userA, "session:summary", {
        conversations: record.userA.conversationCount || 0
    });
    send(record.userB, "session:summary", {
        conversations: record.userB.conversationCount || 0
    });
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

    const growthCtx = growth.ctxFromRequest(socket.request);
    const experiment = growth.assignExperiment(growthCtx);
    growthCtx.experimentId = experiment.experimentId;
    growthCtx.variant = experiment.variant;
    socket.growthCtx = growthCtx;

    const visit = growth.registerVisitor(growthCtx.visitorId);
    if (visit && visit.returning) {
        growth.trackProductEvent("return_session", growthCtx);
    }

    growth.trackConnectionAttempt(growthCtx);

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

    growth.trackConnectionSuccess(growthCtx);
    growth.trackSessionCreated(growthCtx);
    growth.trackSessionReady(growthCtx);

    socket.roomId = null;
    socket.roomTimer = null;
    socket.matchStartedAt = null;
    socket._queuedAt = null;

    socket.lastMessageAt = 0;
    socket.lastTypingAt = 0;
    socket.typing = false;

    // Feature-wave per-socket state (server-authoritative).
    socket.interests = [];
    socket.language = growthCtx.language || null;
    socket.country = growthCtx.country || null;
    socket.conversationCount = 0;
    socket._feedbackSubmitted = false;
    socket._lastIcebreakerId = null;

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

        if (!socket._messageCounted) {
            socket._messageCounted = true;
            growth.trackConversationWithMessage();
        }
        growth.trackConversationMessage(socket.growthCtx || {});

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

    socket.on("queue:next", () => {
        if (socket.roomId) {
            send(socket, "messageError", {
                message: "Sohbet devam ediyor."
            });
            return;
        }

        growth.trackProductEvent("next_match_clicked", socket.growthCtx || {});
        queueUser(socket);
    });

    /*
    |----------------------------------------------------------------------
    | INTERESTS
    |----------------------------------------------------------------------
    */

    socket.on("interests:set", (data) => {
        if (!feat.isEnabled("interests")) {
            send(socket, "interests:set", { interests: [] });
            return;
        }

        const result = feat.normalizeInterests(
            data && (Array.isArray(data) ? data : data.interests)
        );

        if (!result.valid) {
            send(socket, "messageError", {
                message: result.message
            });
            return;
        }

        socket.interests = result.interests;

        if (result.interests.length === 0) {
            growth.trackProductEvent("interest_skipped", socket.growthCtx || {});
        } else {
            growth.trackProductEvent("interest_selected", socket.growthCtx || {});
        }

        send(socket, "interests:set", {
            interests: result.interests
        });
    });

    /*
    |----------------------------------------------------------------------
    | ICEBREAKER ROTATION
    |----------------------------------------------------------------------
    */

    socket.on("icebreaker:next", () => {
        if (!socket.roomId || !feat.isEnabled("icebreakers")) {
            return;
        }

        const check = sec.checkIcebreakerRate(socket.id);
        if (!check.allowed) {
            send(socket, "messageError", { message: check.message });
            return;
        }

        const next = feat.rotateIcebreaker(socket._lastIcebreakerId, Date.now() % 1000);
        socket._lastIcebreakerId = next ? next.id : socket._lastIcebreakerId;

        send(socket, "conversation:icebreaker", next);
        growth.trackProductEvent("icebreaker_changed", socket.growthCtx || {});
    });

    /*
    |----------------------------------------------------------------------
    | CONVERSATION FEEDBACK (only valid after termination)
    |----------------------------------------------------------------------
    */

    socket.on("conversation:feedback", (data) => {
        if (socket.roomId) {
            return; // must only happen after room termination
        }

        const rating =
            typeof data?.rating === "string" ? data.rating : "";

        if (!feat.FEEDBACK_OPTIONS[rating]) {
            send(socket, "messageError", { message: "Geçersiz geri bildirim." });
            return;
        }

        if (socket._feedbackSubmitted) {
            return; // isolate feedback per match
        }

        const check = sec.checkFeedbackRate(socket.id);
        if (!check.allowed) {
            send(socket, "messageError", { message: check.message });
            return;
        }

        socket._feedbackSubmitted = true;
        growth.trackProductEvent("conversation_feedback", socket.growthCtx || {});
        growth.trackProductEvent("session_conversation_completed", socket.growthCtx || {});

        send(socket, "conversation:ended", { accepted: true });

        // Positive feedback optionally triggers a share prompt (never forced).
        if (rating === "good") {
            growth.trackProductEvent("share_prompt_shown", socket.growthCtx || {});
            send(socket, "share:prompt", { visible: true });
        }
    });

    /*
    |----------------------------------------------------------------------
    | SHARE
    |----------------------------------------------------------------------
    */

    socket.on("share:clicked", () => {
        const check = sec.checkShareRate(socket.id);
        if (!check.allowed) {
            send(socket, "messageError", { message: check.message });
            return;
        }

        growth.trackProductEvent("share_clicked", socket.growthCtx || {});
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

            growth.trackQueueLeave(socket.growthCtx || {});

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
| NETWORK DENSITY SNAPSHOT PROVIDER (injected into growth)
|--------------------------------------------------------------------------
| Provides live concurrent-user structure:
|   global: connected / waiting / matched / eligible
|   countries: country -> { connected, waiting, eligible }
|   languages: language -> { connected, waiting, eligible }
|
| "eligible" = matching candidates currently available = connected users not
| already in a room (they are waiting or could be matched immediately). This
| is real live state — never fabricated.
|--------------------------------------------------------------------------
*/

growth.setSnapshotProvider(() => {
    const sockets = io.sockets.sockets;
    const global = { connected: 0, waiting: 0, matched: 0, eligible: 0 };
    const countries = {};
    const languages = {};

    for (const socket of sockets.values()) {
        if (!socket.connected) continue;

        global.connected += 1;

        const ctx = socket.growthCtx || {};
        const inRoom = Boolean(socket.roomId);

        if (!inRoom) {
            global.eligible += 1;
        }
        if (socket.connectionState === STATE.WAITING) {
            global.waiting += 1;
        }
        if (socket.connectionState === STATE.MATCHED) {
            global.matched += 1;
        }

        if (ctx.country) {
            if (!countries[ctx.country]) {
                countries[ctx.country] = {
                    connected: 0,
                    waiting: 0,
                    eligible: 0
                };
            }
            countries[ctx.country].connected += 1;
            if (!inRoom) countries[ctx.country].eligible += 1;
            if (socket.connectionState === STATE.WAITING) {
                countries[ctx.country].waiting += 1;
            }
        }

        if (ctx.language) {
            if (!languages[ctx.language]) {
                languages[ctx.language] = {
                    connected: 0,
                    waiting: 0,
                    eligible: 0
                };
            }
            languages[ctx.language].connected += 1;
            if (!inRoom) languages[ctx.language].eligible += 1;
            if (socket.connectionState === STATE.WAITING) {
                languages[ctx.language].waiting += 1;
            }
        }
    }

    return {
        timestamp: Date.now(),
        global,
        countries,
        languages
    };
});

growth.takeSnapshot();
growth.startSnapshots(30_000);

/*
|--------------------------------------------------------------------------
| PRESENCE (people online)
|--------------------------------------------------------------------------
| Broadcast real aggregate eligibility only. Never fabricate counts. Small
| cohorts are simply <3 by platform convention, not exposed precisely.
|--------------------------------------------------------------------------
*/

let presenceTimer = null;

function broadcastPresence() {
    if (feat.isEnabled("onlineCount")) {
        const snap = growth.getStats().networkDensity;
        const eligible = (snap && snap.current && snap.current.eligible) || 0;

        io.emit("presence", {
            eligible,
            connected: (snap && snap.current && snap.current.connected) || 0,
            waiting: (snap && snap.current && snap.current.waiting) || 0
        });
    }
}

presenceTimer = setInterval(broadcastPresence, 15_000);
if (presenceTimer.unref) presenceTimer.unref();
broadcastPresence();

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