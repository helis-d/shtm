/*
 |==============================================================================
 | SHTM — FEATURE DATA MODEL + FEATURE FLAGS
 |==============================================================================
 |
 | Lightweight, server-side product data for the conversation-first feature
 | wave: interests, icebreakers, feedback options, milestones, match
 | compatibility, and feature flags. No accounts, no profiles, no ML.
 |
 | All incoming network data is normalized/validated here (never trusted).
 |==============================================================================
 */

const INTEREST_LIST = [
    { id: "gaming", label: "Gaming" },
    { id: "music", label: "Music" },
    { id: "movies", label: "Movies" },
    { id: "technology", label: "Technology" },
    { id: "sports", label: "Sports" },
    { id: "travel", label: "Travel" },
    { id: "anime", label: "Anime" },
    { id: "art", label: "Art" },
    { id: "science", label: "Science" },
    { id: "fashion", label: "Fashion" },
    { id: "books", label: "Books" },
    { id: "food", label: "Food" },
    { id: "memes", label: "Memes" },
    { id: "coding", label: "Coding" },
    { id: "photography", label: "Photography" }
];

const INTERESTS = Object.fromEntries(
    INTEREST_LIST.map((i) => [i.id, i.label])
);

const MAX_INTERESTS = 5;

/*
 |--------------------------------------------------------------------------
 | ICEBREAKERS (safe, non-sensitive prompts)
 |--------------------------------------------------------------------------
 | Curated pool. No political / medical / financial / sexual / identity-
 | sensitive prompts. Split into universal + interest-specific categories.
 |--------------------------------------------------------------------------
 */

const UNIVERSAL_ICEBREAKERS = [
    { id: "q_forever", text: "What's something you could talk about for hours?" },
    { id: "q_lately", text: "What are you into lately?" },
    { id: "q_learned", text: "What's the most interesting thing you've learned recently?" },
    { id: "q_visit", text: "What's one place you'd love to visit?" },
    { id: "q_never_tired", text: "What's a game, movie, or song you never get tired of?" },
    { id: "q_day_better", text: "What's a small thing that always makes your day better?" }
];

const INTEREST_ICEBREAKERS = {
    gaming: [
        { id: "gaming_forever", text: "What game could you play forever?" },
        { id: "gaming_best", text: "What's the best game you've played this year?" }
    ],
    music: [
        { id: "music_kind", text: "What kind of music do you usually listen to?" },
        { id: "music_artist", text: "Which artist have you been listening to a lot?" }
    ],
    movies: [
        { id: "movies_watched", text: "What's the best thing you've watched recently?" },
        { id: "movies_genre", text: "What movie genre do you always go back to?" }
    ],
    technology: [
        { id: "tech_gadget", text: "What's a piece of tech you're excited about?" },
        { id: "tech_app", text: "What's an app or tool you can't live without?" }
    ],
    sports: [
        { id: "sports_follow", text: "What sport do you follow or play?" },
        { id: "sports_moment", text: "What's a sports moment you'll never forget?" }
    ],
    travel: [
        { id: "travel_place", text: "What's a place you'd love to travel to next?" },
        { id: "travel_trip", text: "What's the most memorable trip you've taken?" }
    ],
    anime: [
        { id: "anime_fav", text: "What's an anime you'd recommend to anyone?" },
        { id: "anime_lately", text: "What anime have you been watching lately?" }
    ],
    art: [
        { id: "art_form", text: "What kind of art do you enjoy most?" },
        { id: "art_create", text: "Do you create art yourself, and what inspires you?" }
    ],
    science: [
        { id: "science_topic", text: "What area of science fascinates you?" },
        { id: "science_fact", text: "What's a science fact that blew your mind?" }
    ],
    fashion: [
        { id: "fashion_style", text: "How would you describe your style?" },
        { id: "fashion_inspiration", text: "What inspires your fashion choices?" }
    ],
    books: [
        { id: "books_fav", text: "What's a book that changed how you think?" },
        { id: "books_reading", text: "What are you reading right now?" }
    ],
    food: [
        { id: "food_fav", text: "What's a food you could eat every day?" },
        { id: "food_cook", text: "Do you like cooking, and what's your go-to dish?" }
    ],
    memes: [
        { id: "memes_fav", text: "What kind of memes make you laugh the most?" },
        { id: "memes_last", text: "What's the last thing that genuinely made you laugh?" }
    ],
    coding: [
        { id: "coding_language", text: "What programming language or tech are you into?" },
        { id: "coding_project", text: "What's a project you've been building lately?" }
    ],
    photography: [
        { id: "photo_style", text: "What do you like to photograph most?" },
        { id: "photo_gear", text: "What camera or gear do you like to shoot with?" }
    ]
};

const FEEDBACK_OPTIONS = {
    good: "Good",
    okay: "Okay",
    not_great: "Not great"
};

// Conversation milestones (subtle, analytics + optional UX). Only reachable
// milestones are emitted; default conversation length still observes the
// legacy 60s unless SHTM_CHAT_DURATION_MS is configured higher.
const MILESTONES = [
    { atMs: 30_000, level: 1 },
    { atMs: 120_000, level: 2 },
    { atMs: 300_000, level: 3 },
    { atMs: 600_000, level: 4 }
];

/*
 |--------------------------------------------------------------------------
 | FEATURE FLAGS
 |--------------------------------------------------------------------------
 | Environment-driven, additive only. Disabling a feature returns behavior to
 | the legacy safe path and never breaks matching/conversations/analytics.
 |--------------------------------------------------------------------------
 */

function flag(value, defaultOn = true) {
    if (value === undefined) return defaultOn;
    return value === "1" || value === "true";
}

const FLAGS = {
    interests: flag(process.env.SHTM_INTERESTS_ENABLED),
    icebreakers: flag(process.env.SHTM_ICEBREAKERS_ENABLED),
    nextMatch: flag(process.env.SHTM_NEXT_MATCH_ENABLED),
    onlineCount: flag(process.env.SHTM_ONLINE_COUNT_ENABLED)
};

function isEnabled(name) {
    return FLAGS[name] !== false;
}

/*
 |--------------------------------------------------------------------------
 | VALIDATION (server-side only; client is never trusted)
 |--------------------------------------------------------------------------
 */

/**
 * Normalize + validate an interests payload.
 * Accepts either an array of ids or `{ interests: [...] }`.
 * Returns { valid, interests, message }.
 */
function normalizeInterests(value) {
    if (value === null || value === undefined) {
        return { valid: true, interests: [], message: "" };
    }

    if (Array.isArray(value)) {
        return validateInterestList(value);
    }

    if (typeof value === "object" && "interests" in value) {
        const raw = value.interests;
        if (raw === undefined || raw === null) {
            // Explicitly skipped via object wrapper.
            return { valid: true, interests: [], message: "" };
        }
        if (!Array.isArray(raw)) {
            return {
                valid: false,
                interests: [],
                message: "Interests must be a list."
            };
        }
        return validateInterestList(raw);
    }

    // Malformed payload: not an array and not an object wrapper.
    return {
        valid: false,
        interests: [],
        message: "Interests must be a list."
    };
}

function validateInterestList(raw) {
    if (!Array.isArray(raw)) {
        return {
            valid: false,
            interests: [],
            message: "Interests must be a list."
        };
    }

    if (raw.length > MAX_INTERESTS) {
        return {
            valid: false,
            interests: [],
            message: `Choose up to ${MAX_INTERESTS} interests.`
        };
    }

    const seen = new Set();
    const interests = [];

    for (const item of raw) {
        const id = typeof item === "string" ? item : item && item.id;

        if (typeof id !== "string" || !INTERESTS[id]) {
            return {
                valid: false,
                interests: [],
                message: "Unknown interest."
            };
        }

        if (seen.has(id)) {
            return {
                valid: false,
                interests: [],
                message: "Duplicate interests are not allowed."
            };
        }

        seen.add(id);
        interests.push(id);
    }

    return { valid: true, interests, message: "" };
}

/*
 |--------------------------------------------------------------------------
 | MATCH HELPERS
 |--------------------------------------------------------------------------
 */

function sharedInterests(a, b) {
    const setA = new Set(Array.isArray(a) ? a : []);
    const listB = Array.isArray(b) ? b : [];
    return listB.filter((id) => setA.has(id));
}

/**
 * Lightweight, informational compatibility score (0-100). Kept intentionally
 * simple: "interesting enough to start a conversation", not "identical".
 */
function compatibilityScore(a, b) {
    let score = 50;

    const shared = sharedInterests(a && a.interests, b && b.interests);
    score += Math.min(shared.length, 5) * 8;

    if (a && b && a.language && a.language === b.language) {
        score += 10;
    }

    return Math.min(100, score);
}

/**
 * Coarse, anonymous intro profile. Only what the user intentionally supplied
 * plus coarse country/language. Never name/email/ip/location.
 */
function buildIntroProfile(user) {
    return {
        country: (user && user.country) || null,
        language: (user && user.language) || null,
        interests: Array.isArray(user && user.interests) ? user.interests : []
    };
}

/*
 |--------------------------------------------------------------------------
 | ICEBREAKER SELECTION
 |--------------------------------------------------------------------------
 */

function pickFrom(pool, seed) {
    if (!pool || pool.length === 0) return null;
    const idx = (seed >>> 0) % pool.length;
    return pool[idx];
}

/**
 * Priority: shared interest → selected interest → broad universal.
 * seed is a stable-ish per-conversation number.
 */
function pickInitialIcebreaker({ shared, selected, seed = 0 } = {}) {
    if (shared && shared.length) {
        const pool = INTEREST_ICEBREAKERS[shared[0]];
        const q = pickFrom(pool, seed);
        if (q) return { ...q, category: "shared", interest: shared[0] };
    }

    if (selected && selected.length) {
        const pool = INTEREST_ICEBREAKERS[selected[0]];
        const q = pickFrom(pool, seed + 1);
        if (q) return { ...q, category: "interest", interest: selected[0] };
    }

    const q = pickFrom(UNIVERSAL_ICEBREAKERS, seed + 2);
    return q ? { ...q, category: "universal", interest: null } : null;
}

/**
 * Next prompt for rotation, excluding the current one.
 */
function rotateIcebreaker(currentId, seed = 0) {
    const universal = UNIVERSAL_ICEBREAKERS.filter((q) => q.id !== currentId);
    const pool = universal.length ? universal : UNIVERSAL_ICEBREAKERS;
    const q = pickFrom(pool, seed);
    return q ? { ...q, category: "universal", interest: null } : null;
}

module.exports = {
    INTEREST_LIST,
    INTERESTS,
    MAX_INTERESTS,
    UNIVERSAL_ICEBREAKERS,
    INTEREST_ICEBREAKERS,
    FEEDBACK_OPTIONS,
    MILESTONES,
    FLAGS,
    isEnabled,
    normalizeInterests,
    sharedInterests,
    compatibilityScore,
    buildIntroProfile,
    pickInitialIcebreaker,
    rotateIcebreaker
};