const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { Server } = require("socket.io");
const sec = require("./security");
const anl = require("./analytics");

const app = express();

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
    cors: {
        origin: "*"
    },
    transports: ["websocket"],
    allowEIO3: true
});

const CHAT_DURATION = sec.CHAT_DURATION;
const MESSAGE_COOLDOWN = sec.MESSAGE_COOLDOWN_MS;
const MAX_MESSAGE_LENGTH = sec.MAX_MESSAGE_LENGTH;
const MAX_IMAGE_SIZE = sec.MAX_IMAGE_SIZE;

let waitingUser = null;

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

    res.setHeader(
        "X-Content-Type-Options",
        "nosniff"
    );

    res.setHeader(
        "Referrer-Policy",
        "strict-origin-when-cross-origin"
    );

    res.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=(), interest-cohort=()"
    );

    res.setHeader(
        "X-Frame-Options",
        "SAMEORIGIN"
    );

    res.setHeader(
        "X-DNS-Prefetch-Control",
        "off"
    );

    next();
});

/*
|--------------------------------------------------------------------------
| STATIC FRONTEND
|--------------------------------------------------------------------------
*/

const publicPath = path.join(
    __dirname,
    "..",
    "public"
);

app.use(
    express.static(publicPath)
);

/*
   Serve Vercel Speed Insights MJS for vanilla JS import
*/

app.get(
    "/speed-insights.mjs",
    (req, res) => {
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
    }
);

app.get("/", (req, res) => {
    res.sendFile(
        path.join(
            publicPath,
            "index.html"
        )
    );
});

app.get("/stats", (req, res) => {
    res.sendFile(
        path.join(
            publicPath,
            "stats.html"
        )
    );
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
    const room =
        io.sockets.adapter.rooms.get(roomId);

    if (!room) {
        return [];
    }

    return [...room]
        .map(id =>
            io.sockets.sockets.get(id)
        )
        .filter(Boolean);
}

function clearRoomTimer(socket) {
    if (socket.roomTimer) {
        clearTimeout(
            socket.roomTimer
        );

        socket.roomTimer = null;
    }
}

function getPartner(socket) {
    if (!socket.roomId) {
        return null;
    }

    return getRoomUsers(socket.roomId)
        .find(
            user =>
                user.id !== socket.id
        ) || null;
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

/*
|--------------------------------------------------------------------------
| MATCHMAKING
|--------------------------------------------------------------------------
*/

function queueUser(socket) {
    if (
        !isConnected(socket) ||
        socket.roomId
    ) {
        return;
    }

    // Rate limit: matchmaking attempts
    const matchmakingCheck =
        sec.checkMatchmakingRate(socket.id);

    sec.incrementMetric("matchmakingAttempts");

    if (!matchmakingCheck.allowed) {
        sec.incrementMetric("rateLimitViolations");

        send(
            socket,
            "messageError",
            {
                message:
                    matchmakingCheck.message
            }
        );

        return;
    }

    if (
        waitingUser &&
        !isConnected(waitingUser)
    ) {
        waitingUser = null;
    }

    if (
        waitingUser &&
        waitingUser.id !== socket.id
    ) {
        const other =
            waitingUser;

        waitingUser = null;

        trackMatchWait(other, socket);

        createMatch(
            other,
            socket
        );

        return;
    }

    waitingUser = socket;

    socket._queuedAt = Date.now();

    send(
        socket,
        "searching",
        {
            message:
                "Bir yabancı aranıyor..."
        }
    );
}

function createMatch(
    userA,
    userB
) {
    anl.trackMatchStarted();
    anl.trackConversationStarted();

    const roomId =
        `room_${crypto.randomUUID()}`;

    userA.join(roomId);
    userB.join(roomId);

    userA.roomId = roomId;
    userB.roomId = roomId;

    userA.matchStartedAt =
        Date.now();

    userB.matchStartedAt =
        userA.matchStartedAt;

    const timer =
        setTimeout(
            () => {
                finishRoom(
                    roomId,
                    "timeout"
                );
            },
            CHAT_DURATION
        );

    userA.roomTimer = timer;
    userB.roomTimer = timer;

    // Random icebreaker (0-19)
    const icebreakerIndex =
        Math.floor(Math.random() * 20);

    io.to(roomId).emit(
        "matched",
        {
            message:
                "Bir yabancıyla eşleştin.",

            startedAt:
                userA.matchStartedAt,

            duration:
                CHAT_DURATION,

            icebreaker:
                icebreakerIndex
        }
    );
}

function finishRoom(
    roomId,
    reason = "manual"
) {
    const users =
        getRoomUsers(roomId);

    if (!users.length) {
        return;
    }

    for (
        const user of users
    ) {
        clearRoomTimer(user);
    }

    let message =
        "Sohbet sona erdi.";

    if (
        reason === "timeout"
    ) {
        message =
            "60 saniye doldu.";
    }

    if (
        reason === "skip"
    ) {
        message =
            "Eşleşme atlandı.";
    }

    // Track conversation duration
    const convStart = users[0].matchStartedAt;
    if (convStart) {
        anl.trackConversationEnded(Date.now() - convStart);
    }

    io.to(roomId).emit(
        "roomEnded",
        {
            message,
            reason
        }
    );

    for (
        const user of users
    ) {
        user.leave(roomId);

        user.roomId = null;
        user.roomTimer = null;
        user.matchStartedAt = null;
        user.typing = false;
    }
}

/*
|--------------------------------------------------------------------------
| SOCKET.IO
|--------------------------------------------------------------------------
*/

io.on(
    "connection",
    socket => {
        /*
        |------------------------------------------------------------------
        | CONNECTION RATE LIMITING
        |------------------------------------------------------------------
        */

        const connectionCheck =
            sec.checkConnectionRate(socket);

        sec.incrementMetric("connections");
        sec.incrementMetric("activeSessions");

        if (!connectionCheck.allowed) {
            sec.incrementMetric("rejectedConnections");
            sec.incrementMetric("rateLimitViolations");

            console.log(
                "SECURITY: Connection rejected",
                {
                    ip: sec.getClientIP(socket),
                    socketId: socket.id
                }
            );

            socket.emit(
                "messageError",
                {
                    message:
                        connectionCheck.message
                }
            );

            socket.disconnect(true);

            return;
        }

        console.log(
            "Connected:",
            socket.id
        );

        socket.roomId = null;
        socket.roomTimer = null;
        socket.matchStartedAt = null;

        socket.lastMessageAt = 0;
        socket.lastTypingAt = 0;

        socket.typing = false;

        anl.setActiveCountGetters(
            () => io.sockets.sockets.size,
            () => {
                let matchRooms = 0;
                const rooms =
                    io.sockets.adapter.rooms;
                for (
                    const [name, members]
                    of rooms
                ) {
                    if (
                        name.startsWith(
                            "room_"
                        ) &&
                        members.size === 2
                    ) {
                        matchRooms += 1;
                    }
                }
                return matchRooms;
            },
            () =>
                waitingUser ? 1 : 0
        );

        anl.trackConnection(
            anl.getCountryFromRequest(
                socket.request
            ),
            anl.getLanguageFromRequest(
                socket.request
            )
        );

        queueUser(socket);

        /*
        |------------------------------------------------------------------
        | IMAGE
        |------------------------------------------------------------------
        */

        socket.on(
            "sendImage",
            data => {
                if (
                    !socket.roomId
                ) {
                    return;
                }

                // Rate limit: image uploads
                const imageRateCheck =
                    sec.checkImageUploadRate(
                        socket.id
                    );

                if (!imageRateCheck.allowed) {
                    sec.incrementMetric("rateLimitViolations");

                    send(
                        socket,
                        "messageError",
                        {
                            message:
                                imageRateCheck.message
                        }
                    );

                    return;
                }

                // Payload size guard
                if (
                    !sec.checkPayloadSize(
                        data
                    )
                ) {
                    sec.incrementMetric("rejectedMessages");

                    send(
                        socket,
                        "messageError",
                        {
                            message:
                                "Görsel çok büyük."
                        }
                    );

                    return;
                }

                // Validate image (MIME + magic bytes + size)
                const validation =
                    sec.validateImagePayload(
                        data?.image
                    );

                if (!validation.valid) {
                    sec.incrementMetric("rejectedMessages");

                    send(
                        socket,
                        "messageError",
                        {
                            message:
                                validation.message
                        }
                    );

                    return;
                }

                // Cooldown check
                const now =
                    Date.now();

                if (
                    now -
                    socket.lastMessageAt <
                    MESSAGE_COOLDOWN
                ) {
                    send(
                        socket,
                        "messageError",
                        {
                            message:
                                "Biraz yavaş."
                        }
                    );

                    return;
                }

                socket.lastMessageAt =
                    now;

                sec.incrementMetric("imageUploads");
                anl.trackImage();

                socket.typing = false;

                socket
                    .to(socket.roomId)
                    .emit(
                        "typing",
                        {
                            active: false
                        }
                    );

                socket
                    .to(socket.roomId)
                    .emit(
                        "image",
                        {
                            image: data.image,
                            timestamp:
                                now
                        }
                    );
            }
        );

        /*
        |------------------------------------------------------------------
        | MESSAGE
        |------------------------------------------------------------------
        */

        socket.on(
            "sendMessage",
            data => {
                if (
                    !socket.roomId
                ) {
                    return;
                }

                // Payload size guard
                if (
                    !sec.checkPayloadSize(
                        data,
                        64 * 1024
                    )
                ) {
                    sec.incrementMetric("rejectedMessages");

                    send(
                        socket,
                        "messageError",
                        {
                            message:
                                "Mesaj çok büyük."
                        }
                    );

                    return;
                }

                const message =
                    sec.sanitizeMessage(
                        data?.message
                    );

                if (!message) {
                    send(
                        socket,
                        "messageError",
                        {
                            message:
                                `Mesaj 1-${MAX_MESSAGE_LENGTH} karakter arasında olmalı.`
                        }
                    );

                    return;
                }

                // Burst + cooldown rate limiting
                const rateCheck =
                    sec.checkMessageRate(
                        socket.id
                    );

                if (!rateCheck.allowed) {
                    sec.incrementMetric("rateLimitViolations");

                    send(
                        socket,
                        "messageError",
                        {
                            message:
                                rateCheck.message
                        }
                    );

                    return;
                }

                sec.incrementMetric("messages");
                anl.trackMessage();

                socket.typing = false;

                socket
                    .to(socket.roomId)
                    .emit(
                        "typing",
                        {
                            active: false
                        }
                    );

                socket
                    .to(socket.roomId)
                    .emit(
                        "message",
                        {
                            message,
                            timestamp:
                                Date.now()
                        }
                    );
            }
        );

        /*
        |------------------------------------------------------------------
        | TYPING
        |------------------------------------------------------------------
        */

        socket.on(
            "typing",
            active => {
                if (
                    !socket.roomId ||
                    typeof active !==
                        "boolean"
                ) {
                    return;
                }

                const now =
                    Date.now();

                if (
                    now -
                    socket.lastTypingAt <
                    300
                ) {
                    return;
                }

                socket.lastTypingAt =
                    now;

                socket.typing =
                    active;

                socket
                    .to(socket.roomId)
                    .emit(
                        "typing",
                        {
                            active
                        }
                    );
            }
        );

        /*
        |------------------------------------------------------------------
        | SKIP
        |------------------------------------------------------------------
        */

        socket.on(
            "skip",
            () => {
                if (
                    !socket.roomId
                ) {
                    return;
                }

                const roomId =
                    socket.roomId;

                const partner =
                    getPartner(socket);

                clearRoomTimer(
                    socket
                );

                socket.leave(
                    roomId
                );

                socket.roomId = null;

                socket.matchStartedAt =
                    null;

                send(
                    socket,
                    "skipped",
                    {
                        message:
                            "Yabancıyı atladın."
                    }
                );

                if (partner) {
                    clearRoomTimer(
                        partner
                    );

                    partner.leave(
                        roomId
                    );

                    partner.roomId =
                        null;

                    partner.matchStartedAt =
                        null;

                    send(
                        partner,
                        "partnerLeft",
                        {
                            message:
                                "Karşı taraf sohbeti sonlandırdı."
                        }
                    );

                    send(
                        partner,
                        "readyForNewMatch"
                    );
                }

                send(
                    socket,
                    "readyForNewMatch"
                );
            }
        );

        /*
        |------------------------------------------------------------------
        | END CHAT
        |------------------------------------------------------------------
        */

        socket.on(
            "endChat",
            () => {
                if (
                    !socket.roomId
                ) {
                    return;
                }

                finishRoom(
                    socket.roomId,
                    "manual"
                );
            }
        );

        /*
        |------------------------------------------------------------------
        | FIND AGAIN
        |------------------------------------------------------------------
        */

        socket.on(
            "findAgain",
            () => {
                if (
                    socket.roomId
                ) {
                    return;
                }

                queueUser(socket);
            }
        );

        /*
        |------------------------------------------------------------------
        | REPORT
        |------------------------------------------------------------------
        */

        socket.on(
            "report",
            data => {
                const reason =
                    typeof data?.reason ===
                    "string"
                        ? data.reason
                            .trim()
                            .slice(
                                0,
                                300
                            )
                        : "";

                if (!reason) {
                    send(
                        socket,
                        "reportError",
                        {
                            message:
                                "Rapor nedeni gerekli."
                        }
                    );

                    return;
                }

                console.log(
                    "REPORT",
                    {
                        reporter:
                            socket.id,

                        partner:
                            getPartner(
                                socket
                            )?.id ||
                            null,

                        reason,

                        time:
                            new Date()
                                .toISOString()
                    }
                );

                send(
                    socket,
                    "reportSent",
                    {
                        message:
                            "Rapor gönderildi."
                    }
                );
            }
        );

        /*
        |------------------------------------------------------------------
        | DISCONNECT
        |------------------------------------------------------------------
        */

        socket.on(
            "disconnect",
            reason => {
                console.log(
                    "Disconnected:",
                    socket.id,
                    reason
                );

                sec.decrementConnection(
                    sec.getClientIP(socket)
                );

                sec.decrementMetric("activeSessions");

                anl.trackDisconnect();

                if (
                    waitingUser ===
                    socket
                ) {
                    waitingUser =
                        null;
                }

                if (
                    socket.roomId
                ) {
                    const roomId =
                        socket.roomId;

                    const partner =
                        getPartner(
                            socket
                        );

                    clearRoomTimer(
                        socket
                    );

                    socket.roomId =
                        null;

                    if (partner) {
                        clearRoomTimer(
                            partner
                        );

                        partner.leave(
                            roomId
                        );

                        partner.roomId =
                            null;

                        partner.matchStartedAt =
                            null;

                        partner.roomTimer =
                            null;

                        send(
                            partner,
                            "partnerLeft",
                            {
                                message:
                                    "Yabancı bağlantıyı kapattı."
                            }
                        );

                        send(
                            partner,
                            "readyForNewMatch"
                        );
                    }
                }
            }
        );
    }
);

/*
|--------------------------------------------------------------------------
| LOCAL DEVELOPMENT
|--------------------------------------------------------------------------
*/

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    httpServer.listen(PORT, () => {
        console.log(`SHTM local → http://localhost:${PORT}`);
    });
}

module.exports = httpServer;