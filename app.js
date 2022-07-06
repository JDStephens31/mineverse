//Getting Packages
const express = require("express");
const bodyParser = require("body-parser");
const P2pServer = require('./p2p-server');
const BlockChain = require("./Chains/chain");
const Block = require("./Blocks/data-block");
const CurInfoBlock = require("./Chains/subChain/curInfoBlock");
const SubChain = require("./Chains/subChain/subChain");
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

//Creating a currency
//Init Chain for the currency
let subChain = new SubChain('Test Chain');
let subTChain = new SubChain('SecondChain');

//Create Currency (details) - new CurInfoBlock(SUB CHAIN, PREV-HASH, AMOUNT, NAME, ABREVIATION, LIQUIDITY)
let curT = new CurInfoBlock(subChain.blockchain, chain.obtainLatestBlock.hash, 1000000000, 'Jon Coin', 'JC', 1000000000)
let curO = new CurInfoBlock(subTChain.blockchain, chain.obtainLatestBlock.hash, 10000000, 'Not Jons Coin', 'NJC', 100000000000)

//Add the currency to the chain
chain.addNewBlock(curT)
chain.addNewBlock(curO)

//Test wallet one
let Wallet = new wallet()
chain.addNewBlock(Wallet)

//Test wallet two
Wallet = new wallet()
console.log(Wallet.publicKey)
chain.addNewBlock(Wallet)


//Sending 10 From Test Acct ONE to Test Acct TWO - send(RECIPIENT, SENDER, AMOUNT, CURRENCY)
// chain.send('0424205e88c269746bd7851d8c94808d83e8a90981b5cf2aec1b0c44d8a8af97c274640f91e3c860da85954155ece21ad317ed777c6cbd0fd5d60596399e1e0391', '0424205e88c269746bd7851d8c94808d83e8a90981b5cf2aec1b0c44d8a8af97c274640f91e3c860da85954155ece21ad317ed777c6cbd0fd5d60596399e1e0390', 1, 'NJC')

//Listen
app.listen(8080, () => {
    console.log('App is running on port 8080')
})

//Routes
app.get("/", (req, res) => {
    chain.calcPrices();
    res.json(chain.blockchain);
})

app.post('/buyCur', (req, res)=>{
    chain.buyCur(req.body.publicKey, req.body.cur, req.body.amount);
    res.sendStatus(200);
})
app.post('/sellCur', (req, res)=>{
    chain.sellCur(req.body.publicKey, req.body.cur, req.body.amount);
    res.sendStatus(200);
})

app.post('/addBalance', (req, res) => {
    chain.addBalance(req.body.publicKey, req.body.amount);
    mainChain.replaceChain(chain.blockchain);
    res.sendStatus(200)
})




// Validating Chain and Replacing old chain if valid
// function validate() {

//     setTimeout(function () {
//         if (chain.blockchain !== mainChain.blockchain) {
//             mainChain.replaceChain(chain.blockchain);
//         }
//         // Again
//         validate();

//         // Every 3 sec
//     }, 10000);
// }

// // Begins
// validate();