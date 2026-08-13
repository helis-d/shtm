"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const growth = require("../lib/growth");

test("growth: referrerDomain normalizes and classifies direct sources", () => {
    assert.equal(growth.referrerDomain("https://reddit.com/r/shtm"), "reddit.com");
    assert.equal(growth.referrerDomain("https://www.example.com/foo"), "www.example.com");
    assert.equal(growth.referrerDomain(""), "direct");
    assert.equal(growth.referrerDomain("null"), "direct");
    assert.equal(growth.referrerDomain(undefined), null);
    assert.equal(growth.referrerDomain(null), null);
    assert.equal(growth.referrerDomain(123), null);
});

test("growth: ctxFromRequest extracts country, language, referrer, UTM safely", () => {
    const ctx = growth.ctxFromRequest({
        headers: {
            "x-vercel-ip-country": "au",
            "accept-language": "en-AU,en;q=0.9",
            referer: "https://reddit.com/r/shtm"
        },
        query: {
            utm_source: "reddit",
            utm_medium: "community",
            utm_campaign: "au-launch"
        }
    });

    assert.equal(ctx.country, "AU");
    assert.equal(ctx.language, "en");
    assert.equal(ctx.referrer, "reddit.com");
    assert.equal(ctx.utmSource, "reddit");
    assert.equal(ctx.utmMedium, "community");
    assert.equal(ctx.utmCampaign, "au-launch");
});

test("growth: funnel records stages globally and by country", () => {
    growth.reset();

    const au = { country: "AU", language: "en", referrer: "reddit.com" };

    growth.trackLandingView(au);
    growth.trackConnectionAttempt(au);
    growth.trackConnectionSuccess(au);
    growth.trackSessionCreated(au);
    growth.trackQueueJoin(au);
    growth.trackMatchAttempt(au);

    const stats = growth.getStats();

    const byStage = Object.fromEntries(
        stats.funnel.map((s) => [s.stage, s.count])
    );

    assert.equal(byStage.landing_view, 1);
    assert.equal(byStage.queue_join, 1);
    assert.equal(byStage.match_attempt, 1);
    assert.equal(stats.cohorts.AU.queueJoins, 1);
});

test("growth: pair events counted once globally, attributed to both", () => {
    growth.reset();

    const au = { country: "AU", language: "en", referrer: "reddit.com" };
    const tr = { country: "TR", language: "tr", referrer: "direct" };

    growth.trackMatchAttempt(au);
    growth.trackMatchAttempt(tr);
    growth.trackMatchCreatedPair(au, tr);
    growth.trackConversationStartedPair(au, tr);
    growth.trackConversationEndedPair(au, tr);

    const stats = growth.getStats();
    const byStage = Object.fromEntries(
        stats.funnel.map((s) => [s.stage, s.count])
    );

    assert.equal(byStage.match_created, 1);
    assert.equal(byStage.conversation_started, 1);
    assert.equal(byStage.conversation_ended, 1);

    assert.equal(stats.cohorts.AU.matches, 1);
    assert.equal(stats.cohorts.TR.matches, 1);
});

test("growth: match success rate uses matches/matchAttempts and is never NaN", () => {
    growth.reset();

    const attempts = [];
    for (let i = 0; i < 5; i += 1) {
        attempts.push({ country: "AU" });
        growth.trackMatchAttempt(attempts[i]);
    }

    // One successful match between two distinct AU users. Because both are
    // in the AU cohort, the match is attributed to AU exactly once.
    growth.trackMatchCreatedPair(attempts[0], attempts[1]);

    const stats = growth.getStats();
    assert.equal(stats.cohorts.AU.matchAttempts, 5);
    assert.equal(stats.cohorts.AU.matches, 1);
    assert.equal(
        stats.cohorts.AU.conversionRates.matchSuccessRate,
        20
    );
});

test("growth: match failures normalize unknown reasons to INTERNAL_ERROR", () => {
    growth.reset();

    growth.trackMatchFailure("WEIRD_REASON", {});
    growth.trackMatchFailure("NO_CANDIDATE", {});

    const stats = growth.getStats();
    const reasons = Object.fromEntries(
        stats.matchFailures.map((f) => [f.reason, f.count])
    );

    assert.equal(reasons.INTERNAL_ERROR, 1);
    assert.equal(reasons.NO_CANDIDATE, 1);
});

test("growth: return behavior classifies new vs returning sessions", () => {
    growth.reset();

    const first = growth.registerVisitor("v_abc");
    const second = growth.registerVisitor("v_abc");

    assert.equal(first.isNew, true);
    assert.equal(second.isNew, false);
    assert.equal(second.returning, true);
    assert.equal(second.within24h, true);

    const stats = growth.getStats();
    assert.equal(stats.returnBehavior.firstSessions, 1);
    assert.equal(stats.returnBehavior.returningSessions, 1);
    assert.equal(stats.returnBehavior.secondSessions, 1);
});

test("growth: concurrency snapshots track global, country and language peaks", () => {
    growth.reset();

    growth.setSnapshotProvider(() => ({
        timestamp: Date.now(),
        global: { connected: 3, waiting: 1, matched: 2, eligible: 1 },
        countries: { AU: { connected: 2, waiting: 1, eligible: 0 } },
        languages: { en: { connected: 2, waiting: 1, eligible: 0 } }
    }));

    growth.takeSnapshot();
    growth.takeSnapshot();

    const stats = growth.getStats();
    assert.equal(stats.networkDensity.peak.connected, 3);
    assert.equal(stats.networkDensity.peak.waiting, 1);
    assert.equal(stats.networkDensity.peak.matched, 2);

    const au = stats.networkDensity.countries.find((c) => c.country === "AU");
    assert.equal(au.peakConnected, 2);
    assert.equal(au.peakWaiting, 1);
});

test("growth: experiment assignment only applies to configured cohort", () => {
    const exp = growth.assignExperiment({ country: "AU" });
    const none = growth.assignExperiment({ country: "TR" });

    // Experiment window is not active unless configured, so AU is also null.
    assert.equal(none.experimentId, null);
    // But the API shape is stable.
    assert.ok("experimentId" in exp);
    assert.ok("variant" in exp);
});

test("growth: isInWindow handles normal and cross-midnight windows", () => {
    // A fixed window that does not cross midnight.
    const window = { startMinutes: 8 * 60, endMinutes: 12 * 60, timezone: "UTC" };

    const inWindow = new Date("2026-01-01T09:00:00Z");
    const outWindow = new Date("2026-01-01T14:00:00Z");

    assert.equal(growth.isInWindow(inWindow, window), true);
    assert.equal(growth.isInWindow(outWindow, window), false);

    // Cross-midnight.
    const cross = { startMinutes: 22 * 60, endMinutes: 2 * 60, timezone: "UTC" };
    const beforeMidnight = new Date("2026-01-01T23:00:00Z");
    const afterMidnight = new Date("2026-01-01T01:00:00Z");
    const middle = new Date("2026-01-01T15:00:00Z");

    assert.equal(growth.isInWindow(beforeMidnight, cross), true);
    assert.equal(growth.isInWindow(afterMidnight, cross), true);
    assert.equal(growth.isInWindow(middle, cross), false);
});