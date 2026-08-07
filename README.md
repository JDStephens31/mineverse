# Mineverse

Like the metaverse, but in Minecraft.

A peer-to-peer blockchain: signed transactions, proof-of-work, and gossip between
independent nodes. There is no central server — every node validates everything
it is told and keeps its own copy of the chain.

## Quick start

```bash
npm install

# run 3 nodes locally, 2 of them mining
node run-nodes.js --nodes 3 --miners 2 --fresh

# in another terminal
curl http://127.0.0.1:8080/status
curl http://127.0.0.1:8081/status   # same height, same stateRoot
```

Run the tests:

```bash
npm run test:unit      # consensus + security, in process, ~20s
npm run test:network   # 4 real nodes gossiping over WebSockets, ~2min
```

## Features

- [x] Create currencies, each with its own constant-product liquidity pool
- [x] Send any currency to anyone
- [x] Buy and sell any currency, with slippage protection
- [x] A marketplace: list items for any currency, buy them, collect them anywhere
- [x] Two-sided contracts, escrowed on proposal and staked by the bank once accepted
- [x] Chunk ownership recorded across every server on the network
- [x] A stock market: float a company, invest in it, take a dividend
- [x] Vote on proposals, settled deterministically by block time
- [x] Deposit items on one Minecraft server and withdraw them on another
- [x] Snapshot and restore the chain from disk
- [x] Peer-to-peer: gossip, peer discovery, chain sync, and reorgs

## How it works

**Blocks hold transactions. Transactions produce state.**

Balances, currencies, votes, contracts and stored inventories are not written
into blocks. They are derived by replaying every block from genesis through a
deterministic state machine ([src/core/state.js](src/core/state.js)). Two nodes
holding the same blocks compute the same state, byte for byte — `/status`
reports a `stateRoot` you can compare across nodes to confirm it.

**Every action is a signed transaction.** A node holds no private keys and
cannot move anyone's funds. A client signs locally and posts the result; the
signature covers the chain id, the sender, a sequential nonce, the fee and the
payload, so a transaction cannot be altered, replayed, or reused on another
network.

**Consensus is most-cumulative-work.** Blocks need real proof-of-work, the
difficulty retargets toward a 5-second block time, and a node adopts a peer's
chain only when it is fully valid *and* carries strictly more work than its own.

### Transaction types

| Type | What it does |
| --- | --- |
| `TRANSFER` | Send `MVC` or any token to another address |
| `CREATE_CURRENCY` | Mint a token and seed its liquidity pool |
| `BUY` / `SELL` | Swap against a pool, bounded by `minOut` |
| `CREATE_VOTE` / `CAST_VOTE` | Governance; one vote per address, optionally scoped to a server |
| `CREATE_CONTRACT` | Propose a contract and escrow its cost |
| `ACCEPT_CONTRACT` | Contractee confirms; the principal moves into the bank |
| `REJECT_CONTRACT` / `CANCEL_CONTRACT` | Refund an unaccepted proposal |
| `RESOLVE_CONTRACT` | Contracter settles early |
| `DEPOSIT_INVENTORY` | Put items into chain custody |
| `WITHDRAW_INVENTORY` | Take them back out, once, as the owner |
| `REGISTER_UUID` | Bind a Minecraft UUID to an address |
| `LIST_ITEM` | Offer an inventory on the marketplace at a price |
| `CANCEL_LISTING` / `BUY_LISTING` | Pull a listing, or buy it |
| `REGISTER_SERVER` | Claim a server id to hang land off |
| `CLAIM_CHUNK` | Buy an unowned chunk from the protocol |
| `SET_CHUNK_SALE` / `BUY_CHUNK` | List land, or buy it from its owner |
| `TRANSFER_CHUNK` | Hand a chunk over for nothing |
| `CREATE_COMPANY` | Float a business and seed its share pool |
| `BUY_SHARES` / `SELL_SHARES` | Trade stock against the pool, bounded by `minOut` |
| `TRANSFER_SHARES` | Move shares directly between players |
| `COMPANY_PAYOUT` | CEO spends the treasury on tools or wages |
| `PAY_DIVIDEND` | CEO returns treasury to shareholders, pro rata |
| `COINBASE` | Block reward + fees; one per block, block-local |

## Running a node

```bash
node src/node.js --api-port 8080 --p2p-port 6001 --mine \
                 --peers ws://198.51.100.7:6001,ws://198.51.100.8:6001 \
                 --data-dir ./data/mynode \
                 --miner-key <privateKeyHex>
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--api-port` | `8080` | HTTP API port |
| `--api-host` | `127.0.0.1` | Bind address for the API |
| `--p2p-port` | `6001` | WebSocket port for peers |
| `--p2p-host` | `0.0.0.0` | Bind address for P2P |
| `--advertise-host` | `127.0.0.1` | Host other nodes should dial you on |
| `--peers` | none | Comma-separated bootstrap peers |
| `--mine` | off | Mine blocks |
| `--miner-key` / `--miner-mnemonic` / `--miner-address` | ephemeral | Where rewards go |
| `--data-dir` | none | Persist the chain here |
| `--genesis` | `./genesis.json` | Genesis file |
| `--api-token` | none | Require `x-api-token` on non-GET requests |
| `--allow-key-gen` | off | Enable `POST /wallet/new` |

`run-nodes.js` wraps this for local testing: `--nodes N`, `--miners N`,
`--fresh`, `--no-mine`, `--ephemeral`, `--base-api-port`, `--base-p2p-port`.
Node 0 is the bootstrap peer; the rest find each other through peer gossip.

## Wallets

Keys are generated on your machine, never by a node.

```bash
node scripts/wallet.js new                    # address + private key + recovery phrase
node scripts/wallet.js restore "stone granite diamond ..."
node scripts/wallet.js show <privateKeyHex>
```

A wallet is a secp256k1 keypair. The address is `mv` + the first 20 bytes of
`sha256(publicKey)`. The 12-word recovery phrase is drawn from the Minecraft
item table with the OS CSPRNG and stretched through PBKDF2 — it genuinely
restores the same key.

## API

Read endpoints are open; the only endpoint that changes chain state is
`POST /tx/submit`, and it accepts nothing but an already-signed transaction.

| Method | Route | |
| --- | --- | --- |
| GET | `/status` | Height, tip hash, cumulative work, state root, peers |
| GET | `/chain?from=&to=` | Blocks |
| GET | `/block/:hashOrIndex` | One block |
| GET | `/tx/:hash` | Confirmed or pending transaction, plus its receipt |
| GET | `/mempool` | Pending transactions |
| GET | `/account/:address` | Balance, nonce, token holdings |
| GET | `/account/:address/nonce` | Next nonce to sign with |
| GET | `/uuid/:uuid` | Account bound to a Minecraft UUID |
| GET | `/currencies`, `/currency/:symbol` | Tokens and their pools |
| GET | `/quote/:symbol?side=buy&amountIn=N` | Dry-run a swap before signing |
| GET | `/votes?serverId=&running=`, `/vote/:id` | Governance and per-server polls |
| GET | `/contracts?address=&status=`, `/contract/:id` | Contracts |
| GET | `/inventories?address=&uuid=&claimed=`, `/inventory/:id` | Item custody |
| GET | `/listings?status=&seller=&symbol=&serverId=` | Marketplace, items included |
| GET | `/listing/:id` | One listing |
| GET | `/reserved/:address` | Bought and waiting to be collected |
| GET | `/servers`, `/server/:id` | Server registry, its polls and companies |
| GET | `/server/:id/chunks?dimension=&owner=&forSale=&minX=&maxX=&minZ=&maxZ=` | Chunk map |
| GET | `/server/:id/leaderboard` | Landowners, ranked |
| GET | `/chunk/:serverId/:dimension/:x/:z` | One chunk; unclaimed land quotes its price |
| GET | `/land/:address` | Everything an address owns, across servers |
| GET | `/companies?serverId=`, `/company/:symbol` | Stock market |
| GET | `/company/:symbol/quote?side=buy&amountIn=N` | Dry-run a share trade |
| GET | `/bank` | Vault, escrow, treasury, interest paid |
| GET | `/peers` | Connected and known peers |
| POST | `/tx/build` | Returns the exact hash a client must sign |
| POST | `/tx/submit` | Submit a signed transaction |
| POST | `/peers/add` | Dial a peer |
| POST | `/snapshot` | Write the chain to `--data-dir` |
| POST | `/wallet/new` | Dev only, needs `--allow-key-gen` |

### Signing from a client

Use [src/client.js](src/client.js) from Node:

```js
const { MineverseClient, Wallet } = require("./src/client");

const wallet = Wallet.fromMnemonic("stone granite diamond ...".split(" "));
const client = new MineverseClient("http://127.0.0.1:8080", wallet);

const { tx } = await client.transfer("mv<recipient>", 1000);
await client.waitForTx(tx.hash);
```

From the Minecraft mod (or anything else), the flow is:

1. `POST /tx/build` with `{ publicKey, type, payload }` → returns `{ unsigned, hash }`
2. Sign `hash` with secp256k1, DER-encoded hex
3. `POST /tx/submit` with `{ tx: { ...unsigned, hash, signature } }`

### Moving items between servers

```
server A:  DEPOSIT_INVENTORY  { uuid, items }   -> inventoryId = tx hash
server B:  WITHDRAW_INVENTORY { inventoryId, uuid }
```

The withdrawal must be signed by the depositing address, and succeeds exactly
once. The deposit record stays on the chain, marked claimed.

## The marketplace

A listing is not a promise to hand something over later — it is a claim on items
the chain is already holding.

```
seller:  DEPOSIT_INVENTORY { uuid, items }        -> inventoryId
seller:  LIST_ITEM         { inventoryId, price, symbol }
buyer:   BUY_LISTING       { listingId }
buyer:   WITHDRAW_INVENTORY { inventoryId, uuid }  on any server
```

Because the listing escrows the custody record, a seller cannot withdraw what
they have listed and a sale cannot fail to deliver. Ownership passes the instant
the block lands; the withdrawal is just the buyer collecting, and it works on
whichever server they happen to log in to. `GET /reserved/:address` is the list
of things waiting for them.

Listings can be priced in `MVC` or any token. The bank takes
`MARKET_FEE_BPS` out of the seller's proceeds, not on top of the buyer's price.

## Servers and land

Chunk ownership lives on the chain rather than in any one world save, so a deed
survives a server wipe and every server can see who owns what everywhere.

```
REGISTER_SERVER { serverId, name }             once, per server
CLAIM_CHUNK     { serverId, dimension, x, z }  buy virgin land from the protocol
SET_CHUNK_SALE  { ..., price }                 list it; price 0 delists
BUY_CHUNK       { ..., maxPrice }              buy it from its owner
```

A chunk's identity is `serverId/dimension/x,z`, so the same coordinates on two
servers are two different pieces of land. `GET /server/:id/chunks` takes a
bounding box, which is what a map viewport wants; `GET /land/:address` is
everything one player owns, across every server.

## Contracts and the bank

A contract is a two-sided agreement, and it moves through a lifecycle:

```
proposed --accept--> active --resolve/expire--> settled
   |                    ^
   |                    |  principal sits in the bank vault from here,
   |                    |  earning the bank interest over block time
   +--reject/cancel/timeout--> refunded
```

The proposer's coin is debited when the contract is **proposed**, not when it is
accepted. That is what makes "the signer must have enough currency or no
contract can be made" stay true: if the check ran only at proposal time, the
proposer could spend the money before the counterparty accepted, and acceptance
would fail on a contract both sides believed was funded. An accepted contract is
always payable. A proposal nobody answers within `CONTRACT_ACCEPT_WINDOW_MS`
expires and refunds, so funds cannot be locked up by a counterparty who never
replies.

Once accepted, the principal moves into the bank vault and earns
`BANK_INTEREST_APR_BPS` over block time. **That interest is minted**, exactly
like a staking reward: the contractee is always paid the full agreed cost, and
the yield is new supply credited to the bank treasury. `state.bank.interestPaid`
records the lifetime total, so circulating supply stays auditable —
`GET /bank` exposes it, and the test suites assert
`genesis + block rewards + interestPaid` against every coin in existence. Set
`BANK_INTEREST_APR_BPS: 0` for a non-inflationary bank; the treasury still earns
from market fees, land sales and server registrations, which move existing coin
rather than creating it.

Contracts are denominated in `MVC` only. The bank stakes what it holds, and a
token's value is set by a pool the bank does not control.

## The stock market

A company is a business somebody actually runs in the world — a wood operation,
a mob farm, a build crew — with a share pool attached. Shares trade against the
same constant-product curve that prices currencies, so a stock's price moves for
the honest reason: somebody bought or sold and the reserves shifted. There is no
oracle and no scheduled price tick, because neither could be made to agree
across nodes.

What separates a share from a token is where the money goes. `COMPANY_TREASURY_BPS`
of every purchase is routed to the company treasury instead of the pool, so
buying stock funds operations — which the CEO spends with `COMPANY_PAYOUT` and
returns with `PAY_DIVIDEND`. Selling takes no such cut; an investor exiting is
not an investment.

```
CREATE_COMPANY { symbol, name, totalShares, liquidity, serverId? }
BUY_SHARES     { symbol, amountIn, minOut }   -> part to the pool, part to the treasury
COMPANY_PAYOUT { symbol, to, amount, memo }   -> CEO pays a worker
PAY_DIVIDEND   { symbol, amount }             -> pro rata to every holder
```

Tickers are one namespace: a symbol cannot be both a currency and a company.
Dividends walk the holder table, so it is capped at `MAX_COMPANY_HOLDERS` —
without a bound, one transaction could cost every node unbounded work to
validate.

## Starting your own network

`genesis.json` ships with an allocation to a **development faucet whose
recovery phrase is public** (see [scripts/dev-faucet.js](scripts/dev-faucet.js)).
It exists so local test networks start with spendable coins. For a network you
actually care about, generate your own:

```bash
node scripts/wallet.js new                        # keep the private key safe
mv genesis.json genesis.dev.json
node scripts/wallet.js genesis mv<youraddress> 100000000
```

Every node must run the identical `genesis.json`. Nodes reject peers on a
different `chainId` at handshake, and reject chains with a different genesis
hash outright.

The marketplace, land registry, bank and stock market are new consensus rules,
so `CHAIN_ID` is now `mineverse-2`. That is a hard fork by design: a node on
`mineverse-1` will refuse to handshake rather than quietly build an
incompatible chain. Any existing network has to restart from a new genesis —
there is no upgrade path from a chain whose state machine did not know about
these transaction types.

## What changed from v1

The original chain was a single centralized server that stored mutable account
records inside blocks. The rewrite fixes the design problems that made it
unsafe, not just the missing networking:

- **State was stored in blocks and mutated in place.** `addBalance`, `buyCur`
  and `send` assigned directly into `blockchain[i].balance`, which invalidated
  that block's hash and every hash after it. `mine()` then "repaired" the chain
  by recomputing all the hashes, so tampering and mining were the same
  operation. State is now derived from an append-only log and never edited.
- **Nothing was signed.** Any caller could name any `publicKey` and spend from
  it. `wallet.sign()` called `genKeyPair()` again, signing with a key that was
  discarded immediately — the signature could not be verified by anyone. Every
  transaction now carries a real secp256k1 signature over its contents.
- **No nonces, so every request was replayable.** Nonces are now sequential per
  account and enforced by consensus.
- **Votes and contracts resolved with `setTimeout`.** Wall-clock timers cannot
  agree across nodes, and are lost on restart. Both now settle on block
  timestamps during replay, so every node reaches the same result.
- **Every new wallet minted itself 10,000 coins.** Supply now comes only from
  genesis and from block rewards; `test/network.js` asserts that.
- **Pricing was `liquidity / amount` at a fixed price**, so a pool could be
  bought out at a stale price. Swaps now run through a constant-product pool
  with a 0.30% fee and a caller-supplied `minOut`.
- **`sendInventory` spliced a block out of the middle of the chain** and handed
  the items to whoever supplied the UUID. Withdrawal is now a signed
  transaction, checked against the recorded owner, and valid once.
- **`getWordKeys()` read items.json asynchronously and returned before the
  callback ran**, so every wallet's key words were `[]` and every `keyHash` was
  identical. Recovery phrases now work and actually restore the key.
- **P2P was a stub.** `startPTP()` opened a socket.io server on a hardcoded port
  and echoed messages back to the sender; it never dialled a peer or exchanged a
  block. There is now a real gossip layer with peer discovery, block and
  transaction relay, chain sync, reorgs, rate limiting and dedup.
- Assorted crashes: `computeVHash` referenced an undefined `type`, `/addBalance`
  called an undefined `mainChain`, `send()` referenced an undefined `publicKey`,
  and `mine()` passed eight arguments to a seven-parameter function.

The v1 files (`app.js`, `Blocks/`, `Chains/`, `Voting/`, `Wallet/`,
`SNAPSHOT.json`) are superseded by `src/` and can be deleted.

## Layout

```
src/
  core/
    transaction.js  types, payload validation, signing
    block.js        block structure and proof-of-work
    blockchain.js   chain, consensus, mining
    mempool.js      pending transactions
    ledger.js       accounts, balances, the AMM curve
    state.js        the state machine, and dispatch into the domains below
    bank.js         contracts, escrow, staked interest
    market.js       item custody and listings
    land.js         server registry and chunk ownership
    stocks.js       companies, shares, dividends
    config.js       consensus constants
  crypto/      keys, mnemonic, wallet
  net/p2p.js   gossip, peer discovery, sync
  api/         HTTP API
  node.js      node entrypoint
  client.js    signing client
run-nodes.js   local multi-node launcher
scripts/       wallet + genesis CLI
test/          unit and network suites
genesis.json   network definition
```

Every domain module moves value through the same primitives in `ledger.js`, so
there is exactly one implementation of "does this address have enough to pay",
and `state.js` stays a dispatcher rather than growing a thousand-line switch.

## Security notes

- Bind the API to `127.0.0.1` (the default) or put it behind a proxy. Use
  `--api-token` if it must be reachable.
- `--allow-key-gen` makes a node generate and return private keys over HTTP.
  It is off by default; leave it off outside local development.
- Proof-of-work is only as strong as the honest hashrate behind it. On a small
  private network, a participant with the majority of it can reorg the chain.
