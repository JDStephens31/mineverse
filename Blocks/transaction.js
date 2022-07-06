const crypto = require('crypto'); // Import NodeJS's Crypto Module
class transaction{
    constructor(data, pubKey, amount, cur, prevHash = ""){
        this.timestamp = Date.now();
        this.type = 'transaction';
        this.data = data
        this.prevHash = prevHash;
        this.hash = this.computeHash();
        this.currency = cur;
        this.publicKey = pubKey;
        this.amount = amount;
    }
    computeHash() { // Compute this Block's hash
        let strBlock = this.prevHash + this.timestamp + JSON.stringify(this.data) // Stringify the block's data
        return crypto.createHash("sha256").update(strBlock).digest("hex") // Hash said string with SHA256 encrpytion
    }
}
module.exports = transaction;