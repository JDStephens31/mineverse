# Mineverse Mod — Build Prompt & Specification

Everything the Minecraft mod needs in order to talk to the Mineverse chain.

The mod lives at <https://github.com/JDStephens31/Mineverse-Blockchain-Java>. This
chain is its only backend. [README.md](README.md) describes the chain itself;
this document describes what the mod must do with it.

**Part 1** is a prompt you can hand to an agent (or a new contributor) to build
the mod. **Part 2** is the specification it refers to: exact payloads, exact
crypto, exact bounds, and the failure modes that will bite.

---

# Part 1 — The prompt

> You are building a Minecraft mod that is the in-world client for the Mineverse
> blockchain. The chain is finished and running; your job is the mod.
>
> Read `prompt.md` Part 2 in full before writing code. It contains the exact
> transaction payloads, the exact signing algorithm, and the validation bounds
> the chain enforces. Getting any of the crypto wrong means the mod cannot sign a
> single valid transaction, so build and test that layer first, against the
> vectors in §2.2.6, before anything else.
>
> **What the mod must do natively**, in the world, without a website:
>
> 1. **Wallets.** Generate, restore from a 12-word phrase, and store a keypair
>    encrypted on the player's own machine. The player's private key must never
>    reach the server or the node.
> 2. **Identity.** Bind a Minecraft UUID to a chain address.
> 3. **Money.** Show balances, send MVC and tokens, create currencies, and swap
>    with a live quote and slippage protection.
> 4. **Item custody.** Deposit items from a player's inventory into the chain and
>    pull them back down on any server on the network.
> 5. **Listing and collecting.** List a deposited inventory for sale, and cancel a
>    listing. Show the player what they have bought and let them pull it into the
>    world. **Do not build a marketplace browser or a buy flow in-game** — buying
>    happens on the website. The mod is the seller's counter and the pickup desk.
> 6. **Land.** Claim the chunk the player is standing in, record it on the chain,
>    and then *enforce* it: block breaking, placing, and interaction by anyone who
>    does not own that chunk. Sell, buy, and gift chunks. Show a map or overlay of
>    what is claimed.
> 7. **Contracts.** Propose, accept, reject, cancel, and settle two-sided
>    contracts, with the player clearly shown that proposing escrows their money
>    immediately.
> 8. **Polls.** Create and vote on proposals scoped to the server.
> 9. **Stocks.** Browse companies, buy and sell shares with a quote, see holdings,
>    and — for a CEO — pay wages from the treasury and declare dividends.
> 10. **Server admin.** Register the server's id on the chain, once, from an
>     operator wallet held in server config.
>
> **Three rules that outrank convenience:**
>
> - **Never block the server thread on the chain.** Every HTTP call goes to a
>   background executor. Chunk-protection checks read a local cache only — a block
>   break must never wait on a network round trip.
> - **The server never holds a player's private key.** Signing happens on the
>   player's client. The server builds an unsigned transaction, ships it to the
>   client, the client recomputes the hash itself, shows the player what they are
>   approving, signs, and returns only the signature. See §2.3.
> - **Items are the mod's responsibility, not the chain's.** The chain records
>   whatever items a deposit claims. Nothing stops a bad server from inventing
>   them. Take items out of the player's inventory into a persisted pending
>   escrow *before* submitting, restore them if the transaction fails, and only
>   hand items over after a withdrawal is confirmed. See §2.5.3.
>
> Build in the order given in §2.10. Do not start on the GUI until wallets, the
> signing layer, and the chunk cache are working and tested.

---

# Part 2 — Specification

## 2.1 Architecture

```
Minecraft client                Minecraft server                 Mineverse node
────────────────                ────────────────                 ──────────────
wallet (encrypted keyfile)      serverId, operator wallet        HTTP API :8080
signs digests    <──packet──>   builds unsigned txs   <──HTTP──> /tx/submit
shows approval UI               submits signed txs               /account, /chunk…
                                chunk ownership cache
                                pending item escrow (on disk)
```

The node is a plain HTTP dependency. It holds no keys and cannot move anyone's
funds; it only validates and gossips. Point the mod at one node, or several for
redundancy — any node on the network answers identically once synced.

| Component | Where it runs | Responsibility |
| --- | --- | --- |
| Wallet + signer | Client | Key storage, mnemonic, secp256k1 signing, approval UI |
| Chain client | Server | HTTP to the node, retries, nonce tracking, tx submission |
| Chunk cache | Server | Ownership lookups for protection; async refresh; disk-backed |
| Item escrow | Server | Items in flight to or from the chain, persisted |
| GUIs / commands | Both | Everything the player touches |

For singleplayer and LAN, the integrated server is the server — the same
client↔server packet round trip applies, so there is one code path, not two.

### 2.1.1 Threading

| Work | Thread |
| --- | --- |
| Any HTTP call | Background executor, never the server tick |
| Chunk protection check | Server tick, cache read only, no I/O |
| Applying a confirmed result (giving items, updating cache) | Hop back to the server thread |
| PBKDF2 key derivation (~120k rounds) | Background thread; it takes hundreds of ms |
| Signing | Client thread off the render loop |

### 2.1.2 Node connection

Config: `nodeUrl` (default `http://127.0.0.1:8080`), optional `apiToken` sent as
the `x-api-token` header on non-GET requests, and a connect/read timeout
(default 5s). If the node is bound to `127.0.0.1` — which is the recommended
default — run it on the same host as the Minecraft server.

---

## 2.2 Chain primitives to reimplement in Java

These must match the chain **byte for byte**. A single ordering or encoding
difference produces a hash the network will not accept.

### 2.2.1 Canonical JSON

Source: [src/util/canonical.js](src/util/canonical.js).

- Object keys sorted with a plain lexicographic sort on the UTF-16 code units,
  recursively.
- Keys whose value is `undefined` (absent) are dropped entirely. A key present
  with value `null` is kept and serializes as `null`.
- No whitespace anywhere.
- Strings JSON-escaped exactly as `JSON.stringify` does.
- Numbers: all chain amounts are integers, so emit them with no decimal point, no
  exponent, and no `-0` (serialize `-0` as `0`).
- Booleans as `true`/`false`; arrays as `[a,b,c]`.

Every amount the chain handles is a safe integer (≤ 2^53−1). Use `long` in Java
and reject anything above `9007199254740991` before signing.

### 2.2.2 Hashing

`sha256(canonicalJson.getBytes(UTF_8))`, output as lowercase hex.

### 2.2.3 Keys and addresses

| Item | Format |
| --- | --- |
| Private key | 32-byte hex, must be in `[1, n-1]` for secp256k1 |
| Public key | Uncompressed SEC1, hex, always starts `04`, 130 chars total |
| Address | `"mv" + sha256(publicKeyBytes).hex[0..40]` → `^mv[0-9a-f]{40}$` |

Note the address hashes the **bytes** the hex decodes to, not the hex string.

### 2.2.4 Signing

The signature covers a subset of the transaction, in this exact shape:

```json
{ "chainId": …, "type": …, "from": …, "nonce": …, "fee": …, "timestamp": …, "payload": {…} }
```

`hash` and `signature` are deliberately excluded. Then:

1. `digest = sha256(canonicalize(signingPayload))` — 32-byte hex.
2. `signature = secp256k1.sign(digest)`, **low-S canonical**, **DER-encoded**, hex.
3. Submit `{ ...signingPayload, hash: digest, signature }`.

BouncyCastle's `ECDSASigner` with `HMacDSAKCalculator` (RFC 6979) produces a
deterministic signature; you must then normalise S to the lower half of the curve
order before DER encoding, or the node's verifier will reject it.

`chainId` is `"mineverse-2"`. `from` is the **public key**, not the address; the
chain derives the address from it.

### 2.2.5 Mnemonic

Source: [src/crypto/mnemonic.js](src/crypto/mnemonic.js). 12 words.

Wordlist — build it identically or the phrases will not restore:

1. Read `JSON/items.json`, take each entry's `name`.
2. `trim().toLowerCase()`, replace runs of whitespace with `_`.
3. Keep only words matching `^[a-z0-9_]+$`.
4. Deduplicate, then sort lexicographically.

Ship this file (or the derived list) inside the mod jar; do not fetch it.

Derivation:

```
seed = PBKDF2-HMAC-SHA512(phrase.join(" "), "mineverse-mnemonic-v1", 120000, 32 bytes)
for i in 0..255:
    candidate = sha256(utf8("mineverse-key-v1") || seed || byte(i))
    if candidate in [1, n-1]: return candidate
```

The salt is a literal ASCII string, and `byte(i)` is a single byte appended.

### 2.2.6 Test vectors to write first

Before any Minecraft code, prove the Java layer against the JavaScript one. Run
`node scripts/wallet.js new` and `node scripts/wallet.js show <priv>` to generate
truth, then assert in Java that:

- A known private key yields the same public key and the same address.
- A known 12-word phrase yields the same private key.
- `canonicalize` of a nested object with keys inserted out of order matches the
  JS output string exactly.
- A transaction built in Java produces the same `hash` as `POST /tx/build` on the
  node for the same `{publicKey, type, payload, nonce, fee, timestamp}`.
- The node accepts a Java-signed transaction at `POST /tx/submit`.

The last two are the ones that matter. Do not proceed until they pass.

---

## 2.3 The signing round trip

The server never sees a private key. Two custom payload packets:

```
S→C  SignRequest  { requestId, unsignedTx (full signing payload), summary }
C→S  SignResponse { requestId, signature }
```

Rules:

- The client **recomputes the digest itself** from `unsignedTx`. It must never
  sign a hash the server handed it — that is the difference between "approve this
  transfer" and "sign this arbitrary thing".
- The client renders `summary` — type, amounts, counterparty, fee — and requires
  an explicit confirm. Optionally allow the player to whitelist low-risk types
  (`REGISTER_UUID`, `CAST_VOTE`) for one session.
- Requests expire after ~60s; the server drops the pending entry and tells the
  player it timed out.
- The server assembles `{...unsignedTx, hash, signature}` and posts it. If the
  node rejects it, surface the node's error string to the player verbatim — they
  are almost always actionable ("insufficient MVC: need 5000, have 120").

Server-owned actions (`REGISTER_SERVER`) use an operator wallet loaded from
server config and need no round trip.

### 2.3.1 Nonces

Nonces are strictly sequential per address and enforced by consensus.

- Read the confirmed nonce from `GET /account/:address/nonce`.
- Track locally: `next = max(confirmed, lastUsed + 1)`.
- The mempool allows at most **16 pending per sender** and a nonce no more than
  **16 ahead** of confirmed. Queue beyond that rather than submitting.
- On any submission error, drop the local counter and re-read. A gap wedges every
  later transaction from that address until the stuck one is evicted (3 failed
  block-inclusion attempts, or 1 hour).
- Serialize submissions per address. Two transactions racing on one nonce means
  one of them silently never confirms.

### 2.3.2 Confirmation

`POST /tx/submit` returning `{accepted: true}` means *accepted into a mempool*,
not confirmed. Poll `GET /tx/:hash` until `status === "confirmed"`; blocks target
5 seconds, so budget 30–60s before calling it a timeout. Receipts (swap outputs,
withdrawn items, dividend totals) are on the confirmed response under `receipt`.

Never apply an in-world effect on submission. Only on confirmation.

---

## 2.4 Transaction catalogue

`chainId` `"mineverse-2"`, `fee` ≥ 1 MVC, `timestamp` in ms and no more than
120s ahead of the node's clock. Amounts are integers in the smallest unit.

Shared formats:

| Field | Rule |
| --- | --- |
| address | `^mv[0-9a-f]{40}$` |
| symbol | `^[A-Z][A-Z0-9]{1,9}$` — one namespace for tokens *and* company tickers |
| hash id | 64 lowercase hex |
| uuid | standard UUID, hyphens optional |
| serverId | `^[a-z0-9][a-z0-9_-]{2,31}$` |
| dimension | `^[a-z0-9][a-z0-9_:.-]{0,31}$` — `minecraft:overworld` fits |
| chunk x/z | integer, `abs(v) ≤ 10000000` |

### Identity and money

| Type | Payload | Notes |
| --- | --- | --- |
| `REGISTER_UUID` | `{uuid}` | One uuid ↔ one address, permanently |
| `TRANSFER` | `{to, amount≥1, symbol}` | `symbol` may be `MVC` or a token; not to self |
| `CREATE_CURRENCY` | `{name≤40, symbol, totalSupply 1..1e12, liquidity≥100}` | Creator keeps 5%, rest seeds the pool; `liquidity` MVC is locked |
| `BUY` | `{symbol, amountIn≥1, minOut≥0}` | MVC → token, 0.30% pool fee |
| `SELL` | `{symbol, amountIn≥1, minOut≥0}` | token → MVC |

### Item custody and listing

| Type | Payload | Notes |
| --- | --- | --- |
| `DEPOSIT_INVENTORY` | `{uuid, items[], serverId?}` | `inventoryId` = the tx hash |
| `WITHDRAW_INVENTORY` | `{inventoryId, uuid}` | Owner-only, succeeds exactly once |
| `LIST_ITEM` | `{inventoryId, price≥1, symbol, note≤140}` | `listingId` = the tx hash |
| `CANCEL_LISTING` | `{listingId}` | Seller only |
| `BUY_LISTING` | `{listingId}` | **Website only — not in the mod** |

`items` is 1..45 entries of `{id ≤64 chars, count 1..64, meta 0..65535, nbt? ≤4096}`.
Send `meta: 0` explicitly on modern versions.

### Land

| Type | Payload | Notes |
| --- | --- | --- |
| `REGISTER_SERVER` | `{serverId, name≤60, description≤500}` | Costs 5000 MVC, once per id |
| `CLAIM_CHUNK` | `{serverId, dimension, x, z, name≤60}` | Costs 500 MVC, must be unowned |
| `SET_CHUNK_SALE` | `{serverId, dimension, x, z, price≥0}` | `price: 0` delists |
| `BUY_CHUNK` | `{serverId, dimension, x, z, maxPrice≥1}` | Fails if the asking price exceeds `maxPrice`; 2.5% to the bank |
| `TRANSFER_CHUNK` | `{serverId, dimension, x, z, to}` | Gift, no payment |

### Contracts

| Type | Payload | Notes |
| --- | --- | --- |
| `CREATE_CONTRACT` | `{contractee, cost≥1, durationMs 10s..365d, data≤1024}` | **Escrows `cost` immediately** |
| `ACCEPT_CONTRACT` | `{contractId}` | Contractee only, within 24h |
| `REJECT_CONTRACT` | `{contractId}` | Contractee only, refunds |
| `CANCEL_CONTRACT` | `{contractId}` | Contracter only, before acceptance |
| `RESOLVE_CONTRACT` | `{contractId}` | Contracter only, settles early |

### Governance

| Type | Payload | Notes |
| --- | --- | --- |
| `CREATE_VOTE` | `{statement≤280, durationMs 10s..30d, serverId?}` | `voteId` = the tx hash |
| `CAST_VOTE` | `{voteId, choice: "yes"\|"no"}` | One vote per address, no changing it |

### Stocks

| Type | Payload | Notes |
| --- | --- | --- |
| `CREATE_COMPANY` | `{name≤60, symbol, description≤500, totalShares 1000..1e12, liquidity≥1000, serverId?}` | Founder keeps 10% |
| `BUY_SHARES` | `{symbol, amountIn≥1, minOut≥0}` | 20% of `amountIn` goes to the company treasury, 80% to the pool |
| `SELL_SHARES` | `{symbol, amountIn≥1, minOut≥0}` | No treasury cut |
| `TRANSFER_SHARES` | `{symbol, to, amount≥1}` | Direct, off-market |
| `COMPANY_PAYOUT` | `{symbol, to, amount≥1, memo≤140}` | CEO only |
| `PAY_DIVIDEND` | `{symbol, amount≥1}` | CEO only, pro rata to holders |

---

## 2.5 Feature specifications

### 2.5.1 F1 — Wallet and identity

Store the key in `.minecraft/mineverse/wallet.json`, encrypted with a passphrase
(AES-GCM, key from PBKDF2 or Argon2). Never log it, never send it, never put it
in a packet.

- **Create**: generate a 12-word phrase, derive, show the phrase **once** with an
  explicit "write this down" gate, require the player to re-enter three random
  words before continuing.
- **Restore**: 12 words in, wallet out. Validate each word against the list and
  name the offending word if one is wrong.
- **Unlock**: prompt for the passphrase on first chain action per session; keep
  the decrypted key in memory only, and wipe it on disconnect.
- **Bind**: `REGISTER_UUID` links the player's MC UUID to their address. Do this
  once on first join with a wallet. Check `GET /uuid/:uuid` first — if the uuid is
  already bound to a *different* address, tell the player and do not retry; that
  binding is permanent and the chain will reject it.

Show address, MVC balance, tokens, and share holdings from
`GET /account/:address`. Cache for a few seconds; refresh on demand.

### 2.5.2 F2 — Money

Transfers, currency creation, and swaps, each behind a confirm screen showing the
fee.

Swaps must quote before signing: `GET /quote/:symbol?side=buy&amountIn=N` returns
`amountOut`. Set `minOut` to that figure minus a player-configurable slippage
tolerance (default 1%). Never submit `minOut: 0` from a UI — that is an
instruction to accept any price at all.

### 2.5.3 F3 — Item custody

This is the most dangerous surface in the mod, because the chain does not verify
that the depositing server actually had the items. **The chain trusts the
depositing server.** Anyone running a modified server can conjure items into
custody and sell them on a network you share. Say so in the mod's documentation,
and make `serverId` on the deposit non-optional in practice so provenance is
recorded.

**Depositing:**

1. Validate the stacks: ≤45 entries, count ≤64, NBT serialized to a string ≤4096
   chars. If an item's NBT is too large, refuse and tell the player which item.
2. Remove the items from the player's inventory into a **persisted pending
   escrow** keyed by the tx hash. Persist before submitting.
3. Submit, then poll.
4. On confirmation: drop the escrow entry, tell the player the `inventoryId`.
5. On failure or timeout: **return the items** and clear the entry.
6. On server restart with entries still pending: re-poll each. Confirmed → drop.
   Permanently rejected → return the items. Still unknown after the mempool
   expiry (1 hour) → return the items.

**Withdrawing:**

1. Check the record is unclaimed and owned by the player (`GET /inventory/:id`).
2. Submit `WITHDRAW_INVENTORY` and poll.
3. On confirmation, read the items from `receipt.items` — that is the
   authoritative list — and add them to a **persisted pending delivery** queue.
4. Give them to the player. If they are offline or their inventory is full, keep
   the queue entry and deliver on next join or on demand. Never drop it: the
   chain has already marked the record claimed and will not do so again.

Reconstructing an ItemStack from `{id, count, meta, nbt}` must tolerate an
unknown item id (a mod removed since the deposit). Surface it to the player as a
recoverable error, keep the delivery queued, do not crash.

### 2.5.4 F4 — Listing and collecting

No marketplace browser in-game. The mod is the seller's counter and the pickup
desk; buying is the website's job.

- **List**: pick a deposited, unclaimed inventory the player owns, set a price and
  a symbol (MVC or any token), optional 140-char note → `LIST_ITEM`.
- **Cancel**: `CANCEL_LISTING` releases the inventory so it can be withdrawn
  again. Include this — without it, a listed inventory can never be taken back.
- **My listings**: `GET /listings?seller=<address>&status=all`.
- **Collect**: `GET /reserved/:address` returns inventories the player owns,
  unclaimed and not currently listed — i.e. everything bought on the website and
  waiting. Show it as a pickup list; each entry withdraws through F3.

A player cannot withdraw an inventory while it is listed. The chain enforces it;
the UI should explain it rather than letting them try and fail.

### 2.5.5 F5 — Land

The headline feature, and the one with the hardest performance constraint.

**Claiming.** `/claim` takes the chunk the player is standing in: `serverId` from
config, `dimension` from the level key, `x = blockX >> 4`, `z = blockZ >> 4`.
Costs 500 MVC. Show the price and require confirmation. Optionally name the claim.

**Enforcement.** Cancel these events when the actor is not the chunk owner:

| Event | Cancel when |
| --- | --- |
| Block break / place | Chunk is owned by someone else |
| Right-click on containers, doors, redstone | Chunk is owned by someone else |
| Bucket fill/empty, fire, TNT ignition | Chunk is owned by someone else |
| Explosion damage to blocks | Chunk is owned by anyone but the detonator |
| PvP / mob griefing | Configurable, default off |

Operators bypass. Support a per-chunk trust list stored **server-side** — the
chain has no concept of trusted players, so this is local data, and the mod
should say so rather than implying it travels between servers.

**The cache.** This is not optional.

- An in-memory map `chunkKey → owner` for the whole server, populated at startup
  from `GET /server/:id/chunks` — one request, not one per chunk.
- Refresh on an interval (default 60s) and immediately after any land
  transaction. Poll `GET /status` for `stateRoot` changes to skip pointless
  refetches.
- Mirror it to disk so a restart during a node outage is not a free-for-all.
- Protection checks read this map only. Never HTTP, never block, never allocate
  per event.
- Unknown chunk = unclaimed = allowed. Do **not** fail closed on a lookup miss;
  a node blip would otherwise stop everyone from building anywhere.

**Trading.** `SET_CHUNK_SALE` to list at a price (0 delists), `BUY_CHUNK` with a
`maxPrice` guard, `TRANSFER_CHUNK` to gift. Always populate `maxPrice` from the
price actually shown to the player, so a price change between reading and signing
fails safe instead of overcharging them.

**Display.** A map screen or minimap overlay reading the cache: owned by you,
owned by others, for sale, unclaimed. `GET /server/:id/chunks` accepts a bounding
box (`minX`/`maxX`/`minZ`/`maxZ`) — use it for the viewport rather than pulling
the whole world. `GET /land/:address` lists a player's holdings across every
server on the network, which is worth surfacing: it is the thing a per-server
land plugin cannot do.

### 2.5.6 F6 — Contracts

The lifecycle is `proposed → active → settled`, with refund paths. Make the money
movement explicit at every step, because it surprises people:

- Proposing **debits the cost immediately**. Say so on the confirm screen: "5,000
  MVC leaves your balance now and is held until this settles."
- The counterparty has 24 hours to accept or the proposal expires and refunds.
- Once accepted, only the contracter can settle early; nobody can cancel.
- On settlement the contractee receives the full agreed cost.

Notify a player on join, and in chat when online, if they have a proposal waiting
(`GET /contracts?address=<addr>&status=proposed`). A proposal nobody notices is a
proposal that expires.

### 2.5.7 F7 — Polls

Create a poll scoped to the server (`serverId` in the payload) and vote yes/no.
List open polls with `GET /votes?serverId=<id>&running=true`. One vote per
address, permanent — warn before submitting. Results settle on block time, so a
poll closes at the same moment for everyone.

### 2.5.8 F8 — Stocks

- **Browse**: `GET /companies` (optionally `?serverId=`) for symbol, name, price,
  treasury, outstanding shares.
- **Detail**: `GET /company/:symbol` adds the top 100 holders.
- **Trade**: quote with `GET /company/:symbol/quote?side=buy&amountIn=N`, then
  `BUY_SHARES` / `SELL_SHARES` with `minOut` from the quote minus tolerance. The
  buy quote already accounts for the 20% treasury cut; show the split, because
  "I paid 1000 and got shares worth 800" needs explaining once.
- **Holdings**: `shares` on `GET /account/:address`.
- **Found**: `CREATE_COMPANY` behind a confirm screen showing the locked
  liquidity and the founder's 10%.
- **Run**: if the player is the CEO, `COMPANY_PAYOUT` to pay a worker (with a
  memo) and `PAY_DIVIDEND` to distribute. Show treasury balance and holder count.

Tickers are shared with currencies: `CREATE_COMPANY` on a symbol that is already
a token fails, and vice versa. Check before submitting and say which it is.

### 2.5.9 F9 — Server administration

`REGISTER_SERVER` from an operator wallet in server config, once, costing 5000
MVC. Everything land-related depends on the server id existing on the chain, so
run this at first boot and refuse to enable land features until
`GET /server/:id` resolves. Log a clear message rather than failing silently.

---

## 2.6 Commands

Suggested surface. Every one of these should also be reachable from a GUI.

| Command | Does |
| --- | --- |
| `/mv wallet create \| restore \| show \| unlock` | Wallet management |
| `/mv balance` | MVC, tokens, shares |
| `/mv pay <address\|player> <amount> [symbol]` | Transfer |
| `/mv swap buy\|sell <symbol> <amount>` | Quote, confirm, swap |
| `/mv deposit [all\|hand]` | Items into custody |
| `/mv withdraw <inventoryId>` | Items back out |
| `/mv pickup` | List and collect purchases (`/reserved`) |
| `/mv list <inventoryId> <price> [symbol]` | Offer for sale |
| `/mv unlist <listingId>` | Cancel a listing |
| `/claim` / `/unclaim` | Claim the current chunk / list it for sale |
| `/mv land sell <price>` / `/mv land buy` / `/mv land give <player>` | Land trading |
| `/mv land list` / `/mv map` | Holdings and map |
| `/mv contract propose <player> <cost> <duration> <text>` | Propose |
| `/mv contract accept\|reject\|cancel\|resolve <id>` | Lifecycle |
| `/mv poll create <duration> <statement>` / `/mv poll vote <id> yes\|no` | Governance |
| `/mv stock list\|info\|buy\|sell` | Trading |
| `/mv company found\|pay\|dividend` | CEO actions |
| `/mv admin register-server` | Operator only |

---

## 2.7 Configuration

**Server** (`config/mineverse-server.toml`):

| Key | Default | Meaning |
| --- | --- | --- |
| `nodeUrl` | `http://127.0.0.1:8080` | Node API |
| `fallbackNodeUrls` | `[]` | Tried in order on failure |
| `apiToken` | none | `x-api-token` header |
| `serverId` | none | Must match a registered server |
| `operatorMnemonic` | none | Server-owned actions; keep out of version control |
| `landProtection` | `true` | Master switch for enforcement |
| `chunkCacheRefreshSeconds` | `60` | Background refresh interval |
| `explosionProtection` / `pvpInClaims` | `true` / `false` | Enforcement toggles |
| `txConfirmTimeoutSeconds` | `60` | When to give up polling |
| `defaultFee` | `1` | MVC per transaction |

**Client** (`config/mineverse-client.toml`): `slippageTolerancePercent` (1),
`requireConfirmationFor` (list of tx types), `walletFile`, `mapOverlayEnabled`.

---

## 2.8 Failure modes to handle explicitly

| Situation | Required behaviour |
| --- | --- |
| Node unreachable | Queue nothing silently. Tell the player. Land protection falls back to the disk cache. |
| Node behind / syncing | `GET /status` height not advancing — warn operators; reads may be stale |
| Transaction accepted then never confirmed | Poll to timeout, then treat as failed: restore escrowed items, reset the nonce |
| Chain reorg drops a confirmed tx | Re-check on the next poll cycle before applying irreversible effects |
| Nonce gap wedges a player | Detect no confirmations for >1 min with pending txs, re-read nonce, resubmit |
| Player's inventory full on withdrawal | Keep the delivery queued and persisted; never void items |
| Item id no longer exists | Keep queued, report to the player, do not crash the join |
| UUID already bound elsewhere | Permanent — explain, do not retry |
| Two players claim the same chunk simultaneously | One transaction fails; refresh the cache and tell the loser |
| Server restart mid-deposit | Replay pending escrow on boot (§2.5.3) |
| `CHAIN_ID` mismatch | Refuse to start the chain integration and log loudly |

---

## 2.9 Acceptance tests

The mod is done when all of these pass:

1. A Java-signed transaction of **every** type in §2.4 is accepted by a live node.
2. A phrase generated by `scripts/wallet.js` restores the same address in Java,
   and vice versa.
3. Items deposited on server A are withdrawn on server B, byte-identical.
4. An item listed in-game, bought via the HTTP API as another address, appears in
   the buyer's `/mv pickup` and lands in their inventory.
5. A listed inventory cannot be withdrawn until the listing is cancelled.
6. A claimed chunk blocks a non-owner from breaking a block, and the check costs
   no HTTP call — verify by killing the node and confirming protection still
   holds from cache.
7. Claiming, selling, and buying a chunk moves ownership and money correctly, and
   `maxPrice` prevents an overcharge when the price changes mid-flow.
8. A contract proposed in-game debits immediately, accepts, and settles.
9. A share purchase splits into pool and treasury as quoted, and the price moves.
10. Killing the node mid-deposit and restarting the server returns the items.
11. 200 players' worth of block events per tick with land protection on shows no
    measurable tick-time regression.

---

## 2.10 Build order

Each step is testable before the next one starts.

1. **Crypto layer** — canonical JSON, sha256, keys, addresses, mnemonic, signing.
   Prove it against §2.2.6. Nothing else works until this does.
2. **HTTP client** — reads, `/tx/build` cross-check, `/tx/submit`, polling,
   nonce tracking, retries.
3. **Client↔server signing round trip** (§2.3) with a throwaway `REGISTER_UUID`.
4. **Wallet UI** — create, restore, unlock, approval screen.
5. **Balances and transfers.**
6. **Item custody** with the persisted escrow, both directions.
7. **Chunk cache and land protection** — cache and enforcement first, claiming
   second.
8. **Land trading and the map.**
9. **Listing and pickup.**
10. **Contracts, polls.**
11. **Stocks.**
12. **Polish** — notifications on join, error strings, docs.

---

## 2.11 Out of scope

- Marketplace browsing and buying — website only (`BUY_LISTING`).
- Company founding flows aimed at investors, leaderboards, cross-server
  dashboards — website only.
- Mining. The mod is a client; it does not produce blocks.
- Any custody of player keys by the server, under any justification.
