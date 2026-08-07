"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const keys = require("./keys");

const WORD_COUNT = 12;

let WORDLIST = null;

/**
 * Wordlist built from the Minecraft item table.
 *
 * The original implementation read items.json with an async callback and
 * returned the (still empty) array synchronously, so every wallet got the same
 * empty key list. This loads once, synchronously, and deduplicates + sorts so
 * the list is identical on every node.
 */
function loadWordlist() {
    if (WORDLIST) return WORDLIST;

    const file = path.join(__dirname, "..", "..", "JSON", "items.json");
    const items = JSON.parse(fs.readFileSync(file, "utf8"));

    const seen = new Set();
    for (const item of items) {
        if (!item || typeof item.name !== "string") continue;
        const word = item.name.trim().toLowerCase().replace(/\s+/g, "_");
        // Keep only plain words. Apostrophes and brackets in item names would
        // otherwise land in recovery phrases and get mangled by shell quoting.
        if (/^[a-z0-9_]+$/.test(word)) seen.add(word);
    }

    WORDLIST = Array.from(seen).sort();
    if (WORDLIST.length < 256) {
        throw new Error("wordlist too small to be safe: " + WORDLIST.length);
    }
    return WORDLIST;
}

/**
 * Generate a recovery phrase using the OS CSPRNG.
 *
 * crypto.randomInt is rejection-sampled, so the words are uniform -- Math.random
 * would have been both biased and predictable.
 */
function generateMnemonic() {
    const words = loadWordlist();
    const phrase = [];
    for (let i = 0; i < WORD_COUNT; i++) {
        phrase.push(words[crypto.randomInt(words.length)]);
    }
    return phrase;
}

function normalizeMnemonic(mnemonic) {
    const phrase = Array.isArray(mnemonic) ? mnemonic : String(mnemonic).split(/\s+/);
    return phrase.map((w) => String(w).trim().toLowerCase()).filter((w) => w.length > 0);
}

/** Words -> private key. Deterministic, so the phrase actually restores a wallet. */
function privateKeyFromMnemonic(mnemonic) {
    const phrase = normalizeMnemonic(mnemonic);
    if (phrase.length !== WORD_COUNT) {
        throw new Error(`recovery phrase must be ${WORD_COUNT} words`);
    }
    const words = loadWordlist();
    for (const w of phrase) {
        if (!words.includes(w)) throw new Error("unknown word in recovery phrase: " + w);
    }
    // Key stretching so a phrase that leaks partially is still expensive to brute force.
    const seed = crypto.pbkdf2Sync(phrase.join(" "), "mineverse-mnemonic-v1", 120000, 32, "sha512");
    return keys.privateKeyFromSeed(seed);
}

module.exports = {
    WORD_COUNT,
    loadWordlist,
    generateMnemonic,
    normalizeMnemonic,
    privateKeyFromMnemonic,
};
