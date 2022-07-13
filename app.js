//Getting Packages
const express = require("express");
const bodyParser = require("body-parser");
const P2pServer = require('./p2p-server');
const BlockChain = require("./Chains/chain");
const Block = require("./Blocks/data-block");
// const CurInfoBlock = require("./Chains/subChain/curInfoBlock");
// const SubChain = require("./Chains/subChain/subChain");
const wallet = require('./Wallet/wallet');
//Setup
const app = express();

//Use
app.use(bodyParser.json());

// Init our chain
let chain = new BlockChain();

// Init the main chain
let mainChain = new BlockChain();

// Init our P2P server
const p2pServer = new P2pServer(mainChain.blockchain);
p2pServer.listen();

//Adding Current Chain to Main & Validating Chain
mainChain.replaceChain(chain.blockchain);

// Creating a normal block - new Block(DATA))
let a = new Block("Hello");
chain.addNewBlock(a);

//Listen
app.listen(8080, () => {
    console.log('App is running on port 8080')
})

//Routes
app.get("/", (req, res) => {
    chain.calcPrices();
    res.json(chain.blockchain);
})

//Buy Currency
app.post('/buyCur', (req, res) => {
    res.send(chain.buyCur(req.body.publicKey, req.body.cur, req.body.amount));
})

//Sell Currency
app.post('/sellCur', (req, res) => {
    res.send(chain.sellCur(req.body.publicKey, req.body.cur, req.body.amount));
})

//Create Currency
app.post('/createCurrency', (req, res) => {
    res.send(chain.createCurrency(req.body.name, req.body.amount, req.body.abv, req.body.liquid, req.body.owner));
})

//Add balance to an Account
app.post('/addBalance', (req, res) => {
    chain.addBalance(req.body.publicKey, req.body.amount);
    mainChain.replaceChain(chain.blockchain);
    res.sendStatus(200)
})

//Add New transaction
app.post('/newTrans', (req, res) => {
    res.send(chain.newTransaction(req.body.data, req.body.publicKey, req.body.amount, req.body.cur));
})

//Creates Voting
app.post('/newVote', (req, res) => {
    chain.createVote(req.body.statement);
    res.sendStatus(200);
})

//Vote
app.post('/vote', (req, res) => {
    chain.vote(req.body.hash, req.body.vote);
    res.sendStatus(200);
})

//Creates a contract
app.post('/createContract', (req, res) => {
    chain.createContract(req.body.data, req.body.contracter, req.body.contractee, req.body.cost, req.body.days);
    res.sendStatus(200);
});

//Mines Chain and makes the  chain valid
app.post('/mine', (req, res) => {
    chain.mine(req.body.publicKey);
    res.sendStatus(200);
});

//Creates a wallet
app.post('/createWallet', (req, res) => {
    chain.createWallet(req.body.uuid);
    res.sendStatus(200);
})

//Creates a snapshot of the blockchain
app.get("/snapshot", (req, res) => {
    res.send(chain.snapshot());
});

//Uploads the Existing data to the blockchain
app.get("/reload", (req, res) => {
    res.send(chain.reload());
});