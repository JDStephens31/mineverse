"use strict";

/**
 * Wallet and genesis CLI.
 *
 *   node scripts/wallet.js new
 *   node scripts/wallet.js restore "stone granite diamond ..."
 *   node scripts/wallet.js show <privateKeyHex>
 *   node scripts/wallet.js genesis <address> <amount> [outFile]
 *
 * Keys are generated locally and never touch a node.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Wallet = require("../src/crypto/wallet");
const keys = require("../src/crypto/keys");
const cfg = require("../src/core/config");

function printWallet(wallet, { mnemonic = null } = {}) {
    console.log("");
    console.log("  address:     " + wallet.address);
    console.log("  public key:  " + wallet.publicKey);
    console.log("  private key: " + wallet.privateKey);
    if (mnemonic) console.log("  recovery:    " + mnemonic.join(" "));
    console.log("");
    console.log("  Anyone with the private key or recovery phrase controls this account.");
    console.log("  Store them offline. Never paste them into a node or an API call.");
    console.log("");
}

function usage() {
    console.log(`
  usage:
    node scripts/wallet.js new
    node scripts/wallet.js restore "<12 words>"
    node scripts/wallet.js show <privateKeyHex>
    node scripts/wallet.js genesis <address> <amount> [outFile]
`);
}

function main() {
    const [command, ...rest] = process.argv.slice(2);

    switch (command) {
        case "new": {
            const wallet = Wallet.create();
            printWallet(wallet, { mnemonic: wallet.mnemonic });
            break;
        }

        case "restore": {
            const phrase = rest.join(" ").trim();
            if (!phrase) return usage();
            const wallet = Wallet.fromMnemonic(phrase.split(/\s+/));
            printWallet(wallet);
            break;
        }

        case "show": {
            if (!rest[0]) return usage();
            printWallet(Wallet.fromPrivateKey(rest[0].trim()));
            break;
        }

        case "genesis": {
            const [address, amountRaw, outFile] = rest;
            if (!keys.isValidAddress(address)) {
                console.error("  first argument must be a valid address (run `new` to make one)");
                process.exit(1);
            }
            const amount = parseInt(amountRaw, 10);
            if (!Number.isSafeInteger(amount) || amount <= 0) {
                console.error("  second argument must be a positive integer amount");
                process.exit(1);
            }

            const target = path.resolve(outFile || "genesis.json");
            const genesis = {
                chainId: cfg.CHAIN_ID,
                // A fresh timestamp gives a distinct genesis hash, so this network
                // cannot be confused with anyone else's.
                timestamp: Date.now(),
                difficulty: cfg.INITIAL_DIFFICULTY,
                message: "mineverse genesis " + crypto.randomBytes(8).toString("hex"),
                allocations: { [address]: amount },
            };

            if (fs.existsSync(target)) {
                console.error(`  ${target} already exists -- move it aside first`);
                process.exit(1);
            }
            fs.writeFileSync(target, JSON.stringify(genesis, null, 2) + "\n");
            console.log(`\n  wrote ${target}`);
            console.log("  Every node on this network must use this exact file.\n");
            break;
        }

        default:
            usage();
    }
}

main();
