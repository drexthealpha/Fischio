//! fischio-exchange: a fully on-chain, permissionless central limit order book for the
//! conditional (YES/NO) tokens of a fischio prediction market.
//!
//! No operator, no off-chain matching, no relayer. Orders rest in an on-chain book;
//! matching runs on-chain in `place_order`; anyone can trade. Tokens live in shared vaults
//! and matching only moves value between traders' claimable balances, so a single order can
//! cross many makers without a token transfer per fill.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub mod matching;
pub mod state;

use matching::{insert_resting, match_incoming, Level};
use state::*;

declare_id!("7PtxtGEGwBsSNRcRDsP4pedkQkzpGLZNv92Ndc9WwgrE");

// The pure matching engine keeps its own Side (no Anchor deps); convert at the boundary.
impl From<Side> for matching::Side {
    fn from(s: Side) -> Self {
        match s {
            Side::Bid => matching::Side::Bid,
            Side::Ask => matching::Side::Ask,
        }
    }
}

#[program]
pub mod fischio_exchange {
    use super::*;

    /// Open the order book for a market's outcome token, with its base (YES) and quote
    /// (USDC) vaults. Permissionless: anyone can list a market for trading.
    pub fn create_book(ctx: Context<CreateBook>, market: Pubkey) -> Result<()> {
        let mut book = ctx.accounts.book.load_init()?;
        book.market = market;
        book.base_mint = ctx.accounts.base_mint.key();
        book.quote_mint = ctx.accounts.quote_mint.key();
        book.base_vault = ctx.accounts.base_vault.key();
        book.quote_vault = ctx.accounts.quote_vault.key();
        book.bump = ctx.bumps.book;
        book.seq = 0;
        book.next_order_id = 1;
        book.bid_count = 0;
        book.ask_count = 0;
        Ok(())
    }

    /// Create a trader's claimable-balance account for a book.
    pub fn init_open_orders(ctx: Context<InitOpenOrders>) -> Result<()> {
        let oo = &mut ctx.accounts.open_orders;
        oo.owner = ctx.accounts.owner.key();
        oo.book = ctx.accounts.book.key();
        oo.base_free = 0;
        oo.quote_free = 0;
        oo.bump = ctx.bumps.open_orders;
        Ok(())
    }

    /// Move tokens from the wallet into claimable balances. Deposit base (YES) to sell, or
    /// quote (USDC) to buy.
    pub fn deposit(ctx: Context<Deposit>, base_amount: u64, quote_amount: u64) -> Result<()> {
        require!(base_amount > 0 || quote_amount > 0, ExchangeError::ZeroAmount);
        if base_amount > 0 {
            token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer {
                from: ctx.accounts.user_base.to_account_info(),
                to: ctx.accounts.base_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            }), base_amount)?;
            ctx.accounts.open_orders.base_free += base_amount;
        }
        if quote_amount > 0 {
            token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer {
                from: ctx.accounts.user_quote.to_account_info(),
                to: ctx.accounts.quote_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            }), quote_amount)?;
            ctx.accounts.open_orders.quote_free += quote_amount;
        }
        Ok(())
    }

    /// Withdraw claimable balances back to the wallet.
    pub fn withdraw(ctx: Context<Deposit>, base_amount: u64, quote_amount: u64) -> Result<()> {
        let oo = &mut ctx.accounts.open_orders;
        require!(base_amount <= oo.base_free && quote_amount <= oo.quote_free, ExchangeError::InsufficientBalance);
        oo.base_free -= base_amount;
        oo.quote_free -= quote_amount;

        // the book PDA (the vault authority) is seeded by its market key, not its own key
        let (market, bump) = {
            let b = ctx.accounts.book.load()?;
            (b.market, b.bump)
        };
        let seeds: &[&[u8]] = &[BOOK_SEED, market.as_ref(), &[bump]];
        let signer = &[seeds];
        if base_amount > 0 {
            token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
                from: ctx.accounts.base_vault.to_account_info(), to: ctx.accounts.user_base.to_account_info(),
                authority: ctx.accounts.book.to_account_info(),
            }, signer), base_amount)?;
        }
        if quote_amount > 0 {
            token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
                from: ctx.accounts.quote_vault.to_account_info(), to: ctx.accounts.user_quote.to_account_info(),
                authority: ctx.accounts.book.to_account_info(),
            }, signer), quote_amount)?;
        }
        Ok(())
    }

    /// Place a limit order. It escrows from your claimable balance, matches against the
    /// opposite side on-chain at each maker's price, credits you inline, and records each
    /// maker's credit as an event for the crank to pay out. The remainder rests on the book.
    /// No maker accounts are needed, so one order can cross the whole book.
    pub fn place_order(ctx: Context<PlaceOrder>, side: Side, price: u64, size: u64) -> Result<()> {
        require!(size > 0, ExchangeError::ZeroAmount);
        require!(price > 0 && price <= PRICE_ONE, ExchangeError::BadPrice);

        let mut book = ctx.accounts.book.load_mut()?;
        let mut heap = ctx.accounts.event_heap.load_mut()?;
        let taker_oo_key = ctx.accounts.open_orders.key();

        // escrow the maximum this order can cost, out of the taker's free balance
        {
            let oo = &mut ctx.accounts.open_orders;
            match side {
                Side::Bid => {
                    let cost = (price as u128 * size as u128) / PRICE_ONE as u128;
                    let cost = u64::try_from(cost).map_err(|_| ExchangeError::MathOverflow)?;
                    require!(oo.quote_free >= cost, ExchangeError::InsufficientBalance);
                    oo.quote_free -= cost;
                }
                Side::Ask => {
                    require!(oo.base_free >= size, ExchangeError::InsufficientBalance);
                    oo.base_free -= size;
                }
            }
        }

        // build the opposite side as a match view, sorted best-first already
        let (opp, opp_count) = match side {
            Side::Bid => (&book.asks, book.ask_count as usize),
            Side::Ask => (&book.bids, book.bid_count as usize),
        };
        let mut levels: Vec<Level> = (0..opp_count)
            .map(|i| Level { id: opp[i].id, price: opp[i].price, size: opp[i].size, seq: opp[i].seq })
            .collect();
        let (fills, rest) = match_incoming(&mut levels, side.into(), price, size);

        // credit the taker inline; record each maker credit as an event for the crank
        let mut taker_base_gain: u64 = 0;
        let mut taker_quote_gain: u64 = 0;
        for f in &fills {
            let maker_owner = find_owner(&book, side, f.maker_id)?;
            require_keys_neq!(maker_owner, taker_oo_key, ExchangeError::SelfTrade);
            let notional = (f.price as u128 * f.size as u128 / PRICE_ONE as u128) as u64;
            match side {
                Side::Bid => {
                    // taker buys shares, pays `notional`; maker (ask) is owed quote
                    taker_base_gain += f.size;
                    let escrowed = (price as u128 * f.size as u128 / PRICE_ONE as u128) as u64;
                    taker_quote_gain += escrowed - notional; // refund the price improvement
                    push_event(&mut heap, maker_owner, 0, notional)?;
                }
                Side::Ask => {
                    // taker sells shares, receives quote; maker (bid) is owed shares
                    taker_quote_gain += notional;
                    push_event(&mut heap, maker_owner, f.size, 0)?;
                }
            }
            reduce_book_order(&mut book, side, f.maker_id, f.size);
        }

        // rest the remainder in the taker's own side
        if rest > 0 {
            let order = BookOrder {
                id: book.next_order_id,
                owner: taker_oo_key,
                price,
                size: rest,
                seq: book.seq,
            };
            book.next_order_id += 1;
            book.seq += 1;
            insert_book_order(&mut book, side, order)?;
        } else if side == Side::Bid {
            // fully filled bid: refund the escrow held for the unfilled part is zero, but
            // any per-fill price improvement was already credited above
        }

        let oo = &mut ctx.accounts.open_orders;
        oo.base_free += taker_base_gain;
        oo.quote_free += taker_quote_gain;
        Ok(())
    }

    /// Cancel one of your resting orders and return its escrow to your claimable balance.
    pub fn cancel_order(ctx: Context<CancelOrder>, side: Side, order_id: u64) -> Result<()> {
        let mut book = ctx.accounts.book.load_mut()?;
        let oo_key = ctx.accounts.open_orders.key();
        let (price, size, owner) = take_book_order(&mut book, side, order_id)?;
        require_keys_eq!(owner, oo_key, ExchangeError::NotYourOrder);
        let oo = &mut ctx.accounts.open_orders;
        match side {
            Side::Bid => oo.quote_free += (price as u128 * size as u128 / PRICE_ONE as u128) as u64,
            Side::Ask => oo.base_free += size,
        }
        Ok(())
    }

    /// Create the event heap for a book (a one-time setup, separate from create_book to keep
    /// each transaction small).
    pub fn init_event_heap(ctx: Context<InitEventHeap>) -> Result<()> {
        let mut h = ctx.accounts.event_heap.load_init()?;
        h.book = ctx.accounts.book.key();
        h.head = 0;
        h.count = 0;
        Ok(())
    }

    /// Permissionless crank: pay out queued maker credits, oldest first. Pass the makers'
    /// OpenOrders in remaining_accounts. Processing stops at the first maker not provided, so
    /// the crank is always safe to call and can be run by anyone, in any batch size.
    pub fn consume_events<'info>(
        ctx: Context<'_, '_, 'info, 'info, ConsumeEvents<'info>>,
        max: u8,
    ) -> Result<()> {
        let mut heap = ctx.accounts.event_heap.load_mut()?;
        let makers = ctx.remaining_accounts;
        let mut processed = 0u8;
        while processed < max && heap.count > 0 {
            let ev = heap.events[heap.head as usize];
            let maker_ai = match makers.iter().find(|a| a.key() == ev.maker) {
                Some(a) => a,
                None => break, // maker not provided; a later crank pays it
            };
            let mut maker_oo: Account<OpenOrders> = Account::try_from(maker_ai)?;
            maker_oo.base_free += ev.base_credit;
            maker_oo.quote_free += ev.quote_credit;
            maker_oo.exit(&crate::ID)?;
            heap.head = (heap.head + 1) % MAX_EVENTS as u64;
            heap.count -= 1;
            processed += 1;
        }
        Ok(())
    }
}

// ---------- book helpers (operate on the zero-copy arrays) ----------

/// Append a maker credit to the event heap (FIFO). Rejects if the heap is full so the
/// caller cranks first; nothing is ever silently dropped.
fn push_event(heap: &mut EventHeap, maker: Pubkey, base_credit: u64, quote_credit: u64) -> Result<()> {
    require!((heap.count as usize) < MAX_EVENTS, ExchangeError::EventHeapFull);
    let slot = ((heap.head + heap.count) % MAX_EVENTS as u64) as usize;
    heap.events[slot] = FillEvent { maker, base_credit, quote_credit };
    heap.count += 1;
    Ok(())
}

fn find_owner(book: &Book, taker_side: Side, id: u64) -> Result<Pubkey> {
    let (arr, count) = match taker_side {
        Side::Bid => (&book.asks, book.ask_count as usize),
        Side::Ask => (&book.bids, book.bid_count as usize),
    };
    for i in 0..count {
        if arr[i].id == id {
            return Ok(arr[i].owner);
        }
    }
    err!(ExchangeError::OrderNotFound)
}

/// Reduce (or remove) a filled maker order on the side opposite the taker.
fn reduce_book_order(book: &mut Book, taker_side: Side, id: u64, filled: u64) {
    let is_ask = taker_side == Side::Bid; // opposite side holds the makers
    let count = if is_ask { book.ask_count as usize } else { book.bid_count as usize };
    let arr = if is_ask { &mut book.asks } else { &mut book.bids };
    let mut idx = None;
    for i in 0..count {
        if arr[i].id == id {
            idx = Some(i);
            break;
        }
    }
    let Some(i) = idx else { return };
    if arr[i].size > filled {
        arr[i].size -= filled;
        return;
    }
    // remove by shifting the tail left (keeps sort order)
    for j in i..count - 1 {
        arr[j] = arr[j + 1];
    }
    arr[count - 1] = BookOrder::default();
    if is_ask {
        book.ask_count -= 1;
    } else {
        book.bid_count -= 1;
    }
}

/// Insert a resting order on the taker's own side, keeping best-first + time priority.
fn insert_book_order(book: &mut Book, side: Side, order: BookOrder) -> Result<()> {
    let count = if side == Side::Bid { book.bid_count as usize } else { book.ask_count as usize };
    require!(count < MAX_ORDERS, ExchangeError::BookFull);
    // reuse the tested matching::insert_resting on a Vec view, then write back
    let arr_ref = if side == Side::Bid { &book.bids } else { &book.asks };
    let mut view: Vec<Level> = (0..count)
        .map(|i| Level { id: arr_ref[i].id, price: arr_ref[i].price, size: arr_ref[i].size, seq: arr_ref[i].seq })
        .collect();
    let ok = insert_resting(&mut view, side.into(), Level { id: order.id, price: order.price, size: order.size, seq: order.seq });
    require!(ok, ExchangeError::BookFull);
    // write the sorted view back, restoring owner from the inserted order or existing arr
    let arr = if side == Side::Bid { &mut book.bids } else { &mut book.asks };
    for (i, lv) in view.iter().enumerate() {
        let owner = if lv.id == order.id { order.owner } else { arr[find_index_by_id(arr, count, lv.id)].owner };
        arr[i] = BookOrder { id: lv.id, owner, price: lv.price, size: lv.size, seq: lv.seq };
    }
    if side == Side::Bid {
        book.bid_count += 1;
    } else {
        book.ask_count += 1;
    }
    Ok(())
}

fn find_index_by_id(arr: &[BookOrder; MAX_ORDERS], count: usize, id: u64) -> usize {
    (0..count).find(|&i| arr[i].id == id).unwrap_or(0)
}

/// Remove an order by id from a side, returning (price, size, owner).
fn take_book_order(book: &mut Book, side: Side, id: u64) -> Result<(u64, u64, Pubkey)> {
    let count = if side == Side::Bid { book.bid_count as usize } else { book.ask_count as usize };
    let arr = if side == Side::Bid { &mut book.bids } else { &mut book.asks };
    let mut idx = None;
    for i in 0..count {
        if arr[i].id == id {
            idx = Some(i);
            break;
        }
    }
    let i = idx.ok_or(ExchangeError::OrderNotFound)?;
    let taken = arr[i];
    for j in i..count - 1 {
        arr[j] = arr[j + 1];
    }
    arr[count - 1] = BookOrder::default();
    if side == Side::Bid {
        book.bid_count -= 1;
    } else {
        book.ask_count -= 1;
    }
    Ok((taken.price, taken.size, taken.owner))
}

// ---------- accounts ----------

#[derive(Accounts)]
#[instruction(market: Pubkey)]
pub struct CreateBook<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(init, payer = creator, space = 8 + std::mem::size_of::<Book>(),
        seeds = [BOOK_SEED, market.as_ref()], bump)]
    pub book: AccountLoader<'info, Book>,
    pub base_mint: Account<'info, Mint>,
    pub quote_mint: Account<'info, Mint>,
    #[account(init, payer = creator, seeds = [BASE_VAULT_SEED, book.key().as_ref()], bump,
        token::mint = base_mint, token::authority = book)]
    pub base_vault: Account<'info, TokenAccount>,
    #[account(init, payer = creator, seeds = [QUOTE_VAULT_SEED, book.key().as_ref()], bump,
        token::mint = quote_mint, token::authority = book)]
    pub quote_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitOpenOrders<'info> {
    /// Pays the rent for the OpenOrders account. Separate from `owner` so an onboarding
    /// sponsor (or the gasless relayer's funder) can cover it, letting a wallet with zero
    /// SOL still join a book: `owner` only signs as the trading authority, and a signature
    /// costs no balance. Pass `owner` here for the ordinary self-funded path.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub owner: Signer<'info>,
    pub book: AccountLoader<'info, Book>,
    #[account(init, payer = payer, space = 8 + OpenOrders::INIT_SPACE,
        seeds = [OPEN_ORDERS_SEED, book.key().as_ref(), owner.key().as_ref()], bump)]
    pub open_orders: Account<'info, OpenOrders>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,
    pub book: AccountLoader<'info, Book>,
    #[account(mut, seeds = [OPEN_ORDERS_SEED, book.key().as_ref(), owner.key().as_ref()], bump = open_orders.bump,
        has_one = owner)]
    pub open_orders: Account<'info, OpenOrders>,
    #[account(mut, seeds = [BASE_VAULT_SEED, book.key().as_ref()], bump)]
    pub base_vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [QUOTE_VAULT_SEED, book.key().as_ref()], bump)]
    pub quote_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_base: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_quote: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub book: AccountLoader<'info, Book>,
    #[account(mut, seeds = [OPEN_ORDERS_SEED, book.key().as_ref(), owner.key().as_ref()], bump = open_orders.bump,
        has_one = owner)]
    pub open_orders: Account<'info, OpenOrders>,
    #[account(mut, seeds = [EVENTS_SEED, book.key().as_ref()], bump)]
    pub event_heap: AccountLoader<'info, EventHeap>,
    // maker credits are pushed to the event_heap and paid by the consume_events crank
}

#[derive(Accounts)]
pub struct InitEventHeap<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    pub book: AccountLoader<'info, Book>,
    #[account(init, payer = creator, space = 8 + std::mem::size_of::<EventHeap>(),
        seeds = [EVENTS_SEED, book.key().as_ref()], bump)]
    pub event_heap: AccountLoader<'info, EventHeap>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ConsumeEvents<'info> {
    pub cranker: Signer<'info>,
    #[account(mut, has_one = book)]
    pub event_heap: AccountLoader<'info, EventHeap>,
    /// CHECK: identity only; the heap's `book` field is bound by has_one above
    pub book: UncheckedAccount<'info>,
    // makers' OpenOrders to credit are passed in remaining_accounts
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub book: AccountLoader<'info, Book>,
    #[account(mut, seeds = [OPEN_ORDERS_SEED, book.key().as_ref(), owner.key().as_ref()], bump = open_orders.bump,
        has_one = owner)]
    pub open_orders: Account<'info, OpenOrders>,
}

#[error_code]
pub enum ExchangeError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Price must be in (0, 1]")]
    BadPrice,
    #[msg("Insufficient claimable balance")]
    InsufficientBalance,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Order crossed more makers than max_fills")]
    TooManyFills,
    #[msg("A crossed maker's OpenOrders account was not provided")]
    MakerAccountMissing,
    #[msg("Order not found in the book")]
    OrderNotFound,
    #[msg("Cannot trade against your own order")]
    SelfTrade,
    #[msg("Not your order")]
    NotYourOrder,
    #[msg("Order book is full")]
    BookFull,
    #[msg("Event heap is full; run the consume_events crank before placing more orders")]
    EventHeapFull,
}
