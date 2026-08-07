"use strict";

const crypto = require("crypto");
const EC = require("elliptic").ec;

const ec = new EC("secp256k1");

/** Curve order. Private keys must be in [1, N-1]. */
const CURVE_N = ec.curve.n;

const ADDRESS_PREFIX = "mv";
const HEX64 = /^[0-9a-f]{64}$/;
const PUBKEY_HEX = /^04[0-9a-f]{128}$/; // uncompressed SEC1
const ADDRESS_RE = /^mv[0-9a-f]{40}$/;

function isValidPrivateKey(hex) {
    if (typeof hex !== "string" || !HEX64.test(hex)) return false;
    const k = ec.keyFromPrivate(hex, "hex").getPrivate();
    return k.gtn(0) && k.lt(CURVE_N);
}

function isValidPublicKey(hex) {
    if (typeof hex !== "string" || !PUBKEY_HEX.test(hex)) return false;
    try {
        const key = ec.keyFromPublic(hex, "hex");
        return key.validate().result === true;
    } catch {
        return false;
    }
}

function isValidAddress(addr) {
    return typeof addr === "string" && ADDRESS_RE.test(addr);
}

function publicKeyFromPrivate(privHex) {
    return ec.keyFromPrivate(privHex, "hex").getPublic().encode("hex", false);
}

/**
 * Address = "mv" + first 20 bytes of sha256(publicKey bytes).
 *
 * The address, not the raw public key, is the account identifier in state --
 * it is shorter and the public key only needs to appear on transactions that
 * actually spend.
 */
function addressFromPublicKey(pubHex) {
    if (!isValidPublicKey(pubHex)) throw new Error("invalid public key");
    const digest = crypto.createHash("sha256").update(Buffer.from(pubHex, "hex")).digest("hex");
    return ADDRESS_PREFIX + digest.slice(0, 40);
}

function generatePrivateKey() {
    for (;;) {
        const candidate = crypto.randomBytes(32).toString("hex");
        if (isValidPrivateKey(candidate)) return candidate;
    }
}

/**
 * Derive a private key from arbitrary seed material (used by the mnemonic).
 * Rehashes with a counter on the astronomically unlikely out-of-range result
 * so derivation is total and deterministic.
 */
function privateKeyFromSeed(seedBuffer) {
    let material = Buffer.isBuffer(seedBuffer) ? seedBuffer : Buffer.from(String(seedBuffer), "utf8");
    for (let i = 0; i < 256; i++) {
        const candidate = crypto
            .createHash("sha256")
            .update(Buffer.concat([Buffer.from("mineverse-key-v1"), material, Buffer.from([i])]))
            .digest("hex");
        if (isValidPrivateKey(candidate)) return candidate;
    }
    throw new Error("key derivation failed");
}

/** Sign a 32-byte hex digest. Returns a DER-encoded hex signature. */
function sign(privHex, digestHex) {
    if (!isValidPrivateKey(privHex)) throw new Error("invalid private key");
    if (!HEX64.test(digestHex)) throw new Error("digest must be 32-byte hex");
    return ec.keyFromPrivate(privHex, "hex").sign(digestHex, { canonical: true }).toDER("hex");
}

function verify(pubHex, digestHex, signatureHex) {
    if (!isValidPublicKey(pubHex)) return false;
    if (typeof signatureHex !== "string" || !/^[0-9a-f]+$/.test(signatureHex)) return false;
    if (!HEX64.test(digestHex)) return false;
    try {
        return ec.keyFromPublic(pubHex, "hex").verify(digestHex, signatureHex);
    } catch {
        return false;
    }
}

module.exports = {
    ADDRESS_PREFIX,
    generatePrivateKey,
    privateKeyFromSeed,
    publicKeyFromPrivate,
    addressFromPublicKey,
    isValidPrivateKey,
    isValidPublicKey,
    isValidAddress,
    sign,
    verify,
};
