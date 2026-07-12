//! fischio-multi: a multi-outcome (NegRisk) prediction market.
//!
//! N mutually-exclusive outcomes, each with its own YES/NO conditional tokens. One proof
//! resolves the whole market: it verifies the final stats are genuine through a CPI into
//! TxLINE validate_stat, then picks the single outcome whose predicate holds. The
//! capital-efficient `convert` primitive and its solvency proof live in `negrisk`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

pub mod negrisk;
pub mod state;
pub mod txoracle;

use state::*;

declare_id!("8zVnp7ivs5fSdmjYFHTLChrSzbKnDeKX6mj5nuP1CAgg");

fn market_seeds(m: &MultiMarket) -> [Vec<u8>; 4] {
    [MARKET_SEED.to_vec(), m.creator.to_bytes().to_vec(), m.market_id.to_le_bytes().to_vec(), vec![m.bump]]
}

#[program]
pub mod fischio_multi {
    use super::*;

    /// Create a market with N mutually-exclusive outcomes. Each outcome's predicate is
    /// evaluated against the same combined stat at resolution; exactly one must hold.
    pub fn create_multi_market(
        ctx: Context<CreateMultiMarket>,
        market_id: u64,
        fixture_id: i64,
        num_outcomes: u8,
        stat_a_key: u32,
        stat_b_key: u32,
        op_is_subtract: bool,
        predicates: Vec<OutcomePredicate>,
        close_ts: i64,
        expiry_ts: i64,
    ) -> Result<()> {
        require!((2..=MAX_OUTCOMES as u8).contains(&num_outcomes), MultiError::InvalidTerms);
        require!(predicates.len() == num_outcomes as usize, MultiError::InvalidTerms);
        require!(fixture_id > 0 && stat_a_key > 0, MultiError::InvalidTerms);
        let now = Clock::get()?.unix_timestamp;
        require!(close_ts > now && expiry_ts > close_ts, MultiError::InvalidTerms);

        let m = &mut ctx.accounts.market;
        m.creator = ctx.accounts.creator.key();
        m.market_id = market_id;
        m.fixture_id = fixture_id;
        m.num_outcomes = num_outcomes;
        m.stat_a_key = stat_a_key;
        m.stat_b_key = stat_b_key;
        m.op_is_subtract = op_is_subtract;
        m.collateral_mint = ctx.accounts.collateral_mint.key();
        m.close_ts = close_ts;
        m.expiry_ts = expiry_ts;
        m.state = MultiState::Trading;
        m.winning_outcome = 255;
        m.predicates = predicates;
        m.bump = ctx.bumps.market;
        Ok(())
    }

    /// Create the YES and NO mints for one outcome. Called once per outcome.
    pub fn init_outcome(ctx: Context<InitOutcome>, index: u8) -> Result<()> {
        require!((index as usize) < ctx.accounts.market.num_outcomes as usize, MultiError::BadOutcomeIndex);
        Ok(()) // mints are created by the account constraints
    }

    /// Split `amount` collateral into `amount` YES_i + `amount` NO_i.
    pub fn split(ctx: Context<SplitMerge>, index: u8, amount: u64) -> Result<()> {
        require!(amount > 0, MultiError::ZeroAmount);
        {
            let m = &ctx.accounts.market;
            require!(m.state == MultiState::Trading, MultiError::MarketNotTrading);
            require!((index as usize) < m.num_outcomes as usize, MultiError::BadOutcomeIndex);
        }
        let a = &ctx.accounts;
        token::transfer(CpiContext::new(a.token_program.to_account_info(), Transfer {
            from: a.user_collateral.to_account_info(), to: a.vault.to_account_info(), authority: a.user.to_account_info(),
        }), amount)?;

        let seeds = market_seeds(&ctx.accounts.market);
        let sref: [&[u8]; 4] = [&seeds[0], &seeds[1], &seeds[2], &seeds[3]];
        let signer = &[&sref[..]];
        token::mint_to(CpiContext::new_with_signer(a.token_program.to_account_info(), MintTo {
            mint: a.yes_mint.to_account_info(), to: a.user_yes.to_account_info(), authority: a.market.to_account_info(),
        }, signer), amount)?;
        token::mint_to(CpiContext::new_with_signer(a.token_program.to_account_info(), MintTo {
            mint: a.no_mint.to_account_info(), to: a.user_no.to_account_info(), authority: a.market.to_account_info(),
        }, signer), amount)?;
        Ok(())
    }

    /// Merge `amount` YES_i + `amount` NO_i back into `amount` collateral.
    pub fn merge(ctx: Context<SplitMerge>, index: u8, amount: u64) -> Result<()> {
        require!(amount > 0, MultiError::ZeroAmount);
        {
            let m = &ctx.accounts.market;
            require!(m.state == MultiState::Trading, MultiError::MarketNotTrading);
            require!((index as usize) < m.num_outcomes as usize, MultiError::BadOutcomeIndex);
        }
        let a = &ctx.accounts;
        token::burn(CpiContext::new(a.token_program.to_account_info(), Burn {
            mint: a.yes_mint.to_account_info(), from: a.user_yes.to_account_info(), authority: a.user.to_account_info(),
        }), amount)?;
        token::burn(CpiContext::new(a.token_program.to_account_info(), Burn {
            mint: a.no_mint.to_account_info(), from: a.user_no.to_account_info(), authority: a.user.to_account_info(),
        }), amount)?;

        let seeds = market_seeds(&ctx.accounts.market);
        let sref: [&[u8]; 4] = [&seeds[0], &seeds[1], &seeds[2], &seeds[3]];
        let signer = &[&sref[..]];
        token::transfer(CpiContext::new_with_signer(a.token_program.to_account_info(), Transfer {
            from: a.vault.to_account_info(), to: a.user_collateral.to_account_info(), authority: a.market.to_account_info(),
        }, signer), amount)?;
        Ok(())
    }

    /// Resolve by proof. One CPI into validate_stat proves the final stats are genuine;
    /// the program then picks the single outcome whose predicate holds. Permissionless.
    pub fn resolve(
        ctx: Context<Resolve>,
        fixture_summary: txoracle::ScoresBatchSummary,
        fixture_proof: Vec<txoracle::ProofNode>,
        main_tree_proof: Vec<txoracle::ProofNode>,
        stat_a: txoracle::StatTerm,
        stat_b: Option<txoracle::StatTerm>,
    ) -> Result<()> {
        let (fixture_id, stat_a_key, stat_b_key, op_sub, num, predicates) = {
            let m = &ctx.accounts.market;
            require!(m.state == MultiState::Trading, MultiError::AlreadyResolved);
            (m.fixture_id, m.stat_a_key, m.stat_b_key, m.op_is_subtract, m.num_outcomes, m.predicates.clone())
        };

        // the proof must be about this fixture and these stats, at a terminal phase
        require!(fixture_summary.fixture_id == fixture_id, MultiError::FixtureMismatch);
        require!(stat_a.stat_to_prove.key == stat_a_key, MultiError::StatKeyMismatch);
        require!(TERMINAL_PERIODS.contains(&stat_a.stat_to_prove.period), MultiError::NonTerminalPeriod);
        let has_b = stat_b_key != 0;
        match (&stat_b, has_b) {
            (Some(b), true) => {
                require!(b.stat_to_prove.key == stat_b_key, MultiError::StatKeyMismatch);
                require!(b.stat_to_prove.period == stat_a.stat_to_prove.period, MultiError::NonTerminalPeriod);
                require!(b.event_stat_root == stat_a.event_stat_root, MultiError::StatKeyMismatch);
            }
            (None, false) => {}
            _ => return err!(MultiError::StatKeyMismatch),
        }

        // canonical roots PDA for the proof's epoch day
        let min_ts = fixture_summary.update_stats.min_timestamp;
        let epoch_day = min_ts / txoracle::MS_PER_DAY;
        require!((0..=u16::MAX as i64).contains(&epoch_day), MultiError::EpochDayOutOfRange);
        let (expected_roots, _) = Pubkey::find_program_address(
            &[txoracle::DAILY_SCORES_ROOTS_SEED, &(epoch_day as u16).to_le_bytes()], &txoracle::TXORACLE_ID);
        require_keys_eq!(ctx.accounts.daily_scores_roots.key(), expected_roots, MultiError::WrongDailyRootsAccount);

        // the values we settle on must be genuine. A tautological predicate makes the CPI
        // succeed iff the stat is in the Merkle tree; if it does not abort, the value is real.
        let taut = txoracle::TraderPredicate { threshold: i32::MIN, comparison: txoracle::Comparison::GreaterThan };
        let op = if has_b {
            Some(if op_sub { txoracle::BinaryExpression::Subtract } else { txoracle::BinaryExpression::Add })
        } else {
            None
        };
        let a_val = stat_a.stat_to_prove.value as i64;
        let b_val = stat_b.as_ref().map(|b| b.stat_to_prove.value as i64).unwrap_or(0);
        txoracle::cpi_validate_stat(
            &ctx.accounts.daily_scores_roots.to_account_info(),
            &ctx.accounts.txoracle_program.to_account_info(),
            &txoracle::ValidateStatArgs {
                ts: min_ts, fixture_summary, fixture_proof, main_tree_proof, predicate: taut, stat_a, stat_b, op,
            },
        )?;

        // combine the genuine values and find the one outcome whose predicate holds
        let combined = if has_b {
            if op_sub { a_val - b_val } else { a_val + b_val }
        } else {
            a_val
        };
        let mut winner: Option<u8> = None;
        for i in 0..num as usize {
            if predicates[i].holds(combined) {
                require!(winner.is_none(), MultiError::MultipleWinners);
                winner = Some(i as u8);
            }
        }
        let w = winner.ok_or(MultiError::NoWinningOutcome)?;

        let m = &mut ctx.accounts.market;
        m.state = MultiState::Resolved;
        m.winning_outcome = w;
        Ok(())
    }

    /// Redeem a winning token for collateral. YES on the winning outcome pays 1 each; NO
    /// on any losing outcome pays 1 each. Everything else is worthless.
    pub fn redeem(ctx: Context<Redeem>, index: u8, is_yes: bool, amount: u64) -> Result<()> {
        require!(amount > 0, MultiError::ZeroAmount);
        let (state, winner, market_key, expected_mint) = {
            let m = &ctx.accounts.market;
            require!(m.state == MultiState::Resolved, MultiError::NotResolved);
            require!((index as usize) < m.num_outcomes as usize, MultiError::BadOutcomeIndex);
            let seed = if is_yes { YES_SEED } else { NO_SEED };
            let (mint, _) = Pubkey::find_program_address(&[seed, ctx.accounts.market.key().as_ref(), &[index]], &crate::ID);
            (m.state, m.winning_outcome, ctx.accounts.market.key(), mint)
        };
        let _ = (state, market_key);
        require_keys_eq!(ctx.accounts.outcome_mint.key(), expected_mint, MultiError::WrongOutcomeMint);

        // winning token: YES on the winner, or NO on any loser
        let pays = if is_yes { index == winner } else { index != winner };
        require!(pays, MultiError::WorthlessShare);

        let a = &ctx.accounts;
        token::burn(CpiContext::new(a.token_program.to_account_info(), Burn {
            mint: a.outcome_mint.to_account_info(), from: a.redeemer_outcome.to_account_info(), authority: a.redeemer.to_account_info(),
        }), amount)?;
        let seeds = market_seeds(&ctx.accounts.market);
        let sref: [&[u8]; 4] = [&seeds[0], &seeds[1], &seeds[2], &seeds[3]];
        token::transfer(CpiContext::new_with_signer(a.token_program.to_account_info(), Transfer {
            from: a.vault.to_account_info(), to: a.redeemer_collateral.to_account_info(), authority: a.market.to_account_info(),
        }, &[&sref[..]]), amount)?;
        Ok(())
    }

    /// NegRisk convert: burn `amount` NO on every outcome in `index_set` (size k >= 2),
    /// mint `amount` YES on every outcome NOT in the set, and release (k-1)*amount
    /// collateral. This is the capital-efficient primitive: holding NO on many outcomes
    /// nets down to far less collateral. Solvency is preserved (proven in `negrisk`).
    ///
    /// remaining_accounts, in order: [no_mint_i, user_no_i] for each i in the set, then
    /// [yes_mint_j, user_yes_j] for each j in the complement (ascending).
    pub fn convert<'info>(
        ctx: Context<'_, '_, 'info, 'info, Convert<'info>>,
        index_set: Vec<u8>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, MultiError::ZeroAmount);
        let (num, market_key) = {
            let m = &ctx.accounts.market;
            require!(m.state == MultiState::Trading, MultiError::MarketNotTrading);
            (m.num_outcomes, ctx.accounts.market.key())
        };
        let k = index_set.len();
        require!(k >= 2 && k <= num as usize, MultiError::InvalidTerms);

        // validate the set: in range and distinct; derive the complement
        let mut in_set = [false; MAX_OUTCOMES];
        for &i in &index_set {
            require!((i as usize) < num as usize, MultiError::BadOutcomeIndex);
            require!(!in_set[i as usize], MultiError::InvalidTerms); // distinct
            in_set[i as usize] = true;
        }
        let complement: Vec<u8> = (0..num).filter(|j| !in_set[*j as usize]).collect();

        let ra = ctx.remaining_accounts;
        require!(ra.len() == 2 * k + 2 * complement.len(), MultiError::WrongRemainingAccounts);

        let seeds = market_seeds(&ctx.accounts.market);
        let sref: [&[u8]; 4] = [&seeds[0], &seeds[1], &seeds[2], &seeds[3]];
        let signer = &[&sref[..]];
        let tp = ctx.accounts.token_program.to_account_info();
        let mkt = ctx.accounts.market.to_account_info();
        let user = ctx.accounts.user.to_account_info();

        // burn NO on each set member (validate the mint is the real PDA for that index)
        for (idx, &si) in index_set.iter().enumerate() {
            let no_mint = &ra[2 * idx];
            let user_no = &ra[2 * idx + 1];
            let (expected, _) = Pubkey::find_program_address(&[NO_SEED, market_key.as_ref(), &[si]], &crate::ID);
            require_keys_eq!(no_mint.key(), expected, MultiError::WrongOutcomeMint);
            token::burn(CpiContext::new(tp.clone(), Burn {
                mint: no_mint.clone(), from: user_no.clone(), authority: user.clone(),
            }), amount)?;
        }
        // mint YES on each complement member
        for (c, &cj) in complement.iter().enumerate() {
            let base = 2 * k + 2 * c;
            let yes_mint = &ra[base];
            let user_yes = &ra[base + 1];
            let (expected, _) = Pubkey::find_program_address(&[YES_SEED, market_key.as_ref(), &[cj]], &crate::ID);
            require_keys_eq!(yes_mint.key(), expected, MultiError::WrongOutcomeMint);
            token::mint_to(CpiContext::new_with_signer(tp.clone(), MintTo {
                mint: yes_mint.clone(), to: user_yes.clone(), authority: mkt.clone(),
            }, signer), amount)?;
        }
        // release (k-1)*amount collateral
        let release = (k as u64 - 1).checked_mul(amount).ok_or(MultiError::MathOverflow)?;
        token::transfer(CpiContext::new_with_signer(tp.clone(), Transfer {
            from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.user_collateral.to_account_info(), authority: mkt.clone(),
        }, signer), release)?;
        Ok(())
    }
}

// ---------- accounts ----------

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct CreateMultiMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(init, payer = creator, space = 8 + MultiMarket::INIT_SPACE,
        seeds = [MARKET_SEED, creator.key().as_ref(), &market_id.to_le_bytes()], bump)]
    pub market: Box<Account<'info, MultiMarket>>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = creator, seeds = [VAULT_SEED, market.key().as_ref()], bump,
        token::mint = collateral_mint, token::authority = market)]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct InitOutcome<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds = [MARKET_SEED, market.creator.as_ref(), &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, MultiMarket>>,
    #[account(init, payer = creator, seeds = [YES_SEED, market.key().as_ref(), &[index]], bump,
        mint::decimals = COLLATERAL_DECIMALS, mint::authority = market)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = creator, seeds = [NO_SEED, market.key().as_ref(), &[index]], bump,
        mint::decimals = COLLATERAL_DECIMALS, mint::authority = market)]
    pub no_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct SplitMerge<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [MARKET_SEED, market.creator.as_ref(), &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, MultiMarket>>,
    #[account(mut, seeds = [YES_SEED, market.key().as_ref(), &[index]], bump)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [NO_SEED, market.key().as_ref(), &[index]], bump)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.collateral_mint, token::authority = user)]
    pub user_collateral: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = user)]
    pub user_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = user)]
    pub user_no: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Resolve<'info> {
    pub resolver: Signer<'info>,
    #[account(mut, seeds = [MARKET_SEED, market.creator.as_ref(), &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, MultiMarket>>,
    /// CHECK: canonical txoracle roots PDA, verified in the handler; contents verified in validate_stat
    pub daily_scores_roots: UncheckedAccount<'info>,
    /// CHECK: pinned to the txoracle program id
    #[account(address = txoracle::TXORACLE_ID)]
    pub txoracle_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(index: u8, is_yes: bool)]
pub struct Redeem<'info> {
    pub redeemer: Signer<'info>,
    #[account(seeds = [MARKET_SEED, market.creator.as_ref(), &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, MultiMarket>>,
    #[account(mut)]
    pub outcome_mint: Box<Account<'info, Mint>>, // validated against (index, is_yes) in the handler
    #[account(mut, token::mint = outcome_mint, token::authority = redeemer)]
    pub redeemer_outcome: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.collateral_mint, token::authority = redeemer)]
    pub redeemer_collateral: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Convert<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [MARKET_SEED, market.creator.as_ref(), &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, MultiMarket>>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.collateral_mint, token::authority = user)]
    pub user_collateral: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    // outcome mints and user token accounts are passed in remaining_accounts
}

#[error_code]
pub enum MultiError {
    #[msg("txoracle returned no verdict")]
    MissingOracleReturn,
    #[msg("Invalid market terms")]
    InvalidTerms,
    #[msg("Market is not trading")]
    MarketNotTrading,
    #[msg("Market has closed")]
    MarketClosed,
    #[msg("Market already resolved")]
    AlreadyResolved,
    #[msg("Market is not resolved")]
    NotResolved,
    #[msg("Market has not expired")]
    NotExpired,
    #[msg("Proof is for a different fixture")]
    FixtureMismatch,
    #[msg("Proven stat keys do not match market terms")]
    StatKeyMismatch,
    #[msg("Proven stat is not from a terminal game phase")]
    NonTerminalPeriod,
    #[msg("Epoch day out of range")]
    EpochDayOutOfRange,
    #[msg("Not the canonical txoracle roots PDA")]
    WrongDailyRootsAccount,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("No outcome predicate held; market cannot resolve")]
    NoWinningOutcome,
    #[msg("More than one outcome predicate held")]
    MultipleWinners,
    #[msg("Outcome mint does not match the index and side")]
    WrongOutcomeMint,
    #[msg("This share is worthless")]
    WorthlessShare,
    #[msg("Outcome index out of range")]
    BadOutcomeIndex,
    #[msg("Wrong number of remaining accounts for the convert set")]
    WrongRemainingAccounts,
}
