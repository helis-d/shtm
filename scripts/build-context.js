"use strict";

/*
|------------------------------------------------------------------------------
| SHTM CONTEXT MANIFEST BUILDER
|------------------------------------------------------------------------------
|
| Generates docs/context/current-state.json from the actual repository.
|
| The manifest is a durable, machine-readable architectural context for future
| coding agents. It is derived, where practical, from the real source code
| (event names, lifecycle states, disconnect reasons, critical files).
|
| Run with:  npm run context:build
|------------------------------------------------------------------------------
*/

const fs = require("fs");
const path = require("path");

const introspect = require("./lib/context-introspect");
const pkg = require("../package.json");

const indexSource = introspect.readIfExists("api/index.js");
const loggerSource = introspect.readIfExists("api/logger.js");
const securitySource = introspect.readIfExists("api/security.js");
const analyticsSource = introspect.readIfExists("api/analytics.js");

/*
|--------------------------------------------------------------------------
| CRITICAL FILES
|--------------------------------------------------------------------------
| Files whose existence is required for the system to function and whose
| architectural role is documented.
|--------------------------------------------------------------------------
*/

const criticalFiles = {
    "api/index.js": "HTTP + Socket.IO server, lifecycle, matchmaking, routing",
    "api/security.js": "rate limiting, payload/MIME validation, metrics",
    "api/analytics.js": "aggregate metrics and /api/stats response",
    "api/logger.js": "structured logger, enums, disconnect forensics",
    "public/app.js": "client socket wiring and connection UX",
    "public/lang.js": "i18n (tr/en) and icebreakers",
    "public/index.html": "main page",
    "public/stats.html": "public stats page",
    "public/style.css": "styling",
    "vercel.json": "routing config",
    "package.json": "dependencies and scripts"
};

/*
|--------------------------------------------------------------------------
| MANIFEST
|--------------------------------------------------------------------------
*/

const manifest = {
    project: "SHTM",
    generatedAt: new Date().toISOString(),
    generator: "scripts/build-context.js",

    architecture: {
        frontend: "vanilla JS + HTML + CSS in public/",
        backend: "Express 5 + Socket.IO 4.8 in api/",
        persistence: "none — in-memory only (ephemeral)",
        realtime: "Socket.IO WebSocket-only"
    },

    runtime: {
        platform: "Vercel serverless (single instance) + local Node",
        entrypoint: "api/index.js",
        localDevCommand: "npm run dev",
        localStartCommand: "npm start"
    },

    realtime: {
        serverEvents: introspect.extractServerEvents(indexSource),
        clientEvents: introspect.extractClientEvents(indexSource),
        transports: ["websocket"],
        stateMachines: {
            socket: introspect.extractSocketStates(loggerSource)
        }
    },

    matchmaking: {
        model: "single-slot in-memory queue (waitingUser)",
        states: ["waiting", "matched", "active", "ended", "aborted"],
        timers: ["60s room timeout"]
    },

    stateMachines: {
        socket: introspect.extractSocketStates(loggerSource),
        disconnectReasons: introspect.extractDisconnectReasons(loggerSource)
    },

    events: {
        serverToClient: introspect.extractServerEvents(indexSource),
        clientToServer: introspect.extractClientEvents(indexSource),
        analyticsTracking: [
            "trackConnectionAttempt",
            "trackConnectionAccepted",
            "trackConnectionRejected",
            "trackDisconnect",
            "trackSocketLifetime",
            "trackMatchStarted",
            "trackMatchWaitTime",
            "trackMatchCompleted",
            "trackMatchAborted",
            "trackConversationStarted",
            "trackConversationEnded",
            "trackMessage",
            "trackImage",
            "trackRateLimitViolation",
            "trackWSLatency"
        ]
    },

    security: {
        rateLimits: {
            connectionsPerIp: "5 / 10s",
            matchmakingCooldown: "3s per socket",
            messageBurst: "5 / 4s with 2s cooldown",
            imageUploadCooldown: "10s per socket"
        },
        validation: [
            "sanitizeMessage (1-500 chars)",
            "validateImagePayload (MIME + magic bytes + 5MiB)",
            "checkPayloadSize (anti-flood)"
        ]
    },

    observability: {
        metrics: [
            "connectionAttempts",
            "connectionAccepted",
            "connectionRejected",
            "disconnects",
            "matchesStarted",
            "matchesCompleted",
            "matchesAborted",
            "conversationsStarted",
            "conversationsEnded",
            "totalMessages",
            "totalImages",
            "rateLimitViolations"
        ],
        logging: "structured JSON via api/logger.js",
        correlationIds: ["sessionId", "socketId", "matchId"]
    },

    deployment: {
        routing: "vercel.json rewrites /* -> /api/index",
        env: [],
        dependencies: Object.keys(pkg.dependencies || {}),
        devDependencies: Object.keys(pkg.devDependencies || {})
    },

    invariants: [
        "A socket must not be in the waiting pool and a room at the same time.",
        "A socket must not belong to two rooms.",
        "Room cleanup must be idempotent.",
        "Client-controlled state is never authoritative for security/transition decisions.",
        "Metrics must use explicit, matching numerator/denominator pairs."
    ],

    knownRisks: [
        "In-memory state resets on cold start (serverless).",
        "Single-slot matchmaking does not scale to multi-instance.",
        "Rate limiting is per-instance, not global.",
        "No persistent message/history storage."
    ],

    criticalFiles: {
        files: Object.keys(criticalFiles).filter((f) =>
            introspect.fileExists(f)
        ),
        roles: criticalFiles
    }
};

/*
|--------------------------------------------------------------------------
| WRITE
|--------------------------------------------------------------------------
*/

const outDir = path.join(__dirname, "..", "docs", "context");
const outFile = path.join(outDir, "current-state.json");

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + "\n", "utf8");

console.log(`Context manifest written to ${outFile}`);