//! Minimal mirror of the txoracle types needed to CPI into `validate_stat`.
//!
//! Byte-identical to the deployed devnet IDL (program
//! 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J). Borsh encodes structs by field order
//! and enums by declaration index, so reordering here would settle the wrong outcome.
//! This is the same verified module wc-settle uses; the market program CPIs the same way.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke},
};

use crate::MarketError;

pub const TXORACLE_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

/// From the on-chain IDL (`instructions[].discriminator`), not recomputed locally.
pub const VALIDATE_STAT_DISC: [u8; 8] = [107, 197, 232, 90, 191, 136, 105, 185];

pub const DAILY_SCORES_ROOTS_SEED: &[u8] = b"daily_scores_roots";
/// TxLINE epoch days are derived from millisecond timestamps (verified live).
pub const MS_PER_DAY: i64 = 86_400_000;

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Comparison {
    GreaterThan, // index 0
    LessThan,    // index 1
    EqualTo,     // index 2
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BinaryExpression {
    Add,      // index 0
    Subtract, // index 1
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug)]
pub struct TraderPredicate {
    pub threshold: i32,
    pub comparison: Comparison,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct ScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32, // game-phase code of the proven update; part of the hashed leaf
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatTerm {
    pub stat_to_prove: ScoreStat,
    pub event_stat_root: [u8; 32],
    pub stat_proof: Vec<ProofNode>,
}

/// Args in exact IDL order for `validate_stat`.
#[derive(AnchorSerialize)]
pub struct ValidateStatArgs {
    pub ts: i64,
    pub fixture_summary: ScoresBatchSummary,
    pub fixture_proof: Vec<ProofNode>,
    pub main_tree_proof: Vec<ProofNode>,
    pub predicate: TraderPredicate,
    pub stat_a: StatTerm,
    pub stat_b: Option<StatTerm>,
    pub op: Option<BinaryExpression>,
}

/// CPI into txoracle validate_stat; returns the oracle's bool verdict. Any invalid proof
/// aborts the whole transaction inside the oracle, so a market can never resolve on
/// unverified data.
pub fn cpi_validate_stat<'info>(
    daily_scores_roots: &AccountInfo<'info>,
    txoracle_program: &AccountInfo<'info>,
    args: &ValidateStatArgs,
) -> Result<bool> {
    let mut data = Vec::with_capacity(1024);
    data.extend_from_slice(&VALIDATE_STAT_DISC);
    args.serialize(&mut data)?;

    let ix = Instruction {
        program_id: TXORACLE_ID,
        accounts: vec![AccountMeta::new_readonly(daily_scores_roots.key(), false)],
        data,
    };
    invoke(&ix, &[daily_scores_roots.clone(), txoracle_program.clone()])?;

    let (pid, ret) = get_return_data().ok_or(MarketError::MissingOracleReturn)?;
    require_keys_eq!(pid, TXORACLE_ID, MarketError::MissingOracleReturn);
    require!(ret.len() == 1, MarketError::MissingOracleReturn);
    Ok(ret[0] == 1)
}
