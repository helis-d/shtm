/*
|==============================================================================
| SHTM — ANALYTICS MODULE
|==============================================================================
|
| Anonymous aggregate statistics tracking for /stats page.
| NO personally identifiable information is collected.
|
| Tracks: connections, disconnects, matches, conversations, wait times,
|          durations, latency, country/language distribution, system metrics.
|
| DESIGN: In-memory (single Vercel instance). Data resets on cold start.
|         This is acceptable for the current MVP — stats represent
|         the current instance's lifetime, not historical data.
|
| PRIVACY: Only aggregate counts and distributions. No IPs, session IDs,
|          socket IDs, or individual user data is exposed.
|
| METRIC CORRECTNESS:
|   Denominators are explicit and documented. Rates are computed from
|   matching numerator/denominator pairs:
|
|     connectionSuccessRate = acceptedConnections / connectionAttempts
|     connectionFailureRate = rejectedConnections / connectionAttempts
|     matchSuccessRate      = matchesCompleted    / matchesStarted
|     matchFailureRate      = matchesAborted      / matchesStarted
|     conversationRate      = conversationsEnded  / conversationsStarted
|
|   "disconnectRate" is intentionally reported as churn: disconnected /
|   acceptedConnections. It is NOT a failure metric.
|==============================================================================
*/

const CHAT_DURATION = 60_000;

/*
|--------------------------------------------------------------------------
| EVENT STORE
|--------------------------------------------------------------------------
*/

const events = {
    // Connection lifecycle (attempts include rejected handshakes)
    connectionAttempts: 0,
    connectionAccepted: 0,
    connectionRejected: 0,
    disconnects: 0,

    // Match lifecycle
    matchesStarted: 0,
    matchesCompleted: 0,
    matchesAborted: 0,

    // Conversation lifecycle
    conversationsStarted: 0,
    conversationsEnded: 0,

    totalMessages: 0,
    totalImages: 0,
    rateLimitViolations: 0
};

const countries = {};
const languages = {};

// Disconnect reason distribution (categories, not personal data)
const disconnectReasons = {};

const matchWaitTimes = [];
const conversationDurations = [];
const wsLatencies = [];

// Session lifetimes (ms) for p50/p95/p99 socket-lifetime metrics
const socketLifetimes = [];

// Maximum samples to keep in memory (prevent unbounded growth)
const MAX_SAMPLES = 1000;

/*
|--------------------------------------------------------------------------
| TRACKING
|--------------------------------------------------------------------------
*/

function trackConnectionAttempt() {
    events.connectionAttempts += 1;
}

function trackConnectionAccepted(country, language) {
    events.connectionAccepted += 1;

    if (country) {
        countries[country] = (countries[country] || 0) + 1;
    }

    if (language) {
        languages[language] = (languages[language] || 0) + 1;
    }
}

// Backward-compatible alias: historically named "trackConnection"
function trackConnection(country, language) {
    trackConnectionAccepted(country, language);
}

function trackConnectionRejected() {
    events.connectionRejected += 1;
}

function trackDisconnect(reasonCategory) {
    events.disconnects += 1;

    if (reasonCategory) {
        disconnectReasons[reasonCategory] =
            (disconnectReasons[reasonCategory] || 0) + 1;
    }
}

function trackSocketLifetime(ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    socketLifetimes.push(ms);
    if (socketLifetimes.length > MAX_SAMPLES) {
        socketLifetimes.shift();
    }
}

function trackMatchStarted() {
    events.matchesStarted += 1;
}

function trackMatchWaitTime(ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    matchWaitTimes.push(ms);
    if (matchWaitTimes.length > MAX_SAMPLES) {
        matchWaitTimes.shift();
    }
}

function trackMatchCompleted() {
    events.matchesCompleted += 1;
}

function trackMatchAborted() {
    events.matchesAborted += 1;
}

function trackConversationStarted() {
    events.conversationsStarted += 1;
}

function trackConversationEnded(durationMs) {
    events.conversationsEnded += 1;
    if (Number.isFinite(durationMs) && durationMs >= 0) {
        conversationDurations.push(durationMs);
        if (conversationDurations.length > MAX_SAMPLES) {
            conversationDurations.shift();
        }
    }
}

function trackMessage() {
    events.totalMessages += 1;
}

function trackImage() {
    events.totalImages += 1;
}

function trackRateLimitViolation() {
    events.rateLimitViolations += 1;
}

function trackWSLatency(ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    wsLatencies.push(ms);
    if (wsLatencies.length > MAX_SAMPLES) {
        wsLatencies.shift();
    }
}

/*
|--------------------------------------------------------------------------
| COUNTRY / LANGUAGE HELPERS
|--------------------------------------------------------------------------
*/

/**
 * Extract country code from Vercel headers or socket headers.
 * Vercel provides: x-vercel-ip-country (ISO 3166-1 alpha-2)
 */
function getCountryFromRequest(req) {
    const raw =
        req?.headers?.["x-vercel-ip-country"] ||
        req?.headers?.["cf-ipcountry"] ||
        "";
    return raw ? raw.toUpperCase() : null;
}

/**
 * Extract language preference from Accept-Language header.
 */
function getLanguageFromRequest(req) {
    const header = req?.headers?.["accept-language"] || "";
    const match = header.match(/^([a-zA-Z]{2})/);
    if (match) {
        const code = match[1].toLowerCase();
        if (code === "tr") return "tr";
        if (code === "en") return "en";
        return code;
    }
    return null;
}

const COUNTRY_NAMES = {
    TR: "Turkey",
    US: "United States",
    DE: "Germany",
    GB: "United Kingdom",
    FR: "France",
    IT: "Italy",
    ES: "Spain",
    NL: "Netherlands",
    SE: "Sweden",
    NO: "Norway",
    DK: "Denmark",
    FI: "Finland",
    PL: "Poland",
    UA: "Ukraine",
    RU: "Russia",
    CN: "China",
    JP: "Japan",
    KR: "South Korea",
    IN: "India",
    BR: "Brazil",
    MX: "Mexico",
    CA: "Canada",
    AU: "Australia",
    NZ: "New Zealand",
    ZA: "South Africa",
    EG: "Egypt",
    SA: "Saudi Arabia",
    AE: "United Arab Emirates",
    SG: "Singapore",
    MY: "Malaysia",
    ID: "Indonesia",
    TH: "Thailand",
    VN: "Vietnam",
    PH: "Philippines",
    PK: "Pakistan",
    BD: "Bangladesh",
    NG: "Nigeria",
    KE: "Kenya",
    AR: "Argentina",
    CL: "Chile",
    CO: "Colombia",
    PE: "Peru",
    PT: "Portugal",
    AT: "Austria",
    CH: "Switzerland",
    BE: "Belgium",
    GR: "Greece",
    CZ: "Czech Republic",
    HU: "Hungary",
    RO: "Romania",
    BG: "Bulgaria",
    IE: "Ireland",
    IL: "Israel",
    TW: "Taiwan",
    HK: "Hong Kong"
};

function countryName(code) {
    return COUNTRY_NAMES[code] || code;
}

const LANGUAGE_NAMES = {
    tr: "Turkish",
    en: "English",
    de: "German",
    fr: "French",
    it: "Italian",
    es: "Spanish",
    pt: "Portuguese",
    nl: "Dutch",
    sv: "Swedish",
    no: "Norwegian",
    da: "Danish",
    fi: "Finnish",
    pl: "Polish",
    ru: "Russian",
    ja: "Japanese",
    ko: "Korean",
    zh: "Chinese",
    ar: "Arabic",
    hi: "Hindi",
    bn: "Bengali",
    ur: "Urdu",
    id: "Indonesian",
    th: "Thai",
    vi: "Vietnamese",
    ms: "Malay",
    ro: "Romanian",
    cs: "Czech",
    hu: "Hungarian",
    bg: "Bulgarian",
    el: "Greek",
    he: "Hebrew"
};

function languageName(code) {
    return LANGUAGE_NAMES[code] || code;
}

/*
|--------------------------------------------------------------------------
| STATISTICS MATH
|--------------------------------------------------------------------------
*/

function average(arr) {
    if (!arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Linear-interpolated percentile (p in [0, 1]).
 */
function percentile(arr, p) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const pos = (sorted.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function max(arr) {
    if (!arr.length) return 0;
    return Math.max(...arr);
}

/**
 * Compute a rate as a percentage string with an explicit numerator and
 * denominator. Returns "0.0" when the denominator is zero (no data), never
 * NaN or Infinity.
 */
function rate(numerator, denominator) {
    if (!denominator) return "0.0";
    return ((numerator / denominator) * 100).toFixed(1);
}

function getCountryDistribution() {
    const total = Object.values(countries).reduce((a, b) => a + b, 0);

    return Object.entries(countries)
        .map(([code, count]) => ({
            code,
            name: countryName(code),
            count,
            percentage: total ? ((count / total) * 100).toFixed(1) : "0.0"
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
}

function getLanguageDistribution() {
    const total = Object.values(languages).reduce((a, b) => a + b, 0);

    return Object.entries(languages)
        .map(([code, count]) => ({
            code,
            name: languageName(code),
            count,
            percentage: total ? ((count / total) * 100).toFixed(1) : "0.0"
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
}

function getDisconnectReasonDistribution() {
    const total = Object.values(disconnectReasons).reduce((a, b) => a + b, 0);

    return Object.entries(disconnectReasons)
        .map(([reason, count]) => ({
            reason,
            count,
            percentage: total ? ((count / total) * 100).toFixed(1) : "0.0"
        }))
        .sort((a, b) => b.count - a.count);
}

/**
 * Get the active user/session count from the main server.
 * Injected by api/index.js since it has access to io.
 */
let getActiveUserCount = () => 0;
let getActiveMatchCount = () => 0;
let getWaitingUserCount = () => 0;

function setActiveCountGetters(
    activeUsersFn,
    activeMatchesFn,
    waitingUsersFn
) {
    getActiveUserCount = activeUsersFn;
    getActiveMatchCount = activeMatchesFn;
    getWaitingUserCount = waitingUsersFn;
}

/*
|--------------------------------------------------------------------------
| FULL STATS RESPONSE
|--------------------------------------------------------------------------
*/

function getStats() {
    const attempts = events.connectionAttempts;
    const accepted = events.connectionAccepted;
    const rejected = events.connectionRejected;
    const disconnects = events.disconnects;

    const started = events.matchesStarted;
    const completed = events.matchesCompleted;
    const aborted = events.matchesAborted;

    const activeUsers = getActiveUserCount();
    const activeMatches = getActiveMatchCount();
    const waitingUsers = getWaitingUserCount();

    return {
        timestamp: Date.now(),

        global: {
            totalConnections: accepted,
            totalMatches: started,
            totalConversations: events.conversationsStarted,
            activeUsers,
            activeMatches,
            waitingUsers,
            avgMatchWaitMs: Math.round(average(matchWaitTimes)),
            avgConversationDurationMs: Math.round(
                average(conversationDurations)
            )
        },

        countries: getCountryDistribution(),

        languages: getLanguageDistribution(),

        matching: {
            started,
            completed,
            aborted,
            successfulMatches: completed,
            avgWaitMs: Math.round(average(matchWaitTimes)),
            p50WaitMs: Math.round(percentile(matchWaitTimes, 0.5)),
            p95WaitMs: Math.round(percentile(matchWaitTimes, 0.95)),
            p99WaitMs: Math.round(percentile(matchWaitTimes, 0.99)),
            longestWaitMs: Math.round(max(matchWaitTimes)),
            matchSuccessRate: rate(completed, started) + "%",
            matchFailureRate: rate(aborted, started) + "%",
            activeMatches
        },

        conversation: {
            started: events.conversationsStarted,
            completed: events.conversationsEnded,
            avgDurationMs: Math.round(average(conversationDurations)),
            p50DurationMs: Math.round(percentile(conversationDurations, 0.5)),
            p95DurationMs: Math.round(percentile(conversationDurations, 0.95)),
            medianDurationMs: Math.round(median(conversationDurations)),
            avgMessagesPerConversation: events.conversationsStarted
                ? (events.totalMessages / events.conversationsStarted).toFixed(1)
                : "0.0",
            completionRate:
                rate(events.conversationsEnded, events.conversationsStarted) +
                "%"
        },

        system: {
            connectionAttempts: attempts,
            connectionAccepted: accepted,
            connectionRejected: rejected,
            connectionSuccessRate: rate(accepted, attempts) + "%",
            connectionFailureRate: rate(rejected, attempts) + "%",
            disconnectCount: disconnects,
            disconnectRate: rate(disconnects, accepted) + "%",
            avgWSLatencyMs: Math.round(average(wsLatencies)),
            p50WSLatencyMs: Math.round(percentile(wsLatencies, 0.5)),
            p95WSLatencyMs: Math.round(percentile(wsLatencies, 0.95)),
            p99WSLatencyMs: Math.round(percentile(wsLatencies, 0.99)),
            avgSocketLifetimeMs: Math.round(average(socketLifetimes)),
            p50SocketLifetimeMs: Math.round(percentile(socketLifetimes, 0.5)),
            p95SocketLifetimeMs: Math.round(percentile(socketLifetimes, 0.95)),
            apiErrors: events.rateLimitViolations
        },

        disconnectReasons: getDisconnectReasonDistribution()
    };
}

/*
|--------------------------------------------------------------------------
| RESET
|--------------------------------------------------------------------------
*/

function reset() {
    for (const key of Object.keys(events)) events[key] = 0;
    for (const key of Object.keys(countries)) delete countries[key];
    for (const key of Object.keys(languages)) delete languages[key];
    for (const key of Object.keys(disconnectReasons)) {
        delete disconnectReasons[key];
    }

    matchWaitTimes.length = 0;
    conversationDurations.length = 0;
    wsLatencies.length = 0;
    socketLifetimes.length = 0;
}

module.exports = {
    // Tracking
    trackConnectionAttempt,
    trackConnection,
    trackConnectionAccepted,
    trackConnectionRejected,
    trackDisconnect,
    trackSocketLifetime,
    trackMatchStarted,
    trackMatchWaitTime,
    trackMatchCompleted,
    trackMatchAborted,
    trackConversationStarted,
    trackConversationEnded,
    trackMessage,
    trackImage,
    trackRateLimitViolation,
    trackWSLatency,

    // Helpers
    getCountryFromRequest,
    getLanguageFromRequest,
    average,
    median,
    percentile,
    rate,

    // Stats
    getStats,
    setActiveCountGetters,
    reset,

    // Expose for testing
    _events: events,
    _countries: countries,
    _languages: languages,
    _disconnectReasons: disconnectReasons
};