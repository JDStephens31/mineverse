"use strict";

/**
 * Deterministic serialization.
 *
 * Every node must produce byte-identical bytes for the same logical object,
 * otherwise hashes disagree and the network forks. JSON.stringify preserves
 * insertion order, which differs between a locally-built object and one parsed
 * off the wire, so we sort keys recursively instead.
 */
function canonicalize(value) {
    if (value === null) return "null";

    const t = typeof value;

    if (t === "number") {
        if (!Number.isFinite(value)) {
            throw new Error("canonicalize: non-finite number");
        }
        // -0 and 0 must serialize identically.
        return JSON.stringify(value === 0 ? 0 : value);
    }

    if (t === "string" || t === "boolean") return JSON.stringify(value);

    if (t === "bigint") return JSON.stringify(value.toString());

    if (Array.isArray(value)) {
        return "[" + value.map(canonicalize).join(",") + "]";
    }

    if (t === "object") {
        const keys = Object.keys(value)
            .filter((k) => value[k] !== undefined)
            .sort();
        return (
            "{" +
            keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") +
            "}"
        );
    }

    throw new Error("canonicalize: unsupported type " + t);
}

module.exports = { canonicalize };
