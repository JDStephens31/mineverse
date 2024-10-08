const fs = require('fs');
const Block = require("../Blocks/data-block");
const crypto = require('crypto');
const CurInfoBlock = require("./subChain/curInfoBlock");
const wallet = require("../Wallet/wallet")
const transaction = require('../Blocks/transaction');
const contract = require('../Blocks/contract');
const inventoryB = require("../Blocks/inventory");
const SubChain = require("./subChain/subChain");
const vote = require('../Voting/vote');

//Peer to Peer Server Setup
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

class BlockChain {
    constructor() {
        this.blockchain = [this.startGenesisBlock()];
        this.chains = [];
        this.peers = [];
    }
    startGenesisBlock() {
        return new Block({})
    }
    startPTP() {
        io.on('connection', (socket) => {
            socket.on('message', (msg) => {
                io.emit('message', msg);
            });
            this.peers.push(socket.id);
            io.emit('NEW_PEER', "New Peer Connected " + socket.id);
        });
        server.listen(3000, () => {
            console.log('listening on *:3000');
        });
    }
    restart() {
        this.snapshot();
        this.reload();
    }
    reload() {
        let data = fs.readFileSync("./SNAPSHOT.json");
        let chain = JSON.parse(data);
        this.blockchain = chain;
    }
    snapshot() {
        fs.writeFile('./SNAPSHOT.json', JSON.stringify(this.blockchain, null, 2), callback);
        function callback(err) {
            if (err) {
                return false;
            } else {
                return true;
            }
        }
    }
    obtainLatestBlock() {
        return this.blockchain[this.blockchain.length - 1]
    }
    computeHash(data, prevHash, timestamp, contractee, contracter, cost, block) {
        if (block.type === 'contract') {
            let strBlock = prevHash + timestamp + cost + contractee + contracter + JSON.stringify(data) // Stringify the block's data
            return crypto.createHash("sha256").update(strBlock).digest("hex") // Hash said string with SHA256 encrpytion
        } else if (block.type === 'vote' || block.type === 'cur' || block.type === 'data') {
            let strBlock = prevHash + timestamp + JSON.stringify(data) // Stringify the block's data
            return crypto.createHash("sha256").update(strBlock).digest("hex") // Hash said string with SHA256 encrpytion
        } else if (block.type === 'wallet') {
            let strBlock = prevHash + timestamp + JSON.stringify(data) // Stringify the block's data
            return crypto.createHash("sha256").update(strBlock).digest("hex") // Hash said string with SHA256 encrpytion
        }
    }
    addNewBlock(newBlock) {
        newBlock.prevHash = this.obtainLatestBlock().hash
        newBlock.hash = newBlock.computeHash()
        // io.emit('message', newBlock);
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
    verifyChain(chain, pubKey) {
        for (let i = 0; i < this.chains.length; i++) {
            if (this.chains[i].chain === chain) {
                this.chains[i].votes++;
                this.chains[i].wallets.push(pubKey);
                return true;
            }
        }
        this.chains.push({
            chain: chain,
            votes: 1,
            wallets: [pubKey]
        });
        return true;
    }
    replaceChainWithVerified() {
        let max = 0;
        for (let i = 0; i < this.chains.length; i++) {
            if (this.chains[i].votes > max) {
                max = this.chains[i].votes;
            }
        }
        if(this.chains.length > 1) {
            for (let i = 0; i < this.chains.length; i++) {
                if (this.chains[i].votes === max) {
                    let newChain = JSON.parse(this.chains[i].chain);
                    this.replaceChain(newChain);
                    this.chains[i].wallets.forEach(wallet => {
                        console.log("1");
                        console.log(wallet)
                        this.addBalance(wallet, 50);
                    });
                    return JSON.stringify(newChain);
                }
            }
        } else {
            this.replaceChain(this.chains[0].chain);
            this.chains[0].wallets.forEach(wallet => {
                console.log("2");
                console.log(wallet)
                this.addBalance(toString(wallet), 50);
            });
            return JSON.stringify(this.chains[0].chain);
        }
        
    }

    isValidChain(blockchain) {
        for (let i = 1; i < blockchain.length; i++) {
            let block = blockchain[i];
            let lastBlock = blockchain[i - 1];

            if (block.prevHash !== lastBlock.hash) {
                return false;
            } else if (block.hash !== this.computeVHash(block.prevHash, block.timestamp, block.type)) {
                return false;
            }
        }
        return true;
    }
    computeVHash(prevHash, timestamp, data) {
        let Block = prevHash + timestamp + JSON.stringify(type)
        return crypto.createHash("sha256").update(Block).digest("hex")
    }
    replaceChain(newChain) {
        this.blockchain = JSON.parse(newChain);
        return this.blockchain;
    }
    calcPrices() {
        for (let i = 0; i < this.blockchain.length; i++) {
            if (this.blockchain[i].data && this.blockchain[i].type === 'cur') {
                this.blockchain[i].price = this.blockchain[i].liquidity / this.blockchain[i].amount;
            }
        }
    }
    createWallet(uuid) {
        let wal = new wallet(uuid);
        this.addNewBlock(wal);
        return wal;
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
        for (let e = 0; e < this.blockchain.length; e++) {
            if (this.blockchain[e].abv === cur) {
                this.calcPrices();
                currencyL = this.blockchain[e].liquidity;
                currencyP = this.blockchain[e].price;
            }
        }
        for (let i = 0; i < this.blockchain.length; i++) {
            if (this.blockchain[i].publicKey == publicKey) {
                balance = this.blockchain[i].balance;
                if (this.blockchain[i].data.length === 1) {
                    this.blockchain[i].data.push({ [cur]: 0 })
                    this.bUpdateWCL(currencyL, currencyP, balance, amount, cur, publicKey);
                    console.log('Balance Updated With Data Updating');
                    return true;
                } else {
                    for (let x = 1; x < this.blockchain[i].data.length; x++) {
                        console.log("Here")
                        if (balance < amount * currencyP) {
                            console.error("Error: Not Enough Funds")
                            return false;
                        } else if (typeof (this.blockchain[i].data[x][cur]) == 'number') {
                            this.bUpdateWCL(currencyL, currencyP, balance, amount, cur, publicKey);
                            console.log('Balance Updated Without Updating Data')
                            return true;
                        } else {
                            this.blockchain[i].data.push({ [cur]: 0 })
                            console.log(this.blockchain[i].data[x])
                            this.bUpdateWCL(currencyL, currencyP, balance, amount, cur, publicKey);
                            console.log('Balance Updated With Data Updating');
                            return true;
                        }
                    }
                }

            }
        }
        return "Error: Could not find wallet";

    }
    bUpdateWCL(liquid, price, balance, amount, cur, publicKey) {
        let priceFAW;
        for (let i = 0; i < this.blockchain.length; i++) {
            if (this.blockchain[i].publicKey === publicKey) {
                priceFAW = price * amount;
                this.blockchain[i].balance = balance - priceFAW;
                for (let x = 0; x < this.blockchain[i].data.length; x++) {
                    if (typeof (this.blockchain[i].data[x][cur]) == 'number') {
                        this.newTransaction("buy", publicKey, amount, cur);
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
                        this.newTransaction("sell", publicKey, amount, cur);
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
                        this.newTransaction("send", publicKey, amount, cur);
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
    newTransaction(data, pubKey, amount, cur) {
        let trans = new transaction(data, pubKey, amount, cur);
        for (let i = 0; i < this.blockchain.length; i++) {
            if (cur === 'def') {
                this.addNewBlock(trans);
                return true;
            } else if (this.blockchain[i].abv === cur) {
                trans.prevHash = this.blockchain[i].data[this.blockchain[i].data.length - 1].hash;
                this.blockchain[i].data.push(trans);
                return true;
            }

        }
    }
    createVote(statement) {
        let options = {
            "vote": {
                "statement": [statement],
                "Yes": {
                    "votes": 0
                },
                "No": {
                    "votes": 0
                }
            }
        }
        let newVote = new vote(options);
        this.addNewBlock(newVote);
        let endTime = newVote.endTime;
        let hash = newVote.hash;
        let setTime = endTime - Date.now();
        setTimeout(() => {
            this.endVote(hash);
        }, setTime);
    }
    endVote(hash) {
        for (let i = 0; i < this.blockchain.length; i++) {
            if (this.blockchain[i].hash === hash) {
                this.blockchain[i].running = false;
                return (this.blockchain[i].hash);
            }
        }
    }
    vote(hash, vote) {
        for (let i = 0; i < this.blockchain.length; i++) {
            if (this.blockchain[i].hash === hash) {
                if (this.blockchain[i].running === false) {
                    return false;
                } else {
                    if (vote === 0) {
                        for (let i = 0; i < this.blockchain.length; i++) {
                            if (this.blockchain[i].hash === hash) {
                                this.blockchain[i].data[0].vote.Yes.votes += 1;
                                return true;
                            }
                        }
                    } else if (vote === 1) {
                        for (let i = 0; i < this.blockchain.length; i++) {
                            if (this.blockchain[i].hash === hash) {
                                this.blockchain[i].data[0].vote.No.votes += 1;
                                return true;
                            }
                        }
                    } else {
                        console.error("Error: Vote is Invalid");
                        return false;
                    }
                }
            }
        }
    }
    createContract(data, contracter, contractee, cost, days) {
        let newContract = new contract(data, contracter, contractee, cost, days);
        this.addNewBlock(newContract);
        let endTime = newContract.endTime;
        let hash = newContract.hash;
        let setTime = endTime - Date.now();
        setTimeout(() => {
            this.endContract(hash, contracter, contractee, cost);
        }, setTime);
    }
    endContract(hash, contracter, contractee, cost) {
        for (let i = 0; i < this.blockchain.length; i++) {
            if (this.blockchain[i].hash === hash) {
                this.blockchain[i].running = false;
                this.send(contracter, contractee, cost, "def");
                return (this.blockchain[i].hash);
            }
        }
    }
    mine(publicKey) {
        if (this.isValidChain(this.blockchain) === true) {
            console.log("Blockchain is already valid. No mining needed");
            return false;
        } else if (this.isValidChain(this.blockchain) === false) {
            let x;
            for (let i = 1; i < this.blockchain.length; i++) {
                x = i - 1;
                this.blockchain[i].prevHash = this.blockchain[x].hash;
                this.blockchain[i].hash = this.computeHash(this.blockchain[i].data, this.blockchain[i].prevHash, this.blockchain[i].timestamp, this.blockchain[i].contractee, this.blockchain[i].contracter, this.blockchain[i].cost, this.blockchain[i].balance, this.blockchain[i]);
                this.addBalance(publicKey, 100);
                return true;
            }
        }
    }
    recInventory(inventory, uuid) {
        let inv = new inventoryB(inventory, uuid);
        this.addNewBlock(inv);
    }
    sendInventory(uuid) {
        for (let i = 0; i < this.blockchain.length; i++) {
            if (this.blockchain[i].uuid === uuid) {
                let block = this.blockchain[i];
                this.blockchain.splice(this.blockchain.indexOf(block), 1);
                return block.data;
            }
        }
        return false;
    }
    //Get specific block
    getBlock(hash) {
        for (let i = 0; i < this.blockchain.length; i++) {
            if (this.blockchain[i].hash === hash) {
                return this.blockchain[i];
            }
        }
    }
}
module.exports = BlockChain;