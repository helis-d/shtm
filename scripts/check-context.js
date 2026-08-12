"use strict";

/*
|------------------------------------------------------------------------------
| SHTM CONTEXT CHECK
|------------------------------------------------------------------------------
|
| Detects when the architectural context manifest is stale or invalid.
|
| Verifies:
|   1. The manifest file exists and is valid JSON.
|   2. Every critical file referenced in the manifest still exists.
|   3. Important documented events still exist in the source.
|   4. Lifecycle states still exist in the source.
|
| Run with:  npm run context:check
|
| Exit code 0 = valid, 1 = stale/invalid.
|------------------------------------------------------------------------------
*/

const fs = require("fs");
const path = require("path");

const introspect = require("./lib/context-introspect");

const manifestPath = path.join(
    __dirname,
    "..",
    "docs",
    "context",
    "current-state.json"
);

const indexSource = introspect.readIfExists("api/index.js");
const loggerSource = introspect.readIfExists("api/logger.js");

const failures = [];

function fail(message) {
    failures.push(message);
}

/*
| 1. Manifest exists and is valid JSON.
*/

if (!fs.existsSync(manifestPath)) {
    fail("current-state.json is missing — run `npm run context:build`.");
} else {
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (err) {
        fail(`current-state.json is not valid JSON: ${err.message}`);
    }

    if (manifest) {
        /*
        | 2. Critical files still exist.
        */

        const critical = manifest.criticalFiles?.files || [];
        for (const file of critical) {
            if (!introspect.fileExists(file)) {
                fail(`Critical file referenced in manifest is missing: ${file}`);
            }
        }

        /*
        | 3. Documented events still exist in source.
        */

        const sourceServerEvents = new Set(
            introspect.extractServerEvents(indexSource)
        );
        const sourceClientEvents = new Set(
            introspect.extractClientEvents(indexSource)
        );

        for (const evt of manifest.events?.serverToClient || []) {
            if (!sourceServerEvents.has(evt)) {
                fail(`Server event missing from source: ${evt}`);
            }
        }
        for (const evt of manifest.events?.clientToServer || []) {
            if (!sourceClientEvents.has(evt)) {
                fail(`Client event missing from source: ${evt}`);
            }
        }

        /*
        | 4. Lifecycle states still exist.
        */

        const sourceStates = new Set(
            introspect.extractSocketStates(loggerSource)
        );
        const documentedStates =
            manifest.stateMachines?.socket || [];

        for (const state of documentedStates) {
            if (!sourceStates.has(state)) {
                fail(`Lifecycle state missing from source: ${state}`);
            }
        }

        for (const state of sourceStates) {
            if (!documentedStates.includes(state)) {
                fail(
                    `Lifecycle state in source is not in manifest (stale doc): ${state}`
                );
            }
        }
    }
}

if (failures.length > 0) {
    console.error("Context check FAILED:");
    for (const failure of failures) {
        console.error(`  - ${failure}`);
    }
    process.exit(1);
}

console.log("Context check passed.");
process.exit(0);