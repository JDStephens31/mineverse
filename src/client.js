"use strict";

const cfg = require("./core/config");
const Wallet = require("./crypto/wallet");
const { TxType, createTransaction } = require("./core/transaction");

/**
 * Thin client.
 *
 * Signing happens here, never on the node. The node is only asked for the
 * current nonce; if it lies about it, the resulting transaction simply fails
 * to apply -- it cannot be turned into a transfer the signer did not authorise.
 */
class MineverseClient {
    constructor(baseUrl, wallet = null, { apiToken = null } = {}) {
        this.baseUrl = baseUrl.replace(/\/$/, "");
        this.wallet = wallet;
        this.apiToken = apiToken;
        this.localNonce = null;
    }

    async request(method, route, body) {
        const headers = { "content-type": "application/json" };
        if (this.apiToken) headers["x-api-token"] = this.apiToken;

        const res = await fetch(this.baseUrl + route, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let data;
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            throw new Error(`${method} ${route}: non-JSON response: ${text.slice(0, 200)}`);
        }
        if (!res.ok) throw new Error(`${method} ${route}: ${data.error || res.status}`);
        return data;
    }

    get(route) {
        return this.request("GET", route);
    }

    post(route, body) {
        return this.request("POST", route, body);
    }

    // -- reads -------------------------------------------------------------

    status() {
        return this.get("/status");
    }
    account(address) {
        return this.get(`/account/${address}`);
    }
    currencies() {
        return this.get("/currencies");
    }
    currency(symbol) {
        return this.get(`/currency/${symbol}`);
    }
    quote(symbol, side, amountIn) {
        return this.get(`/quote/${symbol}?side=${side}&amountIn=${amountIn}`);
    }
    votes() {
        return this.get("/votes");
    }
    vote(id) {
        return this.get(`/vote/${id}`);
    }
    contract(id) {
        return this.get(`/contract/${id}`);
    }
    inventory(id) {
        return this.get(`/inventory/${id}`);
    }
    inventories(query = "") {
        return this.get(`/inventories${query}`);
    }
    contracts(address) {
        return this.get(`/contracts?address=${address}`);
    }
    listings(query = "") {
        return this.get(`/listings${query}`);
    }
    listing(id) {
        return this.get(`/listing/${id}`);
    }
    /** What this address has bought and not yet pulled into the world. */
    reserved(address) {
        return this.get(`/reserved/${address}`);
    }
    servers() {
        return this.get("/servers");
    }
    server(id) {
        return this.get(`/server/${id}`);
    }
    chunks(serverId, query = "") {
        return this.get(`/server/${serverId}/chunks${query}`);
    }
    chunk(serverId, dimension, x, z) {
        return this.get(`/chunk/${serverId}/${dimension}/${x}/${z}`);
    }
    land(address) {
        return this.get(`/land/${address}`);
    }
    companies(query = "") {
        return this.get(`/companies${query}`);
    }
    company(symbol) {
        return this.get(`/company/${symbol}`);
    }
    shareQuote(symbol, side, amountIn) {
        return this.get(`/company/${symbol}/quote?side=${side}&amountIn=${amountIn}`);
    }
    bank() {
        return this.get("/bank");
    }
    peers() {
        return this.get("/peers");
    }

    // -- writes ------------------------------------------------------------

    /**
     * Nonces must be strictly sequential per account, so consecutive sends
     * before a block is mined track the nonce locally rather than re-reading a
     * value the chain has not advanced yet.
     */
    async nextNonce() {
        const { nonce } = await this.get(`/account/${this.wallet.address}/nonce`);
        if (this.localNonce === null || nonce > this.localNonce) this.localNonce = nonce;
        return this.localNonce;
    }

    resetNonce() {
        this.localNonce = null;
    }

    async send(type, payload, { fee = cfg.MIN_FEE } = {}) {
        if (!this.wallet) throw new Error("client has no wallet");

        const nonce = await this.nextNonce();
        const tx = createTransaction({ wallet: this.wallet, type, payload, nonce, fee });

        const result = await this.post("/tx/submit", { tx });
        this.localNonce = nonce + 1;
        return { ...result, tx };
    }

    transfer(to, amount, symbol = cfg.NATIVE, opts) {
        return this.send(TxType.TRANSFER, { to, amount, symbol }, opts);
    }
    createCurrency(name, symbol, totalSupply, liquidity, opts) {
        return this.send(TxType.CREATE_CURRENCY, { name, symbol, totalSupply, liquidity }, opts);
    }
    buy(symbol, amountIn, minOut = 0, opts) {
        return this.send(TxType.BUY, { symbol, amountIn, minOut }, opts);
    }
    sell(symbol, amountIn, minOut = 0, opts) {
        return this.send(TxType.SELL, { symbol, amountIn, minOut }, opts);
    }
    createVote(statement, durationMs, opts) {
        return this.send(TxType.CREATE_VOTE, { statement, durationMs }, opts);
    }
    castVote(voteId, choice, opts) {
        return this.send(TxType.CAST_VOTE, { voteId, choice }, opts);
    }
    registerUuid(uuid, opts) {
        return this.send(TxType.REGISTER_UUID, { uuid }, opts);
    }
    depositInventory(uuid, items, serverId = null, opts) {
        return this.send(TxType.DEPOSIT_INVENTORY, { uuid, items, serverId }, opts);
    }
    withdrawInventory(inventoryId, uuid, opts) {
        return this.send(TxType.WITHDRAW_INVENTORY, { inventoryId, uuid }, opts);
    }

    // -- contracts ---------------------------------------------------------
    //
    // Proposing escrows the cost immediately; accepting is what moves it into
    // the bank and starts the clock it earns on.

    createContract(contractee, cost, durationMs, data = "", opts) {
        return this.send(TxType.CREATE_CONTRACT, { contractee, cost, durationMs, data }, opts);
    }
    acceptContract(contractId, opts) {
        return this.send(TxType.ACCEPT_CONTRACT, { contractId }, opts);
    }
    rejectContract(contractId, opts) {
        return this.send(TxType.REJECT_CONTRACT, { contractId }, opts);
    }
    cancelContract(contractId, opts) {
        return this.send(TxType.CANCEL_CONTRACT, { contractId }, opts);
    }
    resolveContract(contractId, opts) {
        return this.send(TxType.RESOLVE_CONTRACT, { contractId }, opts);
    }

    // -- marketplace -------------------------------------------------------

    listItem(inventoryId, price, symbol = cfg.NATIVE, note = "", opts) {
        return this.send(TxType.LIST_ITEM, { inventoryId, price, symbol, note }, opts);
    }
    cancelListing(listingId, opts) {
        return this.send(TxType.CANCEL_LISTING, { listingId }, opts);
    }
    buyListing(listingId, opts) {
        return this.send(TxType.BUY_LISTING, { listingId }, opts);
    }

    // -- servers and land --------------------------------------------------

    registerServer(serverId, name, description = "", opts) {
        return this.send(TxType.REGISTER_SERVER, { serverId, name, description }, opts);
    }
    claimChunk(serverId, dimension, x, z, name = "", opts) {
        return this.send(TxType.CLAIM_CHUNK, { serverId, dimension, x, z, name }, opts);
    }
    /** A price of 0 takes the chunk off the market. */
    setChunkSale(serverId, dimension, x, z, price, opts) {
        return this.send(TxType.SET_CHUNK_SALE, { serverId, dimension, x, z, price }, opts);
    }
    buyChunk(serverId, dimension, x, z, maxPrice, opts) {
        return this.send(TxType.BUY_CHUNK, { serverId, dimension, x, z, maxPrice }, opts);
    }
    transferChunk(serverId, dimension, x, z, to, opts) {
        return this.send(TxType.TRANSFER_CHUNK, { serverId, dimension, x, z, to }, opts);
    }

    // -- stock market ------------------------------------------------------

    createCompany(name, symbol, totalShares, liquidity, { description = "", serverId = null } = {}, opts) {
        return this.send(
            TxType.CREATE_COMPANY,
            { name, symbol, description, totalShares, liquidity, serverId },
            opts
        );
    }
    buyShares(symbol, amountIn, minOut = 0, opts) {
        return this.send(TxType.BUY_SHARES, { symbol, amountIn, minOut }, opts);
    }
    sellShares(symbol, amountIn, minOut = 0, opts) {
        return this.send(TxType.SELL_SHARES, { symbol, amountIn, minOut }, opts);
    }
    transferShares(symbol, to, amount, opts) {
        return this.send(TxType.TRANSFER_SHARES, { symbol, to, amount }, opts);
    }
    companyPayout(symbol, to, amount, memo = "", opts) {
        return this.send(TxType.COMPANY_PAYOUT, { symbol, to, amount, memo }, opts);
    }
    payDividend(symbol, amount, opts) {
        return this.send(TxType.PAY_DIVIDEND, { symbol, amount }, opts);
    }

    /** Block until `hash` is confirmed, or throw once `timeoutMs` elapses. */
    async waitForTx(hash, { timeoutMs = 60000, intervalMs = 250 } = {}) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            try {
                const found = await this.get(`/tx/${hash}`);
                if (found.status === "confirmed") return found;
            } catch {
                // Not yet relayed to this node.
            }
            if (Date.now() > deadline) throw new Error(`timed out waiting for tx ${hash.slice(0, 12)}`);
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }

    async waitForHeight(height, { timeoutMs = 60000, intervalMs = 250 } = {}) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const status = await this.status();
            if (status.height >= height) return status;
            if (Date.now() > deadline) throw new Error(`timed out waiting for height ${height}`);
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }
}

module.exports = { MineverseClient, Wallet, TxType };
