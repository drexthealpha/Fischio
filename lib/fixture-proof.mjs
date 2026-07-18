// Marshalling for validate_fixture: prove a match is a real fixture, with those teams and that
// kickoff, before anyone stakes a cent on it.
//
// WHY THIS IS THE THIRD PROOF AND NOT AN AFTERTHOUGHT
//
// fischio can prove the price and prove the result. Both of those answer questions about a
// match that everyone already agrees exists. Nothing yet proves the match itself.
//
// That gap is real. An operator who invents a fixture, takes stakes on it, and then settles it
// from a genuine proof of some other match has defrauded you without ever forging a hash. Until
// now fischio read its own bundled schedule and asked you to believe it. This closes that: the
// fixture, its two teams, its competition and its kickoff time all fold into a root TxODDS
// published, and the oracle checks them.
//
// THE TRAP IN THE PAYLOAD
//
// The snapshot's FixtureId is not the fixture id you know. For the World Cup final the summary
// says 18257739 and the snapshot says 281474994968395, which is exactly 2^48 + 18257739. The
// feed hands back a tagged id, and that tagged value is what went into the leaf. Helpfully
// "correcting" it to the id in your own database changes the hash and the proof fails, with an
// error that says nothing about ids. Pass every field back exactly as it arrived.
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export const TXORACLE_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

export const b32 = (a) => Array.from(Buffer.from(a));
export const nodes = (ns) => (ns ?? []).map((n) => ({ hash: b32(n.hash), isRightSibling: n.isRightSibling }));

/**
 * The Fixture record. Anchor camel-cases the IDL's snake_case; TxLINE sends PascalCase.
 * Every field goes back untouched, including the tagged FixtureId described above.
 */
export function fixtureSnapshotArg(pkg) {
  const f = pkg.snapshot;
  return {
    ts: new BN(f.Ts),
    startTime: new BN(f.StartTime),
    competition: f.Competition,
    competitionId: Number(f.CompetitionId),
    fixtureGroupId: Number(f.FixtureGroupId),
    participant1Id: Number(f.Participant1Id),
    participant1: f.Participant1,
    participant2Id: Number(f.Participant2Id),
    participant2: f.Participant2,
    fixtureId: new BN(f.FixtureId),
    participant1IsHome: !!f.Participant1IsHome,
  };
}

/** The batch summary carrying the sub-tree root this fixture folds into. */
export function fixtureSummaryArg(pkg) {
  const s = pkg.summary;
  return {
    fixtureId: new BN(s.fixtureId),
    competitionId: Number(s.competitionId),
    competition: s.competition,
    updateStats: {
      updateCount: Number(s.updateStats.updateCount),
      minTimestamp: new BN(s.updateStats.minTimestamp),
      maxTimestamp: new BN(s.updateStats.maxTimestamp),
    },
    updateSubTreeRoot: b32(s.updateSubTreeRoot),
  };
}

/** Every argument validate_fixture needs, in order, from one validation package. */
export const validateFixtureArgs = (pkg) => [
  fixtureSnapshotArg(pkg),
  fixtureSummaryArg(pkg),
  nodes(pkg.subTreeProof),
  nodes(pkg.mainTreeProof),
];

/** Which day's batch this package belongs to. */
export const fixtureEpochDayOf = (pkg) => Math.floor(Number(pkg.summary.updateStats.minTimestamp) / 86_400_000);

/**
 * The fixtures roots account. One per ten-day block, which is what "ten daily" means: the
 * account keyed 20640 covers epoch days 20640 through 20649.
 *
 * Unlike the odds and scores roots, this is not per-day, and the seed is in neither the IDL nor
 * any documentation. Finding it took three steps worth recording, because the same three work
 * for any undocumented Anchor account:
 *
 *   1. Enumerate what the program owns and group by the Anchor discriminator, which is the
 *      first eight bytes of sha256("account:<StructName>"). That narrowed 3401 accounts to the
 *      49 of this type.
 *   2. Call the instruction with a deliberately wrong account. Anchor's ConstraintSeeds error
 *      prints the address it expected, so the program hands you the answer for one input.
 *   3. Sweep the u16 space against the real account set to recover the formula rather than
 *      hardcode the one address. All 49 indices came back multiples of ten.
 *
 * The program constrains the address itself, so a wrong account fails loudly instead of proving
 * something false.
 */
export const TEN_DAY_BLOCK = 10;
export const fixturesRootsPda = (epochDay) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("ten_daily_fixtures_roots"), new BN(Math.floor(epochDay / TEN_DAY_BLOCK) * TEN_DAY_BLOCK).toArrayLike(Buffer, "le", 2)],
    TXORACLE_ID
  )[0];

// ---- validate_fixture_batch: prove an entire hour of the schedule in one proof --------------
//
// validate_fixture proves one match. validate_fixture_batch proves every fixture published in an
// hour against the same ten-day roots account, in a single call. The package from
// /api/fixtures/batch-validation carries only the batch metadata and the Merkle proof; the
// caller supplies the index of the hour within the account.

/** The batch metadata. camelCase from the feed, snake_case in the program. */
export function batchMetadataArg(pkg) {
  const m = pkg.metadata;
  return {
    totalUpdateCount: Number(m.totalUpdateCount),
    numUniqueFixtures: Number(m.numUniqueFixtures),
    overallBatchStartTs: new BN(m.overallBatchStartTs),
    overallBatchEndTs: new BN(m.overallBatchEndTs),
  };
}

/** Which day and hour a batch package covers, read from its own start timestamp. */
export function batchEpochDayHour(pkg) {
  const ts = Number(pkg.metadata.overallBatchStartTs);
  return { epochDay: Math.floor(ts / 86_400_000), hourOfDay: Math.floor((ts % 86_400_000) / 3_600_000) };
}

/**
 * The u8 index that selects this hour's root inside the ten-day account. It is not in the
 * package, so it is derived from the batch's own day and hour. The account holds ten days, each
 * day carrying twenty-four hourly roots, so the slot is the day's offset in the block times
 * twenty-four plus the hour. Proven by landing the transaction; a wrong index fails the fold.
 */
export function batchIndex(pkg) {
  const { epochDay, hourOfDay } = batchEpochDayHour(pkg);
  return ((epochDay % TEN_DAY_BLOCK) * 24 + hourOfDay) & 0xff;
}

/** Every argument validate_fixture_batch needs, in order. */
export const validateFixtureBatchArgs = (pkg, index = batchIndex(pkg)) => [
  index,
  batchMetadataArg(pkg),
  nodes(pkg.proof),
];

/** A one-line description of what a package claims, for logs and receipts. */
export const describeFixture = (pkg) => {
  const f = pkg.snapshot;
  const ko = new Date(Number(f.StartTime)).toISOString().replace("T", " ").slice(0, 16);
  return `${f.Participant1} v ${f.Participant2}, ${f.Competition}, kickoff ${ko}Z`;
};
