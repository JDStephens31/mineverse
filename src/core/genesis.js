"use strict";

const fs = require("fs");
const path = require("path");
const cfg = require("./config");
const keys = require("../crypto/keys");
const { hashObject } = require("../util/hash");
const { computeHash } = require("./block");
const { emptyState, getAccount } = require("./state");

const ZERO_HASH = "0".repeat(64);
const DEFAULT_GENESIS_PATH = path.join(__dirname, "..", "..", "genesis.json");

/**
 * The genesis block is the one block not produced by mining, so it is also the
 * one place coins can be created outside a coinbase. Every node must load an
 * identical genesis.json or they will build mutually-invalid chains -- the
 * chainId check on connect exists to make that failure loud instead of silent.
 */
function loadGenesisConfig(file = DEFAULT_GENESIS_PATH) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));

    if (raw.chainId !== cfg.CHAIN_ID) {
        throw new Error(`genesis chainId "${raw.chainId}" does not match config "${cfg.CHAIN_ID}"`);
    }
    if (!Number.isSafeInteger(raw.timestamp) || raw.timestamp <= 0) {
        throw new Error("genesis timestamp must be a positive integer");
    }
    if (!Number.isSafeInteger(raw.difficulty)) {
        throw new Error("genesis difficulty must be an integer");
    }
    if (raw.allocations === null || typeof raw.allocations !== "object") {
        throw new Error("genesis allocations must be an object");
    }
    for (const [address, amount] of Object.entries(raw.allocations)) {
        if (!keys.isValidAddress(address)) throw new Error("bad genesis address: " + address);
        if (!Number.isSafeInteger(amount) || amount < 0) {
            throw new Error("bad genesis allocation for " + address);
        }
    }

    return {
        chainId: raw.chainId,
        timestamp: raw.timestamp,
        difficulty: raw.difficulty,
        message: typeof raw.message === "string" ? raw.message : "",
        allocations: raw.allocations,
    };
}

function createGenesisBlock(genesis) {
    const block = {
        chainId: genesis.chainId,
        index: 0,
        prevHash: ZERO_HASH,
        timestamp: genesis.timestamp,
        difficulty: genesis.difficulty,
        // The header commits to the allocations, so a node cannot quietly mint
        // itself a premine and still agree on the genesis hash.
        merkleRoot: hashObject({ message: genesis.message, allocations: genesis.allocations }),
        nonce: 0,
        transactions: [],
    };
    block.hash = computeHash(block);
    block.genesis = { message: genesis.message, allocations: genesis.allocations };
    return block;
}

function genesisState(genesis) {
    const state = emptyState();
    for (const address of Object.keys(genesis.allocations).sort()) {
        getAccount(state, address).balance = genesis.allocations[address];
    }
    state.height = 0;
    state.lastTimestamp = genesis.timestamp;
    return state;
}

module.exports = { ZERO_HASH, DEFAULT_GENESIS_PATH, loadGenesisConfig, createGenesisBlock, genesisState };
