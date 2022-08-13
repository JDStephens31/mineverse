const crypto = require('crypto'); // Import NodeJS's Crypto Module
class inventory {
    constructor(data, uuid, prevHash = ""){
        this.timestamp = Date.now(); 
        this.type = 'inventory'
        this.prevHash = prevHash;
        this.hash = this.computeHash();
        this.uuid = uuid;
        this.data = data;
    }
    computeHash() { // Compute this Block's hash
        let strBlock = this.prevHash + this.timestamp + this.cost + this.contractee + this.contracter + JSON.stringify(this.data) // Stringify the block's data
        return crypto.createHash("sha256").update(strBlock).digest("hex") // Hash said string with SHA256 encrpytion
    }
}
module.exports = inventory;