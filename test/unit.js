"use strict";

const path = require("path");
const { suite, test, assert, run } = require("./harness");

const { canonicalize } = require("../src/util/canonical");
const { meetsDifficulty, leadingZeroBits } = require("../src/util/hash");
const keys = require("../src/crypto/keys");
const mnemonic = require("../src/crypto/mnemonic");
const Wallet = require("../src/crypto/wallet");
const cfg = require("../src/core/config");
const { Blockchain } = require("../src/core/blockchain");
const blockUtil = require("../src/core/block");
const stateUtil = require("../src/core/state");
const bank = require("../src/core/bank");
const { TxType, createTransaction, validateTransaction, txHash } = require("../src/core/transaction");
const { devWallet } = require("../scripts/dev-faucet");

const GENESIS = path.join(__dirname, "genesis.test.json");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function newChain() {
    return new Blockchain({ genesisFile: GENESIS });
}

/** Mine until the tip advances. Difficulty 8 in the test genesis keeps this quick. */
async function mine(chain, address, { now = Date.now() } = {}) {
    const target = chain.height + 1;
    for (let attempt = 0; attempt < 50; attempt++) {
        const result = await chain.mineOnce(address, { now, batchSize: 200000 });
        if (result.mined) return result.block;
        if (chain.height >= target) return chain.latest;
    }
    throw new Error("failed to mine a block");
}

function nonceOf(chain, address) {
    const acct = chain.state.accounts[address];
    return acct ? acct.nonce : 0;
}

function balanceOf(chain, address) {
    const acct = chain.state.accounts[address];
    return acct ? acct.balance : 0;
}

function tokenOf(chain, address, symbol) {
    const acct = chain.state.accounts[address];
    return acct && acct.tokens[symbol] ? acct.tokens[symbol] : 0;
}

function tx(chain, wallet, type, payload, fee = cfg.MIN_FEE) {
    return createTransaction({
        wallet,
        type,
        payload,
        nonce: nonceOf(chain, wallet.address),
        fee,
    });
}

/** Submit a transaction and mine it in, asserting the mempool accepted it. */
async function submitAndMine(chain, minerAddress, transaction, { now = Date.now() } = {}) {
    const accepted = chain.submitTransaction(transaction, { now });
    assert.ok(accepted.accepted, `mempool rejected tx: ${accepted.reason}`);
    const block = await mine(chain, minerAddress, { now });
    assert.ok(
        block.transactions.some((t) => t.hash === transaction.hash),
        "transaction was not included in the mined block"
    );
    return block;
}

/** Give a fresh wallet some coin from the faucet so it can pay its own fees. */
async function fund(chain, miner, wallet, amount, { now = Date.now() } = {}) {
    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.TRANSFER, {
        to: wallet.address,
        amount,
        symbol: cfg.NATIVE,
    }), { now });
}

const FAUCET = devWallet();

// ---------------------------------------------------------------------------

suite("serialization");

test("canonicalize is independent of key insertion order", () => {
    assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
    assert.equal(canonicalize({ a: { z: 1, y: 2 } }), '{"a":{"y":2,"z":1}}');
});

test("canonicalize survives a JSON round trip", () => {
    const value = { z: [3, { b: 1, a: 2 }], a: "x", n: null, t: true };
    assert.equal(canonicalize(value), canonicalize(JSON.parse(JSON.stringify(value))));
});

test("canonicalize rejects non-finite numbers", () => {
    assert.throws(() => canonicalize({ a: NaN }), "non-finite");
});

suite("proof of work");

test("leadingZeroBits counts bits, not hex digits", () => {
    assert.equal(leadingZeroBits("00ff"), 8);
    assert.equal(leadingZeroBits("0fff"), 4);
    assert.equal(leadingZeroBits("1fff"), 3);
    assert.equal(leadingZeroBits("ffff"), 0);
});

test("meetsDifficulty is strict at the boundary", () => {
    assert.ok(meetsDifficulty("00" + "f".repeat(62), 8));
    assert.ok(!meetsDifficulty("01" + "f".repeat(62), 8));
});

suite("keys and wallets");

test("sign/verify round trip", () => {
    const wallet = Wallet.create();
    const digest = "a".repeat(64);
    const sig = wallet.sign(digest);
    assert.ok(keys.verify(wallet.publicKey, digest, sig));
});

test("a signature does not verify against another key", () => {
    const a = Wallet.create();
    const b = Wallet.create();
    const digest = "b".repeat(64);
    assert.ok(!keys.verify(b.publicKey, digest, a.sign(digest)));
});

test("a signature does not verify against different data", () => {
    const wallet = Wallet.create();
    const sig = wallet.sign("c".repeat(64));
    assert.ok(!keys.verify(wallet.publicKey, "d".repeat(64), sig));
});

test("mnemonic actually restores the same wallet", () => {
    const wallet = Wallet.create();
    const restored = Wallet.fromMnemonic(wallet.mnemonic);
    assert.equal(restored.address, wallet.address);
    assert.equal(restored.privateKey, wallet.privateKey);
});

test("distinct wallets get distinct mnemonics and addresses", () => {
    const a = Wallet.create();
    const b = Wallet.create();
    assert.notEqual(a.address, b.address);
    assert.notEqual(a.mnemonic.join(" "), b.mnemonic.join(" "));
    assert.equal(a.mnemonic.length, mnemonic.WORD_COUNT);
});

test("a wrong word count is rejected", () => {
    assert.throws(() => Wallet.fromMnemonic(["stone", "granite"]), "12 words");
});

test("wallets never expose a balance field", () => {
    const wallet = Wallet.create();
    assert.equal(wallet.balance, undefined);
    assert.deepEqual(Object.keys(wallet.toPublic()).sort(), ["address", "publicKey"]);
});

suite("genesis and mining");

test("genesis allocation is credited and nothing else exists", () => {
    const chain = newChain();
    assert.equal(chain.height, 0);
    assert.equal(balanceOf(chain, FAUCET.address), 100000000);
    assert.equal(Object.keys(chain.state.accounts).length, 1);
});

test("two chains built from the same genesis agree on the genesis hash", () => {
    assert.equal(newChain().latest.hash, newChain().latest.hash);
});

test("mining pays exactly the block reward", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    await mine(chain, miner.address);
    assert.equal(chain.height, 1);
    assert.equal(balanceOf(chain, miner.address), cfg.BLOCK_REWARD);
});

test("mining pays the reward plus collected fees", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const recipient = Wallet.create();
    const fee = 7;

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.TRANSFER, {
        to: recipient.address,
        amount: 100,
        symbol: cfg.NATIVE,
    }, fee));

    assert.equal(balanceOf(chain, miner.address), cfg.BLOCK_REWARD + fee);
    assert.equal(balanceOf(chain, recipient.address), 100);
    assert.equal(balanceOf(chain, FAUCET.address), 100000000 - 100 - fee);
});

test("a coinbase claiming an inflated reward is rejected", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const candidate = chain.buildCandidate(miner.address);

    candidate.transactions[0].payload.reward = cfg.BLOCK_REWARD * 1000;
    candidate.transactions[0].hash = txHash(candidate.transactions[0]);
    candidate.merkleRoot = require("../src/util/hash").merkleRoot(candidate.transactions.map((t) => t.hash));

    for (candidate.nonce = 0; candidate.nonce < 500000; candidate.nonce++) {
        candidate.hash = blockUtil.computeHash(candidate);
        if (meetsDifficulty(candidate.hash, candidate.difficulty)) break;
    }

    const result = chain.addBlock(candidate);
    assert.ok(!result.added, "an over-reward block was accepted");
    assert.ok(result.reason.includes("coinbase reward"), `unexpected reason: ${result.reason}`);
});

test("a block without valid proof of work is rejected", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const candidate = chain.buildCandidate(miner.address);
    candidate.nonce = 1;
    candidate.hash = blockUtil.computeHash(candidate);

    if (meetsDifficulty(candidate.hash, candidate.difficulty)) return; // 1-in-256 fluke
    const result = chain.addBlock(candidate);
    assert.ok(!result.added);
    assert.ok(/difficulty target|proof of work/.test(result.reason), result.reason);
});

suite("transaction security");

test("a forged signature is rejected", () => {
    const attacker = Wallet.create();
    const victim = Wallet.create();

    const forged = createTransaction({
        wallet: attacker,
        type: TxType.TRANSFER,
        payload: { to: attacker.address, amount: 1000, symbol: cfg.NATIVE },
        nonce: 0,
    });
    // Swap in the victim's public key while keeping the attacker's signature.
    forged.from = victim.publicKey;

    assert.throws(() => validateTransaction(forged), "hash does not match");
});

test("re-signing a tampered transaction still changes its hash", () => {
    const wallet = Wallet.create();
    const t = createTransaction({
        wallet,
        type: TxType.TRANSFER,
        payload: { to: Wallet.create().address, amount: 1, symbol: cfg.NATIVE },
        nonce: 0,
    });
    const original = t.hash;
    t.payload.amount = 999999;
    assert.notEqual(txHash(t), original);
    assert.throws(() => validateTransaction(t), "hash does not match");
});

test("a transaction from another chain is rejected", () => {
    const wallet = Wallet.create();
    const t = createTransaction({
        wallet,
        type: TxType.TRANSFER,
        payload: { to: Wallet.create().address, amount: 1, symbol: cfg.NATIVE },
        nonce: 0,
    });
    t.chainId = "some-other-chain";
    assert.throws(() => validateTransaction(t), "chainId");
});

test("replaying a confirmed transaction is rejected", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const recipient = Wallet.create();

    const t = tx(chain, FAUCET, TxType.TRANSFER, {
        to: recipient.address,
        amount: 500,
        symbol: cfg.NATIVE,
    });
    await submitAndMine(chain, miner.address, t);
    assert.equal(balanceOf(chain, recipient.address), 500);

    const replay = chain.submitTransaction(t);
    assert.ok(!replay.accepted, "the mempool accepted a replay");
    assert.ok(replay.reason.includes("nonce"), replay.reason);
    assert.equal(balanceOf(chain, recipient.address), 500);
});

test("spending more than the balance is rejected", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const poor = Wallet.create();

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.TRANSFER, {
        to: poor.address,
        amount: 50,
        symbol: cfg.NATIVE,
    }));

    const overspend = tx(chain, poor, TxType.TRANSFER, {
        to: FAUCET.address,
        amount: 1000000,
        symbol: cfg.NATIVE,
    });
    chain.submitTransaction(overspend);

    const before = balanceOf(chain, poor.address);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === overspend.hash), "overspend was mined");
    assert.equal(balanceOf(chain, poor.address), before);
});

test("a transaction with a skipped nonce never applies", async () => {
    const chain = newChain();
    const miner = Wallet.create();

    const skipped = createTransaction({
        wallet: FAUCET,
        type: TxType.TRANSFER,
        payload: { to: miner.address, amount: 10, symbol: cfg.NATIVE },
        nonce: nonceOf(chain, FAUCET.address) + 5,
    });
    chain.submitTransaction(skipped);

    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === skipped.hash), "an out-of-order nonce was mined");
});

suite("chain integrity");

test("editing a balance inside a mined block invalidates the chain", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const recipient = Wallet.create();

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.TRANSFER, {
        to: recipient.address,
        amount: 100,
        symbol: cfg.NATIVE,
    }));

    const tampered = JSON.parse(JSON.stringify(chain.blocks));
    const target = tampered[1].transactions.find((t) => t.type === TxType.TRANSFER);
    target.payload.amount = 99999999;

    assert.throws(() => chain.validateChain(tampered), "hash does not match");
});

test("a chain with a broken prevHash link is rejected", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    await mine(chain, miner.address);
    await mine(chain, miner.address);

    const tampered = JSON.parse(JSON.stringify(chain.blocks));
    tampered[2].prevHash = "0".repeat(64);
    assert.throws(() => chain.validateChain(tampered), /prevHash|hash does not match/);
});

test("a chain from a different genesis is rejected", async () => {
    const chain = newChain();
    const other = new Blockchain(); // production genesis: different difficulty
    const miner = Wallet.create();
    await mine(other, miner.address);

    const result = chain.replaceChain(other.blocks);
    assert.ok(!result.replaced);
});

test("the longer-but-weaker chain does not win over more cumulative work", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    await mine(chain, miner.address);
    await mine(chain, miner.address);

    // Same chain replayed carries identical work, so it must not displace ours.
    const clone = JSON.parse(JSON.stringify(chain.blocks));
    assert.ok(!chain.replaceChain(clone).replaced, "an equal-work chain was adopted");
});

test("a valid heavier chain from a peer is adopted", async () => {
    const a = newChain();
    const b = newChain();
    const miner = Wallet.create();

    await mine(b, miner.address);
    await mine(b, miner.address);
    await mine(b, miner.address);

    const result = a.replaceChain(JSON.parse(JSON.stringify(b.blocks)));
    assert.ok(result.replaced, result.reason);
    assert.equal(a.height, 3);
    assert.equal(stateUtil.stateRoot(a.state), stateUtil.stateRoot(b.state));
});

test("replaying a chain reproduces byte-identical state", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.TRANSFER, {
        to: miner.address,
        amount: 4242,
        symbol: cfg.NATIVE,
    }));

    const replayed = chain.validateChain(JSON.parse(JSON.stringify(chain.blocks)));
    assert.equal(stateUtil.stateRoot(replayed.state), stateUtil.stateRoot(chain.state));
});

suite("currencies and the AMM");

test("creating a currency locks liquidity and grants the creator 5%", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const before = balanceOf(chain, FAUCET.address);

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CREATE_CURRENCY, {
        name: "Diamond Coin",
        symbol: "DIA",
        totalSupply: 1000000,
        liquidity: 50000,
    }));

    const cur = chain.state.currencies.DIA;
    assert.ok(cur, "currency was not created");
    assert.equal(cur.reserveNative, 50000);
    assert.equal(cur.reserveToken, 950000);
    assert.equal(tokenOf(chain, FAUCET.address, "DIA"), 50000);
    assert.equal(balanceOf(chain, FAUCET.address), before - 50000 - cfg.MIN_FEE);
});

test("a duplicate symbol is rejected", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const payload = { name: "Diamond", symbol: "DIA", totalSupply: 1000, liquidity: 1000 };

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CREATE_CURRENCY, payload));

    const dup = tx(chain, FAUCET, TxType.CREATE_CURRENCY, payload);
    chain.submitTransaction(dup);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === dup.hash), "a duplicate symbol was mined");
});

test("the native symbol cannot be re-issued", () => {
    assert.throws(
        () =>
            createTransaction({
                wallet: FAUCET,
                type: TxType.CREATE_CURRENCY,
                payload: { name: "Fake", symbol: cfg.NATIVE, totalSupply: 1000, liquidity: 1000 },
                nonce: 0,
            }),
        "reserved"
    );
});

test("buying moves the price against the buyer", async () => {
    const chain = newChain();
    const miner = Wallet.create();

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CREATE_CURRENCY, {
        name: "Emerald",
        symbol: "EMR",
        totalSupply: 1000000,
        liquidity: 100000,
    }));

    const firstOut = stateUtil.amountOut(1000, chain.state.currencies.EMR.reserveNative, chain.state.currencies.EMR.reserveToken);
    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.BUY, {
        symbol: "EMR",
        amountIn: 1000,
        minOut: 1,
    }));
    const secondOut = stateUtil.amountOut(1000, chain.state.currencies.EMR.reserveNative, chain.state.currencies.EMR.reserveToken);

    assert.ok(secondOut < firstOut, "price did not move after a buy");
    assert.equal(chain.state.currencies.EMR.reserveNative, 101000);
});

test("the pool cannot be drained", async () => {
    const chain = newChain();
    const miner = Wallet.create();

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CREATE_CURRENCY, {
        name: "Gold",
        symbol: "GLD",
        totalSupply: 1000000,
        liquidity: 10000,
    }));

    // A buy far larger than the pool must still leave tokens behind.
    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.BUY, {
        symbol: "GLD",
        amountIn: 10000000,
        minOut: 1,
    }));

    const cur = chain.state.currencies.GLD;
    assert.ok(cur.reserveToken > 0, "pool token reserve was drained to zero");
    assert.ok(cur.reserveNative > 0, "pool native reserve was drained to zero");
});

test("slippage protection aborts a trade that got worse", async () => {
    const chain = newChain();
    const miner = Wallet.create();

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CREATE_CURRENCY, {
        name: "Lapis",
        symbol: "LAP",
        totalSupply: 1000000,
        liquidity: 100000,
    }));

    const greedy = tx(chain, FAUCET, TxType.BUY, {
        symbol: "LAP",
        amountIn: 1000,
        minOut: 999999999, // unreachable
    });
    chain.submitTransaction(greedy);

    const before = balanceOf(chain, FAUCET.address);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === greedy.hash), "a slippage-violating trade was mined");
    assert.equal(balanceOf(chain, FAUCET.address), before);
});

test("selling tokens you do not hold is rejected", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const attacker = Wallet.create();

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CREATE_CURRENCY, {
        name: "Redstone",
        symbol: "RED",
        totalSupply: 1000000,
        liquidity: 100000,
    }));
    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.TRANSFER, {
        to: attacker.address,
        amount: 1000,
        symbol: cfg.NATIVE,
    }));

    const bogus = tx(chain, attacker, TxType.SELL, { symbol: "RED", amountIn: 500, minOut: 0 });
    chain.submitTransaction(bogus);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === bogus.hash), "a phantom sell was mined");
});

test("a round trip through the pool loses only the swap fee", async () => {
    const chain = newChain();
    const miner = Wallet.create();

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CREATE_CURRENCY, {
        name: "Iron",
        symbol: "IRN",
        totalSupply: 1000000,
        liquidity: 100000,
    }));

    const startBalance = balanceOf(chain, FAUCET.address);
    const startTokens = tokenOf(chain, FAUCET.address, "IRN");

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.BUY, {
        symbol: "IRN",
        amountIn: 1000,
        minOut: 1,
    }));
    const gained = tokenOf(chain, FAUCET.address, "IRN") - startTokens;

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.SELL, {
        symbol: "IRN",
        amountIn: gained,
        minOut: 1,
    }));

    const net = startBalance - balanceOf(chain, FAUCET.address);
    assert.ok(net > 0, "a round trip was free or profitable");
    assert.ok(net < 1000, `a round trip lost more than the input: ${net}`);
});

suite("governance");

test("a vote records yes and no, and rejects double voting", async () => {
    const chain = newChain();
    const miner = Wallet.create();

    const createTx = tx(chain, FAUCET, TxType.CREATE_VOTE, {
        statement: "Should creepers drop diamonds?",
        durationMs: cfg.MIN_VOTE_DURATION_MS,
    });
    await submitAndMine(chain, miner.address, createTx);

    const voteId = createTx.hash;
    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CAST_VOTE, { voteId, choice: "yes" }));
    assert.equal(chain.state.votes[voteId].yes, 1);

    const second = tx(chain, FAUCET, TxType.CAST_VOTE, { voteId, choice: "no" });
    chain.submitTransaction(second);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === second.hash), "a double vote was mined");
    assert.equal(chain.state.votes[voteId].no, 0);
});

test("a vote closes on block time, identically for every node", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const now = Date.now();

    const createTx = tx(chain, FAUCET, TxType.CREATE_VOTE, {
        statement: "Nether portals in the overworld?",
        durationMs: cfg.MIN_VOTE_DURATION_MS,
    });
    await submitAndMine(chain, miner.address, createTx, { now });
    const voteId = createTx.hash;

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CAST_VOTE, { voteId, choice: "yes" }), { now });
    assert.ok(chain.state.votes[voteId].running, "vote closed too early");

    // A later block closes it -- no timer involved, so a replaying node agrees.
    await mine(chain, miner.address, { now: now + cfg.MIN_VOTE_DURATION_MS + 1000 });
    assert.ok(!chain.state.votes[voteId].running, "vote did not close");
    assert.equal(chain.state.votes[voteId].result, "passed");

    const replayed = chain.validateChain(JSON.parse(JSON.stringify(chain.blocks)));
    assert.equal(stateUtil.stateRoot(replayed.state), stateUtil.stateRoot(chain.state));
});

suite("contracts");

/** Propose a contract from the faucet and mine it in. Returns the contract id. */
async function propose(chain, miner, contractee, cost, opts = {}) {
    const { durationMs = cfg.MIN_CONTRACT_DURATION_MS, now = Date.now(), data = "build a castle" } = opts;
    const createTx = tx(chain, FAUCET, TxType.CREATE_CONTRACT, {
        contractee: contractee.address,
        cost,
        durationMs,
        data,
    });
    await submitAndMine(chain, miner.address, createTx, { now });
    return createTx.hash;
}

test("a proposal escrows the cost immediately, before anyone accepts", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const contractee = Wallet.create();

    const before = balanceOf(chain, FAUCET.address);
    const id = await propose(chain, miner, contractee, 5000);

    // The money is gone from the proposer the moment the contract exists, so it
    // cannot be spent out from under a counterparty who is about to accept.
    assert.equal(balanceOf(chain, FAUCET.address), before - 5000 - cfg.MIN_FEE);
    assert.equal(chain.state.contracts[id].status, "proposed");
    assert.equal(chain.state.bank.pending, 5000);
    assert.equal(chain.state.bank.vault, 0);
    assert.equal(balanceOf(chain, contractee.address), 0);
});

test("a contract cannot be proposed without the funds to back it", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const pauper = Wallet.create();
    const contractee = Wallet.create();

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.TRANSFER, {
        to: pauper.address,
        amount: 100,
        symbol: cfg.NATIVE,
    }));

    const broke = tx(chain, pauper, TxType.CREATE_CONTRACT, {
        contractee: contractee.address,
        cost: 5000,
        durationMs: cfg.MIN_CONTRACT_DURATION_MS,
        data: "more than I have",
    });
    chain.submitTransaction(broke);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === broke.hash), "an unfunded contract was made");
    assert.equal(chain.state.contracts[broke.hash], undefined);
});

test("accepting moves the principal into the bank vault", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const contractee = Wallet.create();
    const now = Date.now();

    const id = await propose(chain, miner, contractee, 5000, { now });
    await fund(chain, miner, contractee, 100);

    await submitAndMine(chain, miner.address, tx(chain, contractee, TxType.ACCEPT_CONTRACT, {
        contractId: id,
    }), { now });

    const contract = chain.state.contracts[id];
    assert.equal(contract.status, "active");
    assert.equal(chain.state.bank.pending, 0);
    assert.equal(chain.state.bank.vault, 5000);
    // Still not the contractee's until the work is settled.
    assert.equal(balanceOf(chain, contractee.address), 100 - cfg.MIN_FEE);
});

test("only the contractee may accept", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const contractee = Wallet.create();
    const stranger = Wallet.create();

    const id = await propose(chain, miner, contractee, 1000);
    await fund(chain, miner, stranger, 100);

    const forged = tx(chain, stranger, TxType.ACCEPT_CONTRACT, { contractId: id });
    chain.submitTransaction(forged);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === forged.hash), "a stranger accepted a contract");
    assert.equal(chain.state.contracts[id].status, "proposed");
});

test("an accepted contract pays out at expiry", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const contractee = Wallet.create();
    const now = Date.now();

    const id = await propose(chain, miner, contractee, 100000, { now });
    await fund(chain, miner, contractee, 100, { now });
    await submitAndMine(chain, miner.address, tx(chain, contractee, TxType.ACCEPT_CONTRACT, {
        contractId: id,
    }), { now });

    await mine(chain, miner.address, { now: now + cfg.MIN_CONTRACT_DURATION_MS + 1000 });

    const contract = chain.state.contracts[id];
    assert.equal(contract.status, "settled");
    assert.equal(contract.settlement, "expired");
    assert.ok(!contract.running);
    assert.equal(chain.state.bank.vault, 0);
    assert.equal(balanceOf(chain, contractee.address), 100 - cfg.MIN_FEE + 100000);
});

/**
 * A node will not mine a block dated a year ahead -- MAX_FUTURE_DRIFT_MS stops
 * it, and rightly so. Long-horizon settlement is therefore driven straight
 * through the deterministic expiry pass, which is the same code path a block
 * arriving a year from now would take.
 */
test("the bank's yield is paid on top of the contract, not carved out of it", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const contractee = Wallet.create();
    const now = Date.now();

    const id = await propose(chain, miner, contractee, 100000, {
        now,
        durationMs: cfg.MAX_CONTRACT_DURATION_MS,
    });
    await fund(chain, miner, contractee, 100, { now });
    await submitAndMine(chain, miner.address, tx(chain, contractee, TxType.ACCEPT_CONTRACT, {
        contractId: id,
    }), { now });

    const state = stateUtil.cloneState(chain.state);
    const acceptedAt = state.contracts[id].acceptedAt;
    const supplyBefore = stateUtil.circulatingSupply(state);
    const paidBefore = balanceOf(chain, contractee.address);

    stateUtil.processExpirations(state, acceptedAt + cfg.MAX_CONTRACT_DURATION_MS);

    const contract = state.contracts[id];
    assert.equal(contract.status, "settled");
    // The contractee is paid the agreed cost in full...
    assert.equal(state.accounts[contractee.address].balance, paidBefore + 100000);

    // ...and the bank's yield is minted on top of it. A full year at the
    // configured rate, which is why supply grows by exactly that much.
    const expected = Math.floor((100000 * cfg.BANK_INTEREST_APR_BPS) / 10000);
    assert.equal(contract.interest, expected);
    assert.equal(state.bank.treasury, expected);
    assert.equal(state.bank.interestPaid, expected);
    assert.equal(state.bank.vault, 0);
    assert.equal(stateUtil.circulatingSupply(state), supplyBefore + expected);
});

test("interest is proportional to how long the bank held the money", async () => {
    const year = cfg.MS_PER_YEAR;
    const full = bank.accruedInterest(1000000, year);
    assert.equal(full, Math.floor((1000000 * cfg.BANK_INTEREST_APR_BPS) / 10000));
    assert.equal(bank.accruedInterest(1000000, year / 2), Math.floor(full / 2));
    assert.equal(bank.accruedInterest(1000000, 0), 0);
    assert.equal(bank.accruedInterest(0, year), 0);
});

test("a rejected proposal refunds the proposer and never reaches the vault", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const contractee = Wallet.create();

    await fund(chain, miner, contractee, 100);
    const before = balanceOf(chain, FAUCET.address);
    const id = await propose(chain, miner, contractee, 5000);

    await submitAndMine(chain, miner.address, tx(chain, contractee, TxType.REJECT_CONTRACT, {
        contractId: id,
    }));

    assert.equal(chain.state.contracts[id].status, "rejected");
    assert.equal(chain.state.bank.pending, 0);
    assert.equal(chain.state.bank.vault, 0);
    assert.equal(balanceOf(chain, FAUCET.address), before - cfg.MIN_FEE);
});

test("an unanswered proposal expires and refunds rather than locking funds forever", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const contractee = Wallet.create();
    const now = Date.now();

    const before = balanceOf(chain, FAUCET.address);
    const id = await propose(chain, miner, contractee, 5000, { now });

    const state = stateUtil.cloneState(chain.state);
    stateUtil.processExpirations(state, state.contracts[id].acceptDeadline);

    assert.equal(state.contracts[id].status, "expired");
    assert.equal(state.contracts[id].settlement, "expired");
    assert.equal(state.bank.pending, 0);
    assert.equal(state.bank.vault, 0);
    // No interest: the bank never had the use of money nobody agreed to lend it.
    assert.equal(state.bank.interestPaid, 0);
    assert.equal(state.accounts[FAUCET.address].balance, before - cfg.MIN_FEE);
});

test("a contract cannot be cancelled once the counterparty has accepted", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const contractee = Wallet.create();

    const id = await propose(chain, miner, contractee, 1000, { durationMs: cfg.MAX_CONTRACT_DURATION_MS });
    await fund(chain, miner, contractee, 100);
    await submitAndMine(chain, miner.address, tx(chain, contractee, TxType.ACCEPT_CONTRACT, {
        contractId: id,
    }));

    const bail = tx(chain, FAUCET, TxType.CANCEL_CONTRACT, { contractId: id });
    chain.submitTransaction(bail);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === bail.hash), "an active contract was cancelled");
    assert.equal(chain.state.contracts[id].status, "active");
});

test("only the contracter can settle a contract early", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const contractee = Wallet.create();

    const id = await propose(chain, miner, contractee, 1000, { durationMs: cfg.MAX_CONTRACT_DURATION_MS });
    await fund(chain, miner, contractee, 100);
    await submitAndMine(chain, miner.address, tx(chain, contractee, TxType.ACCEPT_CONTRACT, {
        contractId: id,
    }));

    const steal = tx(chain, contractee, TxType.RESOLVE_CONTRACT, { contractId: id });
    chain.submitTransaction(steal);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === steal.hash), "a stranger settled a contract");
    assert.equal(chain.state.contracts[id].status, "active");

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.RESOLVE_CONTRACT, {
        contractId: id,
    }));
    assert.equal(balanceOf(chain, contractee.address), 100 - cfg.MIN_FEE + 1000);
    assert.equal(chain.state.bank.vault, 0);
});

suite("inventory custody");

const SAMPLE_ITEMS = [
    { id: "minecraft:diamond", meta: 0, count: 12 },
    { id: "minecraft:iron_ingot", meta: 0, count: 64 },
];
const UUID_A = "069a79f4-44e9-4726-a5be-fca90e38aaf5";
const UUID_B = "853c80ef-3c37-49fd-aa49-938b674adae6";

test("depositing stores items against the signer", async () => {
    const chain = newChain();
    const miner = Wallet.create();

    const deposit = tx(chain, FAUCET, TxType.DEPOSIT_INVENTORY, { uuid: UUID_A, items: SAMPLE_ITEMS });
    await submitAndMine(chain, miner.address, deposit);

    const inv = chain.state.inventories[deposit.hash];
    assert.ok(inv, "inventory was not stored");
    assert.equal(inv.owner, FAUCET.address);
    assert.equal(inv.claimed, false);
    assert.deepEqual(inv.items, SAMPLE_ITEMS);
});

test("a stranger cannot withdraw someone else's inventory", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const thief = Wallet.create();

    const deposit = tx(chain, FAUCET, TxType.DEPOSIT_INVENTORY, { uuid: UUID_A, items: SAMPLE_ITEMS });
    await submitAndMine(chain, miner.address, deposit);

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.TRANSFER, {
        to: thief.address,
        amount: 100,
        symbol: cfg.NATIVE,
    }));

    const steal = tx(chain, thief, TxType.WITHDRAW_INVENTORY, {
        inventoryId: deposit.hash,
        uuid: UUID_B,
    });
    chain.submitTransaction(steal);
    const block = await mine(chain, miner.address);

    assert.ok(!block.transactions.some((t) => t.hash === steal.hash), "a thief withdrew an inventory");
    assert.equal(chain.state.inventories[deposit.hash].claimed, false);
});

test("an inventory cannot be withdrawn twice", async () => {
    const chain = newChain();
    const miner = Wallet.create();

    const deposit = tx(chain, FAUCET, TxType.DEPOSIT_INVENTORY, { uuid: UUID_A, items: SAMPLE_ITEMS });
    await submitAndMine(chain, miner.address, deposit);

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.WITHDRAW_INVENTORY, {
        inventoryId: deposit.hash,
        uuid: UUID_B,
    }));
    assert.equal(chain.state.inventories[deposit.hash].claimed, true);

    const again = tx(chain, FAUCET, TxType.WITHDRAW_INVENTORY, {
        inventoryId: deposit.hash,
        uuid: UUID_B,
    });
    chain.submitTransaction(again);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === again.hash), "an inventory was withdrawn twice");
});

test("withdrawing keeps the record instead of deleting the block", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const heightBefore = chain.height;

    const deposit = tx(chain, FAUCET, TxType.DEPOSIT_INVENTORY, { uuid: UUID_A, items: SAMPLE_ITEMS });
    await submitAndMine(chain, miner.address, deposit);
    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.WITHDRAW_INVENTORY, {
        inventoryId: deposit.hash,
        uuid: UUID_B,
    }));

    assert.equal(chain.height, heightBefore + 2);
    assert.ok(chain.validateChain(JSON.parse(JSON.stringify(chain.blocks))).state, "chain no longer validates");
});

test("oversized item payloads are rejected before signing", () => {
    const tooMany = Array.from({ length: cfg.MAX_INVENTORY_SLOTS + 1 }, () => ({
        id: "minecraft:dirt",
        count: 1,
    }));
    assert.throws(
        () =>
            createTransaction({
                wallet: FAUCET,
                type: TxType.DEPOSIT_INVENTORY,
                payload: { uuid: UUID_A, items: tooMany },
                nonce: 0,
            }),
        "slots"
    );

    assert.throws(
        () =>
            createTransaction({
                wallet: FAUCET,
                type: TxType.DEPOSIT_INVENTORY,
                payload: { uuid: UUID_A, items: [{ id: "minecraft:dirt", count: 999 }] },
                nonce: 0,
            }),
        "item.count"
    );
});

suite("uuid binding");

test("a uuid cannot be hijacked by another address", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const attacker = Wallet.create();

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.REGISTER_UUID, { uuid: UUID_A }));
    assert.equal(chain.state.uuids[UUID_A], FAUCET.address);

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.TRANSFER, {
        to: attacker.address,
        amount: 100,
        symbol: cfg.NATIVE,
    }));

    const hijack = tx(chain, attacker, TxType.REGISTER_UUID, { uuid: UUID_A });
    chain.submitTransaction(hijack);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === hijack.hash), "a uuid was hijacked");
    assert.equal(chain.state.uuids[UUID_A], FAUCET.address);
});

// ---------------------------------------------------------------------------

suite("marketplace");

const DIAMONDS = [{ id: "minecraft:diamond", count: 32, meta: 0 }];

/** Put items into custody for `seller` and list them at `price`. */
async function listItems(chain, miner, seller, price, { symbol = cfg.NATIVE, uuid = UUID_B } = {}) {
    const deposit = tx(chain, seller, TxType.DEPOSIT_INVENTORY, { uuid, items: DIAMONDS });
    await submitAndMine(chain, miner.address, deposit);

    const listing = tx(chain, seller, TxType.LIST_ITEM, {
        inventoryId: deposit.hash,
        price,
        symbol,
        note: "sharp",
    });
    await submitAndMine(chain, miner.address, listing);
    return { inventoryId: deposit.hash, listingId: listing.hash };
}

test("buying a listing pays the seller, cuts the bank in, and hands over custody", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const buyer = Wallet.create();

    const { inventoryId, listingId } = await listItems(chain, miner, FAUCET, 10000);
    await fund(chain, miner, buyer, 20000);

    const sellerBefore = balanceOf(chain, FAUCET.address);
    await submitAndMine(chain, miner.address, tx(chain, buyer, TxType.BUY_LISTING, { listingId }));

    const fee = Math.floor((10000 * cfg.MARKET_FEE_BPS) / 10000);
    assert.equal(balanceOf(chain, FAUCET.address), sellerBefore + 10000 - fee);
    assert.equal(balanceOf(chain, buyer.address), 20000 - cfg.MIN_FEE - 10000);
    assert.equal(chain.state.bank.treasury, fee);

    const listing = chain.state.listings[listingId];
    assert.equal(listing.status, "sold");
    assert.equal(listing.buyer, buyer.address);
    // The items are reserved for the buyer the instant the block lands.
    assert.equal(chain.state.inventories[inventoryId].owner, buyer.address);
});

test("a buyer can pull purchased items down on any server", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const buyer = Wallet.create();

    const { inventoryId, listingId } = await listItems(chain, miner, FAUCET, 5000);
    await fund(chain, miner, buyer, 20000);
    await submitAndMine(chain, miner.address, tx(chain, buyer, TxType.BUY_LISTING, { listingId }));

    // Deposited under the seller's uuid, withdrawn under the buyer's.
    const withdraw = tx(chain, buyer, TxType.WITHDRAW_INVENTORY, { inventoryId, uuid: UUID_A });
    await submitAndMine(chain, miner.address, withdraw);

    const receipt = chain.getReceipt(withdraw.hash);
    assert.deepEqual(receipt.items, DIAMONDS);
    assert.ok(chain.state.inventories[inventoryId].claimed);
});

test("the seller cannot withdraw items they have listed", async () => {
    const chain = newChain();
    const miner = Wallet.create();

    const { inventoryId } = await listItems(chain, miner, FAUCET, 5000);

    const yank = tx(chain, FAUCET, TxType.WITHDRAW_INVENTORY, { inventoryId, uuid: UUID_B });
    chain.submitTransaction(yank);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === yank.hash), "listed items were withdrawn");
    assert.ok(!chain.state.inventories[inventoryId].claimed);
});

test("a listing cannot be bought twice", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const buyer = Wallet.create();
    const latecomer = Wallet.create();

    const { listingId } = await listItems(chain, miner, FAUCET, 5000);
    await fund(chain, miner, buyer, 20000);
    await fund(chain, miner, latecomer, 20000);
    await submitAndMine(chain, miner.address, tx(chain, buyer, TxType.BUY_LISTING, { listingId }));

    const late = tx(chain, latecomer, TxType.BUY_LISTING, { listingId });
    chain.submitTransaction(late);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === late.hash), "a sold listing was bought again");
    assert.equal(balanceOf(chain, latecomer.address), 20000);
});

test("cancelling a listing releases the items back to the seller", async () => {
    const chain = newChain();
    const miner = Wallet.create();

    const { inventoryId, listingId } = await listItems(chain, miner, FAUCET, 5000);
    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CANCEL_LISTING, { listingId }));

    assert.equal(chain.state.listings[listingId].status, "cancelled");
    assert.equal(chain.state.inventories[inventoryId].listingId, null);

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.WITHDRAW_INVENTORY, {
        inventoryId,
        uuid: UUID_B,
    }));
    assert.ok(chain.state.inventories[inventoryId].claimed);
});

test("listings can be priced in a custom currency", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const buyer = Wallet.create();

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CREATE_CURRENCY, {
        name: "Emerald",
        symbol: "EMR",
        totalSupply: 1000000,
        liquidity: 100000,
    }));

    const { listingId } = await listItems(chain, miner, FAUCET, 1000, { symbol: "EMR" });
    await fund(chain, miner, buyer, 50000);
    await submitAndMine(chain, miner.address, tx(chain, buyer, TxType.BUY, {
        symbol: "EMR",
        amountIn: 20000,
        minOut: 0,
    }));

    const held = tokenOf(chain, buyer.address, "EMR");
    assert.ok(held > 1000, "buyer should hold enough EMR to pay");
    await submitAndMine(chain, miner.address, tx(chain, buyer, TxType.BUY_LISTING, { listingId }));

    assert.equal(tokenOf(chain, buyer.address, "EMR"), held - 1000);
    assert.equal(chain.state.bank.tokens.EMR, Math.floor((1000 * cfg.MARKET_FEE_BPS) / 10000));
});

// ---------------------------------------------------------------------------

suite("servers and land");

/** Register a server owned by the faucet. */
async function registerServer(chain, miner, serverId = "survival") {
    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.REGISTER_SERVER, {
        serverId,
        name: "Survival",
        description: "the main world",
    }));
    return serverId;
}

const CHUNK = { dimension: "overworld", x: 12, z: -40 };

test("claiming a chunk records ownership and pays the bank", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const serverId = await registerServer(chain, miner);

    const before = balanceOf(chain, FAUCET.address);
    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CLAIM_CHUNK, {
        serverId,
        ...CHUNK,
        name: "home base",
    }));

    const key = stateUtil.chunkKey(serverId, CHUNK.dimension, CHUNK.x, CHUNK.z);
    assert.equal(chain.state.chunks[key].owner, FAUCET.address);
    assert.equal(balanceOf(chain, FAUCET.address), before - cfg.CHUNK_CLAIM_PRICE - cfg.MIN_FEE);
    assert.equal(chain.state.bank.treasury, cfg.SERVER_REGISTRATION_PRICE + cfg.CHUNK_CLAIM_PRICE);
    assert.equal(chain.state.servers[serverId].owners[FAUCET.address], 1);
});

test("a chunk cannot be claimed twice", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const squatter = Wallet.create();
    const serverId = await registerServer(chain, miner);

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CLAIM_CHUNK, { serverId, ...CHUNK }));
    await fund(chain, miner, squatter, 20000);

    const grab = tx(chain, squatter, TxType.CLAIM_CHUNK, { serverId, ...CHUNK });
    chain.submitTransaction(grab);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === grab.hash), "an owned chunk was re-claimed");

    const key = stateUtil.chunkKey(serverId, CHUNK.dimension, CHUNK.x, CHUNK.z);
    assert.equal(chain.state.chunks[key].owner, FAUCET.address);
});

test("the same coordinates on two servers are two different chunks", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    await registerServer(chain, miner, "survival");
    await registerServer(chain, miner, "creative");

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CLAIM_CHUNK, {
        serverId: "survival",
        ...CHUNK,
    }));
    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CLAIM_CHUNK, {
        serverId: "creative",
        ...CHUNK,
    }));

    assert.equal(Object.keys(chain.state.chunks).length, 2);
    assert.equal(chain.state.servers.survival.chunkCount, 1);
    assert.equal(chain.state.servers.creative.chunkCount, 1);
});

test("land can be listed and sold between players", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const buyer = Wallet.create();
    const serverId = await registerServer(chain, miner);

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CLAIM_CHUNK, { serverId, ...CHUNK }));
    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.SET_CHUNK_SALE, {
        serverId,
        ...CHUNK,
        price: 8000,
    }));
    await fund(chain, miner, buyer, 20000);

    const sellerBefore = balanceOf(chain, FAUCET.address);
    const treasuryBefore = chain.state.bank.treasury;
    await submitAndMine(chain, miner.address, tx(chain, buyer, TxType.BUY_CHUNK, {
        serverId,
        ...CHUNK,
        maxPrice: 8000,
    }));

    const key = stateUtil.chunkKey(serverId, CHUNK.dimension, CHUNK.x, CHUNK.z);
    const chunk = chain.state.chunks[key];
    const fee = Math.floor((8000 * cfg.LAND_FEE_BPS) / 10000);

    assert.equal(chunk.owner, buyer.address);
    assert.ok(!chunk.forSale, "a sold chunk should not still be listed");
    assert.equal(balanceOf(chain, FAUCET.address), sellerBefore + 8000 - fee);
    assert.equal(chain.state.bank.treasury, treasuryBefore + fee);
    assert.equal(chain.state.servers[serverId].owners[FAUCET.address], undefined);
    assert.equal(chain.state.servers[serverId].owners[buyer.address], 1);
});

test("a buyer is not charged more than their stated maximum", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const buyer = Wallet.create();
    const serverId = await registerServer(chain, miner);

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CLAIM_CHUNK, { serverId, ...CHUNK }));
    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.SET_CHUNK_SALE, {
        serverId,
        ...CHUNK,
        price: 9000,
    }));
    await fund(chain, miner, buyer, 20000);

    const lowball = tx(chain, buyer, TxType.BUY_CHUNK, { serverId, ...CHUNK, maxPrice: 1000 });
    chain.submitTransaction(lowball);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === lowball.hash), "buyer overpaid");
    assert.equal(balanceOf(chain, buyer.address), 20000);
});

test("a chunk that is not for sale cannot be bought", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const buyer = Wallet.create();
    const serverId = await registerServer(chain, miner);

    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CLAIM_CHUNK, { serverId, ...CHUNK }));
    await fund(chain, miner, buyer, 20000);

    const grab = tx(chain, buyer, TxType.BUY_CHUNK, { serverId, ...CHUNK, maxPrice: 999999 });
    chain.submitTransaction(grab);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === grab.hash), "unlisted land was bought");

    const key = stateUtil.chunkKey(serverId, CHUNK.dimension, CHUNK.x, CHUNK.z);
    assert.equal(chain.state.chunks[key].owner, FAUCET.address);
});

test("chunks cannot be claimed on a server nobody registered", async () => {
    const chain = newChain();
    const miner = Wallet.create();

    const orphan = tx(chain, FAUCET, TxType.CLAIM_CHUNK, { serverId: "nowhere", ...CHUNK });
    chain.submitTransaction(orphan);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === orphan.hash), "claimed land on no server");
});

test("a server id cannot be registered twice", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const squatter = Wallet.create();
    await registerServer(chain, miner, "survival");
    await fund(chain, miner, squatter, 20000);

    const dup = tx(chain, squatter, TxType.REGISTER_SERVER, { serverId: "survival", name: "Mine" });
    chain.submitTransaction(dup);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === dup.hash), "a server id was taken twice");
    assert.equal(chain.state.servers.survival.owner, FAUCET.address);
});

// ---------------------------------------------------------------------------

suite("stock market");

/** Float a company owned by the faucet. */
async function float(chain, miner, symbol = "LUMBR", { totalShares = 100000, liquidity = 100000 } = {}) {
    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CREATE_COMPANY, {
        name: "Lumber Co",
        symbol,
        description: "we cut trees",
        totalShares,
        liquidity,
    }));
    return symbol;
}

test("floating a company locks liquidity and grants the founder their share", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const before = balanceOf(chain, FAUCET.address);
    const symbol = await float(chain, miner);

    const company = chain.state.companies[symbol];
    const founderShares = Math.floor((100000 * cfg.FOUNDER_SHARE_BPS) / 10000);

    assert.equal(company.ceo, FAUCET.address);
    assert.equal(company.reserveNative, 100000);
    assert.equal(company.reserveShares, 100000 - founderShares);
    assert.equal(company.holders[FAUCET.address], founderShares);
    assert.equal(balanceOf(chain, FAUCET.address), before - 100000 - cfg.MIN_FEE);
});

test("a ticker cannot be both a currency and a company", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    await float(chain, miner, "LUMBR");

    const clash = tx(chain, FAUCET, TxType.CREATE_CURRENCY, {
        name: "Lumber Token",
        symbol: "LUMBR",
        totalSupply: 1000000,
        liquidity: 10000,
    });
    chain.submitTransaction(clash);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === clash.hash), "a ticker was reused");
});

test("buying shares funds the treasury and moves the price up", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const investor = Wallet.create();
    const symbol = await float(chain, miner);

    await fund(chain, miner, investor, 100000);
    const priceBefore = stateUtil.spotPrice(chain.state.companies[symbol]);

    const buy = tx(chain, investor, TxType.BUY_SHARES, { symbol, amountIn: 20000, minOut: 1 });
    await submitAndMine(chain, miner.address, buy);

    const company = chain.state.companies[symbol];
    const toTreasury = Math.floor((20000 * cfg.COMPANY_TREASURY_BPS) / 10000);

    // Part of the investment reaches the business, the rest deepens the pool.
    assert.equal(company.treasury, toTreasury);
    assert.equal(company.treasuryRaised, toTreasury);
    assert.equal(company.reserveNative, 100000 + 20000 - toTreasury);
    assert.ok(company.holders[investor.address] > 0, "investor holds no shares");
    assert.ok(stateUtil.spotPrice(company) > priceBefore, "price did not rise on a buy");

    const receipt = chain.getReceipt(buy.hash);
    assert.equal(receipt.type, "BUY_SHARES");
    assert.equal(receipt.toTreasury, toTreasury);
});

test("selling shares moves the price back down", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const investor = Wallet.create();
    const symbol = await float(chain, miner);

    await fund(chain, miner, investor, 100000);
    await submitAndMine(chain, miner.address, tx(chain, investor, TxType.BUY_SHARES, {
        symbol,
        amountIn: 20000,
        minOut: 1,
    }));

    const peak = stateUtil.spotPrice(chain.state.companies[symbol]);
    const held = chain.state.companies[symbol].holders[investor.address];

    await submitAndMine(chain, miner.address, tx(chain, investor, TxType.SELL_SHARES, {
        symbol,
        amountIn: held,
        minOut: 1,
    }));

    const company = chain.state.companies[symbol];
    assert.ok(stateUtil.spotPrice(company) < peak, "price did not fall on a sell");
    assert.equal(company.holders[investor.address], undefined);
});

test("slippage protection aborts a share trade that got worse", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const investor = Wallet.create();
    const symbol = await float(chain, miner);
    await fund(chain, miner, investor, 100000);

    const greedy = tx(chain, investor, TxType.BUY_SHARES, {
        symbol,
        amountIn: 10000,
        minOut: 1000000000,
    });
    chain.submitTransaction(greedy);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === greedy.hash), "slippage bound was ignored");
    assert.equal(balanceOf(chain, investor.address), 100000);
});

test("only the CEO can spend the company treasury", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const investor = Wallet.create();
    const worker = Wallet.create();
    const symbol = await float(chain, miner);

    await fund(chain, miner, investor, 100000);
    await submitAndMine(chain, miner.address, tx(chain, investor, TxType.BUY_SHARES, {
        symbol,
        amountIn: 20000,
        minOut: 1,
    }));

    const raid = tx(chain, investor, TxType.COMPANY_PAYOUT, {
        symbol,
        to: investor.address,
        amount: 1000,
        memo: "mine now",
    });
    chain.submitTransaction(raid);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === raid.hash), "a shareholder raided the treasury");

    // The CEO paying a worker, on the other hand, goes through.
    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.COMPANY_PAYOUT, {
        symbol,
        to: worker.address,
        amount: 1000,
        memo: "felling wages",
    }));
    assert.equal(balanceOf(chain, worker.address), 1000);
});

test("a payout cannot exceed the treasury", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const worker = Wallet.create();
    const symbol = await float(chain, miner);

    const overdraw = tx(chain, FAUCET, TxType.COMPANY_PAYOUT, {
        symbol,
        to: worker.address,
        amount: 1000,
    });
    chain.submitTransaction(overdraw);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === overdraw.hash), "an empty treasury paid out");
    assert.equal(balanceOf(chain, worker.address), 0);
});

test("dividends pay shareholders in proportion and never overspend", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const big = Wallet.create();
    const small = Wallet.create();
    const symbol = await float(chain, miner);

    await fund(chain, miner, big, 200000);
    await fund(chain, miner, small, 200000);
    await submitAndMine(chain, miner.address, tx(chain, big, TxType.BUY_SHARES, {
        symbol,
        amountIn: 60000,
        minOut: 1,
    }));
    await submitAndMine(chain, miner.address, tx(chain, small, TxType.BUY_SHARES, {
        symbol,
        amountIn: 10000,
        minOut: 1,
    }));

    const company = chain.state.companies[symbol];
    const treasury = company.treasury;
    const outstanding = company.totalShares - company.reserveShares;
    const bigShares = company.holders[big.address];
    const smallShares = company.holders[small.address];
    assert.ok(bigShares > smallShares, "the larger investor should hold more shares");

    const bigBefore = balanceOf(chain, big.address);
    const smallBefore = balanceOf(chain, small.address);
    const declare = tx(chain, FAUCET, TxType.PAY_DIVIDEND, { symbol, amount: treasury });
    await submitAndMine(chain, miner.address, declare);

    assert.equal(balanceOf(chain, big.address), bigBefore + Math.floor((treasury * bigShares) / outstanding));
    assert.equal(balanceOf(chain, small.address), smallBefore + Math.floor((treasury * smallShares) / outstanding));

    const after = chain.state.companies[symbol];
    const receipt = chain.getReceipt(declare.hash);
    // Rounding dust stays put rather than being conjured out of nothing.
    assert.ok(receipt.distributed <= treasury, "distributed more than was declared");
    assert.equal(after.treasury, treasury - receipt.distributed);
    assert.equal(after.dividendsPaid, receipt.distributed);
});

test("only the CEO can declare a dividend", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const investor = Wallet.create();
    const symbol = await float(chain, miner);

    await fund(chain, miner, investor, 100000);
    await submitAndMine(chain, miner.address, tx(chain, investor, TxType.BUY_SHARES, {
        symbol,
        amountIn: 20000,
        minOut: 1,
    }));

    const forced = tx(chain, investor, TxType.PAY_DIVIDEND, { symbol, amount: 100 });
    chain.submitTransaction(forced);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === forced.hash), "a shareholder forced a dividend");
});

test("shares can be transferred directly between players", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const friend = Wallet.create();
    const symbol = await float(chain, miner);

    const founderShares = chain.state.companies[symbol].holders[FAUCET.address];
    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.TRANSFER_SHARES, {
        symbol,
        to: friend.address,
        amount: 2500,
    }));

    const company = chain.state.companies[symbol];
    assert.equal(company.holders[FAUCET.address], founderShares - 2500);
    assert.equal(company.holders[friend.address], 2500);
    assert.equal(company.holderCount, 2);
    assert.deepEqual(stateUtil.accountView(chain.state, friend.address).shares, { [symbol]: 2500 });
});

test("you cannot sell shares you do not hold", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const chancer = Wallet.create();
    const symbol = await float(chain, miner);
    await fund(chain, miner, chancer, 10000);

    const naked = tx(chain, chancer, TxType.SELL_SHARES, { symbol, amountIn: 500, minOut: 0 });
    chain.submitTransaction(naked);
    const block = await mine(chain, miner.address);
    assert.ok(!block.transactions.some((t) => t.hash === naked.hash), "shares were sold from nothing");
});

// ---------------------------------------------------------------------------

suite("supply");

test("every subsystem conserves supply across a busy chain", async () => {
    const chain = newChain();
    const miner = Wallet.create();
    const player = Wallet.create();
    const allocated = Object.values(chain.genesisConfig.allocations).reduce((a, b) => a + b, 0);

    await fund(chain, miner, player, 500000);
    await registerServer(chain, miner, "survival");
    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CLAIM_CHUNK, {
        serverId: "survival",
        ...CHUNK,
    }));
    await submitAndMine(chain, miner.address, tx(chain, FAUCET, TxType.CREATE_CURRENCY, {
        name: "Emerald",
        symbol: "EMR",
        totalSupply: 1000000,
        liquidity: 50000,
    }));
    await float(chain, miner, "LUMBR");
    await submitAndMine(chain, miner.address, tx(chain, player, TxType.BUY_SHARES, {
        symbol: "LUMBR",
        amountIn: 30000,
        minOut: 1,
    }));
    await submitAndMine(chain, miner.address, tx(chain, player, TxType.BUY, {
        symbol: "EMR",
        amountIn: 10000,
        minOut: 1,
    }));

    const id = await propose(chain, miner, player, 25000);
    await submitAndMine(chain, miner.address, tx(chain, player, TxType.ACCEPT_CONTRACT, { contractId: id }));

    const { listingId } = await listItems(chain, miner, FAUCET, 7000);
    await submitAndMine(chain, miner.address, tx(chain, player, TxType.BUY_LISTING, { listingId }));

    const expected = allocated + chain.height * cfg.BLOCK_REWARD + chain.state.bank.interestPaid;
    assert.equal(
        stateUtil.circulatingSupply(chain.state),
        expected,
        "coin appeared or vanished between the accounts, pools, bank and treasuries"
    );
});

run();
