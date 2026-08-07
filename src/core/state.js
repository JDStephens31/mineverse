"use strict";

const cfg = require("./config");
const { TxType, senderOf } = require("./transaction");
const { hashObject } = require("../util/hash");
const L = require("./ledger");
const bank = require("./bank");
const market = require("./market");
const land = require("./land");
const stocks = require("./stocks");

/**
 * Chain state.
 *
 * This is derived data: it is produced by replaying every block from genesis
 * and is never edited by hand. That is the central fix over the original
 * design, where balances lived inside blocks and were mutated in place --
 * which silently invalidated every hash after the mutated block.
 *
 * Every handler must be a pure function of (previous state, transaction, block
 * context). No Date.now(), no Math.random(), no timers: two nodes replaying the
 * same blocks must land on byte-identical state.
 *
 * The core ledger operations live here; the marketplace, land registry, bank
 * and stock market are domain modules that this file dispatches into. They all
 * move value through the same primitives in ledger.js, so there is exactly one
 * implementation of "does this address have enough to pay".
 */

const { StateError } = L;
const fail = L.fail;

function emptyState() {
    return {
        height: -1,
        lastHash: null,
        lastTimestamp: 0,
        accounts: {},
        currencies: {},
        votes: {},
        contracts: {},
        inventories: {},
        uuids: {},
        /** Marketplace listings, keyed by the id of the transaction that made them. */
        listings: {},
        /** Registered Minecraft servers, and the chunks belonging to them. */
        servers: {},
        chunks: {},
        /** Companies and their share pools. */
        companies: {},
        /** Escrowed principal and the bank's own holdings. */
        bank: bank.emptyBank(),
    };
}

function cloneState(state) {
    return structuredClone(state);
}

/** Fingerprint of the whole state. Two nodes in sync must report the same value. */
function stateRoot(state) {
    return hashObject({
        height: state.height,
        lastHash: state.lastHash,
        accounts: state.accounts,
        currencies: state.currencies,
        votes: state.votes,
        contracts: state.contracts,
        inventories: state.inventories,
        uuids: state.uuids,
        listings: state.listings,
        servers: state.servers,
        chunks: state.chunks,
        companies: state.companies,
        bank: state.bank,
    });
}

// ---------------------------------------------------------------------------
// Core handlers: the native ledger, currencies, governance, identity.
// ---------------------------------------------------------------------------

const coreHandlers = {
    [TxType.TRANSFER](state, tx, ctx, from) {
        const p = tx.payload;
        if (p.to === from) fail("cannot transfer to self");
        if (p.symbol === cfg.NATIVE) {
            L.debitNative(state, from, p.amount);
            L.creditNative(state, p.to, p.amount);
        } else {
            if (!state.currencies[p.symbol]) fail("unknown currency " + p.symbol);
            L.debitToken(state, from, p.symbol, p.amount);
            L.creditToken(state, p.to, p.symbol, p.amount);
        }
    },

    [TxType.CREATE_CURRENCY](state, tx, ctx, from) {
        const p = tx.payload;
        if (state.currencies[p.symbol]) fail("currency already exists: " + p.symbol);
        // Tokens and company stock share one ticker namespace, so a price quoted
        // for a symbol always means one thing.
        if (state.companies[p.symbol]) fail("symbol is already a company: " + p.symbol);

        const creatorShare = Math.floor((p.totalSupply * cfg.CREATOR_SUPPLY_BPS) / 10000);
        const poolShare = p.totalSupply - creatorShare;
        if (poolShare <= 0) fail("supply too small to seed a pool");

        // Liquidity is real: the creator's native coin is locked in the pool.
        L.debitNative(state, from, p.liquidity);

        state.currencies[p.symbol] = {
            symbol: p.symbol,
            name: p.name,
            owner: from,
            totalSupply: p.totalSupply,
            reserveNative: p.liquidity,
            reserveToken: poolShare,
            createdAt: ctx.timestamp,
            createdAtHeight: ctx.height,
        };
        if (creatorShare > 0) L.creditToken(state, from, p.symbol, creatorShare);
    },

    [TxType.BUY](state, tx, ctx, from) {
        const p = tx.payload;
        const cur = state.currencies[p.symbol];
        if (!cur) fail("unknown currency " + p.symbol);

        const out = L.amountOut(p.amountIn, cur.reserveNative, cur.reserveToken);
        // Slippage bound, supplied by the sender and enforced by consensus.
        if (out < p.minOut) fail(`slippage: got ${out}, minOut ${p.minOut}`);

        L.debitNative(state, from, p.amountIn);
        cur.reserveNative = L.checkedAdd(cur.reserveNative, p.amountIn, "reserveNative");
        cur.reserveToken -= out;
        L.creditToken(state, from, p.symbol, out);
        ctx.receipts.push({ tx: tx.hash, type: "BUY", symbol: p.symbol, in: p.amountIn, out });
    },

    [TxType.SELL](state, tx, ctx, from) {
        const p = tx.payload;
        const cur = state.currencies[p.symbol];
        if (!cur) fail("unknown currency " + p.symbol);

        const out = L.amountOut(p.amountIn, cur.reserveToken, cur.reserveNative);
        if (out < p.minOut) fail(`slippage: got ${out}, minOut ${p.minOut}`);

        L.debitToken(state, from, p.symbol, p.amountIn);
        cur.reserveToken = L.checkedAdd(cur.reserveToken, p.amountIn, "reserveToken");
        cur.reserveNative -= out;
        L.creditNative(state, from, out);
        ctx.receipts.push({ tx: tx.hash, type: "SELL", symbol: p.symbol, in: p.amountIn, out });
    },

    [TxType.CREATE_VOTE](state, tx, ctx, from) {
        const p = tx.payload;
        if (state.votes[tx.hash]) fail("vote already exists");
        if (p.serverId !== null && p.serverId !== undefined && !state.servers[p.serverId]) {
            fail("unknown server " + p.serverId);
        }
        state.votes[tx.hash] = {
            id: tx.hash,
            statement: p.statement,
            creator: from,
            serverId: p.serverId || null,
            yes: 0,
            no: 0,
            voters: {},
            createdAt: ctx.timestamp,
            // Expiry is measured in block time, not wall-clock time, so every
            // node closes the vote at exactly the same block.
            endTime: ctx.timestamp + p.durationMs,
            running: true,
            result: null,
        };
    },

    [TxType.CAST_VOTE](state, tx, ctx, from) {
        const p = tx.payload;
        const v = state.votes[p.voteId];
        if (!v) fail("unknown vote");
        if (!v.running) fail("vote has closed");
        if (v.voters[from]) fail("address has already voted");
        v.voters[from] = p.choice;
        if (p.choice === "yes") v.yes += 1;
        else v.no += 1;
    },

    [TxType.REGISTER_UUID](state, tx, ctx, from) {
        const p = tx.payload;
        const acct = L.getAccount(state, from);
        const existing = state.uuids[p.uuid];
        if (existing && existing !== from) fail("uuid already registered to another address");
        if (acct.uuid && acct.uuid !== p.uuid) fail("address already bound to another uuid");
        state.uuids[p.uuid] = from;
        acct.uuid = p.uuid;
    },
};

/** One dispatch table, assembled once. */
const handlers = {
    ...coreHandlers,
    ...bank.handlers,
    ...market.handlers,
    ...land.handlers,
    ...stocks.handlers,
};

// ---------------------------------------------------------------------------
// Transaction application
// ---------------------------------------------------------------------------

function applyTransaction(state, tx, ctx) {
    if (tx.type === TxType.COINBASE) fail("coinbase must be applied by applyBlock");

    const from = senderOf(tx);
    const acct = L.getAccount(state, from);

    // Sequential nonces: each transaction is usable exactly once, in order.
    if (tx.nonce !== acct.nonce) {
        fail(`bad nonce for ${from}: expected ${acct.nonce}, got ${tx.nonce}`);
    }

    // The fee is charged before the body runs, so a failing body still cannot be
    // free -- but a failing body aborts the whole block, so nothing is charged
    // for a transaction that never lands.
    L.debitNative(state, from, tx.fee);
    acct.nonce += 1;

    const handler = handlers[tx.type];
    if (!handler) fail("unknown transaction type " + tx.type);
    handler(state, tx, ctx, from);
}

/**
 * Time-based effects, evaluated after every block.
 *
 * Ids are sorted so the order of settlement is identical on every node --
 * object key order is not something consensus can rely on.
 */
function processExpirations(state, timestamp) {
    for (const id of Object.keys(state.votes).sort()) {
        const v = state.votes[id];
        if (v.running && timestamp >= v.endTime) {
            v.running = false;
            v.result = v.yes > v.no ? "passed" : v.yes < v.no ? "rejected" : "tied";
        }
    }
    bank.processExpirations(state, timestamp);
}

/**
 * Apply a whole block. Returns a NEW state; the input is never mutated, so a
 * block that fails partway through leaves the node's state untouched.
 */
function applyBlock(state, block) {
    const next = cloneState(state);

    if (block.index !== next.height + 1) fail("block index does not follow state height");

    const ctx = { timestamp: block.timestamp, height: block.index, receipts: [] };

    const coinbase = block.transactions[0];
    const body = block.transactions.slice(1);

    let feeTotal = 0;
    for (const tx of body) feeTotal = L.checkedAdd(feeTotal, tx.fee, "fees");

    // The miner may not mint more than the protocol allows.
    if (coinbase.payload.reward !== cfg.BLOCK_REWARD) fail("invalid coinbase reward");
    if (coinbase.payload.fees !== feeTotal) fail("coinbase fees do not match block fees");
    if (coinbase.nonce !== block.index) fail("coinbase height mismatch");

    for (const tx of body) applyTransaction(next, tx, ctx);

    L.creditNative(next, coinbase.payload.to, coinbase.payload.reward + coinbase.payload.fees);

    processExpirations(next, block.timestamp);

    next.height = block.index;
    next.lastHash = block.hash;
    next.lastTimestamp = block.timestamp;

    return { state: next, receipts: ctx.receipts };
}

/**
 * Every native coin in existence, wherever it is currently parked.
 *
 * Coin leaves the account table in several places -- pool reserves, contract
 * escrow, the bank, company treasuries -- and a bug in any of them would show
 * up as supply quietly appearing or vanishing. This is what the supply
 * invariant in the test suite measures against genesis plus block rewards plus
 * bank interest.
 */
function circulatingSupply(state) {
    let total = 0;
    for (const acct of Object.values(state.accounts)) total += acct.balance;
    for (const cur of Object.values(state.currencies)) total += cur.reserveNative;
    for (const co of Object.values(state.companies)) total += co.reserveNative + co.treasury;
    total += state.bank.pending + state.bank.vault + state.bank.treasury;
    return total;
}

/** Read-only account view for the API. */
function accountView(state, address) {
    const acct = state.accounts[address];
    const shares = stocks.shareHoldings(state, address);
    if (!acct) {
        return { address, balance: 0, nonce: 0, tokens: {}, shares, uuid: null, exists: false };
    }
    return {
        address,
        balance: acct.balance,
        nonce: acct.nonce,
        tokens: { ...acct.tokens },
        shares,
        uuid: acct.uuid,
        exists: true,
    };
}

module.exports = {
    StateError,
    emptyState,
    cloneState,
    stateRoot,
    getAccount: L.getAccount,
    accountView,
    circulatingSupply,
    applyBlock,
    applyTransaction,
    processExpirations,
    amountOut: L.amountOut,
    spotPrice: L.spotPrice,
    chunkKey: land.chunkKey,
};
