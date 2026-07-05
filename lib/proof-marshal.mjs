// Shared marshalling: TxLINE stat-validation API package -> wc-settle settle() args.
// Shapes verified against the deployed devnet txoracle IDL (day1/txoracle-devnet-idl.json).
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export const TXORACLE_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

/// Terminal game phases carried inside the proven leaf: 5 = full time, 10 = after ET,
/// 13 = after penalties. Must match TERMINAL_PERIODS in programs/wc-settle/src/state.rs.
export const TERMINAL_PERIODS = [5, 10, 13];

export const b32 = (a) => Array.from(Buffer.from(a));
export const nodes = (ns) => ns.map((n) => ({ hash: b32(n.hash), isRightSibling: n.isRightSibling }));

export function summaryOf(pkg) {
  return {
    fixtureId: new BN(pkg.summary.fixtureId),
    updateStats: {
      updateCount: pkg.summary.updateStats.updateCount,
      minTimestamp: new BN(pkg.summary.updateStats.minTimestamp),
      maxTimestamp: new BN(pkg.summary.updateStats.maxTimestamp),
    },
    eventsSubTreeRoot: b32(pkg.summary.eventStatsSubTreeRoot),
  };
}

export const statA = (pkg) => ({
  statToProve: pkg.statToProve,
  eventStatRoot: b32(pkg.eventStatRoot),
  statProof: nodes(pkg.statProof),
});

export const statB = (pkg) => ({
  statToProve: pkg.statToProve2,
  eventStatRoot: b32(pkg.eventStatRoot),
  statProof: nodes(pkg.statProof2),
});

export const epochDayOf = (pkg) => Math.floor(pkg.summary.updateStats.minTimestamp / 86_400_000);

export function rootsPda(epochDay) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)],
    TXORACLE_ID
  )[0];
}
