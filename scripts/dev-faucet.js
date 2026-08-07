"use strict";

/**
 * The development faucet wallet.
 *
 * Its phrase is hardcoded so every developer's local network starts with the
 * same funded account and the same genesis hash. That also means the key is
 * public: it is for local testing only, and the address must never appear in
 * the allocations of a genesis file you actually run.
 */
const Wallet = require("../src/crypto/wallet");

const DEV_MNEMONIC = [
    "stone",
    "granite",
    "diamond",
    "redstone",
    "obsidian",
    "emerald",
    "gold_ingot",
    "iron_ingot",
    "coal",
    "lapis_lazuli",
    "nether_quartz",
    "netherrack",
];

function devWallet() {
    return Wallet.fromMnemonic(DEV_MNEMONIC);
}

module.exports = { DEV_MNEMONIC, devWallet };

if (require.main === module) {
    const wallet = devWallet();
    console.log(JSON.stringify({ address: wallet.address, publicKey: wallet.publicKey }, null, 2));
}
