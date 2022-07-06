const Block = require("../Blocks/data-block")
const crypto = require('crypto');
const { parse } = require("path");



class BlockChain {
    constructor() {
        this.blockchain = [this.startGenesisBlock()]
    }
    startGenesisBlock() {
        return new Block({})
    }
    obtainLatestBlock() {
        return this.blockchain[this.blockchain.length - 1]
    }
    addNewBlock(newBlock) {
        newBlock.prevHash = this.obtainLatestBlock().hash
        newBlock.hash = newBlock.computeHash()
        this.blockchain.push(newBlock)
    }
    addNewSubChain(newChain) {
        newChain.prevHash = this.obtainLatestBlock().hash
        this.blockchain.push(newChain);
    }
    obtainSubChain() {
        for (let i = 1; i < this.blockchain.length; i++) {
            let block = this.blockchain[i];
            console.log(block);
        }
    }
    isValidChain(blockchain) {
        for (let i = 1; i < blockchain.length; i++) {
            let block = blockchain[i];
            let lastBlock = blockchain[i - 1];

            if (block.prevHash !== lastBlock.hash) {
                console.log('InValid');
                return false;
            } else if (block.hash !== this.computeVHash(block.prevHash, block.timestamp, block.data)) {
                console.log('InValid');
                return false;
            }
        }
        console.log('Valid');
        return true;
    }
    computeVHash(prevHash, timestamp, data) {
        let Block = prevHash + timestamp + JSON.stringify(data)
        return crypto.createHash("sha256").update(Block).digest("hex")
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
    calcPrices() {
        for (let i = 0; i < this.blockchain.length; i++) {
            if (this.blockchain[i].data && this.blockchain[i].type === 'cur') {
                this.blockchain[i].price = this.blockchain[i].liquidity / this.blockchain[i].amount;
            }
        }
    }
    addBalance(publicKey, amount) {
        for (let i = 0; i < this.blockchain.length; i++) {
            if (this.blockchain[i].publicKey && this.blockchain[i].publicKey == publicKey) {
                this.blockchain[i].balance = this.blockchain[i].balance + parseInt(amount);
                return;
            }

        }
    }
    // data[i][cur]) === 'undefined'
    //data.push({ [cur]: 0 })
    buyCur(publicKey, cur, amount) {
        let currencyP;
        let currencyL;
        let balance;
        for (let i = 0; i < this.blockchain.length; i++) {
            if (this.blockchain[i].abv === cur) {
                this.calcPrices();
                currencyL = this.blockchain[i].liquidity;
                currencyP = this.blockchain[i].price;
            }
        }
        for (let i = 0; i < this.blockchain.length; i++) {
            if (this.blockchain[i].publicKey === publicKey) {
                balance = this.blockchain[i].balance;
                for (let x = 0; x < this.blockchain[i].data.length; x++) {
                    if (typeof (this.blockchain[i].data[x][cur]) == 'number') {
                        if (balance<amount * currencyP) {
                            console.error("Error: Not Enough Funds")
                        } else if (typeof(this.blockchain[i].data[x][cur]) === 'undefined') {
                            this.blockchain[i].data.push({ [cur]: 0 })
                            console.log(typeof (this.blockchain[i].data[x][cur]))
                            this.bUpdateWCL(currencyL, currencyP, balance, amount, cur, publicKey);
                            console.log('Balance Updated With Data Updating')
                            return true;
                        } else if (typeof (this.blockchain[i].data[x][cur]) == 'number') {
                            this.bUpdateWCL(currencyL, currencyP, balance, amount, cur, publicKey);
                            console.log('Balance Updated Without Updating Data')
                            return true;
                        }
                    }
                }
            }
        }

    }
    bUpdateWCL(liquid, price, balance, amount, cur, publicKey) {
        let priceFAW;
        for (let i = 0; i < this.blockchain.length; i++) {
            if (this.blockchain[i].publicKey === publicKey) {
                priceFAW = price * amount;
                this.blockchain[i].balance = balance - priceFAW;
                for (let x = 0; x < this.blockchain[i].data.length; x++) {
                    if (typeof (this.blockchain[i].data[x][cur]) == 'number') {
                        for (let e = 0; e < amount; e++) {
                            this.blockchain[i].data[x][cur] += 1;
                            this.calcPrices();
                        }
                    }
                }
            }
        }
        for (let i = 0; i < this.blockchain.length; i++) {
            if (this.blockchain[i].abv == cur) {
                this.blockchain[i].liquidity = liquid + priceFAW;
            }
        }
        return "Balance Updated";
    }
    sellCur(publicKey, cur, amount) {
        let currencyP;
        let currencyL;
        for (let i = 0; i < this.blockchain.length; i++) {
            if (this.blockchain[i].abv === cur) {
                this.calcPrices();
                currencyL = this.blockchain[i].liquidity;
                currencyP = this.blockchain[i].price;
            }
        }
        for (let i = 0; i < this.blockchain.length; i++) {
            if (this.blockchain[i].publicKey === publicKey) {
                for (let x = 0; x < this.blockchain[i].data.length; x++) {
                    if (typeof (this.blockchain[i].data[x][cur]) == 'number') {
                        if (this.blockchain[i].data[x][cur] < amount) {
                            console.error("Error: Not Enough Funds")
                        } else if (typeof (this.blockchain[i].data[x][cur]) === 'undefined') {
                            console.error("Error: Not Assosiated with Currency")
                        } else if (typeof (this.blockchain[i].data[x][cur]) == 'number') {
                            this.sUpdateWCL(currencyL, currencyP, amount, cur, publicKey);
                            return 'Balance Updated Without Updating Data';
                        }
                    }
                }
            }
        }

    }
    sUpdateWCL(liquid, price, amount, cur, publicKey) {
        let priceFAW;
         let balance;
        for (let i = 0; i < this.blockchain.length; i++) {
            if (this.blockchain[i].publicKey === publicKey) {
                priceFAW = price * amount;
                balance = this.blockchain[i].balance;
                this.blockchain[i].balance = balance + priceFAW;
                for (let x = 0; x < this.blockchain[i].data.length; x++) {
                    if (typeof (this.blockchain[i].data[x][cur]) == 'number') {
                        for (let e = 0; e < amount; e++) {
                            this.blockchain[i].data[x][cur] -= 1;
                            this.calcPrices();
                        }
                    }
                }
            }
        }
        for (let i = 0; i < this.blockchain.length; i++) {
            if (this.blockchain[i].abv == cur) {
                this.blockchain[i].liquidity = liquid - priceFAW;
            }
        }
        return "Balance Updated";
    }


    send(recipient, sender, amount, cur) {
        if (cur == 'def') {
            for (let i = 0; i < this.blockchain.length; i++) {
                if (this.blockchain[i].publicKey && this.blockchain[i].publicKey == sender) {
                    if (this.blockchain[i].balance < amount) {
                        console.log("Insufficient Funds");
                        return;
                    } else {
                        this.blockchain[i].balance -= amount;
                    }
                }

            }
            for (let i = 0; i < this.blockchain.length; i++) {
                if (this.blockchain[i].publicKey && this.blockchain[i].publicKey == recipient) {
                    this.blockchain[i].balance += amount;
                }

            }
        } else {
            for (let i = 0; i < this.blockchain.length; i++) {
                let wallet;
                if (this.blockchain[i].publicKey && this.blockchain[i].publicKey == sender) {
                    wallet = this.blockchain[i].data;
                    for (let x = 0; x < wallet.length; x++) {
                        if (typeof (wallet[x][cur]) == 'number') {
                            wallet[x][cur] -= amount;
                        }
                    }
                }
            }
            for (let i = 0; i < this.blockchain.length; i++) {
                let wallet;
                if (this.blockchain[i].publicKey && this.blockchain[i].publicKey == recipient) {
                    wallet = this.blockchain[i].data;
                    if (typeof (wallet[i]) === 'undefined') {
                        wallet.push({ [cur]: 0 })
                        for (let x = 0; x < wallet.length; x++) {
                            if (typeof (wallet[x][cur]) == 'number') {
                                wallet[x][cur] += amount;
                            }
                        }
                        return;
                    }
                    for (let x = 0; x < wallet.length; x++) {
                        if (typeof (wallet[x][cur]) == 'number') {
                            wallet[x][cur] += amount;
                        }
                    }
                }
            }
        }
    }
}
module.exports = BlockChain;



//if(balance < currencyP * amount){
//     console.error("Error: Not Enough Funds");
// } else if(typeof(this.blockchain[i].data[][cur]) === 'undefined') {
//     this.blockchain[i].data.push({ [cur]: 0 })
//     console.log(typeof(this.blockchain[i].data[0][cur]))
//     this.bUpdateWCL(currencyL, currencyP, balance, amount, cur, publicKey);
//     return 'Balance Updated With Data Updating';
// } else if(typeof(this.blockchain[i].data[i][cur]) == 'number') {
//     this.bUpdateWCL(currencyL, currencyP, balance, amount, cur, publicKey);
//     return 'Balance Updated Without Updating Data';
// }