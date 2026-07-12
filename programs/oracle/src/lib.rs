//! fischio-oracle: an optimistic oracle for markets with no cryptographic proof source.
//!
//! Sports resolve by TxLINE proof; everything else (politics, culture) has no signed data
//! feed, so it resolves optimistically, the way UMA does. Someone asserts an outcome and
//! posts a bond. If no one disputes within the window, it stands and the asserter reclaims
//! the bond. If disputed, the arbiter decides, and the loser's bond pays the winner. A
//! market reads `resolved_outcome` once state is Resolved.
//!
//! Every proposer has a permissionless, on-chain accuracy record (ProposerStats), updated on
//! every resolution. That is the curation ingredient real optimistic oracles converged on
//! after running fully open: UMA restricted Polymarket's proposers to an accuracy-gated
//! allowlist in November 2025 after spam and gamesmanship on the fully-open version, cutting
//! incorrect proposals 59% and disputes 68%. Proposing here stays permissionless (bond-gated,
//! same as before), but the accuracy record is real and on-chain, so a UI or a future
//! instruction can gate on it without trusting anyone's off-chain claim.
//!
//! The arbiter used to be named by the asserter themselves at assert time, which let a
//! dishonest asserter nominate their own accomplice to judge any dispute against them. That
//! was a real bug, not a documented trust assumption, and it's fixed here: the arbiter is
//! now a single protocol-wide `OracleConfig`, set once by whoever calls `init_config` first
//! and immutable after that, the same first-mover-wins pattern every other PDA in this
//! codebase already uses. No one can pick their own judge anymore.
//!
//! This is the resolution-breadth piece: with proof settlement for sports and this for
//! everything else, fischio can resolve any market Polymarket can.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("HUXM89x5Uxex2XfTh58i2xXzroeULgtuq7w3tT7zzYpJ");

pub const ASSERTION_SEED: &[u8] = b"assertion";
pub const VAULT_SEED: &[u8] = b"bond_vault";
pub const CONFIG_SEED: &[u8] = b"config";
pub const PROPOSER_SEED: &[u8] = b"proposer";
pub const MIN_WINDOW: i64 = 60; // at least a minute to dispute

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AssertionState {
    Proposed,
    Disputed,
    Resolved,
}

#[program]
pub mod fischio_oracle {
    use super::*;

    /// Set the protocol-wide arbiter, once. Permissionless, but Anchor's `init` constraint
    /// means only the first call can ever succeed; every call after that fails with an
    /// already-initialized error, so this is a one-time setup step, not an ongoing authority.
    pub fn init_config(ctx: Context<InitConfig>, arbiter: Pubkey) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.arbiter = arbiter;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// Create a proposer's accuracy record. Permissionless, one per wallet, required before
    /// that wallet can assert an outcome.
    pub fn init_proposer_stats(ctx: Context<InitProposerStats>) -> Result<()> {
        let p = &mut ctx.accounts.stats;
        p.proposer = ctx.accounts.proposer.key();
        p.correct = 0;
        p.total = 0;
        p.bump = ctx.bumps.stats;
        Ok(())
    }

    /// Assert an outcome for a question and post a bond. Starts the dispute window.
    pub fn assert_outcome(
        ctx: Context<Assert>,
        question_id: [u8; 32],
        proposed_outcome: u8,
        bond: u64,
        window_secs: i64,
    ) -> Result<()> {
        require!(bond > 0, OracleError::ZeroBond);
        require!(window_secs >= MIN_WINDOW, OracleError::WindowTooShort);
        let now = Clock::get()?.unix_timestamp;

        token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer {
            from: ctx.accounts.asserter_token.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.asserter.to_account_info(),
        }), bond)?;

        let a = &mut ctx.accounts.assertion;
        a.question_id = question_id;
        a.asserter = ctx.accounts.asserter.key();
        a.bond_mint = ctx.accounts.bond_mint.key();
        a.bond = bond;
        a.proposed_outcome = proposed_outcome;
        a.propose_ts = now;
        a.window_secs = window_secs;
        a.disputer = Pubkey::default();
        a.state = AssertionState::Proposed;
        a.resolved_outcome = 0;
        a.claimed = false;
        a.bump = ctx.bumps.assertion;
        Ok(())
    }

    /// Dispute an assertion within the window by posting an equal bond.
    pub fn dispute(ctx: Context<Dispute>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let (bond, deadline) = {
            let a = &ctx.accounts.assertion;
            require!(a.state == AssertionState::Proposed, OracleError::NotDisputable);
            (a.bond, a.propose_ts + a.window_secs)
        };
        require!(now < deadline, OracleError::WindowClosed);

        token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer {
            from: ctx.accounts.disputer_token.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.disputer.to_account_info(),
        }), bond)?;

        let a = &mut ctx.accounts.assertion;
        a.disputer = ctx.accounts.disputer.key();
        a.state = AssertionState::Disputed;
        Ok(())
    }

    /// After the window, if undisputed, the assertion stands. Permissionless. An unchallenged
    /// stand counts as a correct proposal for the asserter's accuracy record, the same way an
    /// undisputed UMA assertion is treated as accepted-true.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = &mut ctx.accounts.assertion;
        require!(a.state == AssertionState::Proposed, OracleError::NotSettleable);
        require!(now >= a.propose_ts + a.window_secs, OracleError::WindowOpen);
        a.state = AssertionState::Resolved;
        a.resolved_outcome = a.proposed_outcome;

        let p = &mut ctx.accounts.proposer_stats;
        p.total += 1;
        p.correct += 1;
        Ok(())
    }

    /// Resolve a disputed assertion. Only the protocol arbiter from `OracleConfig`, never a
    /// per-assertion choice. Updates the original proposer's accuracy record: correct if the
    /// arbiter's outcome matches what they proposed, wrong otherwise.
    pub fn arbitrate(ctx: Context<Arbitrate>, outcome: u8) -> Result<()> {
        require_keys_eq!(ctx.accounts.arbiter.key(), ctx.accounts.config.arbiter, OracleError::NotArbiter);
        let a = &mut ctx.accounts.assertion;
        require!(a.state == AssertionState::Disputed, OracleError::NotDisputed);
        let was_correct = outcome == a.proposed_outcome;
        a.state = AssertionState::Resolved;
        a.resolved_outcome = outcome;

        let p = &mut ctx.accounts.proposer_stats;
        p.total += 1;
        if was_correct { p.correct += 1; }
        Ok(())
    }

    /// Claim the bond(s). Undisputed: the asserter reclaims their bond. Disputed: whoever
    /// called it right (asserter if the resolved outcome matches their proposal, else the
    /// disputer) takes both bonds.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let (winner, payout, bond, disputed, asserter, disputer, proposed, resolved, mint, bump, qid) = {
            let a = &ctx.accounts.assertion;
            require!(a.state == AssertionState::Resolved, OracleError::NotResolved);
            require!(!a.claimed, OracleError::AlreadyClaimed);
            let disputed = a.disputer != Pubkey::default();
            let winner = if !disputed {
                a.asserter
            } else if a.resolved_outcome == a.proposed_outcome {
                a.asserter
            } else {
                a.disputer
            };
            let payout = if disputed { a.bond.checked_mul(2).ok_or(OracleError::Overflow)? } else { a.bond };
            (winner, payout, a.bond, disputed, a.asserter, a.disputer, a.proposed_outcome, a.resolved_outcome, a.bond_mint, a.bump, a.question_id)
        };
        let _ = (bond, disputed, asserter, disputer, proposed, resolved, mint);
        require_keys_eq!(ctx.accounts.claimant.key(), winner, OracleError::NotWinner);

        let seeds: &[&[u8]] = &[ASSERTION_SEED, qid.as_ref(), &[bump]];
        token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.claimant_token.to_account_info(),
            authority: ctx.accounts.assertion.to_account_info(),
        }, &[seeds]), payout)?;

        ctx.accounts.assertion.claimed = true;
        Ok(())
    }
}

/// Protocol-wide arbiter. Set once via `init_config`; nothing in this program can ever
/// change it afterward, so there is no ongoing admin authority, only a one-time setup value.
#[account]
#[derive(InitSpace)]
pub struct OracleConfig {
    pub arbiter: Pubkey,
    pub bump: u8,
}

/// A proposer's permissionless, on-chain accuracy record: how many of their assertions stood
/// or were upheld versus how many they made in total. Curation infrastructure, not a gate by
/// itself yet; that threshold is a policy decision for a later instruction, not invented here.
#[account]
#[derive(InitSpace)]
pub struct ProposerStats {
    pub proposer: Pubkey,
    pub correct: u32,
    pub total: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Assertion {
    pub question_id: [u8; 32],
    pub asserter: Pubkey,
    pub disputer: Pubkey, // default until disputed
    pub bond_mint: Pubkey,
    pub bond: u64,
    pub proposed_outcome: u8,
    pub resolved_outcome: u8,
    pub propose_ts: i64,
    pub window_secs: i64,
    pub state: AssertionState,
    pub claimed: bool,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: recorded as the protocol arbiter; not signing here, only in `arbitrate`
    pub arbiter: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + OracleConfig::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, OracleConfig>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitProposerStats<'info> {
    #[account(mut)]
    pub proposer: Signer<'info>,
    #[account(init, payer = proposer, space = 8 + ProposerStats::INIT_SPACE,
        seeds = [PROPOSER_SEED, proposer.key().as_ref()], bump)]
    pub stats: Box<Account<'info, ProposerStats>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(question_id: [u8; 32])]
pub struct Assert<'info> {
    #[account(mut)]
    pub asserter: Signer<'info>,
    #[account(seeds = [PROPOSER_SEED, asserter.key().as_ref()], bump = proposer_stats.bump)]
    pub proposer_stats: Box<Account<'info, ProposerStats>>,
    #[account(init, payer = asserter, space = 8 + Assertion::INIT_SPACE,
        seeds = [ASSERTION_SEED, question_id.as_ref()], bump)]
    pub assertion: Box<Account<'info, Assertion>>,
    pub bond_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = asserter, seeds = [VAULT_SEED, assertion.key().as_ref()], bump,
        token::mint = bond_mint, token::authority = assertion)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = bond_mint, token::authority = asserter)]
    pub asserter_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Dispute<'info> {
    #[account(mut)]
    pub disputer: Signer<'info>,
    #[account(mut, seeds = [ASSERTION_SEED, assertion.question_id.as_ref()], bump = assertion.bump)]
    pub assertion: Box<Account<'info, Assertion>>,
    #[account(mut, seeds = [VAULT_SEED, assertion.key().as_ref()], bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = assertion.bond_mint, token::authority = disputer)]
    pub disputer_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut, seeds = [ASSERTION_SEED, assertion.question_id.as_ref()], bump = assertion.bump)]
    pub assertion: Box<Account<'info, Assertion>>,
    #[account(mut, seeds = [PROPOSER_SEED, assertion.asserter.as_ref()], bump = proposer_stats.bump)]
    pub proposer_stats: Box<Account<'info, ProposerStats>>,
}

#[derive(Accounts)]
pub struct Arbitrate<'info> {
    pub arbiter: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, OracleConfig>>,
    #[account(mut, seeds = [ASSERTION_SEED, assertion.question_id.as_ref()], bump = assertion.bump)]
    pub assertion: Box<Account<'info, Assertion>>,
    #[account(mut, seeds = [PROPOSER_SEED, assertion.asserter.as_ref()], bump = proposer_stats.bump)]
    pub proposer_stats: Box<Account<'info, ProposerStats>>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    pub claimant: Signer<'info>,
    #[account(mut, seeds = [ASSERTION_SEED, assertion.question_id.as_ref()], bump = assertion.bump)]
    pub assertion: Box<Account<'info, Assertion>>,
    #[account(mut, seeds = [VAULT_SEED, assertion.key().as_ref()], bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = assertion.bond_mint, token::authority = claimant)]
    pub claimant_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum OracleError {
    #[msg("Bond must be greater than zero")]
    ZeroBond,
    #[msg("Dispute window is too short")]
    WindowTooShort,
    #[msg("Assertion is not open to dispute")]
    NotDisputable,
    #[msg("Dispute window has closed")]
    WindowClosed,
    #[msg("Assertion is not settleable")]
    NotSettleable,
    #[msg("Dispute window is still open")]
    WindowOpen,
    #[msg("Assertion is not disputed")]
    NotDisputed,
    #[msg("Only the protocol arbiter can resolve a dispute")]
    NotArbiter,
    #[msg("Assertion is not resolved")]
    NotResolved,
    #[msg("Bonds already claimed")]
    AlreadyClaimed,
    #[msg("Only the winner can claim")]
    NotWinner,
    #[msg("Arithmetic overflow")]
    Overflow,
}
