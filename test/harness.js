"use strict";

/** Minimal test harness -- no dev dependency, runs anywhere node runs. */

const tests = [];
let currentSuite = "";

function suite(name) {
    currentSuite = name;
}

function test(name, fn) {
    tests.push({ suite: currentSuite, name, fn });
}

class AssertionError extends Error {}

/** `match` may be a substring or a RegExp. */
function matches(message, match) {
    return match instanceof RegExp ? match.test(String(message)) : String(message).includes(match);
}

const assert = {
    ok(value, message = "expected a truthy value") {
        if (!value) throw new AssertionError(message);
    },
    equal(actual, expected, message) {
        if (actual !== expected) {
            throw new AssertionError(message || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
    },
    notEqual(actual, expected, message) {
        if (actual === expected) throw new AssertionError(message || `expected value to differ from ${actual}`);
    },
    deepEqual(actual, expected, message) {
        const a = JSON.stringify(actual);
        const b = JSON.stringify(expected);
        if (a !== b) throw new AssertionError(message || `expected ${b}, got ${a}`);
    },
    /** Assert a synchronous call throws, optionally matching the message. */
    throws(fn, match, message) {
        let threw = false;
        try {
            fn();
        } catch (err) {
            threw = true;
            if (match && !matches(err.message, match)) {
                throw new AssertionError(`expected error matching "${match}", got "${err.message}"`);
            }
        }
        if (!threw) throw new AssertionError(message || "expected the call to throw");
    },
    async rejects(promise, match, message) {
        let threw = false;
        try {
            await promise;
        } catch (err) {
            threw = true;
            if (match && !matches(err.message, match)) {
                throw new AssertionError(`expected rejection matching "${match}", got "${err.message}"`);
            }
        }
        if (!threw) throw new AssertionError(message || "expected the promise to reject");
    },
};

async function run() {
    let passed = 0;
    const failures = [];
    let printedSuite = null;

    for (const t of tests) {
        if (t.suite !== printedSuite) {
            printedSuite = t.suite;
            console.log(`\n  ${t.suite}`);
        }
        try {
            await t.fn();
            passed++;
            console.log(`    \x1b[32mPASS\x1b[0m ${t.name}`);
        } catch (err) {
            failures.push({ ...t, err });
            console.log(`    \x1b[31mFAIL\x1b[0m ${t.name}`);
            console.log(`         ${err.message}`);
        }
    }

    console.log("");
    console.log(`  ${passed}/${tests.length} passed`);
    if (failures.length > 0) {
        console.log(`  \x1b[31m${failures.length} failed\x1b[0m`);
        for (const f of failures) {
            if (!(f.err instanceof AssertionError)) console.log(`\n  ${f.name}:\n${f.err.stack}`);
        }
        process.exitCode = 1;
    }
    console.log("");
    return failures.length === 0;
}

module.exports = { suite, test, assert, run, AssertionError };
