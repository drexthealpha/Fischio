use anchor_lang::prelude::*;

pub const MAX_ORDERS: usize = 64; // per side; matches matching::MAX_ORDERS
pub const PRICE_ONE: u64 = 1_000_000; // 1.0 with 6 decimals

pub const BOOK_SEED: &[u8] = b"book";
pub const BASE_VAULT_SEED: &[u8] = b"base_vault";
pub const QUOTE_VAULT_SEED: &[u8] = b"quote_vault";
pub const OPEN_ORDERS_SEED: &[u8] = b"open_orders";
pub const EVENTS_SEED: &[u8] = b"events";
pub const MAX_EVENTS: usize = 128; // ring-buffer capacity; crank before it fills

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Bid, // buy the outcome, escrow quote (USDC)
    Ask, // sell the outcome, escrow base (outcome tokens)
}

/// One resting order in the book. `owner` is the OpenOrders account credited on a fill,
/// not the wallet, so matching never needs a wallet signature.
#[zero_copy]
#[derive(Default)]
pub struct BookOrder {
    pub id: u64,
    pub owner: Pubkey,
    pub price: u64,
    pub size: u64,
    pub seq: u64,
}

/// The order book for one market's outcome, traded against USDC. Bids and asks are kept
/// sorted best-first (bids descending, asks ascending) with time priority on ties. This is
/// a zero-copy account because the two 128-order arrays are large.
#[account(zero_copy)]
#[repr(C)]
pub struct Book {
    pub market: Pubkey,      // the fischio-market Market this book trades (YES outcome)
    pub base_mint: Pubkey,   // the outcome (YES) token
    pub quote_mint: Pubkey,  // USDC collateral
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub bump: u8,
    pub _pad: [u8; 7],
    pub seq: u64,            // monotonic time-priority counter
    pub next_order_id: u64,
    pub bid_count: u64,
    pub ask_count: u64,
    pub bids: [BookOrder; MAX_ORDERS],
    pub asks: [BookOrder; MAX_ORDERS],
}

/// A trader's claimable balances for one book. Tokens sit in the shared vaults; this
/// tracks what each user can withdraw. Matching moves value between these, not tokens.
#[account]
#[derive(InitSpace)]
pub struct OpenOrders {
    pub owner: Pubkey,
    pub book: Pubkey,
    pub base_free: u64,  // withdrawable outcome tokens
    pub quote_free: u64, // withdrawable USDC
    pub bump: u8,
}

/// A deferred maker credit. `place_order` matches and pushes one of these per fill instead
/// of touching the maker's account, so an order can cross any number of makers. A
/// permissionless `consume_events` crank credits them later.
#[zero_copy]
#[derive(Default)]
pub struct FillEvent {
    pub maker: Pubkey,        // the maker's OpenOrders to credit
    pub base_credit: u64,     // outcome tokens owed (taker sold into a bid)
    pub quote_credit: u64,    // USDC owed (taker bought from an ask)
}

/// A FIFO ring buffer of unpaid fills for one book. Matching appends; the crank drains from
/// the head, so makers are paid in the order their orders filled.
#[account(zero_copy)]
#[repr(C)]
pub struct EventHeap {
    pub book: Pubkey,
    pub head: u64,
    pub count: u64,
    pub events: [FillEvent; MAX_EVENTS],
}
