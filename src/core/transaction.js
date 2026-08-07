"use strict";

const cfg = require("./config");
const keys = require("../crypto/keys");
const { hashObject } = require("../util/hash");

/**
 * Transaction types.
 *
 * These are the operations that used to be separate "block" classes. Making
 * them transactions rather than blocks is what lets many of them settle in one
 * block, and lets the chain be validated as an append-only log instead of a
 * mutable array of records.
 */
const TxType = {
    COINBASE: "COINBASE",
    TRANSFER: "TRANSFER",
    CREATE_CURRENCY: "CREATE_CURRENCY",
    BUY: "BUY",
    SELL: "SELL",
    CREATE_VOTE: "CREATE_VOTE",
    CAST_VOTE: "CAST_VOTE",
    CREATE_CONTRACT: "CREATE_CONTRACT",
    ACCEPT_CONTRACT: "ACCEPT_CONTRACT",
    REJECT_CONTRACT: "REJECT_CONTRACT",
    CANCEL_CONTRACT: "CANCEL_CONTRACT",
    RESOLVE_CONTRACT: "RESOLVE_CONTRACT",
    DEPOSIT_INVENTORY: "DEPOSIT_INVENTORY",
    WITHDRAW_INVENTORY: "WITHDRAW_INVENTORY",
    REGISTER_UUID: "REGISTER_UUID",

    /** Marketplace. */
    LIST_ITEM: "LIST_ITEM",
    CANCEL_LISTING: "CANCEL_LISTING",
    BUY_LISTING: "BUY_LISTING",

    /** Servers and land. */
    REGISTER_SERVER: "REGISTER_SERVER",
    CLAIM_CHUNK: "CLAIM_CHUNK",
    SET_CHUNK_SALE: "SET_CHUNK_SALE",
    BUY_CHUNK: "BUY_CHUNK",
    TRANSFER_CHUNK: "TRANSFER_CHUNK",

    /** Stock market. */
    CREATE_COMPANY: "CREATE_COMPANY",
    BUY_SHARES: "BUY_SHARES",
    SELL_SHARES: "SELL_SHARES",
    TRANSFER_SHARES: "TRANSFER_SHARES",
    COMPANY_PAYOUT: "COMPANY_PAYOUT",
    PAY_DIVIDEND: "PAY_DIVIDEND",
};

const SIGNED_TYPES = new Set(Object.values(TxType).filter((t) => t !== TxType.COINBASE));

const SYMBOL_RE = /^[A-Z][A-Z0-9]{1,9}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;
/** Server ids and dimensions become parts of a chunk key, so `/` and `,` are out. */
const SERVER_ID_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const DIMENSION_RE = /^[a-z0-9][a-z0-9_:.-]{0,31}$/;

class TxError extends Error {}

function fail(msg) {
    throw new TxError(msg);
}

function requireInt(value, name, { min = 0, max = cfg.MAX_AMOUNT } = {}) {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        fail(`${name} must be a safe integer`);
    }
    if (value < min || value > max) fail(`${name} out of range [${min}, ${max}]`);
    return value;
}

function requireString(value, name, maxLen) {
    if (typeof value !== "string") fail(`${name} must be a string`);
    if (value.length === 0) fail(`${name} must not be empty`);
    if (value.length > maxLen) fail(`${name} exceeds ${maxLen} characters`);
    return value;
}

function requireSymbol(value, name) {
    requireString(value, name, 10);
    if (!SYMBOL_RE.test(value)) fail(`${name} must match ${SYMBOL_RE}`);
    return value;
}

function requireAddress(value, name) {
    if (!keys.isValidAddress(value)) fail(`${name} must be a valid address`);
    return value;
}

function requireHash(value, name) {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail(`${name} must be a hash`);
    return value;
}

/** Optional free text. Absent and empty are both fine; oversized is not. */
function optionalString(value, name, maxLen) {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") fail(`${name} must be a string`);
    if (value.length > maxLen) fail(`${name} exceeds ${maxLen} characters`);
    return value;
}

function requireServerId(value, name) {
    requireString(value, name, 32);
    if (!SERVER_ID_RE.test(value)) fail(`${name} must match ${SERVER_ID_RE}`);
    return value;
}

/** Chunk coordinates: signed, bounded well outside any real world border. */
function requireCoord(value, name) {
    return requireInt(value, name, { min: -cfg.MAX_CHUNK_COORD, max: cfg.MAX_CHUNK_COORD });
}

function requireChunkRef(p) {
    requireServerId(p.serverId, "payload.serverId");
    requireString(p.dimension, "payload.dimension", 32);
    if (!DIMENSION_RE.test(p.dimension)) fail(`payload.dimension must match ${DIMENSION_RE}`);
    requireCoord(p.x, "payload.x");
    requireCoord(p.z, "payload.z");
}

/**
 * Bytes covered by the signature.
 *
 * Deliberately excludes `hash` and `signature` themselves. chainId is included
 * so a signature captured on one network cannot be replayed on another; nonce
 * is included so it cannot be replayed on this one.
 */
function signingPayload(tx) {
    return {
        chainId: tx.chainId,
        type: tx.type,
        from: tx.from,
        nonce: tx.nonce,
        fee: tx.fee,
        timestamp: tx.timestamp,
        payload: tx.payload,
    };
}

function txHash(tx) {
    return hashObject(signingPayload(tx));
}

/** Build and sign a transaction. `wallet` must expose privateKey + publicKey. */
function createTransaction({ wallet, type, payload, nonce, fee = cfg.MIN_FEE, timestamp = Date.now() }) {
    if (!SIGNED_TYPES.has(type)) fail("unknown transaction type: " + type);

    const tx = {
        chainId: cfg.CHAIN_ID,
        type,
        from: wallet.publicKey,
        nonce: requireInt(nonce, "nonce"),
        fee: requireInt(fee, "fee", { min: cfg.MIN_FEE }),
        timestamp: requireInt(timestamp, "timestamp"),
        payload,
    };

    validatePayload(tx);
    tx.hash = txHash(tx);
    tx.signature = keys.sign(wallet.privateKey, tx.hash);
    return tx;
}

/** Coinbase carries the block reward + collected fees. It is unsigned by design. */
function createCoinbase({ to, reward, fees, height }) {
    const tx = {
        chainId: cfg.CHAIN_ID,
        type: TxType.COINBASE,
        from: null,
        nonce: requireInt(height, "height"),
        fee: 0,
        timestamp: 0,
        payload: {
            to: requireAddress(to, "payload.to"),
            reward: requireInt(reward, "payload.reward"),
            fees: requireInt(fees, "payload.fees"),
        },
    };
    tx.hash = txHash(tx);
    tx.signature = null;
    return tx;
}

/** Per-type structural checks. Runs before any state is touched. */
function validatePayload(tx) {
    const p = tx.payload;
    if (p === null || typeof p !== "object" || Array.isArray(p)) fail("payload must be an object");

    switch (tx.type) {
        case TxType.COINBASE:
            requireAddress(p.to, "payload.to");
            requireInt(p.reward, "payload.reward");
            requireInt(p.fees, "payload.fees");
            break;

        case TxType.TRANSFER:
            requireAddress(p.to, "payload.to");
            requireInt(p.amount, "payload.amount", { min: 1 });
            requireSymbol(p.symbol, "payload.symbol");
            break;

        case TxType.CREATE_CURRENCY:
            requireString(p.name, "payload.name", 40);
            requireSymbol(p.symbol, "payload.symbol");
            if (p.symbol === cfg.NATIVE) fail("payload.symbol is reserved");
            requireInt(p.totalSupply, "payload.totalSupply", { min: 1, max: cfg.MAX_TOKEN_SUPPLY });
            requireInt(p.liquidity, "payload.liquidity", { min: cfg.MIN_LIQUIDITY });
            break;

        case TxType.BUY:
            requireSymbol(p.symbol, "payload.symbol");
            requireInt(p.amountIn, "payload.amountIn", { min: 1 });
            requireInt(p.minOut, "payload.minOut", { min: 0 });
            break;

        case TxType.SELL:
            requireSymbol(p.symbol, "payload.symbol");
            requireInt(p.amountIn, "payload.amountIn", { min: 1 });
            requireInt(p.minOut, "payload.minOut", { min: 0 });
            break;

        case TxType.CREATE_VOTE:
            requireString(p.statement, "payload.statement", 280);
            requireInt(p.durationMs, "payload.durationMs", {
                min: cfg.MIN_VOTE_DURATION_MS,
                max: cfg.MAX_VOTE_DURATION_MS,
            });
            // Polls may be scoped to one server so a website can show a server
            // only the questions its own players are being asked.
            if (p.serverId !== undefined && p.serverId !== null) {
                requireServerId(p.serverId, "payload.serverId");
            }
            break;

        case TxType.CAST_VOTE:
            requireHash(p.voteId, "payload.voteId");
            if (p.choice !== "yes" && p.choice !== "no") fail("payload.choice must be 'yes' or 'no'");
            break;

        case TxType.CREATE_CONTRACT:
            requireAddress(p.contractee, "payload.contractee");
            requireInt(p.cost, "payload.cost", { min: 1 });
            requireInt(p.durationMs, "payload.durationMs", {
                min: cfg.MIN_CONTRACT_DURATION_MS,
                max: cfg.MAX_CONTRACT_DURATION_MS,
            });
            requireString(typeof p.data === "string" ? p.data : "", "payload.data", 1024);
            break;

        case TxType.ACCEPT_CONTRACT:
        case TxType.REJECT_CONTRACT:
        case TxType.CANCEL_CONTRACT:
        case TxType.RESOLVE_CONTRACT:
            requireHash(p.contractId, "payload.contractId");
            break;

        case TxType.DEPOSIT_INVENTORY:
            if (typeof p.uuid !== "string" || !UUID_RE.test(p.uuid)) fail("payload.uuid must be a UUID");
            validateItems(p.items);
            if (p.serverId !== undefined && p.serverId !== null) {
                requireServerId(p.serverId, "payload.serverId");
            }
            break;

        case TxType.WITHDRAW_INVENTORY:
            requireHash(p.inventoryId, "payload.inventoryId");
            if (typeof p.uuid !== "string" || !UUID_RE.test(p.uuid)) fail("payload.uuid must be a UUID");
            break;

        case TxType.REGISTER_UUID:
            if (typeof p.uuid !== "string" || !UUID_RE.test(p.uuid)) fail("payload.uuid must be a UUID");
            break;

        // -- marketplace ---------------------------------------------------

        case TxType.LIST_ITEM:
            requireHash(p.inventoryId, "payload.inventoryId");
            requireInt(p.price, "payload.price", { min: 1 });
            requireSymbol(p.symbol, "payload.symbol");
            optionalString(p.note, "payload.note", 140);
            break;

        case TxType.CANCEL_LISTING:
        case TxType.BUY_LISTING:
            requireHash(p.listingId, "payload.listingId");
            break;

        // -- servers and land ----------------------------------------------

        case TxType.REGISTER_SERVER:
            requireServerId(p.serverId, "payload.serverId");
            requireString(p.name, "payload.name", 60);
            optionalString(p.description, "payload.description", 500);
            break;

        case TxType.CLAIM_CHUNK:
            requireChunkRef(p);
            optionalString(p.name, "payload.name", 60);
            break;

        case TxType.SET_CHUNK_SALE:
            requireChunkRef(p);
            // Zero is meaningful here: it delists the chunk.
            requireInt(p.price, "payload.price", { min: 0 });
            break;

        case TxType.BUY_CHUNK:
            requireChunkRef(p);
            requireInt(p.maxPrice, "payload.maxPrice", { min: 1 });
            break;

        case TxType.TRANSFER_CHUNK:
            requireChunkRef(p);
            requireAddress(p.to, "payload.to");
            break;

        // -- stock market ---------------------------------------------------

        case TxType.CREATE_COMPANY:
            requireString(p.name, "payload.name", 60);
            requireSymbol(p.symbol, "payload.symbol");
            if (p.symbol === cfg.NATIVE) fail("payload.symbol is reserved");
            optionalString(p.description, "payload.description", 500);
            requireInt(p.totalShares, "payload.totalShares", {
                min: cfg.MIN_COMPANY_SHARES,
                max: cfg.MAX_COMPANY_SHARES,
            });
            requireInt(p.liquidity, "payload.liquidity", { min: cfg.MIN_COMPANY_LIQUIDITY });
            if (p.serverId !== undefined && p.serverId !== null) {
                requireServerId(p.serverId, "payload.serverId");
            }
            break;

        case TxType.BUY_SHARES:
        case TxType.SELL_SHARES:
            requireSymbol(p.symbol, "payload.symbol");
            requireInt(p.amountIn, "payload.amountIn", { min: 1 });
            requireInt(p.minOut, "payload.minOut", { min: 0 });
            break;

        case TxType.TRANSFER_SHARES:
            requireSymbol(p.symbol, "payload.symbol");
            requireAddress(p.to, "payload.to");
            requireInt(p.amount, "payload.amount", { min: 1 });
            break;

        case TxType.COMPANY_PAYOUT:
            requireSymbol(p.symbol, "payload.symbol");
            requireAddress(p.to, "payload.to");
            requireInt(p.amount, "payload.amount", { min: 1 });
            optionalString(p.memo, "payload.memo", 140);
            break;

        case TxType.PAY_DIVIDEND:
            requireSymbol(p.symbol, "payload.symbol");
            requireInt(p.amount, "payload.amount", { min: 1 });
            break;

        default:
            fail("unknown transaction type: " + tx.type);
    }
}

function validateItems(items) {
    if (!Array.isArray(items)) fail("payload.items must be an array");
    if (items.length === 0) fail("payload.items must not be empty");
    if (items.length > cfg.MAX_INVENTORY_SLOTS) {
        fail(`payload.items exceeds ${cfg.MAX_INVENTORY_SLOTS} slots`);
    }
    for (const item of items) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
            fail("each item must be an object");
        }
        requireString(item.id, "item.id", 64);
        requireInt(item.count, "item.count", { min: 1, max: cfg.MAX_STACK_SIZE });
        requireInt(item.meta ?? 0, "item.meta", { min: 0, max: 65535 });
        if (item.nbt !== undefined) requireString(item.nbt, "item.nbt", 4096);
    }
}

/**
 * Full stateless validation: shape, hash integrity, and signature.
 *
 * Nothing here depends on chain state, so it is safe to run on anything
 * arriving from the network before deciding whether to spend effort on it.
 */
function validateTransaction(tx, { now = Date.now() } = {}) {
    if (tx === null || typeof tx !== "object" || Array.isArray(tx)) fail("tx must be an object");
    if (tx.chainId !== cfg.CHAIN_ID) fail("wrong chainId");
    if (typeof tx.type !== "string") fail("tx.type must be a string");

    requireInt(tx.nonce, "tx.nonce");
    requireInt(tx.fee, "tx.fee");
    requireInt(tx.timestamp, "tx.timestamp");
    validatePayload(tx);

    // The hash must actually commit to the contents, or the signature proves nothing.
    if (tx.hash !== txHash(tx)) fail("tx.hash does not match contents");

    if (tx.type === TxType.COINBASE) {
        if (tx.from !== null) fail("coinbase must have a null sender");
        if (tx.signature !== null && tx.signature !== undefined) fail("coinbase must be unsigned");
        if (tx.fee !== 0) fail("coinbase fee must be 0");
        return true;
    }

    if (tx.fee < cfg.MIN_FEE) fail("fee below minimum");
    if (tx.timestamp > now + cfg.MAX_TX_FUTURE_DRIFT_MS) fail("tx timestamp too far in the future");
    if (!keys.isValidPublicKey(tx.from)) fail("tx.from is not a valid public key");
    if (!keys.verify(tx.from, tx.hash, tx.signature)) fail("invalid signature");

    return true;
}

/** Address that authorised this transaction, derived from the signing key. */
function senderOf(tx) {
    return tx.type === TxType.COINBASE ? null : keys.addressFromPublicKey(tx.from);
}

module.exports = {
    TxType,
    TxError,
    createTransaction,
    createCoinbase,
    validateTransaction,
    validatePayload,
    txHash,
    signingPayload,
    senderOf,
};
