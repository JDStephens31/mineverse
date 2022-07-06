const Block = require("../Blocks/data-block")
const crypto = require('crypto');
const CurInfoBlock = require("./subChain/curInfoBlock");
const SubChain = require("./subChain/subChain");


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
                    if (balance < amount * currencyP) {
                        console.error("Error: Not Enough Funds")
                    } else if (typeof (this.blockchain[i].data[x][cur]) === 'undefined') {
                        this.blockchain[i].data.push({ [cur]: 0 })
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
                this.blockchain[i].amount -= amount;
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
                this.blockchain[i].amount += amount;
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
                        break;
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
                            break;
                        }
                        return;
                    }
                    for (let x = 0; x < wallet.length; x++) {
                        if (typeof (wallet[x][cur]) == 'number') {
                            wallet[x][cur] += amount;
                        }
                        break;
                    }
                }
            }
        }
    }
    createCurrency(name, amount, abv, liquid, owner) {
        for (let i = 0; i < this.blockchain.length; i++) {
            if (this.blockchain[i].publicKey === owner) {
                if (this.blockchain[i].balance < liquid) {
                    console.error("Error: Not Enough Liquidity");
                    return false;
                } else {
                    this.blockchain[i].balance -= liquid;
                    let subChain = new SubChain(name);
                    let cur = new CurInfoBlock(subChain.blockchain, this.obtainLatestBlock().hash, amount, name, abv, liquid, owner);
                    this.addNewBlock(cur);
                    let fPer = amount * .05;
                    console.log(this.blockchain[i].data)
                    this.blockchain[i].data.push({ [abv]: fPer })
                    console.log('Giving Owner 5% of Supply');
                    for (let x = 0; x < this.blockchain.length; x++) {
                        if (this.blockchain[x].abv == abv) {
                            let fPer = amount * .05;
                            this.blockchain[x].amount -= fPer;
                            console.log("Updating Amount")
                            this.calcPrices();
                        }
                    }
                    return true;
                }
            }

        }
        
    }
}
module.exports = BlockChain;