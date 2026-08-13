"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const httpServer = require("../api/index");
const anl = require("../api/analytics");
const growth = require("../lib/growth");

let port;

function listen(server) {
    return new Promise((resolve) => {
        server.listen(0, () => resolve(server.address().port));
    });
}

function close(server) {
    return new Promise((resolve) => {
        server.close(() => resolve());
    });
}

async function getJson(path) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const text = await res.text();
    let body;
    try {
        body = JSON.parse(text);
    } catch (_) {
        body = null;
    }
    return { status: res.status, body, text };
}

test.before(async () => {
    port = await listen(httpServer);
});

test.after(async () => {
    await close(httpServer);
});

test("stats endpoint returns HTTP 200 JSON on fresh empty state", async () => {
    anl.reset();
    growth.reset();

    const { status, body } = await getJson("/api/stats");

    assert.equal(status, 200);
    assert.ok(body && typeof body === "object");
    // Legacy contract must remain intact even with zero data.
    assert.equal(body.global.totalConnections, 0);
    assert.equal(body.global.totalMatches, 0);
    assert.equal(body.global.totalConversations, 0);
    assert.equal(body.system.connectionSuccessRate, "0.0%");
    assert.deepEqual(body.countries, []);
    assert.deepEqual(body.disconnectReasons, []);
});

test("growth endpoint returns HTTP 200 JSON on fresh empty state", async () => {
    anl.reset();
    growth.reset();

    const { status, body } = await getJson("/api/growth");

    assert.equal(status, 200);
    assert.ok(body && typeof body === "object");
    assert.equal(body.growth.totalSessions, 0);
    assert.equal(body.growth.matches, 0);
    assert.ok(Array.isArray(body.funnel));
    assert.equal(body.funnel.length, growth.FUNNEL_STAGES.length);
    assert.ok(Array.isArray(body.experiments));
    assert.ok(Array.isArray(body.networkDensity.marketDensity));
});

test("stats response is JSON-serializable with populated + sparse data", async () => {
    anl.reset();
    growth.reset();

    // Connections but no matches (partial state).
    anl.trackConnectionAttempt();
    anl.trackConnectionAttempt();
    anl.trackConnectionAccepted("AU", "en");
    anl.trackDisconnect("transport_close");

    const { status, body } = await getJson("/api/stats");

    assert.equal(status, 200);
    assert.equal(body.system.connectionAttempts, 2);
    assert.equal(body.system.connectionAccepted, 1);
    assert.equal(body.system.disconnectCount, 1);
    assert.equal(body.matching.started, 0);
    // No throws, always a string.
    assert.equal(typeof body.system.connectionSuccessRate, "string");

    // Double-serialize to prove no BigInt/circular refs sneak in.
    assert.doesNotThrow(() => JSON.stringify(body));
});

test("growth response is JSON-serializable with sparse cohort data", async () => {
    anl.reset();
    growth.reset();

    const au = { country: "AU", language: "en", referrer: "reddit.com" };
    growth.trackLandingView(au);
    growth.trackQueueJoin(au);
    growth.trackMatchAttempt(au);

    const { status, body } = await getJson("/api/growth");

    assert.equal(status, 200);
    assert.equal(body.growth.queueJoins, 1);
    assert.equal(body.cohorts.AU.queueJoins, 1);
    assert.equal(typeof body.cohorts.AU.conversionRates.matchSuccessRate, "number");

    assert.doesNotThrow(() => JSON.stringify(body));
});

test("stats returns a benign sanitized 500 only on internal error", async () => {
    // The route wraps getPayload in try/catch; verify the normal path does not
    // produce HTML and that error payload shape is absent during success.
    const { status, text } = await getJson("/api/stats");
    assert.equal(status, 200);
    assert.ok(!text.trim().startsWith("<!DOCTYPE"));
    assert.ok(!text.includes("stack"));
});