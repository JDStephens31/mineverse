"use strict";

/**
 * Consensus constants.
 *
 * Every node MUST agree on these values byte-for-byte. Changing one is a hard
 * fork -- bump CHAIN_ID when you do, so old nodes reject the new network
 * instead of silently building an incompatible chain.
 */
module.exports = {
    CHAIN_ID: "mineverse-2",

    /** Ticker of the native coin. Reserved -- no token may use it. */
    NATIVE: "MVC",

    /** All amounts are integers in the smallest unit. */
    MAX_AMOUNT: Number.MAX_SAFE_INTEGER,

    /** Coinbase reward paid to the miner of each block. */
    BLOCK_REWARD: 50,

    /** Transactions below this fee are not relayed or mined. Anti-spam. */
    MIN_FEE: 1,

    /** Proof-of-work: leading zero bits required in the block hash. */
    INITIAL_DIFFICULTY: 16,
    MIN_DIFFICULTY: 8,
    MAX_DIFFICULTY: 32,

    /** Retarget every N blocks toward TARGET_BLOCK_TIME_MS. */
    DIFFICULTY_ADJUST_INTERVAL: 10,
    TARGET_BLOCK_TIME_MS: 5000,

    /** Block body limits. */
    MAX_TXS_PER_BLOCK: 200,
    MAX_BLOCK_BYTES: 512 * 1024,

    /**
     * A block's timestamp may not be more than this far in the future relative
     * to the receiving node's clock. Bounds timestamp manipulation of the
     * difficulty retarget and of vote/contract expiry.
     */
    MAX_FUTURE_DRIFT_MS: 120000,

    /** A block's timestamp must exceed the median of the last N blocks. */
    MEDIAN_TIME_BLOCKS: 11,

    /** Mempool limits. */
    MAX_MEMPOOL_TXS: 5000,
    /** Transactions older than this are dropped from the mempool. */
    TX_EXPIRY_MS: 60 * 60 * 1000,
    /** A transaction whose timestamp is this far ahead of now is rejected. */
    MAX_TX_FUTURE_DRIFT_MS: 120000,

    /** AMM swap fee, in basis points (30 = 0.30%). Accrues to the pool. */
    SWAP_FEE_BPS: 30,

    /** Share of a new currency's supply granted to its creator. */
    CREATOR_SUPPLY_BPS: 500, // 5%

    /** Currency listing rules. */
    MIN_LIQUIDITY: 100,
    MAX_TOKEN_SUPPLY: 1e12,

    /** Governance. */
    MIN_VOTE_DURATION_MS: 10000,
    MAX_VOTE_DURATION_MS: 30 * 24 * 60 * 60 * 1000,

    /** Contracts. */
    MIN_CONTRACT_DURATION_MS: 10000,
    MAX_CONTRACT_DURATION_MS: 365 * 24 * 60 * 60 * 1000,
    /**
     * A proposed contract that the contractee has not accepted within this
     * window expires and refunds the proposer. Without it, funds escrowed at
     * proposal time could be locked forever by a counterparty who never replies.
     */
    CONTRACT_ACCEPT_WINDOW_MS: 24 * 60 * 60 * 1000,

    // -- The bank ----------------------------------------------------------

    /**
     * Interest the bank earns on contract principal it holds, in basis points
     * per year, accrued over block time between acceptance and settlement.
     *
     * This is minted, exactly like a staking reward: the contractee is always
     * paid the full agreed cost, and the yield is new supply credited to the
     * bank treasury. `state.bank.interestPaid` records the lifetime total so
     * circulating supply stays auditable. Set to 0 for a non-inflationary bank.
     */
    BANK_INTEREST_APR_BPS: 500,
    MS_PER_YEAR: 365 * 24 * 60 * 60 * 1000,

    // -- Marketplace -------------------------------------------------------

    /** Cut of every marketplace sale that goes to the bank treasury. */
    MARKET_FEE_BPS: 100,

    // -- Land --------------------------------------------------------------

    /** Cost of registering a server id. Priced to make id squatting pointless. */
    SERVER_REGISTRATION_PRICE: 5000,
    /** Price of claiming an unowned chunk from the protocol. Goes to the bank. */
    CHUNK_CLAIM_PRICE: 500,
    /** Cut of every player-to-player chunk sale that goes to the bank treasury. */
    LAND_FEE_BPS: 250,
    /** Chunk coordinates are bounded well outside any real world border. */
    MAX_CHUNK_COORD: 10000000,
    /** A single address may not hold more than this many chunks per server. */
    MAX_CHUNKS_PER_OWNER: 10000,

    // -- Companies (the stock market) --------------------------------------

    /** Share of a new company's stock granted to its founder. */
    FOUNDER_SHARE_BPS: 1000, // 10%
    /**
     * Share of every primary purchase routed to the company treasury instead of
     * the pool. This is what makes buying stock an *investment*: the money
     * reaches the business, which spends it on tools and wages.
     */
    COMPANY_TREASURY_BPS: 2000, // 20%
    MIN_COMPANY_LIQUIDITY: 1000,
    MIN_COMPANY_SHARES: 1000,
    MAX_COMPANY_SHARES: 1e12,
    /**
     * Dividends iterate the holder table, so the table has to stay bounded or a
     * single transaction could cost every node unbounded work to validate.
     */
    MAX_COMPANY_HOLDERS: 10000,

    /** Inventory blocks (Minecraft item custody). */
    MAX_INVENTORY_SLOTS: 45,
    MAX_STACK_SIZE: 64,

    /** Networking. */
    MAX_WS_MESSAGE_BYTES: 8 * 1024 * 1024,
    MAX_PEERS: 32,
    PEER_RETRY_MS: 5000,
    PING_INTERVAL_MS: 20000,
    /** Sliding-window rate limit per peer connection. */
    PEER_MSG_WINDOW_MS: 10000,
    PEER_MSG_LIMIT: 500,
};
