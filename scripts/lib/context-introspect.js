"use strict";

/**
 * Derivation helpers for the SHTM context manifest.
 *
 * These functions read the actual source files to extract real event names,
 * lifecycle states, and critical files — so the manifest is generated from
 * the repository rather than hand-maintained copy.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

function readIfExists(relativePath) {
    const full = path.join(ROOT, relativePath);
    if (!fs.existsSync(full)) return null;
    return fs.readFileSync(full, "utf8");
}

function fileExists(relativePath) {
    return fs.existsSync(path.join(ROOT, relativePath));
}

/**
 * Extract the first capture group from all regex matches in `source`.
 */
function extractAll(source, regex) {
    if (!source) return [];
    const out = new Set();
    let match;
    while ((match = regex.exec(source)) !== null) {
        if (match[1] !== undefined) out.add(match[1]);
    }
    return [...out].sort();
}

/**
 * Server → client events (`io.to(...).emit`, `socket.emit`, `send(...)`).
 * `send(socket, event)` is the wrapper; also inline `socket.emit("event")`.
 */
function extractServerEvents(indexSource) {
    const events = new Set();

    // send(socket, "event", ...)
    for (const m of indexSource.matchAll(/\bsend\(\s*\w+\s*,\s*"([^"]+)"/g)) {
        events.add(m[1]);
    }
    // <scope>.emit("event", ...)
    for (const m of indexSource.matchAll(/\.emit\(\s*"([^"]+)"/g)) {
        events.add(m[1]);
    }

    // Remove internal / non-app events
    events.delete("system:ping");

    return [...events].sort();
}

/**
 * Client → server events (`socket.on("event", ...)` in api/index.js).
 */
function extractClientEvents(indexSource) {
    const events = new Set();
    for (const m of indexSource.matchAll(/socket\.on\(\s*"([^"]+)"/g)) {
        // "connection" and "disconnect" are Socket.IO server lifecycle hooks.
        if (m[1] !== "connection" && m[1] !== "disconnect") {
            events.add(m[1]);
        }
    }
    return [...events].sort();
}

/**
 * Lifecycle states declared in api/logger.js as SOCKET_STATE values.
 */
function extractSocketStates(loggerSource) {
    const block = /SOCKET_STATE\s*=\s*\{([\s\S]*?)\};/.exec(loggerSource);
    if (!block) return [];

    const states = [];
    const valueRe = /:\s*"([^"]+)"/g;
    let m;
    while ((m = valueRe.exec(block[1])) !== null) {
        states.push(m[1]);
    }
    return states.sort();
}

/**
 * Disconnect reason categories declared in api/logger.js.
 */
function extractDisconnectReasons(loggerSource) {
    const block = /DISCONNECT_REASON\s*=\s*\{([\s\S]*?)\};/.exec(loggerSource);
    if (!block) return [];

    const reasons = [];
    const valueRe = /:\s*"([^"]+)"/g;
    let m;
    while ((m = valueRe.exec(block[1])) !== null) {
        reasons.push(m[1]);
    }
    return reasons.sort();
}

/**
 * Extract funnel stage names from lib/growth.js `FUNNEL_STAGES` array.
 */
function extractFunnelStages(growthSource) {
    if (!growthSource) return [];
    const block = /FUNNEL_STAGES\s*=\s*\[([\s\S]*?)\];/.exec(growthSource);
    if (!block) return [];

    const stages = [];
    const valueRe = /"([a-z_]+)"/g;
    let m;
    while ((m = valueRe.exec(block[1])) !== null) {
        stages.push(m[1]);
    }
    return stages;
}

/**
 * Extract experiment ids from lib/growth.js `experiments` array.
 */
function extractGrowthExperiments(growthSource) {
    if (!growthSource) return [];
    const ids = [];
    const valueRe = /experimentId:\s*"([^"]+)"/g;
    let m;
    while ((m = valueRe.exec(growthSource)) !== null) {
        ids.push(m[1]);
    }
    return [...new Set(ids)].sort();
}

module.exports = {
    ROOT,
    readIfExists,
    fileExists,
    extractAll,
    extractServerEvents,
    extractClientEvents,
    extractSocketStates,
    extractDisconnectReasons,
    extractFunnelStages,
    extractGrowthExperiments
};
