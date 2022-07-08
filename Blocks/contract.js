const crypto = require('crypto'); // Import NodeJS's Crypto Module
class contract {
    constructor(data, contracter, contractee, cost, days, prevHash = ""){
        this.timestamp = Date.now(); 
        this.endTime = this.timestamp + days * 86400000;
        this.type = 'Contract'
        this.prevHash = prevHash;
        this.hash = this.computeHash();
        this.data = data;
        this.running = true;
        this.contracter = contracter;
        this.contractee = contractee;
        this.cost = cost;

    }
    computeHash() { // Compute this Block's hash
        let strBlock = this.prevHash + this.timestamp + this.cost + this.contractee + this.contracter + JSON.stringify(this.data) // Stringify the block's data
        return crypto.createHash("sha256").update(strBlock).digest("hex") // Hash said string with SHA256 encrpytion
    }
}
module.exports = contract;