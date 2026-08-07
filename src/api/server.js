"use strict";

const express = require("express");
const cfg = require("../core/config");
const keys = require("../crypto/keys");
const Wallet = require("../crypto/wallet");
const stateUtil = require("../core/state");
const txUtil = require("../core/transaction");

/**
 * HTTP API.
 *
 * Read endpoints are open. The only write endpoint that changes chain state is
 * POST /tx/submit, and it accepts nothing but an already-signed transaction --
 * the node cannot move anyone's funds, because it never holds a private key.
 *
 * This is the main departure from the original API, where routes like
 * /addBalance and /sellCur took a public key as a bare string and acted on it.
 */
/**
 * A listing with the items it covers.
 *
 * The listing record only names an inventory id, but nothing browsing a
 * marketplace wants a price without knowing what it buys.
 */
function withItems(state, listing) {
    const inv = state.inventories[listing.inventoryId];
    return { ...listing, items: inv ? inv.items : [], claimed: inv ? inv.claimed : false };
}

function serverSummary(server) {
    const { owners, ...rest } = server;
    return { ...rest, ownerCount: Object.keys(owners).length };
}

/**
 * A company as a market page wants it: priced, with the holder table left out.
 *
 * That table can run to thousands of rows, which is fine to walk for one
 * company and not fine to ship in a list of every company on the chain.
 */
function companyView(company) {
    const { holders, ...rest } = company;
    return {
        ...rest,
        price: stateUtil.spotPrice(company),
        outstandingShares: company.totalShares - company.reserveShares,
    };
}

function createApiServer({ chain, p2p, apiToken = null, allowKeyGeneration = false }) {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.disable("x-powered-by");

    // Optional shared-secret gate for anything that mutates node or chain state.
    app.use((req, res, next) => {
        if (!apiToken) return next();
        if (req.method === "GET") return next();
        const provided = req.get("x-api-token");
        if (provided !== apiToken) return res.status(401).json({ error: "invalid api token" });
        next();
    });

    const ok = (res, body) => res.json(body);
    const bad = (res, message, code = 400) => res.status(code).json({ error: message });

    // -- chain ------------------------------------------------------------

    app.get("/status", (req, res) =>
        ok(res, {
            ...chain.summary(),
            peers: p2p ? p2p.peerInfo().length : 0,
            nodeId: p2p ? p2p.nodeId : null,
        })
    );

    app.get("/chain", (req, res) => {
        const from = Math.max(0, parseInt(req.query.from, 10) || 0);
        const to = Math.min(chain.blocks.length, parseInt(req.query.to, 10) || chain.blocks.length);
        ok(res, { height: chain.height, blocks: chain.blocks.slice(from, to) });
    });

    app.get("/block/:id", (req, res) => {
        const id = req.params.id;
        const block = /^\d+$/.test(id) ? chain.getBlock(Number(id)) : chain.getBlock(id);
        if (!block) return bad(res, "block not found", 404);
        ok(res, block);
    });

    app.get("/tx/:hash", (req, res) => {
        const found = chain.getTransaction(req.params.hash);
        if (found) return ok(res, { ...found, status: "confirmed", receipt: chain.getReceipt(req.params.hash) });
        const pending = chain.mempool.get(req.params.hash);
        if (pending) return ok(res, { tx: pending, status: "pending" });
        bad(res, "transaction not found", 404);
    });

    app.get("/mempool", (req, res) => ok(res, { size: chain.mempool.size, transactions: chain.mempool.all() }));

    // -- accounts ---------------------------------------------------------

    app.get("/account/:address", (req, res) => {
        if (!keys.isValidAddress(req.params.address)) return bad(res, "invalid address");
        ok(res, stateUtil.accountView(chain.state, req.params.address));
    });

    app.get("/account/:address/nonce", (req, res) => {
        if (!keys.isValidAddress(req.params.address)) return bad(res, "invalid address");
        const acct = chain.state.accounts[req.params.address];
        ok(res, { address: req.params.address, nonce: acct ? acct.nonce : 0 });
    });

    app.get("/uuid/:uuid", (req, res) => {
        const address = chain.state.uuids[req.params.uuid];
        if (!address) return bad(res, "uuid not registered", 404);
        ok(res, stateUtil.accountView(chain.state, address));
    });

    // -- currencies -------------------------------------------------------

    app.get("/currencies", (req, res) => {
        const list = Object.values(chain.state.currencies).map((cur) => ({
            ...cur,
            price: stateUtil.spotPrice(cur),
        }));
        ok(res, { native: cfg.NATIVE, currencies: list });
    });

    app.get("/currency/:symbol", (req, res) => {
        const cur = chain.state.currencies[req.params.symbol];
        if (!cur) return bad(res, "currency not found", 404);
        ok(res, { ...cur, price: stateUtil.spotPrice(cur) });
    });

    /** Dry-run a swap so a client can set a sane minOut before signing. */
    app.get("/quote/:symbol", (req, res) => {
        const cur = chain.state.currencies[req.params.symbol];
        if (!cur) return bad(res, "currency not found", 404);

        const side = req.query.side === "sell" ? "sell" : "buy";
        const amountIn = parseInt(req.query.amountIn, 10);
        if (!Number.isSafeInteger(amountIn) || amountIn <= 0) return bad(res, "amountIn must be a positive integer");

        try {
            const out =
                side === "buy"
                    ? stateUtil.amountOut(amountIn, cur.reserveNative, cur.reserveToken)
                    : stateUtil.amountOut(amountIn, cur.reserveToken, cur.reserveNative);
            ok(res, { symbol: cur.symbol, side, amountIn, amountOut: out, feeBps: cfg.SWAP_FEE_BPS });
        } catch (err) {
            bad(res, err.message);
        }
    });

    // -- governance, contracts, inventory ---------------------------------

    app.get("/votes", (req, res) => {
        let list = Object.values(chain.state.votes);
        if (req.query.serverId) list = list.filter((v) => v.serverId === req.query.serverId);
        if (req.query.running === "true") list = list.filter((v) => v.running);
        ok(res, { votes: list });
    });

    app.get("/vote/:id", (req, res) => {
        const vote = chain.state.votes[req.params.id];
        if (!vote) return bad(res, "vote not found", 404);
        ok(res, vote);
    });

    app.get("/contracts", (req, res) => {
        const { address, status } = req.query;
        let list = Object.values(chain.state.contracts);
        if (address) list = list.filter((c) => c.contracter === address || c.contractee === address);
        if (status) list = list.filter((c) => c.status === status);
        ok(res, { contracts: list });
    });

    app.get("/contract/:id", (req, res) => {
        const contract = chain.state.contracts[req.params.id];
        if (!contract) return bad(res, "contract not found", 404);
        ok(res, contract);
    });

    app.get("/inventories", (req, res) => {
        const { address, uuid, claimed } = req.query;
        let list = Object.values(chain.state.inventories);
        if (address) list = list.filter((inv) => inv.owner === address);
        if (uuid) list = list.filter((inv) => inv.uuid === uuid);
        if (claimed === "false") list = list.filter((inv) => !inv.claimed);
        if (claimed === "true") list = list.filter((inv) => inv.claimed);
        ok(res, { inventories: list });
    });

    app.get("/inventory/:id", (req, res) => {
        const inv = chain.state.inventories[req.params.id];
        if (!inv) return bad(res, "inventory not found", 404);
        ok(res, inv);
    });

    // -- marketplace ------------------------------------------------------

    /**
     * Listings, with the items they cover folded in.
     *
     * A marketplace page needs the price and the contents together, and asking
     * it to fetch an inventory per listing would be a request per row.
     */
    app.get("/listings", (req, res) => {
        const { seller, buyer, symbol, serverId, status = "open" } = req.query;
        let list = Object.values(chain.state.listings);
        if (status !== "all") list = list.filter((l) => l.status === status);
        if (seller) list = list.filter((l) => l.seller === seller);
        if (buyer) list = list.filter((l) => l.buyer === buyer);
        if (symbol) list = list.filter((l) => l.symbol === symbol);
        if (serverId) list = list.filter((l) => l.serverId === serverId);
        ok(res, { listings: list.map((l) => withItems(chain.state, l)) });
    });

    app.get("/listing/:id", (req, res) => {
        const listing = chain.state.listings[req.params.id];
        if (!listing) return bad(res, "listing not found", 404);
        ok(res, withItems(chain.state, listing));
    });

    /**
     * What an address has bought but not yet pulled into the world.
     *
     * This is the list the mod shows a player when they ask what is waiting for
     * them: owned, paid for, and not yet claimed.
     */
    app.get("/reserved/:address", (req, res) => {
        if (!keys.isValidAddress(req.params.address)) return bad(res, "invalid address");
        const pending = Object.values(chain.state.inventories).filter(
            (inv) => inv.owner === req.params.address && !inv.claimed && !inv.listingId
        );
        ok(res, { address: req.params.address, inventories: pending });
    });

    // -- servers and land -------------------------------------------------

    app.get("/servers", (req, res) =>
        ok(res, { servers: Object.values(chain.state.servers).map(serverSummary) })
    );

    app.get("/server/:id", (req, res) => {
        const server = chain.state.servers[req.params.id];
        if (!server) return bad(res, "server not found", 404);
        ok(res, {
            ...serverSummary(server),
            polls: Object.values(chain.state.votes).filter((v) => v.serverId === server.id && v.running),
            companies: Object.values(chain.state.companies)
                .filter((c) => c.serverId === server.id)
                .map(companyView),
        });
    });

    /**
     * A server's chunk map, optionally windowed.
     *
     * A whole-world map is a lot of rows, so the bounding box is there for a
     * viewport that only wants what it is currently showing.
     */
    app.get("/server/:id/chunks", (req, res) => {
        if (!chain.state.servers[req.params.id]) return bad(res, "server not found", 404);

        const { dimension, owner } = req.query;
        const box = ["minX", "maxX", "minZ", "maxZ"].map((k) => parseInt(req.query[k], 10));
        const bounded = box.every(Number.isSafeInteger);

        let list = Object.values(chain.state.chunks).filter((c) => c.serverId === req.params.id);
        if (dimension) list = list.filter((c) => c.dimension === dimension);
        if (owner) list = list.filter((c) => c.owner === owner);
        if (req.query.forSale === "true") list = list.filter((c) => c.forSale);
        if (bounded) {
            const [minX, maxX, minZ, maxZ] = box;
            list = list.filter((c) => c.x >= minX && c.x <= maxX && c.z >= minZ && c.z <= maxZ);
        }
        ok(res, { serverId: req.params.id, count: list.length, chunks: list });
    });

    /** Land leaderboard: who owns the most of this server. */
    app.get("/server/:id/leaderboard", (req, res) => {
        const server = chain.state.servers[req.params.id];
        if (!server) return bad(res, "server not found", 404);

        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
        const landowners = Object.entries(server.owners)
            .map(([address, chunks]) => ({ address, chunks }))
            // Ties break on address so the ordering is stable between calls.
            .sort((a, b) => b.chunks - a.chunks || a.address.localeCompare(b.address))
            .slice(0, limit);

        ok(res, { serverId: server.id, landowners });
    });

    /** One chunk, by coordinate. Unclaimed land is a 200 with `owner: null`. */
    app.get("/chunk/:serverId/:dimension/:x/:z", (req, res) => {
        const { serverId, dimension } = req.params;
        const x = parseInt(req.params.x, 10);
        const z = parseInt(req.params.z, 10);
        if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z)) return bad(res, "invalid coordinates");

        const key = stateUtil.chunkKey(serverId, dimension, x, z);
        const chunk = chain.state.chunks[key];
        if (!chunk) {
            return ok(res, {
                key,
                serverId,
                dimension,
                x,
                z,
                owner: null,
                claimPrice: cfg.CHUNK_CLAIM_PRICE,
            });
        }
        ok(res, chunk);
    });

    /** Everything one address owns, across every server. */
    app.get("/land/:address", (req, res) => {
        if (!keys.isValidAddress(req.params.address)) return bad(res, "invalid address");
        const owned = Object.values(chain.state.chunks).filter((c) => c.owner === req.params.address);
        ok(res, { address: req.params.address, count: owned.length, chunks: owned });
    });

    // -- stock market -----------------------------------------------------

    app.get("/companies", (req, res) => {
        let list = Object.values(chain.state.companies);
        if (req.query.serverId) list = list.filter((c) => c.serverId === req.query.serverId);
        ok(res, { companies: list.map(companyView) });
    });

    app.get("/company/:symbol", (req, res) => {
        const company = chain.state.companies[req.params.symbol];
        if (!company) return bad(res, "company not found", 404);

        const holders = Object.entries(company.holders)
            .map(([address, shares]) => ({ address, shares }))
            .sort((a, b) => b.shares - a.shares || a.address.localeCompare(b.address))
            .slice(0, 100);

        ok(res, { ...companyView(company), holders });
    });

    /** Dry-run a share trade so a client can set a sane minOut before signing. */
    app.get("/company/:symbol/quote", (req, res) => {
        const company = chain.state.companies[req.params.symbol];
        if (!company) return bad(res, "company not found", 404);

        const side = req.query.side === "sell" ? "sell" : "buy";
        const amountIn = parseInt(req.query.amountIn, 10);
        if (!Number.isSafeInteger(amountIn) || amountIn <= 0) return bad(res, "amountIn must be a positive integer");

        try {
            if (side === "sell") {
                const out = stateUtil.amountOut(amountIn, company.reserveShares, company.reserveNative);
                return ok(res, { symbol: company.symbol, side, amountIn, amountOut: out, toTreasury: 0 });
            }
            // A buy is quoted net of the slice that funds the business, since
            // that part never reaches the pool and so never buys shares.
            const toTreasury = Math.floor((amountIn * cfg.COMPANY_TREASURY_BPS) / 10000);
            const out = stateUtil.amountOut(amountIn - toTreasury, company.reserveNative, company.reserveShares);
            ok(res, { symbol: company.symbol, side, amountIn, amountOut: out, toTreasury });
        } catch (err) {
            bad(res, err.message);
        }
    });

    // -- the bank ---------------------------------------------------------

    app.get("/bank", (req, res) => {
        const active = Object.values(chain.state.contracts).filter((c) => c.status === "active");
        ok(res, {
            ...chain.state.bank,
            activeContracts: active.length,
            interestAprBps: cfg.BANK_INTEREST_APR_BPS,
        });
    });

    // -- transactions -----------------------------------------------------

    /**
     * Produce the exact bytes a client must sign.
     *
     * The client keeps its private key, signs the returned `hash`, and posts the
     * result to /tx/submit. The node never sees key material.
     */
    app.post("/tx/build", (req, res) => {
        const { publicKey, type, payload, fee } = req.body || {};
        if (!keys.isValidPublicKey(publicKey)) return bad(res, "invalid publicKey");

        try {
            const address = keys.addressFromPublicKey(publicKey);
            const acct = chain.state.accounts[address];
            const pendingForSender = chain.mempool
                .all()
                .filter((tx) => txUtil.senderOf(tx) === address).length;

            const unsigned = {
                chainId: cfg.CHAIN_ID,
                type,
                from: publicKey,
                nonce: (acct ? acct.nonce : 0) + pendingForSender,
                fee: Number.isSafeInteger(fee) && fee >= cfg.MIN_FEE ? fee : cfg.MIN_FEE,
                timestamp: Date.now(),
                payload,
            };
            txUtil.validatePayload(unsigned);
            ok(res, { unsigned, hash: txUtil.txHash(unsigned), address });
        } catch (err) {
            bad(res, err.message);
        }
    });

    app.post("/tx/submit", (req, res) => {
        const tx = req.body && req.body.tx ? req.body.tx : req.body;
        const result = chain.submitTransaction(tx);
        if (!result.accepted) return bad(res, result.reason);
        if (p2p) p2p.broadcastTransaction(tx);
        ok(res, { accepted: true, hash: tx.hash });
    });

    // -- node control -----------------------------------------------------

    app.get("/peers", (req, res) =>
        ok(res, {
            peers: p2p ? p2p.peerInfo() : [],
            known: p2p ? Array.from(p2p.knownAddresses) : [],
        })
    );

    app.post("/peers/add", (req, res) => {
        if (!p2p) return bad(res, "p2p is disabled", 409);
        const address = req.body && req.body.address;
        if (typeof address !== "string" || !p2p.addPeerAddress(address)) return bad(res, "invalid address");
        p2p.connect(address);
        ok(res, { added: true, address });
    });

    app.post("/snapshot", (req, res) => {
        try {
            const saved = chain.save();
            ok(res, { saved, height: chain.height });
        } catch (err) {
            bad(res, err.message, 500);
        }
    });

    /**
     * Wallet generation, for local development and the Minecraft client.
     *
     * Off unless explicitly enabled: a node that mints keys over HTTP is a
     * liability, and the returned phrase is the wallet.
     */
    app.post("/wallet/new", (req, res) => {
        if (!allowKeyGeneration) {
            return bad(res, "key generation is disabled on this node; generate keys client-side", 403);
        }
        const wallet = Wallet.create();
        ok(res, {
            address: wallet.address,
            publicKey: wallet.publicKey,
            privateKey: wallet.privateKey,
            mnemonic: wallet.mnemonic,
            warning: "Store the mnemonic offline. Anyone holding it controls this account.",
        });
    });

    app.use((req, res) => bad(res, "not found", 404));

    // eslint-disable-next-line no-unused-vars -- express identifies error handlers by arity
    app.use((err, req, res, next) => {
        res.status(400).json({ error: err.message || "bad request" });
    });

    return app;
}

module.exports = { createApiServer };
