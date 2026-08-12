const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { Server } = require("socket.io");

const app = express();

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
    cors: {
        origin: "*"
    },
    transports: ["websocket"],
    allowEIO3: true
});

const CHAT_DURATION = 30_000;
const MESSAGE_COOLDOWN = 2_000;
const MAX_MESSAGE_LENGTH = 500;

let waitingUser = null;

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

app.get("/", (req, res) => {
    res.sendFile(
        path.join(
            publicPath,
            "index.html"
        )
    );
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

function sanitizeMessage(value) {
    if (
        typeof value !== "string"
    ) {
        return null;
    }

    const message = value
        .replace(/\u0000/g, "")
        .trim();

    if (
        !message ||
        message.length >
            MAX_MESSAGE_LENGTH
    ) {
        return null;
    }

    return message;
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

        createMatch(
            other,
            socket
        );

        return;
    }

    waitingUser = socket;

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

    io.to(roomId).emit(
        "matched",
        {
            message:
                "Bir yabancıyla eşleştin.",

            startedAt:
                userA.matchStartedAt,

            duration:
                CHAT_DURATION
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
            "30 saniye doldu.";
    }

    if (
        reason === "skip"
    ) {
        message =
            "Eşleşme atlandı.";
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

        queueUser(socket);

        /*
        |--------------------------------------------------------------------------
        | MESSAGE
        |--------------------------------------------------------------------------
        */

        socket.on(
            "sendMessage",
            data => {
                if (
                    !socket.roomId
                ) {
                    return;
                }

                const message =
                    sanitizeMessage(
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
                                now
                        }
                    );
            }
        );

        /*
        |--------------------------------------------------------------------------
        | TYPING
        |--------------------------------------------------------------------------
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
        |--------------------------------------------------------------------------
        | SKIP
        |--------------------------------------------------------------------------
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
        |--------------------------------------------------------------------------
        | END CHAT
        |--------------------------------------------------------------------------
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
        |--------------------------------------------------------------------------
        | FIND AGAIN
        |--------------------------------------------------------------------------
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
        |--------------------------------------------------------------------------
        | REPORT
        |--------------------------------------------------------------------------
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
        |--------------------------------------------------------------------------
        | DISCONNECT
        |--------------------------------------------------------------------------
        */

        socket.on(
            "disconnect",
            reason => {
                console.log(
                    "Disconnected:",
                    socket.id,
                    reason
                );

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