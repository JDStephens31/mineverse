"use strict";

const cfg = require("./config");
const { TxType } = require("./transaction");
const L = require("./ledger");

/**
 * The bank, and the contracts it holds funds for.
 *
 * A contract is a two-sided agreement. It moves through a lifecycle rather than
 * springing into existence fully formed:
 *
 *     proposed --accept--> active --resolve/expire--> settled
 *        |                    ^
 *        |                    |  principal sits in the bank vault from here,
 *        |                    |  earning the bank interest over block time
 *        +--reject/cancel/timeout--> refunded
 *
 * The proposer's coin is debited the moment the contract is *proposed*, not
 * when it is accepted. That is what makes "the signer must have enough currency
 * or no contract can be made" true in a way that still holds later: if the
 * check ran only at proposal time, the proposer could spend the money before
 * the counterparty accepted, and acceptance would fail on a contract both sides
 * believed was funded. Escrowing up front means an accepted contract is always
 * payable.
 *
 * Contracts are denominated in the native coin only. The bank stakes what it
 * holds, and a token's value is set by a pool the bank does not control.
 */

/** Coin held outside any account: escrowed principal plus the bank's own funds. */
function emptyBank() {
    return {
        /** Principal for contracts that are proposed but not yet accepted. */
        pending: 0,
        /** Principal for accepted contracts. This is what earns interest. */
        vault: 0,
        /** The bank's own native coin: interest, market fees, land sales. */
        treasury: 0,
        /** Non-native fees collected by the marketplace, by symbol. */
        tokens: {},
        /** Lifetime interest minted to the bank. Keeps supply auditable. */
        interestPaid: 0,
    };
}

/**
 * Interest earned on `principal` over `elapsedMs` of block time.
 *
 * Integer math through BigInt: a floating-point rate would round differently
 * across platforms and split the network. Rounds down, so the bank never earns
 * a fraction it is not owed.
 */
function accruedInterest(principal, elapsedMs) {
    if (principal <= 0 || elapsedMs <= 0 || cfg.BANK_INTEREST_APR_BPS <= 0) return 0;

    const capped = Math.min(elapsedMs, cfg.MAX_CONTRACT_DURATION_MS);
    const earned =
        (BigInt(principal) * BigInt(cfg.BANK_INTEREST_APR_BPS) * BigInt(capped)) /
        (10000n * BigInt(cfg.MS_PER_YEAR));

    if (earned > BigInt(Number.MAX_SAFE_INTEGER)) L.fail("interest overflow");
    return Number(earned);
}

/** Fees and land sales. Existing supply moving into the bank, never minted. */
function creditTreasury(state, amount) {
    if (amount === 0) return;
    state.bank.treasury = L.checkedAdd(state.bank.treasury, amount, "bank treasury");
}

function creditTreasuryAsset(state, symbol, amount) {
    if (amount === 0) return;
    if (symbol === cfg.NATIVE) creditTreasury(state, amount);
    else state.bank.tokens[symbol] = L.checkedAdd(state.bank.tokens[symbol] || 0, amount, "bank tokens");
}

/** Interest, on the other hand, is new supply -- a staking reward for the bank. */
function mintInterest(state, amount) {
    if (amount <= 0) return 0;
    state.bank.treasury = L.checkedAdd(state.bank.treasury, amount, "bank treasury");
    state.bank.interestPaid = L.checkedAdd(state.bank.interestPaid, amount, "bank interest");
    return amount;
}

/** Pay the contractee and let the bank keep what the principal earned. */
function settleContract(state, contract, timestamp, settlement) {
    state.bank.vault -= contract.cost;
    L.creditNative(state, contract.contractee, contract.cost);

    contract.interest = mintInterest(state, accruedInterest(contract.cost, timestamp - contract.acceptedAt));
    contract.status = "settled";
    contract.running = false;
    contract.settledAt = timestamp;
    contract.settlement = settlement;
}

/** Return an un-accepted proposal's escrow to whoever put it up. */
function refundContract(state, contract, timestamp, settlement) {
    state.bank.pending -= contract.cost;
    L.creditNative(state, contract.contracter, contract.cost);

    contract.status = settlement === "expired" ? "expired" : settlement;
    contract.running = false;
    contract.settledAt = timestamp;
    contract.settlement = settlement;
}

const handlers = {
    [TxType.CREATE_CONTRACT](state, tx, ctx, from) {
        const p = tx.payload;
        if (state.contracts[tx.hash]) L.fail("contract already exists");
        if (p.contractee === from) L.fail("cannot contract with yourself");

        // Escrow now. The original released funds at expiry with no guarantee
        // the payer still had them, so contracts could silently settle for
        // nothing.
        L.debitNative(state, from, p.cost);
        state.bank.pending = L.checkedAdd(state.bank.pending, p.cost, "bank pending");

        state.contracts[tx.hash] = {
            id: tx.hash,
            contracter: from,
            contractee: p.contractee,
            cost: p.cost,
            data: typeof p.data === "string" ? p.data : "",
            status: "proposed",
            running: true,
            createdAt: ctx.timestamp,
            durationMs: p.durationMs,
            // Both deadlines are block time, not wall-clock time, so every node
            // closes the contract at exactly the same block.
            acceptDeadline: ctx.timestamp + cfg.CONTRACT_ACCEPT_WINDOW_MS,
            acceptedAt: null,
            endTime: null,
            settledAt: null,
            settlement: null,
            interest: 0,
        };
    },

    [TxType.ACCEPT_CONTRACT](state, tx, ctx, from) {
        const c = state.contracts[tx.payload.contractId];
        if (!c) L.fail("unknown contract");
        if (c.status !== "proposed") L.fail(`contract is ${c.status}, not open for acceptance`);
        if (c.contractee !== from) L.fail("only the contractee may accept");
        if (ctx.timestamp >= c.acceptDeadline) L.fail("acceptance window has closed");

        // Confirmed: the principal moves from the holding pen into the vault,
        // and the clock the bank earns on starts here.
        state.bank.pending -= c.cost;
        state.bank.vault = L.checkedAdd(state.bank.vault, c.cost, "bank vault");

        c.status = "active";
        c.acceptedAt = ctx.timestamp;
        c.endTime = ctx.timestamp + c.durationMs;
    },

    [TxType.REJECT_CONTRACT](state, tx, ctx, from) {
        const c = state.contracts[tx.payload.contractId];
        if (!c) L.fail("unknown contract");
        if (c.status !== "proposed") L.fail(`contract is ${c.status}, not open for rejection`);
        if (c.contractee !== from) L.fail("only the contractee may reject");
        refundContract(state, c, ctx.timestamp, "rejected");
    },

    [TxType.CANCEL_CONTRACT](state, tx, ctx, from) {
        const c = state.contracts[tx.payload.contractId];
        if (!c) L.fail("unknown contract");
        // Only withdrawable before the counterparty commits. Once accepted the
        // contractee is relying on it, and only settlement can end it.
        if (c.status !== "proposed") L.fail(`contract is ${c.status}, too late to cancel`);
        if (c.contracter !== from) L.fail("only the contracter may cancel");
        refundContract(state, c, ctx.timestamp, "cancelled");
    },

    [TxType.RESOLVE_CONTRACT](state, tx, ctx, from) {
        const c = state.contracts[tx.payload.contractId];
        if (!c) L.fail("unknown contract");
        if (c.status !== "active") L.fail(`contract is ${c.status}, not settleable`);
        if (c.contracter !== from) L.fail("only the contracter may settle early");
        settleContract(state, c, ctx.timestamp, "resolved");
    },
};

/**
 * Time-based settlement, evaluated after every block.
 *
 * Ids are sorted by the caller so the order is identical on every node --
 * object key order is not something consensus can rely on.
 */
function processExpirations(state, timestamp) {
    for (const id of Object.keys(state.contracts).sort()) {
        const c = state.contracts[id];
        if (c.status === "proposed" && timestamp >= c.acceptDeadline) {
            refundContract(state, c, timestamp, "expired");
        } else if (c.status === "active" && timestamp >= c.endTime) {
            settleContract(state, c, timestamp, "expired");
        }
    }
}

module.exports = {
    emptyBank,
    accruedInterest,
    creditTreasury,
    creditTreasuryAsset,
    handlers,
    processExpirations,
};
