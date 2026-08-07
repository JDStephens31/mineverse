"use strict";

const cfg = require("./config");
const { TxType } = require("./transaction");
const L = require("./ledger");

/**
 * Companies and their stock.
 *
 * A company is a business somebody actually runs in the world -- a wood
 * operation, a mob farm, a build crew -- with a share pool attached. Shares
 * trade against the same constant-product curve that prices currencies, so a
 * stock's price moves for the honest reason: somebody bought or sold, and the
 * reserves shifted. There is no oracle and no scheduled price tick, because
 * neither could be made to agree across nodes.
 *
 * What separates a share from a token is where the money goes. A slice of every
 * purchase (COMPANY_TREASURY_BPS) is routed to the company treasury instead of
 * the pool, so buying stock funds operations -- tools, wages, materials -- which
 * the CEO spends with COMPANY_PAYOUT and returns with PAY_DIVIDEND. Selling
 * takes no such cut; an investor exiting is not an investment.
 *
 * Shares live only in `company.holders`. Keeping a second copy on the account
 * would mean two things to keep in step and one of them eventually being wrong.
 */

function requireCompany(state, symbol) {
    const company = state.companies[symbol];
    if (!company) L.fail("unknown company " + symbol);
    return company;
}

function sharesOf(company, address) {
    return company.holders[address] || 0;
}

function creditShares(company, address, amount) {
    if (amount === 0) return;
    const held = company.holders[address] || 0;
    if (held === 0) {
        // The holder table is walked in full by PAY_DIVIDEND, so it has to stay
        // bounded or one transaction could cost every node unbounded work.
        if (company.holderCount >= cfg.MAX_COMPANY_HOLDERS) {
            L.fail(`${company.symbol} has reached its ${cfg.MAX_COMPANY_HOLDERS} holder limit`);
        }
        company.holderCount += 1;
    }
    company.holders[address] = L.checkedAdd(held, amount, "share balance");
}

function debitShares(company, address, amount) {
    const held = company.holders[address] || 0;
    if (held < amount) L.fail(`insufficient ${company.symbol} shares: need ${amount}, have ${held}`);
    const left = held - amount;
    if (left === 0) {
        delete company.holders[address];
        company.holderCount -= 1;
    } else {
        company.holders[address] = left;
    }
}

/** Shares in players' hands, i.e. everything not sitting in the pool. */
function outstandingShares(company) {
    return company.totalShares - company.reserveShares;
}

/** Every share balance an address holds, assembled for the API. */
function shareHoldings(state, address) {
    const held = {};
    for (const symbol of Object.keys(state.companies).sort()) {
        const shares = state.companies[symbol].holders[address];
        if (shares) held[symbol] = shares;
    }
    return held;
}

const handlers = {
    [TxType.CREATE_COMPANY](state, tx, ctx, from) {
        const p = tx.payload;
        if (state.companies[p.symbol]) L.fail("company already exists: " + p.symbol);
        // One symbol namespace across tokens and stocks: a ticker that means two
        // different things is a trap for anyone reading a price.
        if (state.currencies[p.symbol]) L.fail("symbol is already a currency: " + p.symbol);
        if (p.serverId !== null && p.serverId !== undefined && !state.servers[p.serverId]) {
            L.fail("unknown server " + p.serverId);
        }

        const founderShares = Math.floor((p.totalShares * cfg.FOUNDER_SHARE_BPS) / 10000);
        const poolShares = p.totalShares - founderShares;
        if (poolShares <= 0) L.fail("share count too small to seed a pool");

        // The founder's liquidity is real coin, locked in the pool. Without it
        // there is no price for anyone to trade against.
        L.debitNative(state, from, p.liquidity);

        const company = {
            symbol: p.symbol,
            name: p.name,
            description: typeof p.description === "string" ? p.description : "",
            ceo: from,
            serverId: p.serverId || null,
            totalShares: p.totalShares,
            reserveNative: p.liquidity,
            reserveShares: poolShares,
            treasury: 0,
            treasuryRaised: 0,
            dividendsPaid: 0,
            holders: {},
            holderCount: 0,
            createdAt: ctx.timestamp,
            createdAtHeight: ctx.height,
        };
        state.companies[p.symbol] = company;
        creditShares(company, from, founderShares);
    },

    [TxType.BUY_SHARES](state, tx, ctx, from) {
        const p = tx.payload;
        const company = requireCompany(state, p.symbol);

        const toTreasury = L.feeOf(p.amountIn, cfg.COMPANY_TREASURY_BPS);
        const toPool = p.amountIn - toTreasury;

        const out = L.amountOut(toPool, company.reserveNative, company.reserveShares);
        // Slippage bound, supplied by the sender and enforced by consensus.
        if (out < p.minOut) L.fail(`slippage: got ${out}, minOut ${p.minOut}`);

        L.debitNative(state, from, p.amountIn);
        company.reserveNative = L.checkedAdd(company.reserveNative, toPool, "reserveNative");
        company.reserveShares -= out;
        company.treasury = L.checkedAdd(company.treasury, toTreasury, "company treasury");
        company.treasuryRaised = L.checkedAdd(company.treasuryRaised, toTreasury, "company raised");
        creditShares(company, from, out);

        ctx.receipts.push({
            tx: tx.hash,
            type: "BUY_SHARES",
            symbol: p.symbol,
            in: p.amountIn,
            out,
            toTreasury,
        });
    },

    [TxType.SELL_SHARES](state, tx, ctx, from) {
        const p = tx.payload;
        const company = requireCompany(state, p.symbol);

        const out = L.amountOut(p.amountIn, company.reserveShares, company.reserveNative);
        if (out < p.minOut) L.fail(`slippage: got ${out}, minOut ${p.minOut}`);

        debitShares(company, from, p.amountIn);
        company.reserveShares = L.checkedAdd(company.reserveShares, p.amountIn, "reserveShares");
        company.reserveNative -= out;
        L.creditNative(state, from, out);

        ctx.receipts.push({ tx: tx.hash, type: "SELL_SHARES", symbol: p.symbol, in: p.amountIn, out });
    },

    [TxType.TRANSFER_SHARES](state, tx, ctx, from) {
        const p = tx.payload;
        if (p.to === from) L.fail("cannot transfer to self");
        const company = requireCompany(state, p.symbol);
        debitShares(company, from, p.amount);
        creditShares(company, p.to, p.amount);
    },

    [TxType.COMPANY_PAYOUT](state, tx, ctx, from) {
        const p = tx.payload;
        const company = requireCompany(state, p.symbol);
        if (company.ceo !== from) L.fail("only the CEO may spend the company treasury");
        if (company.treasury < p.amount) {
            L.fail(`insufficient treasury: need ${p.amount}, have ${company.treasury}`);
        }

        company.treasury -= p.amount;
        L.creditNative(state, p.to, p.amount);
        ctx.receipts.push({
            tx: tx.hash,
            type: "COMPANY_PAYOUT",
            symbol: p.symbol,
            to: p.to,
            amount: p.amount,
            memo: typeof p.memo === "string" ? p.memo : "",
        });
    },

    [TxType.PAY_DIVIDEND](state, tx, ctx, from) {
        const p = tx.payload;
        const company = requireCompany(state, p.symbol);
        if (company.ceo !== from) L.fail("only the CEO may declare a dividend");
        if (company.treasury < p.amount) {
            L.fail(`insufficient treasury: need ${p.amount}, have ${company.treasury}`);
        }

        const outstanding = outstandingShares(company);
        if (outstanding <= 0) L.fail("no shares are held outside the pool");

        // Sorted so every node distributes in the same order, and rounded down
        // per holder so the total paid can never exceed what was declared. The
        // dust left over stays in the treasury for the next dividend.
        let distributed = 0;
        for (const address of Object.keys(company.holders).sort()) {
            const cut = Math.floor((p.amount * company.holders[address]) / outstanding);
            if (cut <= 0) continue;
            L.creditNative(state, address, cut);
            distributed += cut;
        }

        company.treasury -= distributed;
        company.dividendsPaid = L.checkedAdd(company.dividendsPaid, distributed, "dividends");

        ctx.receipts.push({
            tx: tx.hash,
            type: "PAY_DIVIDEND",
            symbol: p.symbol,
            declared: p.amount,
            distributed,
            holders: company.holderCount,
        });
    },
};

module.exports = { handlers, sharesOf, shareHoldings, outstandingShares };
