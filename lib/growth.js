/*
 |==============================================================================
 | SHTM — GROWTH ANALYTICS + EXPERIMENTS
 |==============================================================================
 |
 | Anonymous, aggregate growth instrumentation for network-effect measurement.
 |
 | PURPOSE:
 |   SHTM's core growth equation is:
 |
 |     REAL USERS × SIMULTANEOUS DENSITY × MATCH SUCCESS
 |       × CONVERSATION QUALITY × RETENTION
 |
 |   This module makes every term measurable without collecting personal data.
 |
 | MEASURES:
 |   - Funnel (landing → CTA → connect → ready → queue → match → conversation)
 |   - Traffic sources (referrer domain, UTM, landing page, coarse device/browser)
 |   - Country + language cohorts (dynamic, not hardcoded to Australia)
 |   - Network density (concurrent users, eligible matching candidates, peaks)
 |   - Market density (per-country wait times, match success, peak concurrency)
 |   - Return behavior (privacy-preserving visitor id, first/return sessions)
 |   - Match failure taxonomy
 |   - Lightweight experiment framework (Australia Density Test)
 |
 | PRIVACY:
 |   - Aggregate counters and distributions only.
 |   - No IPs, no message bodies, no raw user agents, no persistent storage.
 |   - Visitor identity is a random client-generated id (localStorage) reused
 |     only to distinguish unique sessions vs reconnects vs returns. It is a
 |     non-identifying random token and is never exposed in the stats response.
 |
 | CORRECTNESS INVARIANT:
 |   Every rate has an explicit, matching numerator/denominator. Never NaN.
 |==============================================================================
 */

const anl = require("../api/analytics");

/*
 |--------------------------------------------------------------------------
 | CONFIG
 |--------------------------------------------------------------------------
 */

// Funnel stages measured (see docs/context/GROWTH.md)
const FUNNEL_STAGES = [
    "landing_view",
    "primary_cta_click",
    "connection_attempt",
    "connection_success",
    "session_created",
    "session_ready",
    "queue_join",
    "queue_leave",
    "match_attempt",
    "match_candidate_found",
    "match_created",
    "match_confirmed",
    "conversation_started",
    "conversation_message",
    "conversation_ended"
];

// Additive product events (feature wave). These are independent of the core
// funnel above and must not disturb its 15 stages.
const PRODUCT_STAGES = [
    "interest_selected",
    "interest_skipped",
    "match_card_viewed",
    "shared_interest_shown",
    "icebreaker_shown",
    "icebreaker_changed",
    "conversation_milestone",
    "conversation_feedback",
    "next_match_clicked",
    "share_prompt_shown",
    "share_clicked",
    "session_conversation_completed",
    "return_session"
];

// Normalized match failure reasons (see docs/context/MATCHMAKING.md)
const MATCH_FAILURE_REASONS = {
    NO_CANDIDATE: "NO_CANDIDATE",
    CANDIDATE_DISCONNECTED: "CANDIDATE_DISCONNECTED",
    CANDIDATE_ALREADY_MATCHED: "CANDIDATE_ALREADY_MATCHED",
    CRITERIA_MISMATCH: "CRITERIA_MISMATCH",
    RACE_CONDITION: "RACE_CONDITION",
    SESSION_EXPIRED: "SESSION_EXPIRED",
    MATCH_TIMEOUT: "MATCH_TIMEOUT",
    INTERNAL_ERROR: "INTERNAL_ERROR"
};

// Countries tracked as explicit cohorts in the dashboard. Australia is simply
// one cohort; the system works for every country.
const COHORT_COUNTRIES = ["AU", "TR", "US"];

const MAX_REFERRERS = 200; // bound distinct referrer domains in memory
const MAX_VISITORS = 20_000; // bound visitor map in memory
const MAX_SAMPLES = 1000; // ring-buffer cap for wait times
const MAX_SNAPSHOTS = 400; // rolling concurrency snapshots

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/*
 |--------------------------------------------------------------------------
 | STATE
 |--------------------------------------------------------------------------
 */

// Funnel stage counts: global, by country, language, referrer domain, experiment
const funnel = {};
const funnelCountry = {};
const funnelLanguage = {};
const funnelReferrer = {};
const funnelExperiment = {}; // experimentId -> variant -> stage -> count

// Traffic aggregates (referrer forensics + UTM)
const trafficByReferrer = {}; // referrer -> counts
const referrerForensics = {}; // country -> referrer -> counts
const utmStats = {}; // "source|medium|campaign" -> counts

// Match failures
const matchFailures = {};

// Per-country match wait times
const waitTimesByCountry = {};

// Visitor identity (return behavior). visitorId = random client token only.
const visitors = new Map();

const returnBehavior = {
    firstSessions: 0,
    secondSessions: 0,
    returningSessions: 0,
    returnWithin24h: 0,
    returnWithin7d: 0,
    reconnectConnections: 0
};

// Conversations that actually contained at least one message (quality signal)
let conversationsWithMessages = 0;

// Concurrency snapshots
const concurrency = {
    snapshots: [],
    peak: { connected: 0, waiting: 0, matched: 0, eligible: 0 },
    peakByCountry: {},
    peakByLanguage: {}
};

let snapshotProvider = null;
let snapshotTimer = null;

/*
 |--------------------------------------------------------------------------
 | EXPERIMENT FRAMEWORK (lightweight)
 |--------------------------------------------------------------------------
 */

/**
 * Australia Density Test — first experiment.
 *
 * The experiment changes TIMING + DISTRIBUTION, not core product logic.
 * When an event window is configured (via env), Australian sessions inside the
 * window are tagged `treatment`; Australian sessions outside the window are
 * tagged `control`. This is a real A/B comparison of queue→match conversion
 * driven by a timing/messaging change — no users are faked.
 */
const experiments = [
    {
        experimentId: "au-density-001",
        name: "Australia Density Test",
        hypothesis:
            "Concentrating Australian users into the same time window " +
            "increases successful match rate and conversation start rate.",
        cohort: { country: "AU" },
        control: "AU traffic outside the configured event window",
        treatment:
            "AU traffic inside the configured event window + cohort messaging",
        primaryMetric: "matchSuccessRate",
        secondaryMetrics: [
            "conversationStartRate",
            "queueToMatchConversion",
            "eligibleMatchingDensity"
        ],
        successThreshold: {
            minSessions: 20,
            minQueueJoins: 10,
            minMatches: 5,
            minConversationsOver2min: 3,
            queueToMatchImprovement: "meaningful-vs-baseline"
        },
        status: "planned",
        window: null
    }
];

/**
 * Parse the AU event window config from environment.
 *
 * Format: SHTM_AU_WINDOW="HH:MM-HH:MM@IANA_TZ"
 * Example: SHTM_AU_WINDOW="19:00-23:00@Australia/Sydney"
 * Enable:  SHTM_AU_WINDOW_ENABLED=1
 *
 * Windows may cross midnight (e.g. "22:00-02:00").
 */
function parseWindowConfig(env) {
    const enabled = env.SHTM_AU_WINDOW_ENABLED === "1";
    const raw = env.SHTM_AU_WINDOW;

    if (!enabled || !raw || typeof raw !== "string") {
        return null;
    }

    const match = raw.match(
        /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*(?:@\s*([A-Za-z_/+-]+))?$/
    );

    if (!match) {
        return null;
    }

    const toMinutes = (hh, mm) => Number(hh) * 60 + Number(mm);
    const startMinutes = toMinutes(match[1], match[2]);
    const endMinutes = toMinutes(match[3], match[4]);
    const timezone = match[5] || "Australia/Sydney";

    if (startMinutes < 0 || startMinutes > 1439) return null;
    if (endMinutes < 0 || endMinutes > 1439) return null;

    return { startMinutes, endMinutes, timezone };
}

function initExperiments() {
    const window = parseWindowConfig(process.env);
    if (window) {
        experiments[0].status = "active";
        experiments[0].window = window;
        experiments[0].startTime = new Date().toISOString();
    }
}

initExperiments();

function getTimePartsInTz(date, timezone) {
    try {
        const fmt = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        });
        const parts = fmt.formatToParts(date);
        const get = (type) =>
            parts.find((p) => p.type === type)?.value;

        let hour = Number(get("hour"));
        if (hour === 24) hour = 0;
        const minute = Number(get("minute"));

        return { hour, minute };
    } catch (_) {
        return null;
    }
}

function isInWindow(date, window) {
    if (!window) return false;
    const t = getTimePartsInTz(date, window.timezone);
    if (!t) return false;

    const now = t.hour * 60 + t.minute;

    if (window.startMinutes <= window.endMinutes) {
        return now >= window.startMinutes && now < window.endMinutes;
    }
    // cross-midnight window
    return now >= window.startMinutes || now < window.endMinutes;
}

/**
 * Determine experiment assignment for a socket context.
 * Returns { experimentId, variant } or { experimentId: null, variant: null }.
 *
 * Assignment is derived server-side from country (+ configured time window).
 * Never trust client-supplied experiment assignment.
 */
function assignExperiment(ctx) {
    const country = ctx && ctx.country;

    for (const exp of experiments) {
        const expCountry = exp.cohort && exp.cohort.country;
        if (!expCountry) continue;

        if (country !== expCountry) continue;

        if (exp.status !== "active" || !exp.window) {
            // Experiment not started: tag nothing, but keep measuring the
            // country cohort separately.
            return { experimentId: null, variant: null };
        }

        const variant = isInWindow(new Date(), exp.window)
            ? "treatment"
            : "control";

        return { experimentId: exp.experimentId, variant };
    }

    return { experimentId: null, variant: null };
}

/*
 |--------------------------------------------------------------------------
 | COHORT MESSAGING
 |--------------------------------------------------------------------------
 | Controlled messaging differences through configuration only.
 | No implication of false density: the AU message says only what is true.
 |--------------------------------------------------------------------------
 */

const COHORT_MESSAGES = {
    AU: {
        treatment: {
            searching: "People around the world are online right now."
        }
    }
};

function getCohortMessage(country, variant, stage) {
    const byCountry = COHORT_MESSAGES[country];
    if (!byCountry) return null;

    const byVariant = byCountry[variant];
    if (!byVariant) return null;

    return byVariant[stage] || null;
}

/*
 |--------------------------------------------------------------------------
 | REQUEST CONTEXT EXTRACTION
 |--------------------------------------------------------------------------
 */

function referrerDomain(raw) {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string") return null;

    const value = raw.trim();

    // No referrer means "direct". Some clients also send the literal "null".
    if (value === "" || value === "null" || value === "about:blank") {
        return "direct";
    }

    try {
        const url = new URL(value);
        return url.hostname ? url.hostname.toLowerCase() : "direct";
    } catch (_) {
        return null;
    }
}

function safeParam(value, maxLength = 64) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, maxLength);
}

function categorizeDevice(ua) {
    if (!ua || typeof ua !== "string") return "unknown";
    const s = ua.toLowerCase();
    if (/mobile|iphone|ipod|android/i.test(s)) return "mobile";
    if (/ipad|tablet/i.test(s)) return "tablet";
    if (/windows|macintosh|linux|cros/i.test(s)) return "desktop";
    return "other";
}

function categorizeBrowser(ua) {
    if (!ua || typeof ua !== "string") return "unknown";
    const s = ua.toLowerCase();

    // Bots / crawlers / monitoring agents (coarse, used only for forensics)
    if (
        /bot|crawler|spider|slurp|curl|wget|python-requests|headless|monitor|uptime|pingdom|statuscake/i.test(
            s
        )
    ) {
        return "bot";
    }

    if (/edg\//.test(s)) return "edge";
    if (/opr\//.test(s) || /opera/i.test(s)) return "opera";
    if (/chrome\//.test(s) && !/edg\//.test(s)) return "chrome";
    if (/firefox\//.test(s)) return "firefox";
    if (/safari\//.test(s) && !/chrome/.test(s)) return "safari";
    return "other";
}

/**
 * Build a normalized, privacy-safe analytics context from an Express request
 * or a Socket.IO handshake (both have `.headers` and `.query`).
 */
function ctxFromRequest(req) {
    const headers = (req && req.headers) || {};
    const query = (req && req.query) || {};

    const country = anl.getCountryFromRequest({ headers });
    const language = anl.getLanguageFromRequest({ headers });

    // Referrer: prefer client-supplied `ref` (document.referrer) since it is
    // more reliable than the handshake header; fall back to the HTTP header.
    const referrer = referrerDomain(
        query.ref !== undefined ? query.ref : headers.referer || headers.referrer
    );

    const ua = headers["user-agent"];

    return {
        country: country || null,
        language: language || null,
        referrer,
        utmSource: safeParam(query.utm_source),
        utmMedium: safeParam(query.utm_medium),
        utmCampaign: safeParam(query.utm_campaign),
        landing: safeParam(query.landing, 128) || "/",
        device: categorizeDevice(ua),
        browser: categorizeBrowser(ua),
        visitorId: safeParam(query.vid, 64) || null
    };
}

/*
 |--------------------------------------------------------------------------
 | LOW-LEVEL RECORDING HELPERS
 |--------------------------------------------------------------------------
 */

function bumpByStage(map, key, stage, variant) {
    if (!key) return;

    if (!map[key]) map[key] = {};
    const bucket = map[key];

    let target;
    if (variant) {
        if (!bucket[stage]) bucket[stage] = {};
        target = bucket[stage];
    } else {
        target = bucket;
    }

    target[stage] = (target[stage] || 0) + 1;
}

function attributeCohort(stage, ctx) {
    if (!ctx) return;
    bumpByStage(funnelCountry, ctx.country, stage);
    bumpByStage(funnelLanguage, ctx.language, stage);
    bumpByStage(funnelReferrer, ctx.referrer, stage);
}

function attributeExperiment(stage, ctx) {
    if (!ctx || !ctx.experimentId) return;

    if (!funnelExperiment[ctx.experimentId]) {
        funnelExperiment[ctx.experimentId] = {};
    }
    const variant = ctx.variant || "none";
    if (!funnelExperiment[ctx.experimentId][variant]) {
        funnelExperiment[ctx.experimentId][variant] = {};
    }
    funnelExperiment[ctx.experimentId][variant][stage] =
        (funnelExperiment[ctx.experimentId][variant][stage] || 0) + 1;
}

function attributeOne(stage, ctx) {
    attributeCohort(stage, ctx);
    attributeExperiment(stage, ctx);
    attributeTraffic(stage, ctx);
}

function record(stage, ctx = {}) {
    funnel[stage] = (funnel[stage] || 0) + 1;
    attributeOne(stage, ctx);
}

/**
 * Attribute a cohort dimension for a two-participant event. If both
 * participants share the same value (e.g. the same country), it is counted
 * once — so an AU↔AU match counts as one AU match, not two.
 */
function dedupeBump(map, keyA, keyB, stage) {
    if (keyA && keyB && keyA === keyB) {
        bumpByStage(map, keyA, stage);
    } else {
        if (keyA) bumpByStage(map, keyA, stage);
        if (keyB) bumpByStage(map, keyB, stage);
    }
}

/**
 * Record a stage that involves two participants exactly once globally (one
 * match / conversation), while attributing to each participant's country,
 * language, and referrer without double-counting shared values.
 */
function recordPair(stage, ctxA, ctxB) {
    funnel[stage] = (funnel[stage] || 0) + 1;

    const a = ctxA || {};
    const b = ctxB || {};

    dedupeBump(funnelCountry, a.country, b.country, stage);
    dedupeBump(funnelLanguage, a.language, b.language, stage);
    dedupeBump(funnelReferrer, a.referrer, b.referrer, stage);

    // Experiment assignment is per-socket, so attribute to each participant.
    attributeExperiment(stage, a);
    attributeExperiment(stage, b);

    attributeTrafficPair(stage, a, b);
}

const TRAFFIC_FIELD = {
    landing_view: "landingViews",
    connection_attempt: "connections",
    connection_success: "sessions",
    queue_join: "queueJoins",
    match_created: "matches",
    conversation_started: "conversations"
};

/**
 * Attribute traffic for a two-participant event without double-counting
 * when both participants share the same referrer / UTM.
 */
function attributeTrafficPair(stage, ctxA, ctxB) {
    const field = TRAFFIC_FIELD[stage];
    if (!field) return;

    const a = ctxA || {};
    const b = ctxB || {};

    // Referrer domain (dedupe same referrer)
    if (a.referrer && b.referrer && a.referrer === b.referrer) {
        bumpTrafficCount(trafficByReferrer, a.referrer, field);
    } else {
        if (a.referrer) bumpTrafficCount(trafficByReferrer, a.referrer, field);
        if (b.referrer) bumpTrafficCount(trafficByReferrer, b.referrer, field);
    }

    // Referrer forensics: country -> referrer (dedupe identical pairs)
    const forensicsPairs = new Set();
    for (const ctx of [a, b]) {
        if (ctx.country && ctx.referrer) {
            forensicsPairs.add(ctx.country + "\u0000" + ctx.referrer);
        }
    }
    for (const pair of forensicsPairs) {
        const [country, referrer] = pair.split("\u0000");
        if (!referrerForensics[country]) referrerForensics[country] = {};
        bumpTrafficCount(referrerForensics[country], referrer, field);
    }

    // UTM attribution (dedupe identical source|medium|campaign)
    const utmKeys = new Set();
    for (const ctx of [a, b]) {
        if (ctx.utmSource || ctx.utmMedium || ctx.utmCampaign) {
            utmKeys.add(
                [
                    ctx.utmSource || "-",
                    ctx.utmMedium || "-",
                    ctx.utmCampaign || "-"
                ].join("|")
            );
        }
    }
    for (const key of utmKeys) {
        bumpTrafficCount(utmStats, key, field);
    }
}

function bumpTrafficCount(map, key, field) {
    if (!map[key]) map[key] = zeroTrafficCounts();
    map[key][field] += 1;
}

function attributeTraffic(stage, ctx) {
    const field = TRAFFIC_FIELD[stage];
    if (!field) return;

    // Aggregate by referrer domain
    if (ctx.referrer) {
        if (!trafficByReferrer[ctx.referrer]) {
            trafficByReferrer[ctx.referrer] = zeroTrafficCounts();
        }
        trafficByReferrer[ctx.referrer][field] += 1;
    }

    // Referrer forensics: country -> referrer -> counts
    if (ctx.country && ctx.referrer) {
        if (!referrerForensics[ctx.country]) {
            referrerForensics[ctx.country] = {};
        }
        const byReferrer = referrerForensics[ctx.country];
        if (!byReferrer[ctx.referrer]) {
            byReferrer[ctx.referrer] = zeroTrafficCounts();
        }
        byReferrer[ctx.referrer][field] += 1;
    }

    // UTM attribution
    if (ctx.utmSource || ctx.utmMedium || ctx.utmCampaign) {
        const key = [
            ctx.utmSource || "-",
            ctx.utmMedium || "-",
            ctx.utmCampaign || "-"
        ].join("|");

        if (!utmStats[key]) utmStats[key] = zeroTrafficCounts();
        utmStats[key][field] += 1;
    }
}

function zeroTrafficCounts() {
    return {
        landingViews: 0,
        connections: 0,
        sessions: 0,
        queueJoins: 0,
        matches: 0,
        conversations: 0
    };
}

/*
 |--------------------------------------------------------------------------
 | PUBLIC TRACKING API
 |--------------------------------------------------------------------------
 */

function trackLandingView(ctx) {
    record("landing_view", ctx);
}

function trackCtaClick(ctx) {
    // The product auto-initiates connection; the connection attempt IS the
    // primary CTA. Tracked separately to match the funnel model.
    record("primary_cta_click", ctx);
}

function trackConnectionAttempt(ctx) {
    record("connection_attempt", ctx);
}

function trackConnectionSuccess(ctx) {
    record("connection_success", ctx);
}

function trackSessionCreated(ctx) {
    record("session_created", ctx);
}

function trackSessionReady(ctx) {
    record("session_ready", ctx);
}

function trackQueueJoin(ctx) {
    record("queue_join", ctx);
}

function trackQueueLeave(ctx) {
    record("queue_leave", ctx);
}

function trackMatchAttempt(ctx) {
    record("match_attempt", ctx);
}

function trackMatchCandidateFound(ctx) {
    record("match_candidate_found", ctx);
}

function trackMatchCreated(ctx) {
    record("match_created", ctx);
}

function trackMatchConfirmed(ctx) {
    record("match_confirmed", ctx);
}

function trackMatchCreatedPair(ctxA, ctxB) {
    recordPair("match_created", ctxA, ctxB);
    recordPair("match_confirmed", ctxA, ctxB);
}

function trackConversationStartedPair(ctxA, ctxB) {
    recordPair("conversation_started", ctxA, ctxB);
}

function trackConversationStarted(ctx) {
    record("conversation_started", ctx);
}

function trackConversationMessage(ctx) {
    record("conversation_message", ctx);
}

function trackConversationEnded(ctx) {
    record("conversation_ended", ctx);
}

function trackConversationEndedPair(ctxA, ctxB) {
    recordPair("conversation_ended", ctxA, ctxB);
}

function trackConversationWithMessage() {
    conversationsWithMessages += 1;
}

function trackMatchFailure(reason, ctx) {
    if (!MATCH_FAILURE_REASONS[reason]) {
        reason = MATCH_FAILURE_REASONS.INTERNAL_ERROR;
    }
    matchFailures[reason] = (matchFailures[reason] || 0) + 1;
}

function trackMatchWaitTime(country, ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    if (!country) return;

    if (!waitTimesByCountry[country]) {
        waitTimesByCountry[country] = [];
    }
    const buf = waitTimesByCountry[country];
    buf.push(ms);
    if (buf.length > MAX_SAMPLES) buf.shift();
}

/*
 |--------------------------------------------------------------------------
 | PRODUCT EVENT TRACKING (additive)
 |--------------------------------------------------------------------------
 */

function trackProductEvent(name, ctx) {
    if (!PRODUCT_STAGES.includes(name)) return;
    record(name, ctx || {});
}

/*
 |--------------------------------------------------------------------------
 | VISITOR / RETURN BEHAVIOR
 |--------------------------------------------------------------------------
 */

/**
 * Register a visitor connection and classify return behavior.
 * Uses only the client-generated random visitor id — no identity, no storage.
 */
function registerVisitor(visitorId) {
    if (!visitorId) {
        return { isNew: false, returning: false, within24h: false, within7d: false };
    }

    const now = Date.now();
    const existing = visitors.get(visitorId);

    if (!existing) {
        if (visitors.size >= MAX_VISITORS) {
            // Memory guard: treat as a new session without retaining the id.
            returnBehavior.firstSessions += 1;
            return { isNew: true, returning: false, within24h: false, within7d: false };
        }

        visitors.set(visitorId, {
            firstSeenAt: now,
            lastSeenAt: now,
            sessions: 1
        });

        returnBehavior.firstSessions += 1;

        return { isNew: true, returning: false, within24h: false, within7d: false };
    }

    const sinceLast = now - existing.lastSeenAt;
    const sinceFirst = now - existing.firstSeenAt;

    existing.lastSeenAt = now;
    existing.sessions += 1;

    returnBehavior.reconnectConnections += 1;

    const result = {
        isNew: false,
        returning: true,
        within24h: sinceLast <= DAY_MS,
        within7d: sinceFirst <= WEEK_MS
    };

    returnBehavior.returningSessions += 1;

    if (existing.sessions === 2) {
        returnBehavior.secondSessions += 1;
    }
    if (result.within24h) returnBehavior.returnWithin24h += 1;
    if (result.within7d) returnBehavior.returnWithin7d += 1;

    return result;
}

/*
 |--------------------------------------------------------------------------
 | CONCURRENCY SNAPSHOTS
 |--------------------------------------------------------------------------
 */

function setSnapshotProvider(fn) {
    snapshotProvider = fn;
}

function takeSnapshot() {
    if (!snapshotProvider) return;

    const snap = snapshotProvider();

    concurrency.snapshots.push(snap);
    if (concurrency.snapshots.length > MAX_SNAPSHOTS) {
        concurrency.snapshots.shift();
    }

    const g = snap.global || {};
    concurrency.peak.connected = Math.max(
        concurrency.peak.connected,
        g.connected || 0
    );
    concurrency.peak.waiting = Math.max(concurrency.peak.waiting, g.waiting || 0);
    concurrency.peak.matched = Math.max(concurrency.peak.matched, g.matched || 0);
    concurrency.peak.eligible = Math.max(
        concurrency.peak.eligible,
        g.eligible || 0
    );

    for (const [code, counts] of Object.entries(snap.countries || {})) {
        if (!concurrency.peakByCountry[code]) {
            concurrency.peakByCountry[code] = { connected: 0, waiting: 0 };
        }
        concurrency.peakByCountry[code].connected = Math.max(
            concurrency.peakByCountry[code].connected,
            counts.connected || 0
        );
        concurrency.peakByCountry[code].waiting = Math.max(
            concurrency.peakByCountry[code].waiting,
            counts.waiting || 0
        );
    }

    for (const [code, counts] of Object.entries(snap.languages || {})) {
        if (!concurrency.peakByLanguage[code]) {
            concurrency.peakByLanguage[code] = { connected: 0, waiting: 0 };
        }
        concurrency.peakByLanguage[code].connected = Math.max(
            concurrency.peakByLanguage[code].connected,
            counts.connected || 0
        );
        concurrency.peakByLanguage[code].waiting = Math.max(
            concurrency.peakByLanguage[code].waiting,
            counts.waiting || 0
        );
    }
}

function startSnapshots(intervalMs = 30_000) {
    if (snapshotTimer) return;
    snapshotTimer = setInterval(() => {
        takeSnapshot();
    }, intervalMs);
    if (snapshotTimer.unref) snapshotTimer.unref();
}

/*
 |--------------------------------------------------------------------------
 | STATISTICS MATH (local, explicit denominators)
 |--------------------------------------------------------------------------
 */

function average(arr) {
    if (!arr || !arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
    if (!arr || !arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(arr, p) {
    if (!arr || !arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const pos = (sorted.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function pct(numerator, denominator) {
    if (!denominator) return 0;
    return (numerator / denominator) * 100;
}

/*
 |--------------------------------------------------------------------------
 | STATS RESPONSE
 |--------------------------------------------------------------------------
 */

function stageCount(map, stage) {
    return (map && map[stage]) || 0;
}

function sumStages(map, stage) {
    if (!map) return 0;
    let total = 0;
    for (const key of Object.keys(map)) {
        total += stageCount(map[key], stage);
    }
    return total;
}

function buildCohortFunnel() {
    const cohorts = {};

    const build = (stages) => ({
        sessions: stageCount(stages, "session_created"),
        connections: stageCount(stages, "connection_success"),
        successfulConnections: stageCount(stages, "connection_success"),
        sessionReady: stageCount(stages, "session_ready"),
        queueJoins: stageCount(stages, "queue_join"),
        matchAttempts: stageCount(stages, "match_attempt"),
        matches: stageCount(stages, "match_created"),
        conversationsStarted: stageCount(stages, "conversation_started"),
        conversationsCompleted: stageCount(stages, "conversation_ended"),
        conversionRates: computedRates(stages)
    });

    cohorts.GLOBAL = build(funnel);

    for (const code of COHORT_COUNTRIES) {
        cohorts[code] = build(funnelCountry[code] || {});
    }

    // OTHER = global minus explicitly-tracked cohorts
    const otherStages = {};
    for (const stage of FUNNEL_STAGES) {
        const global = stageCount(funnel, stage);
        let tracked = 0;
        for (const code of COHORT_COUNTRIES) {
            tracked += stageCount(funnelCountry[code] || {}, stage);
        }
        otherStages[stage] = Math.max(0, global - tracked);
    }
    cohorts.OTHER = build(otherStages);

    return cohorts;
}

function computedRates(stages) {
    const connectionSuccess = stageCount(stages, "connection_success");
    const connectionAttempt = stageCount(stages, "connection_attempt");
    const queueJoin = stageCount(stages, "queue_join");
    const matchAttempt = stageCount(stages, "match_attempt");
    const matchCreated = stageCount(stages, "match_created");
    const conversationStarted = stageCount(stages, "conversation_started");
    const conversationEnded = stageCount(stages, "conversation_ended");

    return {
        connectionSuccessRate: pct(connectionSuccess, connectionAttempt),
        queueConversion: pct(queueJoin, connectionSuccess),
        matchSuccessRate: pct(matchCreated, matchAttempt),
        conversationStartRate: pct(conversationStarted, matchCreated),
        conversationCompletionRate: pct(conversationEnded, conversationStarted)
    };
}

function averageConcurrent() {
    const snaps = concurrency.snapshots;
    if (!snaps.length) {
        return { connected: 0, waiting: 0, matched: 0, eligible: 0 };
    }

    const avg = (field) =>
        Math.round(
            average(snaps.map((s) => (s.global && s.global[field]) || 0))
        );

    return {
        connected: avg("connected"),
        waiting: avg("waiting"),
        matched: avg("matched"),
        eligible: avg("eligible")
    };
}

function countryDensity(code) {
    const snaps = concurrency.snapshots.filter(
        (s) => s.countries && s.countries[code]
    );

    let peakConnected = 0;
    let peakWaiting = 0;
    let sumConnected = 0;

    for (const snap of snaps) {
        const c = snap.countries[code];
        peakConnected = Math.max(peakConnected, c.connected || 0);
        peakWaiting = Math.max(peakWaiting, c.waiting || 0);
        sumConnected += c.connected || 0;
    }

    const latest = concurrency.snapshots[concurrency.snapshots.length - 1];
    const matchablePopulation = latest &&
        latest.countries &&
        latest.countries[code]
        ? latest.countries[code].eligible || 0
        : 0;

    const waitTimes = waitTimesByCountry[code] || [];

    return {
        country: code,
        peakConcurrentUsers: peakConnected,
        averageConcurrentUsers: snaps.length
            ? Math.round(sumConnected / snaps.length)
            : 0,
        peakQueueSize: peakWaiting,
        matchablePopulation,
        waitSamples: waitTimes.length,
        avgWaitMs: Math.round(average(waitTimes)),
        p50WaitMs: Math.round(percentile(waitTimes, 0.5)),
        p95WaitMs: Math.round(percentile(waitTimes, 0.95)),
        matchSuccessRate: pct(
            stageCount(funnelCountry[code] || {}, "match_created"),
            stageCount(funnelCountry[code] || {}, "match_attempt")
        )
    };
}

function buildMatchFailures() {
    return Object.entries(matchFailures)
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count);
}

function buildTrafficSources() {
    const referrers = Object.entries(trafficByReferrer)
        .map(([domain, counts]) => ({ domain, ...counts }))
        .sort((a, b) => b.sessions - a.sessions)
        .slice(0, 50);

    const forensics = [];
    for (const [country, byReferrer] of Object.entries(referrerForensics)) {
        for (const [referrer, counts] of Object.entries(byReferrer)) {
            forensics.push({ country, referrer, ...counts });
        }
    }
    forensics.sort((a, b) => b.sessions - a.sessions);

    const utm = Object.entries(utmStats).map(([key, counts]) => {
        const [source, medium, campaign] = key.split("|");
        return { source, medium, campaign, ...counts };
    });

    return { referrers, forensics, utm };
}

function buildExperiments() {
    return experiments.map((exp) => {
        const byVariant = funnelExperiment[exp.experimentId] || {};

        const variants = Object.entries(byVariant)
            .map(([variant, stages]) => ({
                variant,
                sessions: stageCount(stages, "session_created"),
                queueJoins: stageCount(stages, "queue_join"),
                matchAttempts: stageCount(stages, "match_attempt"),
                matches: stageCount(stages, "match_created"),
                conversationsStarted: stageCount(stages, "conversation_started"),
                matchSuccessRate: pct(
                    stageCount(stages, "match_created"),
                    stageCount(stages, "match_attempt")
                )
            }))
            .sort((a, b) => a.variant.localeCompare(b.variant));

        return { ...exp, variants };
    });
}

function uniqueSessions() {
    return visitors.size;
}

function getStats() {
    const currentConcurrency = snapshotProvider ? snapshotProvider() : {
        global: { connected: 0, waiting: 0, matched: 0, eligible: 0 },
        countries: {},
        languages: {}
    };

    const successfulConnections = stageCount(funnel, "connection_success");
    const conversationsStarted = stageCount(funnel, "conversation_started");

    return {
        growth: {
            totalSessions: stageCount(funnel, "session_created"),
            uniqueSessions: uniqueSessions(),
            connections: successfulConnections,
            queueJoins: stageCount(funnel, "queue_join"),
            matches: stageCount(funnel, "match_created"),
            conversations: conversationsStarted,
            conversationsCompleted: stageCount(funnel, "conversation_ended"),
            conversationsWithMessages,
            networkEffectiveness: pct(
                conversationsWithMessages,
                successfulConnections
            )
        },

        funnel: FUNNEL_STAGES.map((stage) => ({
            stage,
            count: stageCount(funnel, stage)
        })),

        productEvents: PRODUCT_STAGES.map((stage) => ({
            stage,
            count: stageCount(funnel, stage)
        })),

        cohorts: buildCohortFunnel(),

        trafficSources: buildTrafficSources(),

        networkDensity: {
            current: currentConcurrency.global || {},
            peak: concurrency.peak,
            average: averageConcurrent(),
            countries: Object.keys(concurrency.peakByCountry)
                .sort()
                .map((code) => {
                    const peak = concurrency.peakByCountry[code];
                    return {
                        country: code,
                        peakConnected: peak.connected,
                        peakWaiting: peak.waiting
                    };
                }),
            marketDensity: COHORT_COUNTRIES.map((code) => countryDensity(code))
        },

        matchFailures: buildMatchFailures(),

        experiments: buildExperiments(),

        returnBehavior: {
            firstSessions: returnBehavior.firstSessions,
            secondSessions: returnBehavior.secondSessions,
            returningSessions: returnBehavior.returningSessions,
            returnWithin24h: returnBehavior.returnWithin24h,
            returnWithin7d: returnBehavior.returnWithin7d,
            reconnectConnections: returnBehavior.reconnectConnections
        }
    };
}

/*
 |--------------------------------------------------------------------------
 | RESET (tests)
 |--------------------------------------------------------------------------
 */

function reset() {
    for (const key of Object.keys(funnel)) delete funnel[key];
    for (const key of Object.keys(funnelCountry)) delete funnelCountry[key];
    for (const key of Object.keys(funnelLanguage)) delete funnelLanguage[key];
    for (const key of Object.keys(funnelReferrer)) delete funnelReferrer[key];
    for (const key of Object.keys(funnelExperiment)) delete funnelExperiment[key];

    for (const key of Object.keys(trafficByReferrer)) delete trafficByReferrer[key];
    for (const key of Object.keys(referrerForensics)) delete referrerForensics[key];
    for (const key of Object.keys(utmStats)) delete utmStats[key];

    for (const key of Object.keys(matchFailures)) delete matchFailures[key];
    for (const key of Object.keys(waitTimesByCountry)) delete waitTimesByCountry[key];

    visitors.clear();

    returnBehavior.firstSessions = 0;
    returnBehavior.secondSessions = 0;
    returnBehavior.returningSessions = 0;
    returnBehavior.returnWithin24h = 0;
    returnBehavior.returnWithin7d = 0;
    returnBehavior.reconnectConnections = 0;

    conversationsWithMessages = 0;

    concurrency.snapshots.length = 0;
    concurrency.peak = { connected: 0, waiting: 0, matched: 0, eligible: 0 };
    for (const key of Object.keys(concurrency.peakByCountry)) {
        delete concurrency.peakByCountry[key];
    }
    for (const key of Object.keys(concurrency.peakByLanguage)) {
        delete concurrency.peakByLanguage[key];
    }
}

module.exports = {
    // constants
    FUNNEL_STAGES,
    PRODUCT_STAGES,
    MATCH_FAILURE_REASONS,

    // context
    ctxFromRequest,
    referrerDomain,

    // tracking
    trackLandingView,
    trackCtaClick,
    trackConnectionAttempt,
    trackConnectionSuccess,
    trackSessionCreated,
    trackSessionReady,
    trackQueueJoin,
    trackQueueLeave,
    trackMatchAttempt,
    trackMatchCandidateFound,
    trackMatchCreated,
    trackMatchConfirmed,
    trackMatchCreatedPair,
    trackConversationStarted,
    trackConversationStartedPair,
    trackConversationMessage,
    trackConversationEnded,
    trackConversationEndedPair,
    trackConversationWithMessage,
    trackMatchFailure,
    trackMatchWaitTime,
    trackProductEvent,

    // visitor / return
    registerVisitor,

    // concurrency
    setSnapshotProvider,
    takeSnapshot,
    startSnapshots,

    // experiments
    assignExperiment,
    getCohortMessage,
    isInWindow,
    getExperiments: () => experiments,

    // stats
    getStats,
    reset,

    // expose internals for tests
    _funnel: funnel,
    _funnelCountry: funnelCountry,
    _matchFailures: matchFailures,
    _returnBehavior: returnBehavior,
    _concurrency: concurrency,
    _visitors: visitors
};