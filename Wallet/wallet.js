const crypto = require('crypto'); // Import NodeJS's Crypto Module
const EC = require('elliptic').ec;
const ec = new EC('secp256k1');
let k = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eightteen', 'nineteen', 'twenty'];
class wallet { // Our Block Class
    constructor(uuid ,prevHash = "") {
        this.timestamp = Date.now(); // Get the current timestamp
        this.type = 'wallet'; //type of block
        this.data = [{"PLACEHOLDER":0}]; // Store whatever data is relevant 
        this.prevHash = prevHash; // Store the previous block's hash
        this.hash = this.computeHash(); // Compute this block's hash
        this.balance = 10000; //Balance of the gov token
        this.uuid = uuid; //UserId of the Minecraft Player
        this.publicKey = this.genKeyPair().getPublic().encode('hex'); // Getting Public Key
        this.keyWords = this.getWordKeys(); // Getting Keywords
        this.keyHash = this.computekeyWordHash(); // Computing Hash based on keywords
    }
    computeHash() { // Compute this Block's hash
        let strBlock = this.prevHash + this.timestamp + this.balance + JSON.stringify(this.data) // Stringify the block's data
        return crypto.createHash("sha256").update(strBlock).digest("hex") // Hash said string with SHA256 encrpytion
    }
    computeVHash(prevHash, timestamp, data) { // Compute Validy hash
        let Block = prevHash + timestamp + JSON.stringify(data) // Stringify the block's data
        return crypto.createHash("sha256").update(Block).digest("hex") // Hash said string with SHA256 encrpytion
    }
    addChain(chain) {
        this.data = chain;
    }
    genKeyPair() {
        return ec.genKeyPair();
    }
    sign(dataHash) {
        return this.genKeyPair().sign(dataHash);
    }
    getWordKeys() {
        let keys = [];
        for (let i = 0; i <= 6; i++) {
            let randomItem = k[Math.floor(Math.random()*k.length)];
            keys.push(randomItem);
        }
        return keys;
    }
    computekeyWordHash() {
        let keyWords = JSON.stringify(this.keyWords);
        return crypto.createHash('sha256').update(keyWords).digest('hex')
    }
}


module.exports = wallet;