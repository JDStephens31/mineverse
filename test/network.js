"use strict";

/**
 * End-to-end multi-node test.
 *
 * Starts several real nodes in one process -- real WebSocket gossip, real HTTP
 * APIs, real proof-of-work -- and checks that they agree. Everything a client
 * does here goes through the same signed-transaction path the Minecraft mod
 * uses.
 */

const path = require("path");
const { MineverseNode } = require("../src/node");
const { MineverseClient } = require("../src/client");
const Wallet = require("../src/crypto/wallet");
const cfg = require("../src/core/config");
const { createTransaction, TxType } = require("../src/core/transaction");
const stateUtil = require("../src/core/state");
const { devWallet } = require("../scripts/dev-faucet");

const GENESIS = path.join(__dirname, "genesis.network.json");
const API_BASE = 19080;
const P2P_BASE = 19001;
const VERBOSE = process.argv.includes("--verbose");

const nodes = [];
let passed = 0;
let failed = 0;

function log(...args) {
    console.log("   ", ...args);
}

async function check(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`    \x1b[32mPASS\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.log(`    \x1b[31mFAIL\x1b[0m ${name}`);
        console.log(`         ${err.message}`);
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(description, predicate, { timeoutMs = 30000, intervalMs = 150 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
        const result = await predicate();
        if (result) return result;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}${last ? ": " + last : ""}`);
        await sleep(intervalMs);
    }
}

async function startNode(i, { mine = false, peers = [] } = {}) {
    const miner = Wallet.create();
    const node = new MineverseNode({
        name: `node${i}`,
        apiHost: "127.0.0.1",
        apiPort: API_BASE + i,
        p2pPort: P2P_BASE + i,
        p2pHost: "127.0.0.1",
        advertiseHost: "127.0.0.1",
        genesisFile: GENESIS,
        mine,
        minerAddress: miner.address,
        allowKeyGeneration: true,
        log: VERBOSE ? undefined : () => {},
    });
    node.minerWallet = miner;
    await node.start(peers);
    nodes.push(node);
    return node;
}

function apiUrl(i) {
    return `http://127.0.0.1:${API_BASE + i}`;
}

/**
 * Bring every node to an identical, settled chain.
 *
 * Two miners can legitimately end up on sibling forks of equal cumulative work,
 * and neither side should yield -- that is the correct tie-breaking rule, not a
 * bug. So rather than hoping for a tie that resolves itself, this stops all
 * miners and lets a single leader extend its fork by two blocks, which makes it
 * strictly heavier and forces every peer to reorg onto it.
 */
async function quiesce(activeNodes = nodes, timeoutMs = 60000) {
    for (const node of nodes) node.stopMining();
    await sleep(300);

    const leader = nodes[0];
    const target = Math.max(...activeNodes.map((n) => n.chain.height)) + 2;
    leader.startMining();
    await until(`the leader to reach height ${target}`, () => leader.chain.height >= target, { timeoutMs });
    leader.stopMining();
    await sleep(300);

    return until(
        "all nodes to converge",
        async () => {
            const summaries = activeNodes.map((n) => n.chain.summary());
            const first = summaries[0];
            const agreed = summaries.every(
                (s) => s.height === first.height && s.stateRoot === first.stateRoot
            );
            if (!agreed && VERBOSE) {
                log("heights:", summaries.map((s) => s.height).join(","));
            }
            return agreed ? first : null;
        },
        { timeoutMs }
    );
}

function resumeMining(activeNodes) {
    for (const node of activeNodes) node.startMining();
}

async function main() {
    console.log("\n  mineverse network test\n");

    const faucet = devWallet();

    const node0 = await startNode(0, { mine: true });
    const node1 = await startNode(1, { mine: true, peers: [`ws://127.0.0.1:${P2P_BASE}`] });
    const node2 = await startNode(2, { mine: false, peers: [`ws://127.0.0.1:${P2P_BASE}`] });

    const faucetOn2 = new MineverseClient(apiUrl(2), faucet);
    const alice = Wallet.create();
    const bob = Wallet.create();
    const aliceOn1 = new MineverseClient(apiUrl(1), alice);
    const bobOn0 = new MineverseClient(apiUrl(0), bob);

    // -- connectivity -----------------------------------------------------

    await check("nodes discover each other through gossip", async () => {
        await until("peer discovery", () => nodes.every((n) => n.p2p.peerInfo().length >= 2));
        assert(node2.p2p.peerInfo().some((p) => p.address === `ws://127.0.0.1:${P2P_BASE + 1}`),
            "node2 never learned about node1 (peer gossip did not work)");
    });

    await check("mining produces blocks that reach every node", async () => {
        await until("height >= 3 everywhere", () => nodes.every((n) => n.chain.height >= 3), {
            timeoutMs: 60000,
        });
    });

    await check("all nodes converge on the same chain and state", async () => {
        const summary = await quiesce();
        log(`converged at height ${summary.height}, state ${summary.stateRoot.slice(0, 16)}...`);
        resumeMining([node0, node1]);
    });

    // -- transactions -----------------------------------------------------

    await check("a transaction submitted to a non-mining node gets mined", async () => {
        const { tx } = await faucetOn2.transfer(alice.address, 1000000);
        await faucetOn2.waitForTx(tx.hash, { timeoutMs: 45000 });

        // Confirmed on the node it was submitted to, and on the ones that mine.
        const onNode0 = new MineverseClient(apiUrl(0));
        await onNode0.waitForTx(tx.hash, { timeoutMs: 45000 });

        const account = await faucetOn2.account(alice.address);
        assert(account.balance === 1000000, `alice has ${account.balance}, expected 1000000`);
    });

    await check("balances agree across every node", async () => {
        await quiesce();
        const views = await Promise.all(
            nodes.map((n, i) => new MineverseClient(apiUrl(i)).account(alice.address))
        );
        assert(views.every((v) => v.balance === views[0].balance), "nodes disagree on alice's balance");
        resumeMining([node0, node1]);
    });

    await check("an unauthorised spend is rejected by the API", async () => {
        // Correctly signed by bob, but bob has no funds.
        const broke = createTransaction({
            wallet: bob,
            type: TxType.TRANSFER,
            payload: { to: alice.address, amount: 999999999, symbol: cfg.NATIVE },
            nonce: 0,
        });
        const res = await fetch(apiUrl(0) + "/tx/submit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tx: broke }),
        });
        assert(res.status === 400, `an unfunded transfer was accepted (${res.status})`);

        // Belt and braces: even if a node did relay it, it must never confirm.
        await sleep(1500);
        const found = await fetch(apiUrl(0) + `/tx/${broke.hash}`).then((r) => r.json());
        assert(found.status !== "confirmed", "an unfunded transfer confirmed");
    });

    await check("a tampered transaction is refused at the API boundary", async () => {
        const good = createTransaction({
            wallet: alice,
            type: TxType.TRANSFER,
            payload: { to: bob.address, amount: 10, symbol: cfg.NATIVE },
            nonce: (await aliceOn1.get(`/account/${alice.address}/nonce`)).nonce,
        });
        const tampered = JSON.parse(JSON.stringify(good));
        tampered.payload.amount = 999999;

        const res = await fetch(apiUrl(1) + "/tx/submit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tx: tampered }),
        });
        assert(res.status === 400, `tampered transaction returned ${res.status}, expected 400`);
        const body = await res.json();
        assert(/hash does not match/.test(body.error), `unexpected error: ${body.error}`);
    });

    // -- currencies -------------------------------------------------------

    await check("a currency created on one node is tradable on another", async () => {
        const created = await aliceOn1.createCurrency("Diamond Coin", "DIA", 1000000, 200000);
        await aliceOn1.waitForTx(created.tx.hash, { timeoutMs: 45000 });

        const onNode2 = new MineverseClient(apiUrl(2), alice);
        await until("DIA to reach node2", async () => {
            try {
                await onNode2.currency("DIA");
                return true;
            } catch {
                return false;
            }
        });

        // Fund bob, then have him buy through node0.
        const funded = await aliceOn1.transfer(bob.address, 50000);
        await aliceOn1.waitForTx(funded.tx.hash, { timeoutMs: 45000 });

        const quote = await bobOn0.quote("DIA", "buy", 10000);
        assert(quote.amountOut > 0, "quote returned nothing");

        const bought = await bobOn0.buy("DIA", 10000, Math.floor(quote.amountOut * 0.9));
        await bobOn0.waitForTx(bought.tx.hash, { timeoutMs: 45000 });

        const bobAccount = await bobOn0.account(bob.address);
        assert(bobAccount.tokens.DIA > 0, "bob received no DIA");
        log(`bob bought ${bobAccount.tokens.DIA} DIA for 10000 ${cfg.NATIVE}`);
    });

    await check("every node reports the same pool reserves", async () => {
        await quiesce();
        const pools = await Promise.all(nodes.map((n, i) => new MineverseClient(apiUrl(i)).currency("DIA")));
        assert(
            pools.every((p) => p.reserveNative === pools[0].reserveNative && p.reserveToken === pools[0].reserveToken),
            "nodes disagree on the DIA pool"
        );
        resumeMining([node0, node1]);
    });

    // -- inventory across servers -----------------------------------------

    await check("items deposited on one node are withdrawn on another", async () => {
        const items = [
            { id: "minecraft:diamond", meta: 0, count: 12 },
            { id: "minecraft:enchanted_book", meta: 0, count: 1 },
        ];
        const serverAUuid = "069a79f4-44e9-4726-a5be-fca90e38aaf5";
        const serverBUuid = "069a79f4-44e9-4726-a5be-fca90e38aaf5";

        // Server A: alice deposits through node1.
        const deposit = await aliceOn1.depositInventory(serverAUuid, items);
        await aliceOn1.waitForTx(deposit.tx.hash, { timeoutMs: 45000 });
        const inventoryId = deposit.tx.hash;

        // Server B: the same player, talking to node2, withdraws.
        const aliceOn2 = new MineverseClient(apiUrl(2), alice);
        const stored = await until("inventory to reach node2", async () => {
            try {
                return await aliceOn2.inventory(inventoryId);
            } catch {
                return null;
            }
        });
        assert(stored.claimed === false, "inventory was already marked claimed");
        assert(stored.items.length === 2, "items did not survive the round trip");

        const withdrawal = await aliceOn2.withdrawInventory(inventoryId, serverBUuid);
        const confirmed = await aliceOn2.waitForTx(withdrawal.tx.hash, { timeoutMs: 45000 });
        assert(confirmed.receipt, "no withdrawal receipt");
        assert(confirmed.receipt.items.length === 2, "receipt did not return the items");

        const after = await aliceOn2.inventory(inventoryId);
        assert(after.claimed === true, "inventory was not marked claimed");
        log(`moved ${after.items.map((i) => `${i.count}x ${i.id}`).join(", ")} across nodes`);
    });

    await check("a claimed inventory cannot be withdrawn again from another node", async () => {
        const list = await new MineverseClient(apiUrl(0)).inventories("?claimed=true");
        assert(list.inventories.length > 0, "no claimed inventories to test against");
        const claimed = list.inventories[0];

        const aliceOn0 = new MineverseClient(apiUrl(0), alice);
        aliceOn0.resetNonce();
        const replay = await aliceOn0.withdrawInventory(claimed.id, claimed.uuid);

        await sleep(2500);
        const status = await fetch(apiUrl(0) + `/tx/${replay.tx.hash}`).then((r) => r.json());
        assert(status.status !== "confirmed", "a claimed inventory was withdrawn twice");
    });

    // -- governance --------------------------------------------------------

    /**
     * The whole point of putting the marketplace on the chain: the sale happens
     * wherever the buyer is, and the goods come out wherever they are playing.
     * Neither side has to be on the same server, or even talking to the same
     * node, and nothing is trusted to relay the trade between them.
     */
    await check("items listed on one node are bought on a second and collected on a third", async () => {
        const items = [{ id: "minecraft:elytra", meta: 0, count: 1 }];
        const listed = await aliceOn1.depositInventory("069a79f4-44e9-4726-a5be-fca90e38aaf5", items);
        await aliceOn1.waitForTx(listed.tx.hash, { timeoutMs: 45000 });

        const listing = await aliceOn1.listItem(listed.tx.hash, 5000, cfg.NATIVE, "one careful owner");
        await aliceOn1.waitForTx(listing.tx.hash, { timeoutMs: 45000 });

        // Node 0: bob sees the listing, items and all, and buys it.
        await until("listing to reach node0", async () => {
            const open = await bobOn0.listings("?status=open");
            return open.listings.find((l) => l.id === listing.tx.hash) || null;
        });
        const sellerBefore = (await bobOn0.account(alice.address)).balance;

        const purchase = await bobOn0.buyListing(listing.tx.hash);
        await bobOn0.waitForTx(purchase.tx.hash, { timeoutMs: 45000 });

        const sold = await bobOn0.listing(listing.tx.hash);
        assert(sold.status === "sold", "listing was not marked sold");
        assert(sold.buyer === bob.address, "listing recorded the wrong buyer");

        const fee = Math.floor((5000 * cfg.MARKET_FEE_BPS) / 10000);
        const sellerAfter = (await bobOn0.account(alice.address)).balance;
        assert(
            sellerAfter === sellerBefore + 5000 - fee,
            `seller was paid ${sellerAfter - sellerBefore}, expected ${5000 - fee}`
        );

        // Node 3: bob logs in to a different server and pulls the goods down.
        const bobOn2 = new MineverseClient(apiUrl(2), bob);
        await until("purchase to reach node2", async () => {
            const waiting = await bobOn2.reserved(bob.address);
            return waiting.inventories.find((inv) => inv.id === listed.tx.hash) || null;
        });

        const collect = await bobOn2.withdrawInventory(listed.tx.hash, "853c80ef-3c37-49fd-aa49-938b674adae6");
        const confirmed = await bobOn2.waitForTx(collect.tx.hash, { timeoutMs: 45000 });
        assert(confirmed.receipt.items[0].id === "minecraft:elytra", "the wrong items came out");
        log(`sold an elytra on node1, bought on node0, collected on node2`);
    });

    await check("a vote created on one node is votable on another", async () => {
        const created = await aliceOn1.createVote("Should we add a Nether market?", cfg.MIN_VOTE_DURATION_MS);
        await aliceOn1.waitForTx(created.tx.hash, { timeoutMs: 45000 });
        const voteId = created.tx.hash;

        const bobOn2 = new MineverseClient(apiUrl(2), bob);
        await until("vote to reach node2", async () => {
            try {
                await bobOn2.vote(voteId);
                return true;
            } catch {
                return false;
            }
        });

        const cast = await bobOn2.castVote(voteId, "yes");
        await bobOn2.waitForTx(cast.tx.hash, { timeoutMs: 45000 });

        await quiesce();
        const views = await Promise.all(nodes.map((n, i) => new MineverseClient(apiUrl(i)).vote(voteId)));
        assert(views.every((v) => v.yes === views[0].yes && v.no === views[0].no), "nodes disagree on the tally");
        assert(views[0].yes >= 1, "the vote was not counted");
        resumeMining([node0, node1]);
    });

    // -- late joiner -------------------------------------------------------

    await check("a node joining late syncs the whole chain", async () => {
        const node3 = await startNode(3, { mine: false, peers: [`ws://127.0.0.1:${P2P_BASE}`] });
        assert(node3.chain.height === 0, "the new node did not start from genesis");

        const target = Math.max(...nodes.slice(0, 3).map((n) => n.chain.height));
        await until(`node3 to reach height ${target}`, () => node3.chain.height >= target, {
            timeoutMs: 45000,
        });

        const summary = await quiesce();
        log(`all four nodes at height ${summary.height}`);
    });

    // -- integrity of the final chain -------------------------------------

    await check("the final chain revalidates from genesis on every node", async () => {
        for (const node of nodes) {
            const result = node.chain.validateChain(JSON.parse(JSON.stringify(node.chain.blocks)));
            const expected = node.chain.summary().stateRoot;
            const actual = require("../src/core/state").stateRoot(result.state);
            assert(actual === expected, `${node.name} state does not reproduce from its own blocks`);
        }
    });

    await check("no coins were created outside genesis, coinbases and bank interest", async () => {
        const chain = nodes[0].chain;
        const allocated = Object.values(chain.genesisConfig.allocations).reduce((a, b) => a + b, 0);
        const minted = chain.height * cfg.BLOCK_REWARD;
        // The bank's yield on escrowed contracts is the only other issuance, and
        // it is recorded rather than inferred so it cannot hide a bug.
        const interest = chain.state.bank.interestPaid;
        const expected = allocated + minted + interest;

        // Counts every place a coin can sit: accounts, currency pools, company
        // pools and treasuries, and the bank's own vault, escrow and treasury.
        const circulating = stateUtil.circulatingSupply(chain.state);

        assert(circulating === expected, `supply mismatch: circulating ${circulating}, expected ${expected}`);
        log(`supply checks out: ${circulating} ${cfg.NATIVE} across ${chain.height} blocks`);
    });

    // ---------------------------------------------------------------------

    console.log("");
    console.log(`  ${passed}/${passed + failed} passed`);
    if (failed > 0) {
        console.log(`  \x1b[31m${failed} failed\x1b[0m`);
        process.exitCode = 1;
    }
    console.log("");

    for (const node of nodes) await node.stop();
}

main().catch(async (err) => {
    console.error("\n  network test crashed:", err.stack);
    for (const node of nodes) await node.stop().catch(() => {});
    process.exit(1);
});
