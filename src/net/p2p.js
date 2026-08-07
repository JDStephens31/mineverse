"use strict";

const EventEmitter = require("events");
const crypto = require("crypto");
const { URL } = require("url");
const WebSocket = require("ws");

const cfg = require("../core/config");

const MsgType = {
    HELLO: "HELLO",
    PING: "PING",
    PONG: "PONG",
    QUERY_TIP: "QUERY_TIP",
    TIP: "TIP",
    QUERY_CHAIN: "QUERY_CHAIN",
    CHAIN: "CHAIN",
    NEW_BLOCK: "NEW_BLOCK",
    NEW_TX: "NEW_TX",
    QUERY_PEERS: "QUERY_PEERS",
    PEERS: "PEERS",
};

/**
 * Peer-to-peer gossip layer.
 *
 * Replaces the original `startPTP`, which opened a socket.io server on a
 * hardcoded port, never dialled anyone, and echoed messages back to the sender
 * without ever exchanging a block.
 *
 * The security posture here is simple and deliberate: peers are anonymous and
 * untrusted. Nothing a peer says is believed. Blocks and transactions are
 * re-validated locally from scratch, and a peer that sends malformed data or
 * floods is disconnected. A peer can waste our bandwidth; it cannot corrupt our
 * chain.
 */
class P2PNode extends EventEmitter {
    constructor({ chain, port, host = "0.0.0.0", advertiseHost = "127.0.0.1", maxPeers = cfg.MAX_PEERS }) {
        super();
        this.chain = chain;
        this.port = port;
        this.host = host;
        this.advertiseHost = advertiseHost;
        this.maxPeers = maxPeers;

        // Random per-process id: lets us detect and drop connections to ourselves
        // and duplicate connections to the same peer.
        this.nodeId = crypto.randomBytes(16).toString("hex");

        this.peers = new Map(); // ws -> peer record
        this.knownAddresses = new Set();
        this.dialing = new Set();
        this.server = null;
        this.timers = [];
        this.stopped = false;

        // Gossip dedup. Without it a small network re-floods every block forever.
        this.seen = new Map(); // key -> expiry ms
    }

    // -- lifecycle ---------------------------------------------------------

    start() {
        this.server = new WebSocket.Server({
            host: this.host,
            port: this.port,
            maxPayload: cfg.MAX_WS_MESSAGE_BYTES,
        });

        this.server.on("connection", (ws, req) => {
            const remote = req.socket.remoteAddress;
            if (this.peers.size >= this.maxPeers) {
                ws.close(1013, "peer limit reached");
                return;
            }
            this.setupPeer(ws, { inbound: true, remote });
        });

        this.server.on("error", (err) => this.emit("error", err));
        this.server.on("listening", () => this.emit("listening", this.port));

        this.timers.push(setInterval(() => this.heartbeat(), cfg.PING_INTERVAL_MS));
        this.timers.push(setInterval(() => this.pruneSeen(), 60000));
        this.timers.push(setInterval(() => this.redial(), cfg.PEER_RETRY_MS));

        // Relay locally mined blocks.
        this.chain.on("block", (block) => this.broadcastBlock(block));
        return this;
    }

    stop() {
        this.stopped = true;
        for (const t of this.timers) clearInterval(t);
        this.timers = [];
        for (const ws of this.peers.keys()) {
            try {
                ws.close();
            } catch {
                /* already closing */
            }
        }
        this.peers.clear();
        if (this.server) this.server.close();
    }

    // -- dialling ----------------------------------------------------------

    /** Normalize a peer address so "1.2.3.4:6001" and "ws://1.2.3.4:6001" dedupe. */
    normalizeAddress(address) {
        try {
            const withScheme = /^wss?:\/\//.test(address) ? address : "ws://" + address;
            const url = new URL(withScheme);
            if (!url.port) return null;
            if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
            return `${url.protocol}//${url.hostname}:${url.port}`;
        } catch {
            return null;
        }
    }

    addPeerAddress(address) {
        const normalized = this.normalizeAddress(address);
        if (!normalized) return false;
        if (normalized === this.selfAddress()) return false;
        this.knownAddresses.add(normalized);
        return true;
    }

    selfAddress() {
        return `ws://${this.advertiseHost}:${this.port}`;
    }

    connect(address) {
        const normalized = this.normalizeAddress(address);
        if (!normalized || this.stopped) return;
        if (normalized === this.selfAddress()) return;
        if (this.dialing.has(normalized)) return;
        if (this.isConnectedTo(normalized)) return;
        if (this.peers.size >= this.maxPeers) return;

        this.knownAddresses.add(normalized);
        this.dialing.add(normalized);

        let ws;
        try {
            ws = new WebSocket(normalized, { maxPayload: cfg.MAX_WS_MESSAGE_BYTES });
        } catch (err) {
            this.dialing.delete(normalized);
            return;
        }

        ws.on("open", () => {
            this.dialing.delete(normalized);
            this.setupPeer(ws, { inbound: false, address: normalized });
        });
        // A peer being down is normal; retry on the redial timer rather than logging noise.
        ws.on("error", () => this.dialing.delete(normalized));
        ws.on("close", () => this.dialing.delete(normalized));
    }

    isConnectedTo(normalizedAddress) {
        for (const peer of this.peers.values()) {
            if (peer.address === normalizedAddress) return true;
        }
        return false;
    }

    redial() {
        if (this.stopped) return;
        for (const address of this.knownAddresses) {
            if (!this.isConnectedTo(address)) this.connect(address);
        }
    }

    // -- peer plumbing -----------------------------------------------------

    setupPeer(ws, { inbound, address = null, remote = null }) {
        const peer = {
            ws,
            inbound,
            address,
            remote,
            nodeId: null,
            handshaken: false,
            alive: true,
            windowStart: Date.now(),
            windowCount: 0,
        };
        this.peers.set(ws, peer);

        ws.on("message", (raw) => this.handleRaw(peer, raw));
        ws.on("close", () => {
            this.peers.delete(ws);
            this.emit("peer:disconnect", peer);
        });
        ws.on("error", () => {
            try {
                ws.terminate();
            } catch {
                /* already gone */
            }
            this.peers.delete(ws);
        });
        ws.on("pong", () => {
            peer.alive = true;
        });

        this.send(peer, MsgType.HELLO, {
            nodeId: this.nodeId,
            chainId: cfg.CHAIN_ID,
            listenAddress: this.selfAddress(),
            summary: this.chain.summary(),
        });

        // A handshake that never arrives is a stalled or hostile peer.
        setTimeout(() => {
            if (!peer.handshaken && this.peers.has(ws)) this.drop(peer, "handshake timeout");
        }, 10000);
    }

    drop(peer, reason) {
        this.emit("peer:drop", { peer, reason });
        try {
            peer.ws.close(1008, String(reason).slice(0, 100));
        } catch {
            /* already closing */
        }
        this.peers.delete(peer.ws);
    }

    send(peer, type, payload) {
        if (peer.ws.readyState !== WebSocket.OPEN) return;
        try {
            peer.ws.send(JSON.stringify({ type, payload }));
        } catch {
            /* peer went away mid-send */
        }
    }

    broadcast(type, payload, { except = null } = {}) {
        for (const peer of this.peers.values()) {
            if (!peer.handshaken || peer === except) continue;
            this.send(peer, type, payload);
        }
    }

    heartbeat() {
        for (const peer of this.peers.values()) {
            if (!peer.alive) {
                this.drop(peer, "unresponsive");
                continue;
            }
            peer.alive = false;
            try {
                peer.ws.ping();
            } catch {
                this.drop(peer, "ping failed");
            }
        }
    }

    // -- dedup -------------------------------------------------------------

    markSeen(key, ttl = 10 * 60 * 1000) {
        if (this.seen.has(key)) return false;
        this.seen.set(key, Date.now() + ttl);
        return true;
    }

    pruneSeen() {
        const now = Date.now();
        for (const [key, expiry] of this.seen) {
            if (expiry <= now) this.seen.delete(key);
        }
    }

    // -- message handling --------------------------------------------------

    handleRaw(peer, raw) {
        // Sliding-window rate limit. A peer that floods is dropped, not queued.
        const now = Date.now();
        if (now - peer.windowStart > cfg.PEER_MSG_WINDOW_MS) {
            peer.windowStart = now;
            peer.windowCount = 0;
        }
        if (++peer.windowCount > cfg.PEER_MSG_LIMIT) {
            this.drop(peer, "rate limit exceeded");
            return;
        }

        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            this.drop(peer, "malformed json");
            return;
        }

        if (msg === null || typeof msg !== "object" || typeof msg.type !== "string") {
            this.drop(peer, "malformed message");
            return;
        }

        if (!peer.handshaken && msg.type !== MsgType.HELLO) {
            this.drop(peer, "message before handshake");
            return;
        }

        try {
            this.handleMessage(peer, msg);
        } catch (err) {
            this.emit("error", err);
            this.drop(peer, "handler error");
        }
    }

    handleMessage(peer, msg) {
        const p = msg.payload;

        switch (msg.type) {
            case MsgType.HELLO: {
                if (!p || typeof p !== "object") return this.drop(peer, "bad hello");
                // Refuse to federate with a different network. This is what turns
                // a genesis or config mismatch into a clean disconnect instead of
                // an endless stream of rejected blocks.
                if (p.chainId !== cfg.CHAIN_ID) return this.drop(peer, "chainId mismatch");
                if (p.nodeId === this.nodeId) return this.drop(peer, "self connection");

                for (const other of this.peers.values()) {
                    if (other !== peer && other.nodeId === p.nodeId) {
                        return this.drop(peer, "duplicate peer");
                    }
                }

                peer.nodeId = typeof p.nodeId === "string" ? p.nodeId.slice(0, 64) : null;
                peer.handshaken = true;
                if (typeof p.listenAddress === "string") {
                    const normalized = this.normalizeAddress(p.listenAddress);
                    if (normalized && normalized !== this.selfAddress()) {
                        peer.address = peer.address || normalized;
                        this.knownAddresses.add(normalized);
                    }
                }

                this.emit("peer:connect", peer);
                this.send(peer, MsgType.QUERY_TIP, {});
                this.send(peer, MsgType.QUERY_PEERS, {});
                this.relayMempool(peer);
                return;
            }

            case MsgType.PING:
                return this.send(peer, MsgType.PONG, {});

            case MsgType.PONG:
                peer.alive = true;
                return;

            case MsgType.QUERY_TIP:
                return this.send(peer, MsgType.TIP, {
                    summary: this.chain.summary(),
                    latest: this.chain.latest,
                });

            case MsgType.TIP: {
                if (!p || !p.latest) return;
                return this.considerBlock(peer, p.latest, { gossip: false });
            }

            case MsgType.QUERY_CHAIN:
                return this.send(peer, MsgType.CHAIN, { blocks: this.chain.blocks });

            case MsgType.CHAIN: {
                if (!p || !Array.isArray(p.blocks)) return;
                if (p.blocks.length > 1_000_000) return this.drop(peer, "absurd chain length");

                const result = this.chain.replaceChain(p.blocks);
                if (result.replaced) {
                    this.emit("sync", { from: peer.address, height: this.chain.height });
                    this.broadcast(MsgType.NEW_BLOCK, { block: this.chain.latest }, { except: peer });
                } else {
                    this.emit("sync:rejected", { from: peer.address, reason: result.reason });
                }
                return;
            }

            case MsgType.NEW_BLOCK: {
                if (!p || !p.block) return;
                return this.considerBlock(peer, p.block, { gossip: true });
            }

            case MsgType.NEW_TX: {
                if (!p || !p.tx || typeof p.tx.hash !== "string") return;
                if (!this.markSeen("tx:" + p.tx.hash)) return;
                if (this.chain.mempool.has(p.tx.hash)) return;

                const result = this.chain.submitTransaction(p.tx);
                if (result.accepted) {
                    this.emit("tx", p.tx);
                    this.broadcast(MsgType.NEW_TX, { tx: p.tx }, { except: peer });
                }
                return;
            }

            case MsgType.QUERY_PEERS:
                return this.send(peer, MsgType.PEERS, {
                    addresses: Array.from(this.knownAddresses).slice(0, 64),
                });

            case MsgType.PEERS: {
                if (!p || !Array.isArray(p.addresses)) return;
                for (const address of p.addresses.slice(0, 64)) {
                    if (typeof address !== "string" || address.length > 256) continue;
                    if (this.addPeerAddress(address) && this.peers.size < this.maxPeers) {
                        this.connect(address);
                    }
                }
                return;
            }

            default:
                // Unknown types are ignored rather than fatal, so newer nodes can
                // add message types without partitioning the network.
                return;
        }
    }

    /**
     * Decide what to do with a block a peer announced.
     *
     * Three cases: we already have it, it extends our tip, or it implies the
     * peer is ahead of us on some fork -- in which case we ask for their whole
     * chain and let replaceChain arbitrate on cumulative work.
     */
    considerBlock(peer, block, { gossip }) {
        if (typeof block !== "object" || block === null || typeof block.hash !== "string") return;
        if (this.chain.getBlock(block.hash)) return;
        if (gossip && !this.markSeen("block:" + block.hash)) return;

        const result = this.chain.addBlock(block);
        if (result.added) {
            this.emit("block", block);
            // chain.emit('block') already triggers broadcastBlock, so no relay here.
            return;
        }

        if (typeof block.index === "number" && block.index > this.chain.height) {
            this.send(peer, MsgType.QUERY_CHAIN, {});
        }
    }

    relayMempool(peer) {
        for (const tx of this.chain.mempool.all().slice(0, 200)) {
            this.send(peer, MsgType.NEW_TX, { tx });
        }
    }

    broadcastBlock(block) {
        this.markSeen("block:" + block.hash);
        this.broadcast(MsgType.NEW_BLOCK, { block });
    }

    broadcastTransaction(tx) {
        this.markSeen("tx:" + tx.hash);
        this.broadcast(MsgType.NEW_TX, { tx });
    }

    peerInfo() {
        return Array.from(this.peers.values())
            .filter((peer) => peer.handshaken)
            .map((peer) => ({
                nodeId: peer.nodeId,
                address: peer.address,
                inbound: peer.inbound,
            }));
    }
}

module.exports = { P2PNode, MsgType };
