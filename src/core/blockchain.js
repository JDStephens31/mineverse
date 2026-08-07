"use strict";

const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");

const cfg = require("./config");
const blockUtil = require("./block");
const stateUtil = require("./state");
const genesisUtil = require("./genesis");
const Mempool = require("./mempool");
const { createCoinbase, senderOf } = require("./transaction");
const { meetsDifficulty } = require("../util/hash");

class ChainError extends Error {}

/**
 * The blockchain.
 *
 * Invariants held here:
 *   - `blocks` is always a fully validated chain rooted at our genesis block.
 *   - `state` is always exactly the result of replaying `blocks`.
 *   - Nothing outside this class mutates either one.
 */
class Blockchain extends EventEmitter {
    constructor({ genesisFile, dataDir } = {}) {
        super();
        this.genesisConfig = genesisUtil.loadGenesisConfig(genesisFile);
        this.genesisBlock = genesisUtil.createGenesisBlock(this.genesisConfig);
        this.dataDir = dataDir || null;

        this.blocks = [this.genesisBlock];
        this.state = genesisUtil.genesisState(this.genesisConfig);
        this.state.lastHash = this.genesisBlock.hash;
        this.receipts = new Map();
        this.mempool = new Mempool();

        this.byHash = new Map([[this.genesisBlock.hash, this.genesisBlock]]);
        this.txIndex = new Map();
        this.work = blockUtil.blockWork(this.genesisBlock);
    }

    // -- accessors ---------------------------------------------------------

    get height() {
        return this.blocks.length - 1;
    }

    get latest() {
        return this.blocks[this.blocks.length - 1];
    }

    getBlock(hashOrIndex) {
        if (typeof hashOrIndex === "number") return this.blocks[hashOrIndex] || null;
        return this.byHash.get(hashOrIndex) || null;
    }

    getTransaction(hash) {
        const located = this.txIndex.get(hash);
        if (!located) return null;
        const block = this.blocks[located.index];
        return { tx: block.transactions[located.pos], blockIndex: located.index, blockHash: block.hash };
    }

    getReceipt(txHash) {
        return this.receipts.get(txHash) || null;
    }

    // -- consensus rules ---------------------------------------------------

    /**
     * Difficulty for the block at `index`, given the chain preceding it.
     *
     * Retarget is deterministic and bounded to one bit per interval, so a miner
     * cannot swing difficulty with a single manipulated timestamp.
     */
    static expectedDifficulty(blocks, index, genesisDifficulty) {
        if (index === 0) return genesisDifficulty;

        const prev = blocks[index - 1];
        if (index % cfg.DIFFICULTY_ADJUST_INTERVAL !== 0) return prev.difficulty;

        // The first window would be measured against the genesis timestamp, which
        // is a fixed constant unrelated to real mining speed. Skip it.
        if (index === cfg.DIFFICULTY_ADJUST_INTERVAL) return prev.difficulty;

        const windowStart = blocks[index - cfg.DIFFICULTY_ADJUST_INTERVAL];
        if (!windowStart) return prev.difficulty;

        const actual = prev.timestamp - windowStart.timestamp;
        const expected = cfg.DIFFICULTY_ADJUST_INTERVAL * cfg.TARGET_BLOCK_TIME_MS;

        let next = prev.difficulty;
        if (actual <= 0 || actual < expected / 2) next += 1;
        else if (actual > expected * 2) next -= 1;

        return Math.min(cfg.MAX_DIFFICULTY, Math.max(cfg.MIN_DIFFICULTY, next));
    }

    /**
     * Median timestamp of the preceding blocks. A new block must be strictly
     * later, which stops a miner from walking block time backwards to unlock
     * escrows or close votes early.
     */
    static medianTimePast(blocks, index) {
        const start = Math.max(0, index - cfg.MEDIAN_TIME_BLOCKS);
        const window = blocks.slice(start, index).map((b) => b.timestamp);
        if (window.length === 0) return 0;
        window.sort((a, b) => a - b);
        return window[Math.floor(window.length / 2)];
    }

    /** Contextual checks that need the chain, on top of validateBlockStructure. */
    checkContext(block, blocks, index, now) {
        const prev = blocks[index - 1];
        if (!prev) throw new ChainError("no parent block");
        if (block.index !== index) throw new ChainError("block index mismatch");
        if (block.prevHash !== prev.hash) throw new ChainError("prevHash does not link to parent");

        const expected = Blockchain.expectedDifficulty(blocks, index, this.genesisConfig.difficulty);
        if (block.difficulty !== expected) {
            throw new ChainError(`unexpected difficulty ${block.difficulty}, expected ${expected}`);
        }
        if (!meetsDifficulty(block.hash, expected)) throw new ChainError("insufficient proof of work");

        const mtp = Blockchain.medianTimePast(blocks, index);
        if (block.timestamp <= mtp) throw new ChainError("block timestamp is not after median time past");
        if (block.timestamp > now + cfg.MAX_FUTURE_DRIFT_MS) {
            throw new ChainError("block timestamp too far in the future");
        }
    }

    /**
     * Replay a candidate chain from genesis and return the state it produces.
     * Throws on the first violation. Used for both single blocks and reorgs --
     * one code path, so a reorg can never bypass a rule.
     */
    validateChain(blocks, { now = Date.now() } = {}) {
        if (!Array.isArray(blocks) || blocks.length === 0) throw new ChainError("empty chain");
        if (blocks[0].hash !== this.genesisBlock.hash) throw new ChainError("different genesis block");

        let state = genesisUtil.genesisState(this.genesisConfig);
        state.lastHash = this.genesisBlock.hash;
        const receipts = new Map();
        const txIndex = new Map();
        const seenTx = new Set();

        for (let i = 1; i < blocks.length; i++) {
            const block = blocks[i];
            blockUtil.validateBlockStructure(block, { now });
            this.checkContext(block, blocks, i, now);

            for (const tx of block.transactions) {
                // A transaction may appear once in the whole chain. Nonces already
                // enforce this per sender; this also covers the coinbase.
                if (seenTx.has(tx.hash)) throw new ChainError("transaction replayed across blocks");
                seenTx.add(tx.hash);
            }

            const applied = stateUtil.applyBlock(state, block);
            state = applied.state;
            for (const r of applied.receipts) receipts.set(r.tx, r);
            block.transactions.forEach((tx, pos) => txIndex.set(tx.hash, { index: i, pos }));
        }

        return { state, receipts, txIndex, work: blockUtil.totalWork(blocks) };
    }

    // -- chain mutation ----------------------------------------------------

    /**
     * Append a single block to the current tip.
     * @returns {{added: boolean, reason?: string}}
     */
    addBlock(block, { now = Date.now() } = {}) {
        try {
            if (this.byHash.has(block.hash)) return { added: false, reason: "already known" };

            blockUtil.validateBlockStructure(block, { now });
            this.checkContext(block, this.blocks, this.blocks.length, now);

            for (const tx of block.transactions) {
                if (this.txIndex.has(tx.hash)) throw new ChainError("transaction replayed across blocks");
            }

            const applied = stateUtil.applyBlock(this.state, block);

            this.blocks.push(block);
            this.state = applied.state;
            this.work += blockUtil.blockWork(block);
            this.byHash.set(block.hash, block);
            for (const r of applied.receipts) this.receipts.set(r.tx, r);
            block.transactions.forEach((tx, pos) =>
                this.txIndex.set(tx.hash, { index: block.index, pos })
            );

            this.mempool.remove(block.transactions.map((t) => t.hash));
            this.mempool.reconcile(this.state, { now });

            this.emit("block", block);
            return { added: true };
        } catch (err) {
            return { added: false, reason: err.message };
        }
    }

    /**
     * Adopt a peer's chain if it is valid and carries strictly more cumulative
     * work. Ties keep the local chain, which stops two nodes from flip-flopping
     * between equal-work forks forever.
     *
     * @returns {{replaced: boolean, reason?: string}}
     */
    replaceChain(candidate, { now = Date.now() } = {}) {
        try {
            const candidateWork = blockUtil.totalWork(candidate);
            if (candidateWork <= this.work) {
                return { replaced: false, reason: "candidate does not have more work" };
            }

            const result = this.validateChain(candidate, { now });

            // Transactions dropped by the reorg go back to the mempool so they
            // can be mined again rather than silently vanishing.
            const orphaned = [];
            const adopted = new Set();
            for (const b of candidate) for (const t of b.transactions) adopted.add(t.hash);
            for (const b of this.blocks) {
                for (const t of b.transactions) {
                    if (t.type !== "COINBASE" && !adopted.has(t.hash)) orphaned.push(t);
                }
            }

            const oldHeight = this.height;
            this.blocks = candidate;
            this.state = result.state;
            this.receipts = result.receipts;
            this.txIndex = result.txIndex;
            this.work = result.work;
            this.byHash = new Map(candidate.map((b) => [b.hash, b]));

            this.mempool.remove(Array.from(adopted));
            for (const tx of orphaned) this.mempool.add(tx, this.state, { now });
            this.mempool.reconcile(this.state, { now });

            this.emit("reorg", { from: oldHeight, to: this.height });
            this.emit("block", this.latest);
            return { replaced: true };
        } catch (err) {
            return { replaced: false, reason: err.message };
        }
    }

    /** Validate and queue a transaction for mining. */
    submitTransaction(tx, { now = Date.now() } = {}) {
        return this.mempool.add(tx, this.state, { now });
    }

    // -- mining ------------------------------------------------------------

    /**
     * Assemble the next block's contents. Transactions are trial-applied here
     * so a single bad one is dropped instead of producing a block the network
     * will reject.
     */
    buildCandidate(minerAddress, { now = Date.now() } = {}) {
        const index = this.height + 1;
        const prev = this.latest;
        const difficulty = Blockchain.expectedDifficulty(this.blocks, index, this.genesisConfig.difficulty);

        const mtp = Blockchain.medianTimePast(this.blocks, index);
        const timestamp = Math.max(now, mtp + 1, prev.timestamp + 1);

        const candidateTxs = this.mempool.selectForBlock(this.state);

        const accepted = [];
        let working = this.state;
        for (const tx of candidateTxs) {
            const probe = stateUtil.cloneState(working);
            try {
                stateUtil.applyTransaction(probe, tx, { timestamp, height: index, receipts: [] });
                working = probe;
                accepted.push(tx);
            } catch {
                // Not applicable on this tip. Leave it in the mempool in case a
                // later tip makes it valid, but count the failure so a
                // permanently-dead transaction eventually stops blocking the
                // sender's later nonces.
                this.mempool.penalize(tx.hash, index);
            }
        }

        const fees = accepted.reduce((sum, tx) => sum + tx.fee, 0);
        const coinbase = createCoinbase({
            to: minerAddress,
            reward: cfg.BLOCK_REWARD,
            fees,
            height: index,
        });

        return blockUtil.buildBlock({
            index,
            prevHash: prev.hash,
            timestamp,
            difficulty,
            transactions: [coinbase, ...accepted],
            nonce: 0,
        });
    }

    /**
     * Search for a nonce satisfying the difficulty target.
     *
     * Runs in setImmediate slices so the HTTP and P2P sockets stay responsive,
     * and aborts as soon as another node's block lands on our tip -- there is no
     * point finishing work on a stale parent.
     */
    mineOnce(minerAddress, { signal, batchSize = 20000, now = Date.now() } = {}) {
        return new Promise((resolve) => {
            const candidate = this.buildCandidate(minerAddress, { now });
            const startTip = this.latest.hash;

            const step = () => {
                if (signal && signal.aborted) return resolve({ mined: false, reason: "aborted" });
                if (this.latest.hash !== startTip) return resolve({ mined: false, reason: "tip changed" });

                for (let i = 0; i < batchSize; i++) {
                    candidate.hash = blockUtil.computeHash(candidate);
                    if (meetsDifficulty(candidate.hash, candidate.difficulty)) {
                        const result = this.addBlock(candidate, { now: Date.now() });
                        return resolve(
                            result.added
                                ? { mined: true, block: candidate }
                                : { mined: false, reason: result.reason }
                        );
                    }
                    candidate.nonce += 1;
                }
                setImmediate(step);
            };

            setImmediate(step);
        });
    }

    // -- persistence -------------------------------------------------------

    /**
     * Snapshot the chain to disk. Written to a temp file and renamed so a crash
     * mid-write cannot leave a truncated chain behind -- the original wrote the
     * live file directly and swallowed the error in a callback.
     */
    save(file) {
        const target = file || (this.dataDir && path.join(this.dataDir, "chain.json"));
        if (!target) return false;

        fs.mkdirSync(path.dirname(target), { recursive: true });
        const tmp = target + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify({ chainId: cfg.CHAIN_ID, blocks: this.blocks }));
        fs.renameSync(tmp, target);
        return true;
    }

    /**
     * Load a chain from disk. The snapshot is fully re-validated -- a file on
     * disk is no more trusted than a chain from the network.
     */
    load(file) {
        const target = file || (this.dataDir && path.join(this.dataDir, "chain.json"));
        if (!target || !fs.existsSync(target)) return { loaded: false, reason: "no snapshot" };

        try {
            const raw = JSON.parse(fs.readFileSync(target, "utf8"));
            if (raw.chainId !== cfg.CHAIN_ID) return { loaded: false, reason: "snapshot chainId mismatch" };
            if (!Array.isArray(raw.blocks) || raw.blocks.length === 0) {
                return { loaded: false, reason: "snapshot has no blocks" };
            }
            if (raw.blocks.length === 1) return { loaded: true, height: 0 };

            const result = this.replaceChain(raw.blocks);
            if (!result.replaced) return { loaded: false, reason: result.reason };
            return { loaded: true, height: this.height };
        } catch (err) {
            return { loaded: false, reason: err.message };
        }
    }

    /** Compact summary used by the API and by P2P handshakes. */
    summary() {
        return {
            chainId: cfg.CHAIN_ID,
            height: this.height,
            latestHash: this.latest.hash,
            work: this.work.toString(),
            difficulty: this.latest.difficulty,
            stateRoot: stateUtil.stateRoot(this.state),
            mempool: this.mempool.size,
        };
    }
}

module.exports = { Blockchain, ChainError };
