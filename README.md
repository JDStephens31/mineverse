# Mine-verse
Like the metaverse, but in minecraft.

# Features
- [x] Ability to Create Currencies
- [x] Ability to send any Currency to someone
- [x] Ablility to buy and sell any currency
- [ ] Java Minecraft mod to connect to the chain via API
- [ ] Ability to send items to the chain on a mc server then pull them down on a different server 
- [ ] Ability to buy chunks and have ownership on the chain
- [ ] Ability to IPO your minecraft business and buy/sell stocks

# How to launch chain
```bash
# install dependencies
$ npm install

# serve with hot reload at localhost:8080
$ npm run dev
```
This will start the chain to see the chain you'll visit http://localhost:8080/ to see the data as JSON

# Routes

```
/buyCur - (PUBLIC KEY, CURRENCY ABREVIATION, AMOUNT OF TOKENS)
/sellCur - (PUBLIC KEY, CURRENCY ABREVIATION, AMOUNT OF TOKENS)
/send - (RECIPIENT, SENDER, AMOUNT OF TOKENS, CURRENCY ABREVIATION)
/createCurrency - (NAME OF CUR, AMOUNT OF TOKENS, CURRRENCY ABREVIATION, LIQUIDITY, OWNER) 
/addBalance - (PUBLIC KEY, AMOUNT)
/newTrans - (DATA, PUBLIC KEY, AMOUNT OF TOKENS, CURRENCY ABV)
```
