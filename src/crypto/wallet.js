"use strict";

const keys = require("./keys");
const mnemonic = require("./mnemonic");

/**
 * A wallet is a keypair. It is NOT a block and it holds no balance -- balances
 * live in chain state, keyed by address, and are only reachable with a
 * signature from the matching private key.
 */
class Wallet {
    constructor(privateKey) {
        if (!keys.isValidPrivateKey(privateKey)) throw new Error("invalid private key");
        this.privateKey = privateKey;
        this.publicKey = keys.publicKeyFromPrivate(privateKey);
        this.address = keys.addressFromPublicKey(this.publicKey);
    }

    static create() {
        const phrase = mnemonic.generateMnemonic();
        const wallet = new Wallet(mnemonic.privateKeyFromMnemonic(phrase));
        wallet.mnemonic = phrase;
        return wallet;
    }

    static fromMnemonic(phrase) {
        return new Wallet(mnemonic.privateKeyFromMnemonic(phrase));
    }

    static fromPrivateKey(privateKey) {
        return new Wallet(privateKey);
    }

    sign(digestHex) {
        return keys.sign(this.privateKey, digestHex);
    }

    /** Safe to hand to a client. Never includes the private key. */
    toPublic() {
        return { address: this.address, publicKey: this.publicKey };
    }
}

module.exports = Wallet;
