// Marshalling for validate_stat_v3: prove several stats in one transaction with one compressed
// Merkle multiproof.
//
// WHY V3 MATTERS
//
// validate_stat proves one or two stats and carries a separate sibling path for each. Proving a
// whole prop board that way costs a transaction per market. V3 replaces the per-leaf paths with a
// single multiproof: the leaves being proven share the hashes they have in common, and the
// `indices` say where each leaf sits, so the shared internal nodes are sent once instead of once
// per leaf. In the live package for a settled match the per-leaf `statProof` arrays come back
// empty and four `multiproof.hashes` cover both leaves, which is the compression doing its job.
//
// The practical result is that the match result, the totals and the other goal-derived props on
// one fixture can settle together against a single root check, rather than one transaction each.
//
// A NOTE ON WHERE THE IDL CAME FROM
//
// The IDL published on-chain for the oracle is stale: it lists neither validate_stat_v2 nor v3,
// because upgrading an Anchor program does not update its IDL account unless that is done as a
// separate step. The instruction is on the deployed program regardless. The authoritative IDL is
// the one TxODDS ships in their repo, kept at local/txoracle-devnet-idl-v3.json and gitignored
// because it is their asset.
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export const b32 = (a) => Array.from(Buffer.from(a));
export const nodes = (ns) => (ns ?? []).map((n) => ({ hash: b32(n.hash), isRightSibling: !!n.isRightSibling }));

/** The batch summary, in the oracle's own field order. */
export function summaryArg(pkg) {
  const s = pkg.summary;
  return {
    fixtureId: new BN(s.fixtureId),
    updateStats: {
      updateCount: Number(s.updateStats.updateCount),
      minTimestamp: new BN(s.updateStats.minTimestamp),
      maxTimestamp: new BN(s.updateStats.maxTimestamp),
    },
    // The program's field is events_sub_tree_root; the API calls the same value
    // eventStatsSubTreeRoot. Naming the key after the API serialises it into the wrong field, the
    // summary then hashes to something that is not in the tree, and the program rejects it as
    // InvalidMainTreeProof, which reads like a bad proof rather than a bad field name.
    eventsSubTreeRoot: b32(s.eventStatsSubTreeRoot),
  };
}

/**
 * The whole StatValidationInputV3. `leaves` keeps each stat next to its own proof, which is empty
 * under V3 because the shared multiproof carries those hashes instead. `leafIndices` is what ties
 * each leaf to its position in the tree, so order matters and must match `leaves`.
 */
export function payloadArg(pkg) {
  return {
    // The batch's minTimestamp, not the package's own `ts`. The program derives the roots account
    // from the timestamp it is given and checks it against the one inside the payload, so the two
    // must be the same value. Passing the package ts here while deriving the PDA from the batch
    // start is what TimestampMismatch is reporting.
    ts: new BN(tsOf(pkg)),
    fixtureSummary: summaryArg(pkg),
    fixtureProof: nodes(pkg.subTreeProof),
    mainTreeProof: nodes(pkg.mainTreeProof),
    eventStatRoot: b32(pkg.eventStatRoot),
    leaves: (pkg.statsToProve ?? []).map((l) => ({
      stat: { key: Number(l.stat.key), value: Number(l.stat.value), period: Number(l.stat.period) },
      statProof: nodes(l.statProof),
    })),
    multiproofHashes: nodes(pkg.multiproof?.hashes),
    leafIndices: (pkg.multiproof?.indices ?? []).map(Number),
  };
}

/** Compare one proven stat against a threshold. `index` is its position in `leaves`. */
export const single = (index, threshold, comparison = "greaterThan") => ({
  single: { index, predicate: { threshold, comparison: { [comparison]: {} } } },
});

/**
 * A strategy is how the oracle turns proven stats into a yes or no. `discretePredicates` is the
 * part fischio uses: a list of comparisons over the proven leaves, so several markets can be
 * judged from the same proof. The geometric fields are for distance-style predictions and stay
 * empty here rather than being filled with something meaningless.
 */
export const strategyArg = ({ discrete = [], geometric = [], distance = null } = {}) => ({
  geometricTargets: geometric,
  distancePredicate: distance,
  discretePredicates: discrete,
});

/**
 * The one timestamp V3 is keyed on: the batch's minTimestamp from the validation response.
 *
 * It is used twice, and it has to be the same value both times, because the program derives the
 * roots account from the timestamp it is handed and then checks that against the timestamp inside
 * the payload. Deriving the account from one and sending the other is what TimestampMismatch
 * means.
 */
export const tsOf = (pkg) => Number(pkg.summary.updateStats.minTimestamp);

/**
 * Which day's roots account this package belongs to.
 *
 * V3 reads the same `daily_scores_roots` account as V1 and V2, so there is no separate V3 roots
 * account to derive. Same seed, same epoch-day encoding, keyed on the timestamp above.
 */
export const epochDayOf = (pkg) => Math.floor(tsOf(pkg) / 86_400_000);

export function scoresRootsPda(programId, epochDay) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)],
    programId
  )[0];
}

/** A one-line description of what a package actually claims, for logs. */
export const describe = (pkg) =>
  (pkg.statsToProve ?? []).map((l) => `key ${l.stat.key} = ${l.stat.value} (period ${l.stat.period})`).join(", ");
