"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const log = require("../api/logger");

test("logger: categorizeDisconnectReason maps socket.io reasons", () => {
    assert.equal(
        log.categorizeDisconnectReason("ping timeout"),
        "timeout"
    );
    assert.equal(
        log.categorizeDisconnectReason("transport close"),
        "transport_close"
    );
    assert.equal(
        log.categorizeDisconnectReason("transport error"),
        "transport_error"
    );
    assert.equal(
        log.categorizeDisconnectReason("client namespace disconnect"),
        "client_disconnect"
    );
    assert.equal(
        log.categorizeDisconnectReason("server shutting down"),
        "server_shutdown"
    );
    assert.equal(
        log.categorizeDisconnectReason("forced close"),
        "server_shutdown"
    );
    assert.equal(
        log.categorizeDisconnectReason("io server disconnect"),
        "unknown"
    );
});

test("logger: categorizeDisconnectReason detects server-side duplicate/stale", () => {
    assert.equal(
        log.categorizeDisconnectReason("transport close", "duplicate connection"),
        "duplicate_connection"
    );
    assert.equal(
        log.categorizeDisconnectReason("transport close", "stale socket"),
        "stale_socket"
    );
});

test("logger: ERROR_CATEGORY and DISCONNECT_REASON are stable enums", () => {
    assert.equal(log.ERROR_CATEGORY.CONNECTION_ERROR, "CONNECTION_ERROR");
    assert.equal(log.ERROR_CATEGORY.VALIDATION_ERROR, "VALIDATION_ERROR");
    assert.equal(log.DISCONNECT_REASON.CLIENT_DISCONNECT, "client_disconnect");
    assert.equal(log.DISCONNECT_REASON.UNKNOWN, "unknown");
});

test("logger: SOCKET_STATE lifecycle enum is stable", () => {
    assert.equal(log.SOCKET_STATE.CONNECTED, "connected");
    assert.equal(log.SOCKET_STATE.WAITING, "waiting");
    assert.equal(log.SOCKET_STATE.MATCHED, "matched");
    assert.equal(log.SOCKET_STATE.DISCONNECTED, "disconnected");
});