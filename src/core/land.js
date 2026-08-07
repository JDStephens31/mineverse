"use strict";

const cfg = require("./config");
const { TxType } = require("./transaction");
const L = require("./ledger");
const bank = require("./bank");

/**
 * Servers and land.
 *
 * Chunk ownership is recorded on the chain rather than in any one server's
 * world save, which is the whole point: a player's deed survives a server
 * wipe, and every server on the network can see who owns what everywhere. A
 * server is a namespace, registered once, that chunk keys hang off.
 *
 * Land is bought from the protocol the first time (CLAIM_CHUNK, at a fixed
 * price into the bank) and from other players after that (SET_CHUNK_SALE, then
 * BUY_CHUNK). The bank takes a cut of resales the way any land registry does.
 */

/**
 * The canonical key for a chunk.
 *
 * Built from already-validated components and used as an object key, so it must
 * be unambiguous: `serverId` and `dimension` cannot contain `/` or `,`, which
 * their validation regexes enforce.
 */
function chunkKey(serverId, dimension, x, z) {
    return `${serverId}/${dimension}/${x},${z}`;
}

function requireServer(state, serverId) {
    const server = state.servers[serverId];
    if (!server) L.fail("unknown server " + serverId);
    return server;
}

function requireOwnedChunk(state, p, from) {
    const key = chunkKey(p.serverId, p.dimension, p.x, p.z);
    const chunk = state.chunks[key];
    if (!chunk) L.fail("chunk is unclaimed");
    if (chunk.owner !== from) L.fail("chunk belongs to another address");
    return chunk;
}

/**
 * Per-server holdings, kept as a running tally on the server record.
 *
 * Counting an address's chunks by scanning `state.chunks` would make every
 * claim cost work proportional to all land ever claimed, which is a transaction
 * every node has to repeat. The tally also gives the website its land
 * leaderboard for free.
 */
function addHolding(server, address, delta) {
    const next = (server.owners[address] || 0) + delta;
    if (next > cfg.MAX_CHUNKS_PER_OWNER) {
        L.fail(`address already holds the maximum ${cfg.MAX_CHUNKS_PER_OWNER} chunks on this server`);
    }
    if (next <= 0) delete server.owners[address];
    else server.owners[address] = next;
}

function moveChunk(state, chunk, to, timestamp) {
    const server = state.servers[chunk.serverId];
    addHolding(server, chunk.owner, -1);
    addHolding(server, to, 1);
    chunk.owner = to;
    chunk.acquiredAt = timestamp;
    chunk.forSale = false;
    chunk.price = 0;
}

const handlers = {
    [TxType.REGISTER_SERVER](state, tx, ctx, from) {
        const p = tx.payload;
        if (state.servers[p.serverId]) L.fail("server id already registered");

        L.debitNative(state, from, cfg.SERVER_REGISTRATION_PRICE);
        bank.creditTreasury(state, cfg.SERVER_REGISTRATION_PRICE);

        state.servers[p.serverId] = {
            id: p.serverId,
            name: p.name,
            description: typeof p.description === "string" ? p.description : "",
            owner: from,
            registeredAt: ctx.timestamp,
            chunkCount: 0,
            owners: {},
        };
    },

    [TxType.CLAIM_CHUNK](state, tx, ctx, from) {
        const p = tx.payload;
        const server = requireServer(state, p.serverId);

        const key = chunkKey(p.serverId, p.dimension, p.x, p.z);
        if (state.chunks[key]) L.fail("chunk is already owned");

        L.debitNative(state, from, cfg.CHUNK_CLAIM_PRICE);
        bank.creditTreasury(state, cfg.CHUNK_CLAIM_PRICE);

        addHolding(server, from, 1);
        server.chunkCount += 1;

        state.chunks[key] = {
            key,
            serverId: p.serverId,
            dimension: p.dimension,
            x: p.x,
            z: p.z,
            owner: from,
            name: typeof p.name === "string" ? p.name : "",
            claimedAt: ctx.timestamp,
            acquiredAt: ctx.timestamp,
            forSale: false,
            price: 0,
        };
    },

    [TxType.SET_CHUNK_SALE](state, tx, ctx, from) {
        const p = tx.payload;
        const chunk = requireOwnedChunk(state, p, from);
        // A price of 0 delists rather than giving the land away for nothing.
        chunk.forSale = p.price > 0;
        chunk.price = p.price;
    },

    [TxType.BUY_CHUNK](state, tx, ctx, from) {
        const p = tx.payload;
        const key = chunkKey(p.serverId, p.dimension, p.x, p.z);
        const chunk = state.chunks[key];
        if (!chunk) L.fail("chunk is unclaimed");
        if (!chunk.forSale) L.fail("chunk is not for sale");
        if (chunk.owner === from) L.fail("you already own this chunk");
        // The seller can change the price in an earlier transaction of the same
        // block, so the buyer states what they are willing to pay.
        if (chunk.price > p.maxPrice) L.fail(`price is ${chunk.price}, above maxPrice ${p.maxPrice}`);

        const fee = L.feeOf(chunk.price, cfg.LAND_FEE_BPS);
        L.debitNative(state, from, chunk.price);
        L.creditNative(state, chunk.owner, chunk.price - fee);
        bank.creditTreasury(state, fee);

        ctx.receipts.push({
            tx: tx.hash,
            type: "BUY_CHUNK",
            chunk: key,
            seller: chunk.owner,
            price: chunk.price,
            fee,
        });
        moveChunk(state, chunk, from, ctx.timestamp);
    },

    [TxType.TRANSFER_CHUNK](state, tx, ctx, from) {
        const p = tx.payload;
        if (p.to === from) L.fail("cannot transfer a chunk to yourself");
        const chunk = requireOwnedChunk(state, p, from);
        moveChunk(state, chunk, p.to, ctx.timestamp);
    },
};

module.exports = { chunkKey, handlers };
