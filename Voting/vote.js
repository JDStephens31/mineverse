const crypto = require('crypto'); // Import NodeJS's Crypto Module
class voting {
    constructor(prevHash = ""){
        this.timestamp = Date.now(); 
        this.endTime = this.timestamp + 60000;
        this.prevHash = prevHash;
        this.hash = this.computeHash();
        this.data = [];
        this.running = true;

    }
    computeHash() { // Compute this Block's hash
        let strBlock = this.prevHash + this.timestamp + JSON.stringify(this.data) // Stringify the block's data
        return crypto.createHash("sha256").update(strBlock).digest("hex") // Hash said string with SHA256 encrpytion
    }
}
module.exports = voting;