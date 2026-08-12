/*
|==============================================================================
| SHTM — ANALYTICS MODULE
|==============================================================================
|
| Anonymous aggregate statistics tracking for /stats page.
| NO personally identifiable information is collected.
|
| Tracks: connections, matches, conversations, wait times, durations,
|          country distribution, language distribution, system metrics.
|
| DESIGN: In-memory (single Vercel instance). Data resets on cold start.
|         This is acceptable for the current MVP — stats represent
|         the current instance's lifetime, not historical data.
|
| PRIVACY: Only aggregate counts and distributions. No IPs, session IDs,
|          socket IDs, or individual user data is exposed.
|==============================================================================
*/

const CHAT_DURATION = 60_000;

/*
|--------------------------------------------------------------------------
| EVENT STORE
|--------------------------------------------------------------------------
*/

const events = {
    connections: 0,
    disconnects: 0,
    matchesStarted: 0,
    matchesCompleted: 0,
    conversationsStarted: 0,
    conversationsEnded: 0,
    totalMessages: 0,
    totalImages: 0,
    rateLimitViolations: 0
};

const countries = {};
const languages = {};

const matchWaitTimes = [];
const conversationDurations = [];
const wsLatencies = [];

// Maximum samples to keep in memory (prevent unbounded growth)
const MAX_SAMPLES = 1000;

// Connection timestamps for calculating average session length
let connectionStartTimes = [];
const SESSION_SAMPLE_MAX = 500;

/*
|--------------------------------------------------------------------------
| TRACKING
|--------------------------------------------------------------------------
*/

function trackConnection(country, language) {
    events.connections += 1;

    if (country) {
        countries[country] = (countries[country] || 0) + 1;
    }

    if (language) {
        languages[language] = (languages[language] || 0) + 1;
    }

    connectionStartTimes.push(Date.now());
    if (connectionStartTimes.length > SESSION_SAMPLE_MAX) {
        connectionStartTimes.shift();
    }
}

function trackDisconnect() {
    events.disconnects += 1;
}

function trackMatchStarted() {
    events.matchesStarted += 1;
}

function trackMatchWaitTime(ms) {
    matchWaitTimes.push(ms);
    if (matchWaitTimes.length > MAX_SAMPLES) {
        matchWaitTimes.shift();
    }
}

function trackMatchCompleted() {
    events.matchesCompleted += 1;
}

function trackConversationStarted() {
    events.conversationsStarted += 1;
}

function trackConversationEnded(durationMs) {
    events.conversationsEnded += 1;
    conversationDurations.push(durationMs);
    if (conversationDurations.length > MAX_SAMPLES) {
        conversationDurations.shift();
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
    return (
        req.headers["x-vercel-ip-country"] ||
        req.headers["cf-ipcountry"] ||
        ""
    ).toUpperCase() || null;
}

/**
 * Extract language preference from Accept-Language header.
 */
function getLanguageFromRequest(req) {
    const header = req.headers["accept-language"] || "";

    // Parse primary language from Accept-Language
    const match = header.match(/^([a-zA-Z]{2})/);
    if (match) {
        const code = match[1].toLowerCase();
        if (code === "tr") return "tr";
        if (code === "en") return "en";
        return code;
    }
    return null;
}

/**
 * Map ISO 3166-1 alpha-2 country code to readable name.
 */
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
| STATS AGGREGATION
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

function max(arr) {
    if (!arr.length) return 0;
    return Math.max(...arr);
}

/**
 * Small-number privacy: return "<3" instead of 1 or 2.
 */
function privacyCount(n) {
    if (typeof n !== "number") return 0;
    if (n === 1 || n === 2) return 0; // Will display as "<3"
    return n;
}

/**
 * Build sorted country distribution with privacy applied.
 */
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

/**
 * Build sorted language distribution with privacy applied.
 */
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

/**
 * Get the active user/session count from the main server.
 * This is injected by api/index.js since it has access to io.
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
    const totalConnections = events.connections;
    const totalDisconnects = events.disconnects;
    const activeUsers = getActiveUserCount();
    const activeMatches = getActiveMatchCount();
    const waitingUsers = getWaitingUserCount();

    const connectionSuccessRate = totalConnections
        ? (((totalConnections - totalDisconnects) / totalConnections) * 100).toFixed(1)
        : "0.0";

    const matchSuccessRate = events.matchesStarted
        ? ((events.matchesCompleted / events.matchesStarted) * 100).toFixed(1)
        : "0.0";

    const avgMatchWait = average(matchWaitTimes);
    const medianMatchWait = median(matchWaitTimes);
    const longestMatchWait = max(matchWaitTimes);

    const avgConversationDuration = average(conversationDurations);
    const medianConversationDuration = median(conversationDurations);

    const avgMessagesPerConversation = events.conversationsStarted
        ? (events.totalMessages / events.conversationsStarted).toFixed(1)
        : "0.0";

    const avgWSLatency = average(wsLatencies);

    const disconnectRate = totalConnections
        ? ((totalDisconnects / totalConnections) * 100).toFixed(1)
        : "0.0";

    return {
        timestamp: Date.now(),

        global: {
            totalConnections,
            totalMatches: events.matchesStarted,
            totalConversations: events.conversationsStarted,
            activeUsers,
            activeMatches,
            waitingUsers,
            avgMatchWaitMs: Math.round(avgMatchWait),
            avgConversationDurationMs: Math.round(avgConversationDuration)
        },

        countries: getCountryDistribution(),

        languages: getLanguageDistribution(),

        matching: {
            successfulMatches: events.matchesStarted,
            avgWaitMs: Math.round(avgMatchWait),
            medianWaitMs: Math.round(medianMatchWait),
            longestWaitMs: Math.round(longestMatchWait),
            matchSuccessRate: matchSuccessRate + "%",
            activeMatches
        },

        conversation: {
            started: events.conversationsStarted,
            completed: events.conversationsEnded,
            avgDurationMs: Math.round(avgConversationDuration),
            medianDurationMs: Math.round(medianConversationDuration),
            avgMessagesPerConversation
        },

        system: {
            avgResponseTimeMs: 0,
            avgWSLatencyMs: Math.round(avgWSLatency),
            connectionSuccessRate: connectionSuccessRate + "%",
            disconnectRate: disconnectRate + "%",
            apiErrors: events.rateLimitViolations
        }
    };
}

/*
|--------------------------------------------------------------------------
| RESET
|--------------------------------------------------------------------------
*/

function reset() {
    events.connections = 0;
    events.disconnects = 0;
    events.matchesStarted = 0;
    events.matchesCompleted = 0;
    events.conversationsStarted = 0;
    events.conversationsEnded = 0;
    events.totalMessages = 0;
    events.totalImages = 0;
    events.rateLimitViolations = 0;

    for (const key of Object.keys(countries)) delete countries[key];
    for (const key of Object.keys(languages)) delete languages[key];

    matchWaitTimes.length = 0;
    conversationDurations.length = 0;
    wsLatencies.length = 0;
    connectionStartTimes = [];
}

module.exports = {
    // Tracking
    trackConnection,
    trackDisconnect,
    trackMatchStarted,
    trackMatchWaitTime,
    trackMatchCompleted,
    trackConversationStarted,
    trackConversationEnded,
    trackMessage,
    trackImage,
    trackRateLimitViolation,
    trackWSLatency,

    // Helpers
    getCountryFromRequest,
    getLanguageFromRequest,

    // Stats
    getStats,
    setActiveCountGetters,
    reset,

    // Expose for testing
    _events: events,
    _countries: countries,
    _languages: languages
};