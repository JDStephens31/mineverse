"use strict";

const cfg = require("./config");
const { hashObject, merkleRoot, meetsDifficulty } = require("../util/hash");
const { canonicalize } = require("../util/canonical");
const tx = require("./transaction");

class BlockError extends Error {}

function fail(msg) {
    throw new BlockError(msg);
}

/**
 * The block header is what proof-of-work commits to. Transactions are bound in
 * through merkleRoot, so a block's body cannot be swapped without redoing work.
 */
function headerOf(block) {
    return {
        chainId: block.chainId,
        index: block.index,
        prevHash: block.prevHash,
        timestamp: block.timestamp,
        difficulty: block.difficulty,
        merkleRoot: block.merkleRoot,
        nonce: block.nonce,
    };
}

function computeHash(block) {
    return hashObject(headerOf(block));
}

function buildBlock({ index, prevHash, timestamp, difficulty, transactions, nonce = 0 }) {
    const block = {
        chainId: cfg.CHAIN_ID,
        index,
        prevHash,
        timestamp,
        difficulty,
        merkleRoot: merkleRoot(transactions.map((t) => t.hash)),
        nonce,
        transactions,
    };
    block.hash = computeHash(block);
    return block;
}

function blockSize(block) {
    return Buffer.byteLength(canonicalize(block), "utf8");
}

/**
 * Structural validation of a block in isolation: shape, proof-of-work, merkle
 * root, coinbase placement, and every transaction's signature.
 *
 * Contextual rules (does prevHash link, is difficulty the expected value, do
 * the transactions apply cleanly) live in Blockchain -- they need the chain.
 */
function validateBlockStructure(block, { now = Date.now() } = {}) {
    if (block === null || typeof block !== "object" || Array.isArray(block)) fail("block must be an object");
    if (block.chainId !== cfg.CHAIN_ID) fail("wrong chainId");

    if (!Number.isSafeInteger(block.index) || block.index < 0) fail("bad index");
    if (typeof block.prevHash !== "string" || !/^[0-9a-f]{64}$/.test(block.prevHash)) fail("bad prevHash");
    if (!Number.isSafeInteger(block.timestamp) || block.timestamp < 0) fail("bad timestamp");
    if (!Number.isSafeInteger(block.difficulty)) fail("bad difficulty");
    if (block.difficulty < cfg.MIN_DIFFICULTY || block.difficulty > cfg.MAX_DIFFICULTY) {
        fail("difficulty out of allowed range");
    }
    if (!Number.isSafeInteger(block.nonce) || block.nonce < 0) fail("bad nonce");
    if (!Array.isArray(block.transactions)) fail("transactions must be an array");
    if (block.transactions.length === 0) fail("block must contain a coinbase");
    if (block.transactions.length > cfg.MAX_TXS_PER_BLOCK) fail("too many transactions");

    if (block.timestamp > now + cfg.MAX_FUTURE_DRIFT_MS) fail("block timestamp too far in the future");
    if (blockSize(block) > cfg.MAX_BLOCK_BYTES) fail("block exceeds size limit");

    // Exactly one coinbase, and it must be first so the reward cannot be hidden
    // among ordinary transactions.
    if (block.transactions[0].type !== tx.TxType.COINBASE) fail("first transaction must be the coinbase");
    for (let i = 1; i < block.transactions.length; i++) {
        if (block.transactions[i].type === tx.TxType.COINBASE) fail("multiple coinbase transactions");
    }

    const seen = new Set();
    for (const t of block.transactions) {
        tx.validateTransaction(t, { now });
        if (seen.has(t.hash)) fail("duplicate transaction in block");
        seen.add(t.hash);
    }

    if (block.merkleRoot !== merkleRoot(block.transactions.map((t) => t.hash))) {
        fail("merkleRoot does not match transactions");
    }
    if (block.hash !== computeHash(block)) fail("block hash does not match header");
    if (!meetsDifficulty(block.hash, block.difficulty)) fail("block does not meet its difficulty target");

    return true;
}

/**
 * Cumulative work of a block, as an exact BigInt (2^difficulty).
 *
 * Chain selection compares total work, not length -- length alone lets an
 * attacker win with a long chain of trivially easy blocks.
 */
function blockWork(block) {
    return 1n << BigInt(block.difficulty);
}

function totalWork(blocks) {
    let sum = 0n;
    for (const b of blocks) sum += blockWork(b);
    return sum;
}

module.exports = {
    BlockError,
    headerOf,
    computeHash,
    buildBlock,
    blockSize,
    validateBlockStructure,
    blockWork,
    totalWork,
};
