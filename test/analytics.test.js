"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const anl = require("../api/analytics");

test("analytics: reset clears all counters and samples", () => {
    anl.trackConnectionAttempt();
    anl.trackConnectionAccepted("US", "en");
    anl.trackDisconnect("timeout");
    anl.trackMatchStarted();
    anl.trackMatchWaitTime(500);
    anl.trackMatchCompleted();
    anl.trackMatchAborted();
    anl.trackConversationStarted();
    anl.trackConversationEnded(1000);
    anl.trackMessage();
    anl.trackImage();
    anl.trackRateLimitViolation();
    anl.trackWSLatency(20);
    anl.trackSocketLifetime(3000);

    anl.reset();

    const stats = anl.getStats();
    assert.equal(stats.system.connectionAttempts, 0);
    assert.equal(stats.system.connectionAccepted, 0);
    assert.equal(stats.system.disconnectCount, 0);
    assert.equal(stats.matching.started, 0);
    assert.equal(stats.matching.completed, 0);
    assert.equal(stats.matching.aborted, 0);
    assert.equal(stats.conversation.started, 0);
    assert.equal(stats.conversation.completed, 0);
    assert.deepEqual(stats.countries, []);
    assert.deepEqual(stats.languages, []);
    assert.deepEqual(stats.disconnectReasons, []);
});

test("analytics: percentiles are interpolated correctly", () => {
    const closeTo = (actual, expected) =>
        assert.ok(
            Math.abs(actual - expected) < 1e-9,
            `expected ${actual} ≈ ${expected}`
        );

    // 1..10
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    closeTo(anl.percentile(arr, 0.5), 5.5);
    closeTo(anl.percentile(arr, 0), 1);
    closeTo(anl.percentile(arr, 1), 10);
    closeTo(anl.percentile(arr, 0.95), 9.55);
    assert.equal(anl.percentile([], 0.5), 0);
});

test("analytics: rate is mathematically correct and never NaN", () => {
    assert.equal(anl.rate(5, 10), "50.0");
    assert.equal(anl.rate(0, 10), "0.0");
    assert.equal(anl.rate(3, 0), "0.0");
    assert.equal(anl.rate(1, 3), "33.3");
});

test("analytics: connection success rate uses accepted/attempts", () => {
    anl.reset();

    // Simulate 8 attempts: 6 accepted, 2 rejected
    for (let i = 0; i < 8; i += 1) anl.trackConnectionAttempt();
    for (let i = 0; i < 6; i += 1) anl.trackConnectionAccepted();
    for (let i = 0; i < 2; i += 1) anl.trackConnectionRejected();

    const stats = anl.getStats();
    assert.equal(stats.system.connectionAttempts, 8);
    assert.equal(stats.system.connectionAccepted, 6);
    assert.equal(stats.system.connectionRejected, 2);
    assert.equal(stats.system.connectionSuccessRate, "75.0%");
    assert.equal(stats.system.connectionFailureRate, "25.0%");
});

test("analytics: match success rate uses completed/started", () => {
    anl.reset();

    anl.trackMatchStarted();
    anl.trackMatchStarted();
    anl.trackMatchCompleted(); // 1 of 2 completed
    anl.trackMatchAborted(); // 1 of 2 aborted

    const stats = anl.getStats();
    assert.equal(stats.matching.started, 2);
    assert.equal(stats.matching.completed, 1);
    assert.equal(stats.matching.aborted, 1);
    assert.equal(stats.matching.matchSuccessRate, "50.0%");
    assert.equal(stats.matching.matchFailureRate, "50.0%");
});

test("analytics: disconnect reasons are aggregated", () => {
    anl.reset();

    anl.trackDisconnect("timeout");
    anl.trackDisconnect("timeout");
    anl.trackDisconnect("client_disconnect");

    const stats = anl.getStats();
    assert.equal(stats.system.disconnectCount, 3);

    const reasons = Object.fromEntries(
        stats.disconnectReasons.map((r) => [r.reason, r.count])
    );
    assert.equal(reasons.timeout, 2);
    assert.equal(reasons.client_disconnect, 1);
});

test("analytics: lifetime and latency samples are tracked", () => {
    anl.reset();

    anl.trackSocketLifetime(1000);
    anl.trackSocketLifetime(3000);
    anl.trackWSLatency(10);
    anl.trackWSLatency(30);

    const stats = anl.getStats();
    assert.equal(stats.system.avgSocketLifetimeMs, 2000);
    assert.equal(stats.system.avgWSLatencyMs, 20);
});