"use strict";

const cfg = require("./config");

/**
 * Ledger primitives.
 *
 * The lowest layer of the state machine: accounts, balances, and the pricing
 * curve. Everything here is a pure function of the state object it is handed.
 * No Date.now(), no Math.random(), no timers -- two nodes replaying the same
 * blocks must land on byte-identical state.
 *
 * This lives apart from state.js so the domain modules (bank, market, land,
 * stocks) can move value without requiring the state machine that dispatches to
 * them.
 */

class StateError extends Error {}

function fail(msg) {
    throw new StateError(msg);
}

function checkedAdd(a, b, what) {
    const sum = a + b;
    if (!Number.isSafeInteger(sum)) fail(`${what} overflow`);
    return sum;
}

function getAccount(state, address) {
    let acct = state.accounts[address];
    if (!acct) {
        acct = { balance: 0, nonce: 0, tokens: {}, uuid: null };
        state.accounts[address] = acct;
    }
    return acct;
}

// -- native coin -------------------------------------------------------------

function creditNative(state, address, amount) {
    const acct = getAccount(state, address);
    acct.balance = checkedAdd(acct.balance, amount, "balance");
}

function debitNative(state, address, amount) {
    const acct = getAccount(state, address);
    if (acct.balance < amount) fail(`insufficient ${cfg.NATIVE}: need ${amount}, have ${acct.balance}`);
    acct.balance -= amount;
}

// -- tokens ------------------------------------------------------------------

function creditToken(state, address, symbol, amount) {
    const acct = getAccount(state, address);
    acct.tokens[symbol] = checkedAdd(acct.tokens[symbol] || 0, amount, "token balance");
}

function debitToken(state, address, symbol, amount) {
    const acct = getAccount(state, address);
    const held = acct.tokens[symbol] || 0;
    if (held < amount) fail(`insufficient ${symbol}: need ${amount}, have ${held}`);
    const left = held - amount;
    if (left === 0) delete acct.tokens[symbol];
    else acct.tokens[symbol] = left;
}

// -- either ------------------------------------------------------------------

/**
 * Move value denominated in any symbol, native or token.
 *
 * The marketplace prices listings in whatever currency the seller chose, so it
 * needs one call site that does not care which it is.
 */
function requireAsset(state, symbol) {
    if (symbol === cfg.NATIVE) return;
    if (!state.currencies[symbol]) fail("unknown currency " + symbol);
}

function creditAsset(state, address, symbol, amount) {
    if (amount === 0) return;
    if (symbol === cfg.NATIVE) creditNative(state, address, amount);
    else creditToken(state, address, symbol, amount);
}

function debitAsset(state, address, symbol, amount) {
    if (amount === 0) return;
    if (symbol === cfg.NATIVE) debitNative(state, address, amount);
    else debitToken(state, address, symbol, amount);
}

function balanceOfAsset(state, address, symbol) {
    const acct = state.accounts[address];
    if (!acct) return 0;
    return symbol === cfg.NATIVE ? acct.balance : acct.tokens[symbol] || 0;
}

// ---------------------------------------------------------------------------
// Constant-product AMM
//
// The original priced tokens as `liquidity / amount` and then let a buyer take
// `amount` tokens at that fixed price, which lets the pool be drained at a
// stale price. x*y=k makes price move with every trade, so draining the pool
// costs unbounded native coin.
//
// Currency pools and company share pools both settle through this function, so
// a stock's price fluctuates for exactly the same reason a token's does: every
// trade moves the reserves.
// ---------------------------------------------------------------------------

const BPS = 10000n;

function amountOut(amountIn, reserveIn, reserveOut) {
    const inBn = BigInt(amountIn);
    const rIn = BigInt(reserveIn);
    const rOut = BigInt(reserveOut);
    if (rIn <= 0n || rOut <= 0n) fail("pool has no liquidity");

    const inAfterFee = (inBn * (BPS - BigInt(cfg.SWAP_FEE_BPS))) / BPS;
    if (inAfterFee <= 0n) fail("trade too small");

    const out = (rOut * inAfterFee) / (rIn + inAfterFee);
    if (out <= 0n) fail("trade produces zero output");
    if (out >= rOut) fail("trade exceeds pool reserves");
    if (out > BigInt(Number.MAX_SAFE_INTEGER)) fail("output overflow");
    return Number(out);
}

/** Spot price in native per unit, for display only. Never used in settlement. */
function spotPrice(pool) {
    const reserveOut = pool.reserveToken !== undefined ? pool.reserveToken : pool.reserveShares;
    if (!reserveOut || reserveOut <= 0) return 0;
    return pool.reserveNative / reserveOut;
}

/** Portion of `amount` taken as a fee, rounded down so the fee never exceeds it. */
function feeOf(amount, bps) {
    return Math.floor((amount * bps) / 10000);
}

module.exports = {
    StateError,
    fail,
    checkedAdd,
    getAccount,
    creditNative,
    debitNative,
    creditToken,
    debitToken,
    requireAsset,
    creditAsset,
    debitAsset,
    balanceOfAsset,
    amountOut,
    spotPrice,
    feeOf,
};
