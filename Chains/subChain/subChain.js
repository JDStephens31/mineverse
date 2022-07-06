const crypto = require('crypto'); // Import NodeJS's Crypto Module
const Block = require("../../Blocks/data-block")
const CurInfoBlock = require('./curInfoBlock');
const transaction = require('../../Blocks/transaction');

class SubChain { // Our Blockchain Object
    constructor(name) {
        this.blockchain = [this.startGenesisBlock()] // Initialize a new array of blocks, starting with a genesis block
        this.timestamp = Date.now()
        this.name = name;
        this.hash = this.computeChainHash();
    }
    startGenesisBlock() {
        return new transaction("Genisis Transaction", "GenPubKey", 0, 'GEN') // Create an empty block to start
    }
    obtainLatestBlock() {
        return this.blockchain[this.blockchain.length - 1] // Get last block on the chain
    }
    computeChainHash() { // Compute this Block's hash
        let strBlock = this.prevHash + this.timestamp + JSON.stringify(this.name) // Stringify the block's data
        return crypto.createHash("sha256").update(strBlock).digest("hex") // Hash said string with SHA256 encrpytion
    }
    addNewBlock(newBlock) { // Add a new block
        newBlock.prevHash = this.obtainLatestBlock().hash // Set its previous hash to the correct value
        newBlock.hash = newBlock.computeHash() // Recalculate its hash with this new prevHash value
        this.blockchain.push(newBlock) // Add the block to our chain
    }
    isValidChain(blockchain) {
        for (let i = 1; i < blockchain.length; i++) {
            const block = blockchain[i];
            const lastBlock = blockchain[i - 1];

            if (block.prevHash !== lastBlock.hash) {
                console.log('InValid');
                return false;
            }
            if (block.hash !== block.computeVHash(block.prevHash, block.timestamp, block.data)) {
                console.log('InValid');
                return false;
            }
        }
        console.log('Valid');
        return true;
    }
    replaceChain(newChain) {
        if (newChain.length <= this.blockchain.length) {
            console.log("Chain too small");
            return;
        } else if (!this.isValidChain(newChain)) {
            console.log("received chain is not valid")
            return;
        } else {
            console.log("Replacing blockchain with the new chain");
            this.blockchain = newChain;
            return;
        }
    }

}

module.exports = SubChain;