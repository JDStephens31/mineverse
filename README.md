# Mine-verse
Like the metaverse, but in minecraft.

# Features I'm wanting to add
1) The ability to send items to the chain on a mc server then pull them down on a different server to create a kind of planet feel where they can travel to different "countries" (servers) and buy/sell and use their items accross all servers connected to the chain
2) The ability to buy chunks and have ownership on the chain.
3) The ability to have a type of stock market.

# How to launch chain
1) in terminal type "npm intall"
2) in terminal type "npm run dev"
This will start the chain to see the chain you'll visit http://localhost:8080/

# Routes
*Note names of routes might change so check back here if something breaks*
1) /buyCur - takes three paramaters (PUBLIC KEY, CURRENCY ABREVIATION, AMOUNT OF TOKENS)
2) /sellCur - takes three paramaters (PUBLIC KEY, CURRENCY ABREVIATION, AMOUNT OF TOKENS)
3) /send - takes four paramaters (RECIPIENT, SENDER, AMOUNT OF TOKENS, CURRENCY ABREVIATION)

