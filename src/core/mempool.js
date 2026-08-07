"use strict";

const cfg = require("./config");
const { validateTransaction, senderOf, TxType } = require("./transaction");

/**
 * Pending transactions waiting to be mined.
 *
 * The mempool is a local policy cache, not consensus. It rejects what it can
 * cheaply prove is junk (bad signature, stale nonce, unaffordable) so a node
 * does not relay or mine garbage, but the block validator re-checks everything
 * regardless -- a peer's mempool decisions are never trusted.
 */
/** Block-inclusion attempts a transaction may fail before it is evicted. */
const MAX_STRIKES = 3;

class Mempool {
    constructor() {
        this.txs = new Map(); // hash -> tx
        this.strikes = new Map(); // hash -> { count, lastHeight }
    }

    get size() {
        return this.txs.size;
    }

    has(hash) {
        return this.txs.has(hash);
    }

    get(hash) {
        return this.txs.get(hash);
    }

    all() {
        return Array.from(this.txs.values());
    }

    /**
     * @returns {{accepted: boolean, reason?: string}}
     */
    add(tx, state, { now = Date.now() } = {}) {
        try {
            if (tx && tx.type === TxType.COINBASE) {
                return { accepted: false, reason: "coinbase transactions are block-local" };
            }
            validateTransaction(tx, { now });
        } catch (err) {
            return { accepted: false, reason: err.message };
        }

        if (this.txs.has(tx.hash)) return { accepted: false, reason: "duplicate" };
        if (this.txs.size >= cfg.MAX_MEMPOOL_TXS) return { accepted: false, reason: "mempool full" };

        const from = senderOf(tx);
        const acct = state.accounts[from];
        const confirmedNonce = acct ? acct.nonce : 0;

        if (tx.nonce < confirmedNonce) return { accepted: false, reason: "nonce already used" };

        // Allow a small run-ahead so a client can queue a few transactions, but
        // not an unbounded one -- that is a free memory-exhaustion vector.
        const pendingForSender = this.all().filter((t) => senderOf(t) === from).length;
        if (tx.nonce > confirmedNonce + 16) return { accepted: false, reason: "nonce too far ahead" };
        if (pendingForSender >= 16) return { accepted: false, reason: "too many pending for sender" };

        // Cheap affordability check on the fee alone. Full balance checks happen
        // during block application, where the ordering is known. An account that
        // does not exist has no balance, so this also stops an attacker filling
        // the mempool from an endless supply of fresh empty addresses.
        const balance = acct ? acct.balance : 0;
        if (balance < tx.fee) return { accepted: false, reason: "cannot afford fee" };

        this.txs.set(tx.hash, tx);
        return { accepted: true };
    }

    remove(hashes) {
        for (const h of hashes) {
            this.txs.delete(h);
            this.strikes.delete(h);
        }
    }

    /**
     * Record that a transaction was picked for a block and failed to apply.
     *
     * A transaction can be permanently unapplicable -- withdrawing an inventory
     * that is already claimed, say -- and because nonces are sequential, one
     * such transaction blocks everything the same sender submits afterwards.
     * Eviction after a few failed attempts unwedges the queue.
     *
     * At most one strike per block height, so a transaction that is merely
     * waiting on an ordering it will eventually get is not thrown out by a fast
     * miner retrying the same tip.
     */
    penalize(hash, height) {
        const record = this.strikes.get(hash);
        if (record && record.lastHeight === height) return;

        const count = (record ? record.count : 0) + 1;
        if (count >= MAX_STRIKES) {
            this.txs.delete(hash);
            this.strikes.delete(hash);
            return;
        }
        this.strikes.set(hash, { count, lastHeight: height });
    }

    /**
     * Candidate transactions for the next block: highest fee first, but strictly
     * nonce-ordered per sender so a block never contains an unapplicable gap.
     */
    selectForBlock(state, limit = cfg.MAX_TXS_PER_BLOCK - 1) {
        const bySender = new Map();
        for (const tx of this.txs.values()) {
            const from = senderOf(tx);
            if (!bySender.has(from)) bySender.set(from, []);
            bySender.get(from).push(tx);
        }

        const runs = [];
        for (const [from, txs] of bySender) {
            // A sender can have several transactions at the same nonce (only one
            // can ever confirm). Keep the highest-fee one, so a stuck low-fee
            // transaction cannot wedge everything behind it.
            const best = new Map();
            for (const tx of txs) {
                const incumbent = best.get(tx.nonce);
                if (!incumbent || tx.fee > incumbent.fee) best.set(tx.nonce, tx);
            }

            const acct = state.accounts[from];
            let expected = acct ? acct.nonce : 0;
            const run = [];
            for (;;) {
                const tx = best.get(expected);
                if (!tx) break; // gap: everything after it is unusable
                run.push(tx);
                expected += 1;
            }
            if (run.length > 0) runs.push(run);
        }

        // Order senders by the fee of their first usable transaction.
        runs.sort((a, b) => b[0].fee - a[0].fee);

        const selected = [];
        for (const run of runs) {
            for (const tx of run) {
                if (selected.length >= limit) return selected;
                selected.push(tx);
            }
        }
        return selected;
    }

    /**
     * Drop transactions that a new tip made invalid: already mined, nonce now
     * stale, or simply too old.
     */
    reconcile(state, { now = Date.now() } = {}) {
        for (const [hash, tx] of this.txs) {
            const from = senderOf(tx);
            const acct = state.accounts[from];
            const confirmedNonce = acct ? acct.nonce : 0;
            if (tx.nonce < confirmedNonce || now - tx.timestamp > cfg.TX_EXPIRY_MS) {
                this.txs.delete(hash);
                this.strikes.delete(hash);
            }
        }
    }
}

module.exports = Mempool;
