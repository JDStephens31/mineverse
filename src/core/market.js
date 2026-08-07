"use strict";

const cfg = require("./config");
const { TxType } = require("./transaction");
const L = require("./ledger");
const bank = require("./bank");

/**
 * Item custody and the marketplace.
 *
 * The two are one subsystem because a listing is not a promise to hand
 * something over later -- it is a claim on items the chain is already holding.
 * The flow is:
 *
 *     DEPOSIT_INVENTORY   items leave the world and enter chain custody
 *     LIST_ITEM           that custody record is offered at a price
 *     BUY_LISTING         the buyer pays; custody transfers to them
 *     WITHDRAW_INVENTORY  the buyer pulls the items down on any server
 *
 * Because the listing escrows the custody record rather than the items
 * themselves, a seller cannot withdraw what they have listed, and a sale cannot
 * fail to deliver. The buyer owns the record the instant the block lands; the
 * withdrawal is just them collecting it, and it works on any server on the
 * network, not only the one the items were deposited on.
 */

function listedElsewhere(inv) {
    return inv.listingId !== null && inv.listingId !== undefined;
}

const handlers = {
    [TxType.DEPOSIT_INVENTORY](state, tx, ctx, from) {
        const p = tx.payload;
        if (state.inventories[tx.hash]) L.fail("inventory already exists");

        const owner = state.uuids[p.uuid];
        if (owner && owner !== from) L.fail("uuid is registered to a different address");

        state.inventories[tx.hash] = {
            id: tx.hash,
            owner: from,
            uuid: p.uuid,
            serverId: typeof p.serverId === "string" ? p.serverId : null,
            items: p.items,
            depositedAt: ctx.timestamp,
            listingId: null,
            acquiredVia: null,
            claimed: false,
            claimedAt: null,
        };
    },

    [TxType.WITHDRAW_INVENTORY](state, tx, ctx, from) {
        const p = tx.payload;
        const inv = state.inventories[p.inventoryId];
        if (!inv) L.fail("unknown inventory");
        // Ownership is proved by the signature, not by knowing the id -- the
        // original handed items to anyone who asked with a uuid.
        if (inv.owner !== from) L.fail("inventory belongs to another address");
        if (inv.claimed) L.fail("inventory already withdrawn");
        if (listedElsewhere(inv)) L.fail("inventory is listed for sale; cancel the listing first");

        inv.claimed = true;
        inv.claimedAt = ctx.timestamp;
        inv.claimedByUuid = p.uuid;
        ctx.receipts.push({ tx: tx.hash, type: "WITHDRAW_INVENTORY", items: inv.items });
    },

    [TxType.LIST_ITEM](state, tx, ctx, from) {
        const p = tx.payload;
        if (state.listings[tx.hash]) L.fail("listing already exists");

        const inv = state.inventories[p.inventoryId];
        if (!inv) L.fail("unknown inventory");
        if (inv.owner !== from) L.fail("inventory belongs to another address");
        if (inv.claimed) L.fail("inventory has already been withdrawn");
        if (listedElsewhere(inv)) L.fail("inventory is already listed");

        // Pricing in a token the chain has never heard of would produce a
        // listing nobody could ever buy.
        L.requireAsset(state, p.symbol);

        state.listings[tx.hash] = {
            id: tx.hash,
            seller: from,
            inventoryId: p.inventoryId,
            price: p.price,
            symbol: p.symbol,
            note: typeof p.note === "string" ? p.note : "",
            serverId: inv.serverId,
            status: "open",
            createdAt: ctx.timestamp,
            buyer: null,
            soldAt: null,
            fee: 0,
        };
        inv.listingId = tx.hash;
    },

    [TxType.CANCEL_LISTING](state, tx, ctx, from) {
        const listing = state.listings[tx.payload.listingId];
        if (!listing) L.fail("unknown listing");
        if (listing.status !== "open") L.fail(`listing is ${listing.status}`);
        if (listing.seller !== from) L.fail("only the seller may cancel a listing");

        listing.status = "cancelled";
        const inv = state.inventories[listing.inventoryId];
        if (inv) inv.listingId = null;
    },

    [TxType.BUY_LISTING](state, tx, ctx, from) {
        const listing = state.listings[tx.payload.listingId];
        if (!listing) L.fail("unknown listing");
        if (listing.status !== "open") L.fail(`listing is ${listing.status}`);
        if (listing.seller === from) L.fail("cannot buy your own listing");

        const inv = state.inventories[listing.inventoryId];
        if (!inv) L.fail("listing has no inventory");
        if (inv.claimed) L.fail("inventory has already been withdrawn");

        // The buyer pays the asking price; the bank takes its cut out of the
        // seller's proceeds rather than adding to what the buyer was quoted.
        const fee = L.feeOf(listing.price, cfg.MARKET_FEE_BPS);
        L.debitAsset(state, from, listing.symbol, listing.price);
        L.creditAsset(state, listing.seller, listing.symbol, listing.price - fee);
        bank.creditTreasuryAsset(state, listing.symbol, fee);

        listing.status = "sold";
        listing.buyer = from;
        listing.soldAt = ctx.timestamp;
        listing.fee = fee;

        // The items are the buyer's from here. They collect them with a
        // WITHDRAW_INVENTORY on whichever server they happen to be playing on.
        inv.owner = from;
        inv.listingId = null;
        inv.acquiredVia = listing.id;

        ctx.receipts.push({
            tx: tx.hash,
            type: "BUY_LISTING",
            listing: listing.id,
            inventoryId: inv.id,
            price: listing.price,
            symbol: listing.symbol,
            fee,
        });
    },
};

module.exports = { handlers };
