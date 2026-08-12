"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { io: Client } = require("socket.io-client");

const httpServer = require("../api/index");

let port;

function listen(server) {
    return new Promise((resolve) => {
        server.listen(0, () => resolve(server.address().port));
    });
}

let ipCounter = 0;

function nextIP() {
    ipCounter += 1;
    return `10.9.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
}

/**
 * Create a client without awaiting connect, so event listeners can be
 * attached before any server-emitted events arrive.
 */
function createClient() {
    return Client(`http://127.0.0.1:${port}`, {
        transports: ["websocket"],
        reconnection: false,
        extraHeaders: {
            "x-forwarded-for": nextIP()
        }
    });
}

function awaitConnect(client) {
    if (client.connected) {
        return Promise.resolve(client);
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error("connect timeout"));
        }, 3000);

        client.once("connect", () => {
            clearTimeout(timeout);
            resolve(client);
        });
        client.once("connect_error", (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

function disconnectClient(client) {
    return new Promise((resolve) => {
        if (!client.connected) {
            resolve();
            return;
        }

        const timeout = setTimeout(resolve, 1000);
        client.once("disconnect", () => {
            clearTimeout(timeout);
            resolve();
        });
        client.disconnect();
    });
}

function waitForEvent(emitter, event, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`timeout waiting for ${event}`));
        }, timeoutMs);

        emitter.once(event, (data) => {
            clearTimeout(timeout);
            resolve(data);
        });
    });
}

test.before(async () => {
    port = await listen(httpServer);
});

test("lifecycle: two users match, exchange a message, and end cleanly", async () => {
    const a = createClient();
    const searchingA = waitForEvent(a, "searching");

    await awaitConnect(a);
    await searchingA;

    const b = createClient();
    const matchedA = waitForEvent(a, "matched");
    const matchedB = waitForEvent(b, "matched");

    await awaitConnect(b);

    const [matchA, matchB] = await Promise.all([matchedA, matchedB]);
    assert.ok(matchA.duration > 0);
    assert.ok(matchB.duration > 0);

    const msgPromise = waitForEvent(b, "message");
    a.emit("sendMessage", { message: "merhaba" });
    const received = await msgPromise;
    assert.equal(received.message, "merhaba");

    const endedPromise = waitForEvent(b, "roomEnded");
    a.emit("endChat");
    const ended = await endedPromise;
    assert.equal(ended.reason, "manual");

    await disconnectClient(a);
    await disconnectClient(b);
});

test("lifecycle: disconnect during a match notifies the partner", async () => {
    const a = createClient();
    const searchingA = waitForEvent(a, "searching");

    await awaitConnect(a);
    await searchingA;

    const b = createClient();
    const matchedA = waitForEvent(a, "matched");
    const matchedB = waitForEvent(b, "matched");

    await awaitConnect(b);
    await Promise.all([matchedA, matchedB]);

    const partnerLeftPromise = waitForEvent(b, "partnerLeft");
    const readyPromise = waitForEvent(b, "readyForNewMatch");

    await disconnectClient(a);

    const partnerLeft = await partnerLeftPromise;
    await readyPromise;
    assert.ok(partnerLeft.message.length > 0);

    await disconnectClient(b);
});

test("lifecycle: a single user is queued without a match", async () => {
    const a = createClient();
    const searching = waitForEvent(a, "searching");

    await awaitConnect(a);

    const msg = await searching;
    assert.ok(msg.message.length > 0);

    await disconnectClient(a);
});

test("lifecycle: findAgain while already queued does not duplicate the queue", async () => {
    const a = createClient();
    const searching = waitForEvent(a, "searching");

    await awaitConnect(a);
    await searching;

    let matched = false;
    a.once("matched", () => {
        matched = true;
    });

    a.emit("findAgain");

    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(matched, false);
    assert.equal(a.connected, true);

    await disconnectClient(a);
});

test("lifecycle: oversized message payload is rejected with messageError", async () => {
    const a = createClient();
    const searchingA = waitForEvent(a, "searching");

    await awaitConnect(a);
    await searchingA;

    const b = createClient();
    const matchedA = waitForEvent(a, "matched");
    const matchedB = waitForEvent(b, "matched");

    await awaitConnect(b);
    await Promise.all([matchedA, matchedB]);

    const errPromise = waitForEvent(a, "messageError");
    a.emit("sendMessage", { message: "x".repeat(501) });
    const err = await errPromise;
    assert.ok(err.message.length > 0);

    await disconnectClient(a);
    await disconnectClient(b);
});

test.after(() => {
    return new Promise((resolve) => {
        httpServer.close(() => resolve());
    });
});