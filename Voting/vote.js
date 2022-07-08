const crypto = require('crypto'); // Import NodeJS's Crypto Module
class voting {
    constructor(data, prevHash = ""){
        this.timestamp = Date.now(); 
        this.type = "vote";
        this.endTime = this.timestamp + 30000;
        this.prevHash = prevHash;
        this.hash = this.computeHash();
        this.data = [data];
        this.running = true;

    }
    computeHash() { // Compute this Block's hash
        let strBlock = this.prevHash + this.timestamp + JSON.stringify(this.data) // Stringify the block's data
        return crypto.createHash("sha256").update(strBlock).digest("hex") // Hash said string with SHA256 encrpytion
    }
}
module.exports = voting;