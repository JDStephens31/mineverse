"use strict";

const crypto = require("crypto");
const { canonicalize } = require("./canonical");

function sha256(input) {
    return crypto.createHash("sha256").update(input).digest("hex");
}

/** Hash of a canonically-serialized object. */
function hashObject(obj) {
    return sha256(canonicalize(obj));
}

/**
 * Merkle root over transaction hashes.
 *
 * Odd nodes are duplicated (Bitcoin-style). An empty list has a zero root --
 * but blocks always carry at least a coinbase, so that case is defensive only.
 */
function merkleRoot(hashes) {
    if (hashes.length === 0) return "0".repeat(64);

    let level = hashes.slice();
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) {
            const left = level[i];
            const right = i + 1 < level.length ? level[i + 1] : left;
            next.push(sha256(left + right));
        }
        level = next;
    }
    return level[0];
}

/**
 * Number of leading zero bits in a hex hash. Proof-of-work difficulty is
 * measured in bits rather than hex digits so it can be tuned finely.
 */
function leadingZeroBits(hexHash) {
    let bits = 0;
    for (let i = 0; i < hexHash.length; i++) {
        const nibble = parseInt(hexHash[i], 16);
        if (Number.isNaN(nibble)) return bits;
        if (nibble === 0) {
            bits += 4;
            continue;
        }
        if (nibble >= 8) return bits;
        if (nibble >= 4) return bits + 1;
        if (nibble >= 2) return bits + 2;
        return bits + 3;
    }
    return bits;
}

function meetsDifficulty(hexHash, difficulty) {
    return leadingZeroBits(hexHash) >= difficulty;
}

module.exports = { sha256, hashObject, merkleRoot, leadingZeroBits, meetsDifficulty };
