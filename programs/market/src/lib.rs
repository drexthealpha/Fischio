//! fischio-market: a proof-settled prediction market for TxLINE World Cup outcomes.
//!
//! Binary YES/NO markets priced by a fixed-product market maker (Gnosis-style). Users
//! hold YES and NO as real SPL tokens in their own wallets and trade them against the
//! maker at a live price. Collateral is USDC. A market resolves by CPI into TxLINE
//! `validate_stat`; the winning token then redeems 1 collateral, the loser 0.
//!
//! Invariant, held at all times: vault collateral == YES supply == NO supply. Every
//! split adds equal collateral, YES, and NO; every merge removes them equally; fees are
//! split into both pools so they never break it. That invariant guarantees every winning
//! share is always redeemable.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

pub mod math;
pub mod state;
pub mod txoracle;

use state::*;

declare_id!("AweLznQDPzt9UXKhon6X8iKgvrd5dX4Ru36ddnuRirKZ");

fn to_u64(x: u128) -> Result<u64> {
    u64::try_from(x).map_err(|_| MarketError::MathOverflow.into())
}

#[program]
pub mod fischio_market {
    use super::*;

    /// Create a binary market on a proposition. Spins up the YES, NO, and LP mints, the
    /// collateral vault, and the two outcome-reserve pools, all owned by the market PDA.
    pub fn create_market(
        ctx: Context<CreateMarket>,
        market_id: u64,
        terms: MarketTerms,
        close_ts: i64,
        expiry_ts: i64,
        fee_bps: u16,
    ) -> Result<()> {
        require!(terms.fixture_id > 0 && terms.stat_a_key > 0, MarketError::InvalidTerms);
        match (terms.stat_b_key, terms.op) {
            (Some(b), Some(_)) => require!(b > 0 && b != terms.stat_a_key, MarketError::InvalidTerms),
            (None, None) => {}
            _ => return err!(MarketError::InvalidTerms), // two-stat needs an op; one-stat forbids it
        }
        require!(fee_bps <= 1_000, MarketError::InvalidTerms); // cap at 10%
        let now = Clock::get()?.unix_timestamp;
        require!(close_ts > now && expiry_ts > close_ts, MarketError::InvalidTerms);

        let m = &mut ctx.accounts.market;
        m.creator = ctx.accounts.creator.key();
        m.market_id = market_id;
        m.terms = terms;
        m.terms_hash = hash(&terms.try_to_vec()?).to_bytes();
        m.collateral_mint = ctx.accounts.collateral_mint.key();
        m.yes_mint = ctx.accounts.yes_mint.key();
        m.no_mint = ctx.accounts.no_mint.key();
        m.lp_mint = ctx.accounts.lp_mint.key();
        m.close_ts = close_ts;
        m.expiry_ts = expiry_ts;
        m.fee_bps = fee_bps;
        m.state = MarketState::Trading;
        m.winning_side = None;
        m.bump = ctx.bumps.market;
        Ok(())
    }

    /// Provide liquidity. Collateral splits into equal YES and NO; the pool keeps each in
    /// proportion to current reserves so the price stays flat, returns the surplus, and
    /// mints LP tokens.
    pub fn add_liquidity(ctx: Context<AddLiquidity>, amount: u64) -> Result<()> {
        {
            let m = &ctx.accounts.market;
            require!(m.state == MarketState::Trading, MarketError::MarketNotTrading);
            require!(Clock::get()?.unix_timestamp < m.close_ts, MarketError::MarketClosed);
        }
        require!(amount > 0, MarketError::ZeroAmount);

        let y = ctx.accounts.yes_pool.amount as u128;
        let n = ctx.accounts.no_pool.amount as u128;
        let lp = ctx.accounts.lp_mint.supply as u128;
        let a = math::calc_add_liquidity(y, n, lp, amount as u128).ok_or(MarketError::MathOverflow)?;

        let a_ = &ctx.accounts;
        let tp = a_.token_program.to_account_info();
        // provider funds the vault
        token::transfer(
            CpiContext::new(tp.clone(), Transfer {
                from: a_.provider_collateral.to_account_info(),
                to: a_.vault.to_account_info(),
                authority: a_.provider.to_account_info(),
            }),
            amount,
        )?;

        let (creator, mid_bytes, bump) = market_key_parts(&ctx.accounts.market);
        let seeds: &[&[u8]] = &[MARKET_SEED, creator.as_ref(), &mid_bytes, &[bump]];
        let signer = &[seeds];
        let market_ai = ctx.accounts.market.to_account_info();

        // split `amount` into `amount` YES + `amount` NO; pool keeps its proportional
        // share, the provider gets the surplus back, plus LP tokens
        mint(&tp, &ctx.accounts.yes_mint, &ctx.accounts.yes_pool, &market_ai, signer, to_u64(a.pool_yes)?)?;
        mint(&tp, &ctx.accounts.yes_mint, &ctx.accounts.provider_yes, &market_ai, signer, to_u64(a.back_yes)?)?;
        mint(&tp, &ctx.accounts.no_mint, &ctx.accounts.no_pool, &market_ai, signer, to_u64(a.pool_no)?)?;
        mint(&tp, &ctx.accounts.no_mint, &ctx.accounts.provider_no, &market_ai, signer, to_u64(a.back_no)?)?;
        mint(&tp, &ctx.accounts.lp_mint, &ctx.accounts.provider_lp, &market_ai, signer, to_u64(a.mint_lp)?)?;
        Ok(())
    }

    /// Buy `collateral_in` worth of one outcome. The fee is routed back into both pools
    /// (earning it for LPs) and does not move the price. Reverts if shares received would
    /// be below `min_shares_out`.
    pub fn buy(ctx: Context<Trade>, collateral_in: u64, side: Side, min_shares_out: u64) -> Result<()> {
        let fee_bps;
        {
            let m = &ctx.accounts.market;
            require!(m.state == MarketState::Trading, MarketError::MarketNotTrading);
            require!(Clock::get()?.unix_timestamp < m.close_ts, MarketError::MarketClosed);
            fee_bps = m.fee_bps;
        }
        require!(collateral_in > 0, MarketError::ZeroAmount);

        let fee = math::fee(collateral_in as u128, fee_bps).ok_or(MarketError::MathOverflow)?;
        let net = (collateral_in as u128) - fee;
        let (r_out, r_other) = reserves_for(&ctx.accounts, side);
        let shares_out = math::calc_buy(r_out, r_other, net).ok_or(MarketError::MathOverflow)?;
        require!(shares_out >= min_shares_out as u128, MarketError::SlippageExceeded);
        let from_pool = shares_out - net; // AMM draw from the bought-side reserve

        let a_ = &ctx.accounts;
        let tp = a_.token_program.to_account_info();
        token::transfer(
            CpiContext::new(tp.clone(), Transfer {
                from: a_.trader_collateral.to_account_info(),
                to: a_.vault.to_account_info(),
                authority: a_.trader.to_account_info(),
            }),
            collateral_in,
        )?;

        let (creator, mid_bytes, bump) = market_key_parts(&a_.market);
        let seeds: &[&[u8]] = &[MARKET_SEED, creator.as_ref(), &mid_bytes, &[bump]];
        let signer = &[seeds];
        let mkt = a_.market.to_account_info();
        let net_u = to_u64(net)?;
        let fee_u = to_u64(fee)?;
        let from_pool_u = to_u64(from_pool)?;

        let (out_mint, out_pool, trader_out, other_mint, other_pool) = match side {
            Side::Yes => (&a_.yes_mint, &a_.yes_pool, &a_.trader_yes, &a_.no_mint, &a_.no_pool),
            Side::No => (&a_.no_mint, &a_.no_pool, &a_.trader_no, &a_.yes_mint, &a_.yes_pool),
        };
        // split net: buyer gets `net` of the bought side, the pool gets `net` of the other
        mint(&tp, out_mint, trader_out, &mkt, signer, net_u)?;
        mint(&tp, other_mint, other_pool, &mkt, signer, net_u)?;
        // AMM draw: move the rest of the buyer's shares out of the bought-side reserve
        token::transfer(
            CpiContext::new_with_signer(tp.clone(), Transfer {
                from: out_pool.to_account_info(),
                to: trader_out.to_account_info(),
                authority: mkt.clone(),
            }, signer),
            from_pool_u,
        )?;
        // fee split into both pools (price-neutral LP reward)
        if fee_u > 0 {
            mint(&tp, out_mint, out_pool, &mkt, signer, fee_u)?;
            mint(&tp, other_mint, other_pool, &mkt, signer, fee_u)?;
        }
        Ok(())
    }

    /// Sell one outcome to receive `collateral_out`. Reverts if it would cost more than
    /// `max_shares_in` shares. Pure FPMM (the buy fee funds LPs).
    pub fn sell(ctx: Context<Trade>, collateral_out: u64, side: Side, max_shares_in: u64) -> Result<()> {
        {
            let m = &ctx.accounts.market;
            require!(m.state == MarketState::Trading, MarketError::MarketNotTrading);
            require!(Clock::get()?.unix_timestamp < m.close_ts, MarketError::MarketClosed);
        }
        require!(collateral_out > 0, MarketError::ZeroAmount);

        let (r_out, r_other) = reserves_for(&ctx.accounts, side);
        let r = collateral_out as u128;
        let shares_in = math::calc_sell(r_out, r_other, r).ok_or(MarketError::InsufficientLiquidity)?;
        require!(shares_in <= max_shares_in as u128, MarketError::SlippageExceeded);
        let shares_in_u = to_u64(shares_in)?;

        let a_ = &ctx.accounts;
        let tp = a_.token_program.to_account_info();
        let (creator, mid_bytes, bump) = market_key_parts(&a_.market);
        let seeds: &[&[u8]] = &[MARKET_SEED, creator.as_ref(), &mid_bytes, &[bump]];
        let signer = &[seeds];
        let mkt = a_.market.to_account_info();

        let (in_pool, trader_in) = match side {
            Side::Yes => (&a_.yes_pool, &a_.trader_yes),
            Side::No => (&a_.no_pool, &a_.trader_no),
        };
        // seller returns shares to the reserve
        token::transfer(
            CpiContext::new(tp.clone(), Transfer {
                from: trader_in.to_account_info(),
                to: in_pool.to_account_info(),
                authority: a_.trader.to_account_info(),
            }),
            shares_in_u,
        )?;
        // merge `r` YES + `r` NO out of the pools, freeing `r` collateral
        token::burn(
            CpiContext::new_with_signer(tp.clone(), Burn {
                mint: a_.yes_mint.to_account_info(),
                from: a_.yes_pool.to_account_info(),
                authority: mkt.clone(),
            }, signer),
            collateral_out,
        )?;
        token::burn(
            CpiContext::new_with_signer(tp.clone(), Burn {
                mint: a_.no_mint.to_account_info(),
                from: a_.no_pool.to_account_info(),
                authority: mkt.clone(),
            }, signer),
            collateral_out,
        )?;
        // pay the seller
        token::transfer(
            CpiContext::new_with_signer(tp.clone(), Transfer {
                from: a_.vault.to_account_info(),
                to: a_.trader_collateral.to_account_info(),
                authority: mkt.clone(),
            }, signer),
            collateral_out,
        )?;
        Ok(())
    }

    /// Resolve the market by proof. Permissionless: anyone submits the TxLINE proof of the
    /// final score. The finality gate rejects any non-terminal or mismatched proof before
    /// the CPI, and the predicate comes from the stored terms, never the caller. Same guard
    /// as wc-settle, proven by that program's 20-case suite.
    pub fn resolve(
        ctx: Context<Resolve>,
        fixture_summary: txoracle::ScoresBatchSummary,
        fixture_proof: Vec<txoracle::ProofNode>,
        main_tree_proof: Vec<txoracle::ProofNode>,
        stat_a: txoracle::StatTerm,
        stat_b: Option<txoracle::StatTerm>,
    ) -> Result<()> {
        let terms = {
            let m = &ctx.accounts.market;
            require!(m.state == MarketState::Trading, MarketError::AlreadyResolved);
            m.terms
        };

        require!(fixture_summary.fixture_id == terms.fixture_id, MarketError::FixtureMismatch);
        require!(stat_a.stat_to_prove.key == terms.stat_a_key, MarketError::StatKeyMismatch);
        match (&stat_b, terms.stat_b_key) {
            (Some(b), Some(kb)) => require!(b.stat_to_prove.key == kb, MarketError::StatKeyMismatch),
            (None, None) => {}
            _ => return err!(MarketError::StatKeyMismatch),
        }
        let period_a = stat_a.stat_to_prove.period;
        require!(TERMINAL_PERIODS.contains(&period_a), MarketError::NonTerminalPeriod);
        if let Some(b) = &stat_b {
            require!(b.stat_to_prove.period == period_a, MarketError::PeriodMismatch);
            require!(b.event_stat_root == stat_a.event_stat_root, MarketError::EventRootMismatch);
        }

        let min_ts = fixture_summary.update_stats.min_timestamp;
        let epoch_day = min_ts / txoracle::MS_PER_DAY;
        require!((0..=u16::MAX as i64).contains(&epoch_day), MarketError::EpochDayOutOfRange);
        let (expected_roots, _) = Pubkey::find_program_address(
            &[txoracle::DAILY_SCORES_ROOTS_SEED, &(epoch_day as u16).to_le_bytes()],
            &txoracle::TXORACLE_ID,
        );
        require_keys_eq!(
            ctx.accounts.daily_scores_roots.key(),
            expected_roots,
            MarketError::WrongDailyRootsAccount
        );

        let yes_wins = txoracle::cpi_validate_stat(
            &ctx.accounts.daily_scores_roots.to_account_info(),
            &ctx.accounts.txoracle_program.to_account_info(),
            &txoracle::ValidateStatArgs {
                ts: min_ts,
                fixture_summary,
                fixture_proof,
                main_tree_proof,
                predicate: terms.predicate,
                stat_a,
                stat_b,
                op: terms.op,
            },
        )?;

        let m = &mut ctx.accounts.market;
        m.state = MarketState::Resolved;
        m.winning_side = Some(if yes_wins { Side::Yes } else { Side::No });
        Ok(())
    }

    /// Redeem outcome tokens for collateral. Resolved: winning shares pay 1 each, losing
    /// shares are worthless. Voided: both sides pay 0.5, which refunds holders and keeps
    /// the vault solvent because total supply of each side equals the vault.
    pub fn redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
        require!(amount > 0, MarketError::ZeroAmount);
        let (state, winning, yes_mint, no_mint) = {
            let m = &ctx.accounts.market;
            (m.state, m.winning_side, m.yes_mint, m.no_mint)
        };
        let redeemed = ctx.accounts.outcome_mint.key();
        require!(redeemed == yes_mint || redeemed == no_mint, MarketError::WrongOutcomeMint);

        let payout = match state {
            MarketState::Resolved => {
                let win_mint = if winning == Some(Side::Yes) { yes_mint } else { no_mint };
                require!(redeemed == win_mint, MarketError::LosingShare); // losing shares pay 0
                amount
            }
            MarketState::Voided => amount / 2,
            MarketState::Trading => return err!(MarketError::MarketNotResolved),
        };

        token::burn(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), Burn {
                mint: ctx.accounts.outcome_mint.to_account_info(),
                from: ctx.accounts.redeemer_outcome.to_account_info(),
                authority: ctx.accounts.redeemer.to_account_info(),
            }),
            amount,
        )?;
        if payout > 0 {
            let (creator, mid, bump) = market_key_parts(&ctx.accounts.market);
            let seeds: &[&[u8]] = &[MARKET_SEED, creator.as_ref(), &mid, &[bump]];
            token::transfer(
                CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.redeemer_collateral.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                }, &[seeds]),
                payout,
            )?;
        }
        Ok(())
    }

    /// Merge equal YES and NO back into collateral (the inverse of a split). A clean exit
    /// for anyone holding both sides while trading is open.
    pub fn merge(ctx: Context<Merge>, amount: u64) -> Result<()> {
        require!(amount > 0, MarketError::ZeroAmount);
        {
            let m = &ctx.accounts.market;
            require!(m.state == MarketState::Trading, MarketError::MarketNotTrading);
        }
        let a_ = &ctx.accounts;
        let tp = a_.token_program.to_account_info();
        token::burn(CpiContext::new(tp.clone(), Burn {
            mint: a_.yes_mint.to_account_info(), from: a_.user_yes.to_account_info(), authority: a_.user.to_account_info(),
        }), amount)?;
        token::burn(CpiContext::new(tp.clone(), Burn {
            mint: a_.no_mint.to_account_info(), from: a_.user_no.to_account_info(), authority: a_.user.to_account_info(),
        }), amount)?;
        let (creator, mid, bump) = market_key_parts(&a_.market);
        let seeds: &[&[u8]] = &[MARKET_SEED, creator.as_ref(), &mid, &[bump]];
        token::transfer(
            CpiContext::new_with_signer(tp.clone(), Transfer {
                from: a_.vault.to_account_info(), to: a_.user_collateral.to_account_info(), authority: a_.market.to_account_info(),
            }, &[seeds]),
            amount,
        )?;
        Ok(())
    }

    /// Split: the inverse of merge. Lock `amount` collateral in the vault and mint an equal
    /// amount of YES and NO to the user. A complete set is always worth exactly one collateral,
    /// so this holds the invariant (vault == YES supply == NO supply). It lets a trader mint a
    /// set and sell one leg on the order book, which is how complementary liquidity is made.
    pub fn split(ctx: Context<Split>, amount: u64) -> Result<()> {
        require!(amount > 0, MarketError::ZeroAmount);
        {
            let m = &ctx.accounts.market;
            require!(m.state == MarketState::Trading, MarketError::MarketNotTrading);
        }
        let a_ = &ctx.accounts;
        let tp = a_.token_program.to_account_info();
        token::transfer(CpiContext::new(tp.clone(), Transfer {
            from: a_.user_collateral.to_account_info(), to: a_.vault.to_account_info(), authority: a_.user.to_account_info(),
        }), amount)?;
        let (creator, mid, bump) = market_key_parts(&a_.market);
        let seeds: &[&[u8]] = &[MARKET_SEED, creator.as_ref(), &mid, &[bump]];
        let signer = &[seeds];
        let mkt = a_.market.to_account_info();
        token::mint_to(CpiContext::new_with_signer(tp.clone(), MintTo {
            mint: a_.yes_mint.to_account_info(), to: a_.user_yes.to_account_info(), authority: mkt.clone(),
        }, signer), amount)?;
        token::mint_to(CpiContext::new_with_signer(tp.clone(), MintTo {
            mint: a_.no_mint.to_account_info(), to: a_.user_no.to_account_info(), authority: mkt.clone(),
        }, signer), amount)?;
        Ok(())
    }

    /// Remove liquidity: burn LP tokens for a pro-rata share of both reserves. After
    /// resolution the provider redeems the winning tokens they receive.
    pub fn remove_liquidity(ctx: Context<RemoveLiquidity>, lp_amount: u64) -> Result<()> {
        require!(lp_amount > 0, MarketError::ZeroAmount);
        let y = ctx.accounts.yes_pool.amount as u128;
        let n = ctx.accounts.no_pool.amount as u128;
        let lp = ctx.accounts.lp_mint.supply as u128;
        let (yo, no) = math::calc_remove_liquidity(y, n, lp, lp_amount as u128).ok_or(MarketError::MathOverflow)?;

        let a_ = &ctx.accounts;
        let tp = a_.token_program.to_account_info();
        token::burn(CpiContext::new(tp.clone(), Burn {
            mint: a_.lp_mint.to_account_info(), from: a_.provider_lp.to_account_info(), authority: a_.provider.to_account_info(),
        }), lp_amount)?;

        let (creator, mid, bump) = market_key_parts(&a_.market);
        let seeds: &[&[u8]] = &[MARKET_SEED, creator.as_ref(), &mid, &[bump]];
        let signer = &[seeds];
        let mkt = a_.market.to_account_info();
        token::transfer(
            CpiContext::new_with_signer(tp.clone(), Transfer {
                from: a_.yes_pool.to_account_info(), to: a_.provider_yes.to_account_info(), authority: mkt.clone(),
            }, signer),
            to_u64(yo)?,
        )?;
        token::transfer(
            CpiContext::new_with_signer(tp.clone(), Transfer {
                from: a_.no_pool.to_account_info(), to: a_.provider_no.to_account_info(), authority: mkt.clone(),
            }, signer),
            to_u64(no)?,
        )?;
        Ok(())
    }

    /// If a market never resolved by its expiry, anyone can void it. Both sides then redeem
    /// at 0.5 through `redeem`.
    pub fn void_market(ctx: Context<VoidMarket>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.state == MarketState::Trading, MarketError::AlreadyResolved);
        require!(Clock::get()?.unix_timestamp >= m.expiry_ts, MarketError::NotExpired);
        m.state = MarketState::Voided;
        Ok(())
    }
}

// ---------- helpers ----------

fn market_key_parts(m: &Account<Market>) -> (Pubkey, [u8; 8], u8) {
    (m.creator, m.market_id.to_le_bytes(), m.bump)
}

fn reserves_for(a: &Trade, side: Side) -> (u128, u128) {
    let y = a.yes_pool.amount as u128;
    let n = a.no_pool.amount as u128;
    match side {
        Side::Yes => (y, n),
        Side::No => (n, y),
    }
}

fn mint<'info>(
    token_program: &AccountInfo<'info>,
    mint_acc: &Account<'info, Mint>,
    to: &Account<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    signer: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::mint_to(
        CpiContext::new_with_signer(
            token_program.clone(),
            MintTo { mint: mint_acc.to_account_info(), to: to.to_account_info(), authority: authority.clone() },
            signer,
        ),
        amount,
    )
}

// ---------- accounts ----------

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init, payer = creator, space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, creator.key().as_ref(), &market_id.to_le_bytes()], bump
    )]
    pub market: Box<Account<'info, Market>>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = creator, seeds = [YES_MINT_SEED, market.key().as_ref()], bump,
        mint::decimals = COLLATERAL_DECIMALS, mint::authority = market)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = creator, seeds = [NO_MINT_SEED, market.key().as_ref()], bump,
        mint::decimals = COLLATERAL_DECIMALS, mint::authority = market)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = creator, seeds = [LP_MINT_SEED, market.key().as_ref()], bump,
        mint::decimals = COLLATERAL_DECIMALS, mint::authority = market)]
    pub lp_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = creator, seeds = [VAULT_SEED, market.key().as_ref()], bump,
        token::mint = collateral_mint, token::authority = market)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = creator, seeds = [YES_POOL_SEED, market.key().as_ref()], bump,
        token::mint = yes_mint, token::authority = market)]
    pub yes_pool: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = creator, seeds = [NO_POOL_SEED, market.key().as_ref()], bump,
        token::mint = no_mint, token::authority = market)]
    pub no_pool: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,
    #[account(seeds = [MARKET_SEED, market.creator.as_ref(), &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, address = market.yes_mint)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.no_mint)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.lp_mint)]
    pub lp_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [YES_POOL_SEED, market.key().as_ref()], bump)]
    pub yes_pool: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [NO_POOL_SEED, market.key().as_ref()], bump)]
    pub no_pool: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.collateral_mint, token::authority = provider)]
    pub provider_collateral: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.yes_mint, token::authority = provider)]
    pub provider_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.no_mint, token::authority = provider)]
    pub provider_no: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.lp_mint, token::authority = provider)]
    pub provider_lp: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

// Accounts are boxed so their deserialization lands on the heap, not the stack. With
// eleven accounts this instruction otherwise overflows the 4KB BPF stack frame.
#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(seeds = [MARKET_SEED, market.creator.as_ref(), &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, address = market.yes_mint)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.no_mint)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [YES_POOL_SEED, market.key().as_ref()], bump)]
    pub yes_pool: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [NO_POOL_SEED, market.key().as_ref()], bump)]
    pub no_pool: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.collateral_mint, token::authority = trader)]
    pub trader_collateral: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.yes_mint, token::authority = trader)]
    pub trader_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.no_mint, token::authority = trader)]
    pub trader_no: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Resolve<'info> {
    pub resolver: Signer<'info>,
    #[account(mut, seeds = [MARKET_SEED, market.creator.as_ref(), &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// CHECK: canonical txoracle daily-roots PDA, verified in the handler against the epoch
    /// day derived from the proof; its contents are verified inside validate_stat.
    pub daily_scores_roots: UncheckedAccount<'info>,
    /// CHECK: pinned to the txoracle program id
    #[account(address = txoracle::TXORACLE_ID)]
    pub txoracle_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    pub redeemer: Signer<'info>,
    #[account(seeds = [MARKET_SEED, market.creator.as_ref(), &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut)]
    pub outcome_mint: Box<Account<'info, Mint>>, // yes or no; validated in the handler
    #[account(mut, token::mint = outcome_mint, token::authority = redeemer)]
    pub redeemer_outcome: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.collateral_mint, token::authority = redeemer)]
    pub redeemer_collateral: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Merge<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [MARKET_SEED, market.creator.as_ref(), &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, address = market.yes_mint)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.no_mint)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.yes_mint, token::authority = user)]
    pub user_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.no_mint, token::authority = user)]
    pub user_no: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.collateral_mint, token::authority = user)]
    pub user_collateral: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

// Split takes the same accounts as Merge: it mints a YES/NO set for collateral, the exact
// inverse of burning a set back to collateral.
#[derive(Accounts)]
pub struct Split<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [MARKET_SEED, market.creator.as_ref(), &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, address = market.yes_mint)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.no_mint)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.yes_mint, token::authority = user)]
    pub user_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.no_mint, token::authority = user)]
    pub user_no: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.collateral_mint, token::authority = user)]
    pub user_collateral: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    pub provider: Signer<'info>,
    #[account(seeds = [MARKET_SEED, market.creator.as_ref(), &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, address = market.lp_mint)]
    pub lp_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [YES_POOL_SEED, market.key().as_ref()], bump)]
    pub yes_pool: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [NO_POOL_SEED, market.key().as_ref()], bump)]
    pub no_pool: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.lp_mint, token::authority = provider)]
    pub provider_lp: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.yes_mint, token::authority = provider)]
    pub provider_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.no_mint, token::authority = provider)]
    pub provider_no: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct VoidMarket<'info> {
    #[account(mut, seeds = [MARKET_SEED, market.creator.as_ref(), &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
}

#[error_code]
pub enum MarketError {
    #[msg("txoracle returned no verdict")]
    MissingOracleReturn,
    #[msg("Market is not open for trading")]
    MarketNotTrading,
    #[msg("Market has closed for trading")]
    MarketClosed,
    #[msg("Market is not resolved")]
    MarketNotResolved,
    #[msg("Market already resolved")]
    AlreadyResolved,
    #[msg("Market has not expired")]
    NotExpired,
    #[msg("Market is not voided")]
    NotVoided,
    #[msg("Price moved past the limit you set")]
    SlippageExceeded,
    #[msg("Arithmetic overflow or invalid pool state")]
    MathOverflow,
    #[msg("Terms are not a predicate validate_stat can evaluate")]
    InvalidTerms,
    #[msg("Proof is for a different fixture")]
    FixtureMismatch,
    #[msg("Proven stat keys do not match market terms")]
    StatKeyMismatch,
    #[msg("Proven stat is not from a terminal game phase (match not ended)")]
    NonTerminalPeriod,
    #[msg("Both stats must be proven at the same terminal phase")]
    PeriodMismatch,
    #[msg("Both stats must come from the same event snapshot")]
    EventRootMismatch,
    #[msg("Epoch day out of range")]
    EpochDayOutOfRange,
    #[msg("Not the canonical txoracle daily scores roots PDA for this epoch day")]
    WrongDailyRootsAccount,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Not enough liquidity in the pool")]
    InsufficientLiquidity,
    #[msg("Outcome mint is not this market's YES or NO")]
    WrongOutcomeMint,
    #[msg("Losing shares pay nothing")]
    LosingShare,
}
