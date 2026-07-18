// Marshalling for validate_odds: turn a TxLINE odds-validation package into the arguments the
// deployed txoracle expects, so a price can be proven on-chain.
//
// WHY THIS EXISTS
//
// fischio could already prove the result of a match. It could not prove the price you traded
// at. Every prediction market shows you odds and asks you to believe they came from a real
// book. TxODDS anchors its odds on Solana the same way it anchors scores, and the oracle
// exposes validate_odds against that root, so the price can carry a proof too.
//
// SHAPES, ALL VERIFIED AGAINST THE DEPLOYED PROGRAM AND THE LIVE FEED
//
//   validate_odds(ts, odds_snapshot, summary, sub_tree_proof, main_tree_proof)
//   account: daily_odds_merkle_roots
//
// GET /api/odds/validation?messageId=..&ts=.. returns { odds, summary, subTreeProof,
// mainTreeProof }, which maps one-to-one onto those arguments. messageId and ts come off any
// odds row, so every market in the catalogue carries its own proof handle.
//
// The roots account is NOT declared as a PDA in the IDL, so it has to be derived. The seed is
// not documented either. It was found by deriving candidates and checking which account
// actually exists on devnet: "daily_batch_roots" + epochDay as a little-endian u16, which
// resolves to a live 9232-byte account owned by the oracle. That mirrors the scores side,
// where validate_stat reads "daily_scores_roots" + the same epochDay encoding.
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export const TXORACLE_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

export const b32 = (a) => Array.from(Buffer.from(a));
export const nodes = (ns) => (ns ?? []).map((n) => ({ hash: b32(n.hash), isRightSibling: n.isRightSibling }));

/**
 * The Odds record itself. Anchor camel-cases the snake_case IDL fields; TxLINE sends them
 * PascalCase, so this is where the two naming worlds meet.
 *
 * gameState, marketParameters and marketPeriod are Option<String> on-chain. A full-match 1X2
 * has no period and no line, so those arrive as null and must stay null rather than becoming
 * the empty string, which would hash to a different leaf and fail the proof.
 */
export function oddsSnapshotArg(pkg) {
  const o = pkg.odds;
  return {
    fixtureId: new BN(o.FixtureId),
    messageId: o.MessageId,
    ts: new BN(o.Ts),
    bookmaker: o.Bookmaker,
    bookmakerId: Number(o.BookmakerId),
    superOddsType: o.SuperOddsType,
    gameState: o.GameState ?? null,
    inRunning: !!o.InRunning,
    marketParameters: o.MarketParameters ?? null,
    marketPeriod: o.MarketPeriod ?? null,
    priceNames: o.PriceNames ?? [],
    prices: (o.Prices ?? []).map(Number),
  };
}

/** The batch summary carrying the sub-tree root this odds record folds into. */
export function oddsSummaryArg(pkg) {
  const s = pkg.summary;
  return {
    fixtureId: new BN(s.fixtureId),
    updateStats: {
      updateCount: Number(s.updateStats.updateCount),
      minTimestamp: new BN(s.updateStats.minTimestamp),
      maxTimestamp: new BN(s.updateStats.maxTimestamp),
    },
    oddsSubTreeRoot: b32(s.oddsSubTreeRoot),
  };
}

/** Which day's root account this package belongs to, taken from the batch it was in. */
export const oddsEpochDayOf = (pkg) => Math.floor(Number(pkg.summary.updateStats.minTimestamp) / 86_400_000);

/** The daily odds roots account. Seed confirmed by probing devnet, not by documentation. */
export function oddsRootsPda(epochDay) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("daily_batch_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)],
    TXORACLE_ID
  )[0];
}

/** Every argument validate_odds needs, in order, from one validation package. */
export function validateOddsArgs(pkg) {
  return [
    new BN(pkg.odds.Ts),
    oddsSnapshotArg(pkg),
    oddsSummaryArg(pkg),
    nodes(pkg.subTreeProof),
    nodes(pkg.mainTreeProof),
  ];
}

/** A one-line description of what a package actually claims, for logs and receipts. */
export function describeOdds(pkg) {
  const o = pkg.odds;
  const pct = (o.Prices ?? []).map((p) => (p > 0 ? (100000 / p).toFixed(1) + "%" : "NA"));
  const parts = (o.PriceNames ?? []).map((n, i) => `${n} ${pct[i]}`);
  return `${o.SuperOddsType}${o.MarketPeriod ? ` ${o.MarketPeriod}` : ""}${o.MarketParameters ? ` ${o.MarketParameters}` : ""}: ${parts.join(" / ")} (${o.Bookmaker})`;
}
