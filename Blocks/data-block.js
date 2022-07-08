const crypto = require('crypto'); // Import NodeJS's Crypto Module

class Block { // Our Block Class
    constructor(data, prevHash = "") {
        this.timestamp = Date.now(); // Get the current timestamp
        this.type = 'data'
        this.data = data; // Store whatever data is relevant 
        this.prevHash = prevHash // Store the previous block's hash
        this.hash = this.computeHash() // Compute this block's hash
    }
    computeHash() { // Compute this Block's hash
        let strBlock = this.prevHash + this.timestamp + JSON.stringify(this.data) // Stringify the block's data
        return crypto.createHash("sha256").update(strBlock).digest("hex") // Hash said string with SHA256 encrpytion
    }
    computeVHash(prevHash, timestamp, data) { // Compute this Block's hash
        let Block = prevHash + timestamp + JSON.stringify(data) // Stringify the block's data
        return crypto.createHash("sha256").update(Block).digest("hex") // Hash said string with SHA256 encrpytion
    }

}


module.exports = Block;
