"use strict";

const path = require("path");
const cfg = require("./core/config");
const { Blockchain } = require("./core/blockchain");
const { P2PNode } = require("./net/p2p");
const { createApiServer } = require("./api/server");
const Wallet = require("./crypto/wallet");
const keys = require("./crypto/keys");

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith("--")) continue;
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
            args[key] = true;
        } else {
            args[key] = next;
            i++;
        }
    }
    return args;
}

function resolveMiner(args) {
    if (args["miner-mnemonic"]) return Wallet.fromMnemonic(String(args["miner-mnemonic"]).split(/[\s,]+/));
    if (args["miner-key"]) return Wallet.fromPrivateKey(String(args["miner-key"]));
    if (args["miner-address"]) {
        if (!keys.isValidAddress(args["miner-address"])) throw new Error("invalid --miner-address");
        return { address: String(args["miner-address"]) };
    }
    // No key supplied: mine to a throwaway address so a dev node still produces
    // blocks. The rewards are unspendable across restarts, which is intentional.
    return Wallet.create();
}

class MineverseNode {
    constructor(options = {}) {
        this.name = options.name || "node";
        this.apiHost = options.apiHost || "127.0.0.1";
        this.apiPort = options.apiPort || 8080;
        this.p2pPort = options.p2pPort || 6001;
        this.dataDir = options.dataDir || null;
        this.mining = Boolean(options.mine);
        this.minerAddress = options.minerAddress || null;
        this.log = options.log || ((...a) => console.log(`[${this.name}]`, ...a));

        this.chain = new Blockchain({ genesisFile: options.genesisFile, dataDir: this.dataDir });

        if (this.dataDir) {
            const result = this.chain.load();
            if (result.loaded) this.log(`restored chain from snapshot at height ${this.chain.height}`);
            else if (result.reason !== "no snapshot") this.log(`snapshot ignored: ${result.reason}`);
        }

        this.p2p = new P2PNode({
            chain: this.chain,
            port: this.p2pPort,
            host: options.p2pHost || "0.0.0.0",
            advertiseHost: options.advertiseHost || "127.0.0.1",
        });

        this.api = createApiServer({
            chain: this.chain,
            p2p: this.p2p,
            apiToken: options.apiToken || null,
            allowKeyGeneration: Boolean(options.allowKeyGeneration),
        });

        this.httpServer = null;
        this.miningLoop = null;
        this.miningAbort = null;
        this.snapshotTimer = null;
        this.stopped = false;
    }

    async start(peers = []) {
        this.p2p.on("listening", (port) => this.log(`p2p listening on ${port}`));
        this.p2p.on("peer:connect", (peer) =>
            this.log(`peer connected ${peer.address || peer.remote || peer.nodeId}`)
        );
        this.p2p.on("peer:disconnect", (peer) => this.log(`peer disconnected ${peer.address || peer.nodeId}`));
        this.p2p.on("peer:drop", ({ peer, reason }) =>
            this.log(`peer dropped ${peer.address || peer.nodeId}: ${reason}`)
        );
        this.p2p.on("sync", ({ from, height }) => this.log(`synced to height ${height} from ${from}`));
        this.p2p.on("sync:rejected", ({ reason }) => this.log(`chain offer rejected: ${reason}`));
        this.p2p.on("error", (err) => this.log(`p2p error: ${err.message}`));

        this.chain.on("reorg", ({ from, to }) => this.log(`reorg ${from} -> ${to}`));

        this.p2p.start();
        for (const address of peers) {
            if (this.p2p.addPeerAddress(address)) this.p2p.connect(address);
        }

        await new Promise((resolve, reject) => {
            this.httpServer = this.api.listen(this.apiPort, this.apiHost, resolve);
            this.httpServer.on("error", reject);
        });
        this.log(`api listening on http://${this.apiHost}:${this.apiPort}`);

        if (this.dataDir) {
            this.snapshotTimer = setInterval(() => {
                try {
                    this.chain.save();
                } catch (err) {
                    this.log(`snapshot failed: ${err.message}`);
                }
            }, 15000);
        }

        if (this.mining) this.startMining();
        return this;
    }

    startMining() {
        if (!this.minerAddress) return;

        // Raise the flag before checking for an existing loop: stopMining leaves
        // the previous iteration awaiting its current mineOnce, and that
        // iteration re-reads this.mining when it resolves. Checking the handle
        // first would make a stop/start pair silently leave mining switched off.
        this.mining = true;
        if (this.miningLoop) return;
        this.log(`mining to ${this.minerAddress}`);

        this.miningLoop = (async () => {
            while (this.mining && !this.stopped) {
                this.miningAbort = new AbortController();
                const result = await this.chain.mineOnce(this.minerAddress, {
                    signal: this.miningAbort.signal,
                });
                if (result.mined) {
                    const txCount = result.block.transactions.length - 1;
                    this.log(
                        `mined block ${result.block.index} ${result.block.hash.slice(0, 12)}... ` +
                            `(${txCount} tx, difficulty ${result.block.difficulty})`
                    );
                } else if (result.reason && result.reason !== "tip changed" && result.reason !== "aborted") {
                    this.log(`mining attempt failed: ${result.reason}`);
                }
                // Yield so a burst of blocks cannot starve the event loop.
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            this.miningLoop = null;
            this.miningAbort = null;
        })();
    }

    stopMining() {
        this.mining = false;
        // Abort the search in progress rather than waiting out a full block.
        if (this.miningAbort) this.miningAbort.abort();
    }

    async stop() {
        this.stopped = true;
        this.mining = false;
        if (this.snapshotTimer) clearInterval(this.snapshotTimer);
        if (this.miningLoop) await this.miningLoop.catch(() => {});
        this.p2p.stop();
        if (this.dataDir) {
            try {
                this.chain.save();
            } catch {
                /* best effort on shutdown */
            }
        }
        if (this.httpServer) await new Promise((resolve) => this.httpServer.close(resolve));
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    const miner = resolveMiner(args);
    const peers = args.peers ? String(args.peers).split(",").map((s) => s.trim()).filter(Boolean) : [];

    const node = new MineverseNode({
        name: args.name || `node-${args["api-port"] || 8080}`,
        apiHost: args["api-host"] || "127.0.0.1",
        apiPort: parseInt(args["api-port"], 10) || 8080,
        p2pPort: parseInt(args["p2p-port"], 10) || 6001,
        p2pHost: args["p2p-host"] || "0.0.0.0",
        advertiseHost: args["advertise-host"] || "127.0.0.1",
        dataDir: args["data-dir"] ? path.resolve(String(args["data-dir"])) : null,
        genesisFile: args.genesis ? path.resolve(String(args.genesis)) : undefined,
        mine: Boolean(args.mine),
        minerAddress: miner.address,
        apiToken: args["api-token"] ? String(args["api-token"]) : null,
        allowKeyGeneration: Boolean(args["allow-key-gen"]),
    });

    await node.start(peers);

    if (miner.mnemonic) {
        node.log("ephemeral miner wallet (pass --miner-key to keep rewards across restarts)");
        node.log(`  address:  ${miner.address}`);
        node.log(`  mnemonic: ${miner.mnemonic.join(" ")}`);
    }
    node.log(`chain ${cfg.CHAIN_ID} at height ${node.chain.height}`);

    const shutdown = async () => {
        node.log("shutting down");
        await node.stop();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

if (require.main === module) {
    main().catch((err) => {
        console.error("fatal:", err.message);
        process.exit(1);
    });
}

module.exports = { MineverseNode, parseArgs };
