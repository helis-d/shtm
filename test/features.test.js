"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const feat = require("../lib/features");

test("features: interest normalization accepts valid ids and objects", () => {
    assert.deepEqual(
        feat.normalizeInterests(["gaming", "music", "coding"]).interests,
        ["gaming", "music", "coding"]
    );
    assert.deepEqual(
        feat.normalizeInterests({ interests: ["travel", "books"] }).interests,
        ["travel", "books"]
    );
});

test("features: interest normalization allows skipping and empty arrays", () => {
    assert.equal(feat.normalizeInterests(null).valid, true);
    assert.deepEqual(feat.normalizeInterests([]).interests, []);
    assert.deepEqual(feat.normalizeInterests(undefined).interests, []);
});

test("features: interest normalization rejects invalid, duplicate, and excessive values", () => {
    assert.equal(feat.normalizeInterests(["unknown_interest"]).valid, false);
    assert.equal(feat.normalizeInterests(["gaming", "gaming"]).valid, false);
    assert.equal(feat.normalizeInterests("not-an-array").valid, false);

    const six = ["gaming", "music", "movies", "technology", "sports", "travel"];
    assert.equal(feat.normalizeInterests(six).valid, false);
});

test("features: sharedInterests returns intersection in order", () => {
    assert.deepEqual(
        feat.sharedInterests(["gaming", "music"], ["music", "coding"]),
        ["music"]
    );
    assert.deepEqual(feat.sharedInterests([], ["music"]), []);
});

test("features: compatibility score is bounded and prioritizes shared interests + language", () => {
    const base = feat.compatibilityScore(
        { interests: [], language: null },
        { interests: [], language: null }
    );
    assert.equal(base, 50);

    const sharedAndSameLang = feat.compatibilityScore(
        { interests: ["gaming"], language: "en" },
        { interests: ["gaming"], language: "en" }
    );
    assert.ok(sharedAndSameLang > base);

    // Never exceeds 100.
    assert.ok(sharedAndSameLang <= 100);
});

test("features: buildIntroProfile only exposes coarse public signals", () => {
    const profile = feat.buildIntroProfile({
        country: "AU",
        language: "en",
        interests: ["gaming"],
        ip: "1.2.3.4",
        sessionId: "secret"
    });

    assert.deepEqual(profile, {
        country: "AU",
        language: "en",
        interests: ["gaming"]
    });
    assert.equal(profile.ip, undefined);
    assert.equal(profile.sessionId, undefined);
});

test("features: icebreaker selection prefers shared interest then universal", () => {
    const shared = feat.pickInitialIcebreaker({
        shared: ["gaming"],
        selected: [],
        seed: 0
    });
    assert.equal(shared.category, "shared");
    assert.equal(shared.interest, "gaming");

    const universal = feat.pickInitialIcebreaker({
        shared: [],
        selected: [],
        seed: 0
    });
    assert.equal(universal.category, "universal");
});

test("features: rotateIcebreaker excludes the current prompt", () => {
    const next = feat.rotateIcebreaker("q_forever", 0);
    assert.ok(next);
    assert.notEqual(next.id, "q_forever");
});

test("features: feedback options are a fixed safe set", () => {
    assert.deepEqual(Object.keys(feat.FEEDBACK_OPTIONS).sort(), [
        "good",
        "not_great",
        "okay"
    ]);
});