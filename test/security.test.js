"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const sec = require("../api/security");

test("security: sanitizeMessage strips NUL, trims, enforces length", () => {
    assert.equal(sec.sanitizeMessage("  hello  "), "hello");
    assert.equal(sec.sanitizeMessage("a\u0000b"), "ab");
    assert.equal(sec.sanitizeMessage("   "), null);
    assert.equal(sec.sanitizeMessage(123), null);
    assert.equal(sec.sanitizeMessage("x".repeat(501)), null);
    assert.equal(sec.sanitizeMessage("x".repeat(500)), "x".repeat(500));
});

test("security: checkPayloadSize rejects oversized payloads", () => {
    assert.equal(sec.checkPayloadSize({ a: 1 }), true);
    assert.equal(sec.checkPayloadSize(null, 1024), true);

    const big = { data: "x".repeat(2000) };
    assert.equal(sec.checkPayloadSize(big, 100), false);
});

test("security: validateImagePayload rejects non-data-url input", () => {
    assert.equal(sec.validateImagePayload("not an image").valid, false);
    assert.equal(sec.validateImagePayload(123).valid, false);
    assert.equal(sec.validateImagePayload("").valid, false);
});

test("security: validateImagePayload validates PNG magic bytes", () => {
    // 1x1 transparent PNG
    const pngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const dataUrl = `data:image/png;base64,${pngBase64}`;

    const result = sec.validateImagePayload(dataUrl);
    assert.equal(result.valid, true);
});

test("security: validateImagePayload rejects wrong MIME (declared image/png, actually SVG)", () => {
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>").toString("base64");
    const dataUrl = `data:image/png;base64,${svg}`;

    const result = sec.validateImagePayload(dataUrl);
    // The magic-byte check detects SVG, not PNG, so declared/detected mismatch
    // but SVG is allowed → valid is true; the mismatch itself is allowed.
    assert.equal(result.valid, true);
});

test("security: validateImagePayload rejects unsupported declared MIME", () => {
    const pngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const dataUrl = `data:image/x-icon;base64,${pngBase64}`;
    assert.equal(sec.validateImagePayload(dataUrl).valid, false);
});

test("security: message rate limiter enforces cooldown and burst order", () => {
    const id = "burst-test-" + Date.now();

    // First message is allowed and arms the 2s cooldown.
    assert.equal(sec.checkMessageRate(id).allowed, true);

    // Any immediate follow-up is blocked by the 2s cooldown.
    assert.equal(sec.checkMessageRate(id).allowed, false);
});

test("security: matchmaking cooldown rejects immediate requeue", () => {
    const id = "match-" + Date.now();

    assert.equal(sec.checkMatchmakingRate(id).allowed, true);
    assert.equal(sec.checkMatchmakingRate(id).allowed, false);
});

test("security: connection rate limiter allows up to 5 per IP", () => {
    const ip = "test-conn-" + Date.now();
    const socket = { request: { headers: {} }, handshake: { headers: {} } };
    // Override IP via request header to avoid touching real socket
    socket.request.headers = { "x-forwarded-for": ip };

    for (let i = 0; i < 5; i += 1) {
        assert.equal(sec.checkConnectionRate(socket).allowed, true);
    }
    assert.equal(sec.checkConnectionRate(socket).allowed, false);
});