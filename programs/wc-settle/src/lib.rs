//! wc-settle: permissionless, proof-based settlement of a single-match World Cup wager.
//!
//! Two parties lock SOL on a stat predicate for one fixture. ANYONE can settle by
//! submitting the TxLINE Merkle proof of the final score; the program enforces the
//! match-ended finality guard, CPIs into txoracle `validate_stat`, and pays the winner
//! from the returned bool. No privileged resolver exists anywhere in the program.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_lang::system_program::{transfer, Transfer};

pub mod state;
pub mod txoracle;

use state::*;
use txoracle::*;

declare_id!("FVVSa2AcwxBdmtKxFHiZMmd2ceRWorh7ZDdppvPsPvxb");

#[program]
pub mod wc_settle {
    use super::*;

    /// Maker opens a wager: locks `stake_lamports` against `terms` until `expiry_ts`.
    pub fn create_wager(
        ctx: Context<CreateWager>,
        wager_id: u64,
        terms: WagerTerms,
        stake_lamports: u64,
        expiry_ts: i64,
    ) -> Result<()> {
        require!(stake_lamports >= MIN_STAKE_LAMPORTS, WagerError::StakeTooSmall);
        let now = Clock::get()?.unix_timestamp;
        require!(expiry_ts > now, WagerError::ExpiryInPast);

        // Terms must be a predicate validate_stat can actually evaluate.
        require!(terms.fixture_id > 0, WagerError::InvalidTerms);
        require!(terms.stat_a_key > 0, WagerError::InvalidTerms);
        match (terms.stat_b_key, terms.op) {
            (Some(b), Some(_)) => require!(b > 0 && b != terms.stat_a_key, WagerError::InvalidTerms),
            (None, None) => {}
            _ => return err!(WagerError::InvalidTerms), // two-stat needs an op; one-stat forbids it
        }

        let wager = &mut ctx.accounts.wager;
        wager.maker = ctx.accounts.maker.key();
        wager.taker = Pubkey::default();
        wager.stake_lamports = stake_lamports;
        wager.terms = terms;
        wager.terms_hash = hash(&terms.try_to_vec()?).to_bytes();
        wager.state = WagerState::Open;
        wager.expiry_ts = expiry_ts;
        wager.wager_id = wager_id;
        wager.bump = ctx.bumps.wager;
        wager.vault_bump = ctx.bumps.vault;

        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.maker.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            stake_lamports,
        )
    }

    /// Taker matches the maker's stake against the stored terms: Open -> Active.
    pub fn accept_wager(ctx: Context<AcceptWager>) -> Result<()> {
        let wager = &mut ctx.accounts.wager;
        require!(wager.state == WagerState::Open, WagerError::WagerNotOpen);
        // No accepting a wager already in its refund window.
        require!(
            Clock::get()?.unix_timestamp < wager.expiry_ts,
            WagerError::ExpiryInPast
        );

        wager.taker = ctx.accounts.taker.key();
        wager.state = WagerState::Active;

        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.taker.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            wager.stake_lamports,
        )
    }

    /// PERMISSIONLESS settlement. Any signer may submit the TxLINE proof bundle.
    ///
    /// Safety model, in order:
    ///   1. The proof must be about the wagered fixture and the wagered stat keys.
    ///   2. FINALITY GUARD: the proven leaves must carry a terminal game phase
    ///      (period ∈ {5 FT, 10 after-ET}) — period=0 running totals and all in-play
    ///      phases are rejected. Period is inside the hashed leaf, so a submitter
    ///      cannot relabel a mid-match proof (verified: relabel → InvalidStatProof).
    ///   3. The predicate evaluated on-chain comes from the STORED terms, never from
    ///      the submitter.
    ///   4. txoracle re-verifies the whole Merkle path against its oracle root; any
    ///      forgery aborts the transaction inside the CPI.
    ///   5. State flips to Settled before a single lamport moves.
    ///
    /// Compute: the validate_stat CPI costs ~179k CU, so callers MUST request an
    /// explicit compute budget (~400k CU) — the default 200k tx budget fails.
    pub fn settle(
        ctx: Context<Settle>,
        fixture_summary: ScoresBatchSummary,
        fixture_proof: Vec<ProofNode>,
        main_tree_proof: Vec<ProofNode>,
        stat_a: StatTerm,
        stat_b: Option<StatTerm>,
    ) -> Result<()> {
        let wager = &mut ctx.accounts.wager;
        require!(wager.state == WagerState::Active, WagerError::WagerNotActive);

        // Party identity is enforced here, after the state check, instead of via
        // address= constraints: an Open wager stores taker = Pubkey::default(), and a
        // constraint on that fires before the handler, masking WagerNotActive and
        // making Open-state paths uncallable (see adversarial suite).
        require_keys_eq!(ctx.accounts.maker.key(), wager.maker, WagerError::PartyMismatch);
        require_keys_eq!(ctx.accounts.taker.key(), wager.taker, WagerError::PartyMismatch);

        // -- 1. proof is about THIS wager --------------------------------------
        let terms = wager.terms;
        require!(
            fixture_summary.fixture_id == terms.fixture_id,
            WagerError::FixtureMismatch
        );
        require!(
            stat_a.stat_to_prove.key == terms.stat_a_key,
            WagerError::StatKeyMismatch
        );
        match (&stat_b, terms.stat_b_key) {
            (Some(b), Some(key_b)) => {
                require!(b.stat_to_prove.key == key_b, WagerError::StatKeyMismatch)
            }
            (None, None) => {}
            _ => return err!(WagerError::StatKeyMismatch),
        }

        // -- 2. finality guard ---------------------------------------------------
        let period_a = stat_a.stat_to_prove.period;
        require!(
            TERMINAL_PERIODS.contains(&period_a),
            WagerError::NonTerminalPeriod
        );
        if let Some(b) = &stat_b {
            // Same terminal snapshot: equal phase AND same event tree. Prevents
            // pairing a final leaf of one stat with any other event's leaf.
            require!(b.stat_to_prove.period == period_a, WagerError::PeriodMismatch);
            require!(
                b.event_stat_root == stat_a.event_stat_root,
                WagerError::EventRootMismatch
            );
        }

        // -- 3. the roots account must be txoracle's canonical PDA for the proof's
        //       epoch day (validate_stat then checks its contents against ts) -----
        let min_ts = fixture_summary.update_stats.min_timestamp;
        let epoch_day = min_ts / MS_PER_DAY;
        require!(
            (0..=u16::MAX as i64).contains(&epoch_day),
            WagerError::EpochDayOutOfRange
        );
        let (expected_roots, _) = Pubkey::find_program_address(
            &[DAILY_SCORES_ROOTS_SEED, &(epoch_day as u16).to_le_bytes()],
            &TXORACLE_ID,
        );
        require_keys_eq!(
            ctx.accounts.daily_scores_roots.key(),
            expected_roots,
            WagerError::WrongDailyRootsAccount
        );

        // -- 4. oracle verdict: predicate and op come from stored terms only ------
        let maker_wins = cpi_validate_stat(
            &ctx.accounts.daily_scores_roots.to_account_info(),
            &ctx.accounts.txoracle_program.to_account_info(),
            &ValidateStatArgs {
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

        // -- 5. state before money -------------------------------------------------
        wager.state = WagerState::Settled;

        let winner = if maker_wins {
            ctx.accounts.maker.to_account_info()
        } else {
            ctx.accounts.taker.to_account_info()
        };

        let pot = ctx.accounts.vault.lamports();
        let tip = SETTLER_TIP_LAMPORTS.min(pot);
        let wager_key = wager.key();
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, wager_key.as_ref(), &[wager.vault_bump]];

        if tip > 0 {
            transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.settler.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                tip,
            )?;
        }
        transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: winner,
                },
                &[vault_seeds],
            ),
            pot - tip, // pot >= tip by construction of `tip`
        )
    }

    /// Timeout path, permissionless like settle: after expiry_ts, anyone can return
    /// the stakes to their owners. Open -> maker only; Active -> both sides.
    /// Covers abandoned wagers and the RootNotAvailable scenario (oracle never posts
    /// a terminal proof for the fixture).
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let wager = &mut ctx.accounts.wager;
        require!(
            Clock::get()?.unix_timestamp >= wager.expiry_ts,
            WagerError::NotExpired
        );
        // Maker is always a refund recipient; taker is only checked in the Active
        // branch below — an Open wager has no taker to verify (stored default).
        require_keys_eq!(ctx.accounts.maker.key(), wager.maker, WagerError::PartyMismatch);

        let prior_state = wager.state;
        wager.state = WagerState::Refunded; // state before money

        let pot = ctx.accounts.vault.lamports();
        let wager_key = wager.key();
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, wager_key.as_ref(), &[wager.vault_bump]];

        match prior_state {
            WagerState::Open => {
                // Only the maker ever funded the vault; drain everything back.
                transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.system_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.vault.to_account_info(),
                            to: ctx.accounts.maker.to_account_info(),
                        },
                        &[vault_seeds],
                    ),
                    pot,
                )
            }
            WagerState::Active => {
                require_keys_eq!(
                    ctx.accounts.taker.key(),
                    wager.taker,
                    WagerError::PartyMismatch
                );
                let taker_share = wager.stake_lamports.min(pot);
                transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.system_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.vault.to_account_info(),
                            to: ctx.accounts.taker.to_account_info(),
                        },
                        &[vault_seeds],
                    ),
                    taker_share,
                )?;
                // Maker takes the remainder so the vault always drains fully.
                transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.system_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.vault.to_account_info(),
                            to: ctx.accounts.maker.to_account_info(),
                        },
                        &[vault_seeds],
                    ),
                    pot - taker_share,
                )
            }
            _ => err!(WagerError::WagerNotRefundable),
        }
    }
}

#[derive(Accounts)]
#[instruction(wager_id: u64)]
pub struct CreateWager<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(
        init,
        payer = maker,
        space = 8 + Wager::INIT_SPACE,
        seeds = [WAGER_SEED, maker.key().as_ref(), &wager_id.to_le_bytes()],
        bump
    )]
    pub wager: Account<'info, Wager>,
    #[account(
        mut,
        seeds = [VAULT_SEED, wager.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptWager<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,
    #[account(
        mut,
        seeds = [WAGER_SEED, wager.maker.as_ref(), &wager.wager_id.to_le_bytes()],
        bump = wager.bump
    )]
    pub wager: Account<'info, Wager>,
    #[account(mut, seeds = [VAULT_SEED, wager.key().as_ref()], bump = wager.vault_bump)]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    /// Anyone. Receives SETTLER_TIP_LAMPORTS from the pot for landing the proof.
    #[account(mut)]
    pub settler: Signer<'info>,
    #[account(
        mut,
        seeds = [WAGER_SEED, wager.maker.as_ref(), &wager.wager_id.to_le_bytes()],
        bump = wager.bump
    )]
    pub wager: Account<'info, Wager>,
    #[account(mut, seeds = [VAULT_SEED, wager.key().as_ref()], bump = wager.vault_bump)]
    pub vault: SystemAccount<'info>,
    /// CHECK: pure lamport recipient; verified against wager.maker in the handler,
    /// after the state check (see settle handler comment)
    #[account(mut)]
    pub maker: UncheckedAccount<'info>,
    /// CHECK: pure lamport recipient; verified against wager.taker in the handler,
    /// after the state check
    #[account(mut)]
    pub taker: UncheckedAccount<'info>,
    /// CHECK: canonical txoracle daily-roots PDA, verified in the handler against the
    /// epoch day derived from the submitted proof; contents verified by validate_stat.
    pub daily_scores_roots: UncheckedAccount<'info>,
    /// CHECK: pinned to the txoracle program id
    #[account(address = TXORACLE_ID)]
    pub txoracle_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(
        mut,
        seeds = [WAGER_SEED, wager.maker.as_ref(), &wager.wager_id.to_le_bytes()],
        bump = wager.bump
    )]
    pub wager: Account<'info, Wager>,
    #[account(mut, seeds = [VAULT_SEED, wager.key().as_ref()], bump = wager.vault_bump)]
    pub vault: SystemAccount<'info>,
    /// CHECK: pure lamport recipient; verified against wager.maker in the handler
    #[account(mut)]
    pub maker: UncheckedAccount<'info>,
    /// CHECK: pure lamport recipient; verified against wager.taker in the handler,
    /// Active branch only — an Open wager has no taker
    #[account(mut)]
    pub taker: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum WagerError {
    #[msg("Stake below minimum")]
    StakeTooSmall,
    #[msg("Expiry must be in the future")]
    ExpiryInPast,
    #[msg("Terms are not a predicate validate_stat can evaluate")]
    InvalidTerms,
    #[msg("Wager is not open for acceptance")]
    WagerNotOpen,
    #[msg("Wager is not active")]
    WagerNotActive,
    #[msg("Proof is for a different fixture")]
    FixtureMismatch,
    #[msg("Proven stat keys do not match wager terms")]
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
    #[msg("txoracle returned no verdict")]
    MissingOracleReturn,
    #[msg("Wager not yet expired")]
    NotExpired,
    #[msg("Wager already settled or refunded")]
    WagerNotRefundable,
    #[msg("Passed maker/taker account does not match the wager parties")]
    PartyMismatch,
}
