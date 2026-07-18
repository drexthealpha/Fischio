// Reading the scores feed: what the score is, and which moment a market settles on.
//
// THE ONE IDEA THAT MAKES THIS FEED MAKE SENSE
//
// Every score update carries a StatusId, which is the state of the match at that moment. When
// you ask for a Merkle proof of a statistic at some sequence, the leaf you get back carries a
// `period` field, and that period is the same number as the StatusId of that row. Measured on
// two real semi-finals, at every sequence: period === StatusId.
//
// That is what ties a proof to a moment. The on-chain settlement program will only accept a
// proof whose period is a terminal one, so choosing the sequence to prove is the same act as
// choosing what moment the market settles on.
//
// THE TRAPS, EACH FOUND BY READING THE LIVE FEED
//
// 1. GameState never changes. Every row says "scheduled", including rows from a match that
//    finished two days ago with 963 updates behind it. It parses, it never throws, and it is
//    always wrong. StatusId is the real state, and it only appears on some rows.
//
// 2. Stats is a flat map, not a list. It arrives as {"1":1,"2":2,"1001":0,...}, where the key
//    encodes the period and the statistic together as period*1000 + stat. So "1" is full-match
//    goals for the first participant and "1001" is that same figure in the first half. Nothing
//    in this payload has the {key, value, period} shape the on-chain proof uses.
//
// 3. The end of the match is not the end of the feed. A match reaches full time at StatusId 5,
//    and then keeps sending updates: an admin finalisation at StatusId 100, and after that
//    things like disconnect notices carrying no status at all. The final whistle on England v
//    Argentina is sequence 959, the finalisation is 962, and the newest row is 963.
//
//    This is the trap that costs money. Proving sequence 962 returns a leaf with period 100,
//    and 100 is not a terminal period, so settlement rejects it. Proving 963 returns period 0.
//    Both carry the correct score of 1-2, so the numbers look right the whole way down, and
//    only the settlement transaction fails, long after the code that chose the sequence ran.
//
// 4. Full time and the end of the match are different moments in a knockout. A 1X2 market
//    settles on the score after ninety minutes, which is StatusId 5. A final that goes to extra
//    time carries on to StatusId 10, and to 13 after penalties, with a different score. Both
//    are terminal, and picking whichever appears first in the array settles some markets on the
//    wrong scoreline. The World Cup final can go to extra time, so this is not hypothetical.

/** Match state, as published in StatusId and mirrored in the proof leaf's `period`. */
export const STATUS = {
  PRE_MATCH: 1,
  FIRST_HALF: 2,
  HALF_TIME: 3,
  SECOND_HALF: 4,
  FULL_TIME: 5,        // ninety minutes are up; this is what a 1X2 market settles on
  ET_FIRST: 6,
  ET_SECOND: 7,
  AFTER_ET: 10,        // extra time is over
  PENALTIES: 11,
  AFTER_PENALTIES: 13, // the shoot-out is over
  FINALISED: 100,      // an administrative close that arrives after the match; NOT provable
};

/**
 * The states a settlement proof will be accepted for. Must stay in step with TERMINAL_PERIODS
 * in lib/proof-marshal.mjs and programs/wc-settle/src/state.rs, which is the on-chain gate.
 * Note that FINALISED is deliberately absent: it is the state the feed lands in after the
 * match, and a proof taken there carries period 100 and is rejected.
 */
export const TERMINAL = [STATUS.FULL_TIME, STATUS.AFTER_ET, STATUS.AFTER_PENALTIES];

/** Stat keys, as published. Odd numbers are the first participant, even the second. */
export const STAT = { P1_GOALS: 1, P2_GOALS: 2, P1_YELLOW: 3, P2_YELLOW: 4, P1_RED: 5, P2_RED: 6, P1_CORNERS: 7, P2_CORNERS: 8 };

/** Period prefixes inside the Stats map. A bare key with no prefix is the whole match. */
export const PERIOD = { MATCH: 0, FIRST_HALF: 1000, HALF_TIME: 2000, SECOND_HALF: 3000, ET_FIRST: 4000, ET_SECOND: 5000, PENALTIES: 6000, ET_TOTAL: 7000 };

/** Build the key the feed uses for one statistic in one period. */
export const statKey = (stat, period = PERIOD.MATCH) => period + stat;

const rowsOf = (snapshot) => (Array.isArray(snapshot) ? snapshot : snapshot ? [snapshot] : []);
const seqOf = (r) => Number(r?.Seq) || 0;
const hasStats = (r) => r?.Stats && typeof r.Stats === "object" && !Array.isArray(r.Stats) && Object.keys(r.Stats).length > 0;

/** Read one statistic off a row, or null when the feed has not published it. */
export function stat(row, key, period = PERIOD.MATCH) {
  const v = row?.Stats?.[String(statKey(key, period))];
  return v == null ? null : Number(v);
}

/** The newest row by sequence. Rows do not arrive in order, so never take the last of the array. */
export function latest(snapshot) {
  const rows = rowsOf(snapshot).filter((r) => seqOf(r) > 0);
  return rows.length ? rows.reduce((a, b) => (seqOf(b) > seqOf(a) ? b : a)) : null;
}

/** The newest row carrying a score. Most rows are comments and carry nothing. */
export function latestScored(snapshot) {
  const rows = rowsOf(snapshot).filter(hasStats);
  return rows.length ? rows.reduce((a, b) => (seqOf(b) > seqOf(a) ? b : a)) : null;
}

/** The match state now, or null before the feed has said anything. */
export function statusNow(snapshot) {
  const rows = rowsOf(snapshot).filter((r) => r.StatusId != null);
  return rows.length ? Number(rows.reduce((a, b) => (seqOf(b) > seqOf(a) ? b : a)).StatusId) : null;
}

/**
 * The newest row in a given state that also carries a score.
 *
 * Newest, and the choice matters. A state spans several sequences: England v Argentina reports
 * full time at both 959 and 961. Today those agree, so either would do.
 *
 * They stop agreeing when a result is corrected. A goal ruled out after the whistle is not an
 * edit of the old row, it is a new row restating full time with a different score. Taking the
 * first row in the state would then settle on a scoreline that has since been withdrawn, and
 * the proof would succeed, because that score really was published. Taking the newest means the
 * latest statement of what happened wins, which is the only reading that survives a correction.
 */
export function rowAtStatus(snapshot, statusId) {
  const rows = rowsOf(snapshot).filter((r) => Number(r.StatusId) === statusId && hasStats(r));
  return rows.length ? rows.reduce((a, b) => (seqOf(b) > seqOf(a) ? b : a)) : null;
}

/**
 * The row a 1X2 market settles on: the score after ninety minutes.
 *
 * Not the last terminal state. A final that goes to extra time reaches full time first, and the
 * 1X2 market is decided there. Reading the later state would settle it on a scoreline the
 * market was never about.
 */
export const fullTimeRow = (snapshot) => rowAtStatus(snapshot, STATUS.FULL_TIME);

/**
 * The row that says how the match actually ended, which is the last terminal state reached.
 * Use this for a question like who lifted the trophy, where penalties count.
 */
export function endRow(snapshot) {
  for (const s of [STATUS.AFTER_PENALTIES, STATUS.AFTER_ET, STATUS.FULL_TIME]) {
    const r = rowAtStatus(snapshot, s);
    if (r) return r;
  }
  return null;
}

/** Has this match reached full time? */
export const isFinal = (snapshot) => fullTimeRow(snapshot) != null;

/**
 * The score, and the sequence to prove it at.
 *
 * `seq` is the thing to be careful with. It is the sequence a settlement proof must be
 * requested for, and it is only valid when `final` is true, because only then does the leaf
 * carry a terminal period.
 *
 * p1 and p2 are the participants in the order the feed lists them. Which one is at home lives
 * on the fixture and Participant1IsHome can be false, so this does not call them home and away.
 */
export function readScore(snapshot, { at = STATUS.FULL_TIME } = {}) {
  const settleRow = at === STATUS.FULL_TIME ? fullTimeRow(snapshot) : rowAtStatus(snapshot, at);
  const row = settleRow ?? latestScored(snapshot);
  if (!row) return null;
  const p1 = stat(row, STAT.P1_GOALS), p2 = stat(row, STAT.P2_GOALS);
  if (p1 == null || p2 == null) return null;
  const end = endRow(snapshot);
  return {
    p1, p2,
    final: settleRow != null,
    seq: seqOf(row),                 // the sequence to request the proof for
    ts: Number(row.Ts) || null,
    status: row.StatusId != null ? Number(row.StatusId) : null,
    fixtureId: Number(row.FixtureId),
    // How the match ended, when that differs from the ninety-minute score.
    endedAt: end?.StatusId != null ? Number(end.StatusId) : null,
    wentToExtraTime: end != null && Number(end.StatusId) !== STATUS.FULL_TIME,
    extraTime: { p1: stat(row, STAT.P1_GOALS, PERIOD.ET_TOTAL), p2: stat(row, STAT.P2_GOALS, PERIOD.ET_TOTAL) },
    penalties: { p1: stat(row, STAT.P1_GOALS, PERIOD.PENALTIES), p2: stat(row, STAT.P2_GOALS, PERIOD.PENALTIES) },
    firstHalf: { p1: stat(row, STAT.P1_GOALS, PERIOD.FIRST_HALF), p2: stat(row, STAT.P2_GOALS, PERIOD.FIRST_HALF) },
    corners: { p1: stat(row, STAT.P1_CORNERS), p2: stat(row, STAT.P2_CORNERS) },
    yellow: { p1: stat(row, STAT.P1_YELLOW), p2: stat(row, STAT.P2_YELLOW) },
    red: { p1: stat(row, STAT.P1_RED), p2: stat(row, STAT.P2_RED) },
  };
}

/**
 * The team lineups, if the feed has published them. Returns [{ team, players: [{number, name,
 * starter}] }] for the two sides, or null before lineups are out (they appear about an hour
 * before kickoff). Names arrive "Last, First" and are flipped to reading order.
 *
 * This is display data, not settlement data. No player id enters a proof, so a lineup is shown
 * for the fan and never used to resolve a market.
 */
export function lineupsOf(snapshot) {
  const rows = rowsOf(snapshot).filter((r) => r.Action === "lineups" && Array.isArray(r.Lineups) && r.Lineups.length);
  if (!rows.length) return null;
  const row = rows.reduce((a, b) => (seqOf(b) > seqOf(a) ? b : a)); // the most recent lineups message
  const flip = (n) => { const p = String(n ?? "").split(", "); return p.length === 2 ? `${p[1]} ${p[0]}` : (n ?? "Unknown"); };
  const teams = row.Lineups.map((t) => ({
    team: t.preferredName ?? "Team",
    players: (t.lineups ?? [])
      .map((p) => ({ number: p.rosterNumber ?? "", name: flip(p.player?.preferredName), starter: !!p.starter }))
      .sort((a, b) => (b.starter - a.starter) || (Number(a.number) - Number(b.number))),
  }));
  return teams.some((t) => t.players.length) ? teams : null;
}

/** Which way the match went, in the terms the 1X2 market settles on. */
export function outcomeOf(score) {
  if (!score) return null;
  return score.p1 > score.p2 ? "P1" : score.p2 > score.p1 ? "P2" : "DRAW";
}

/**
 * The score records to settle or verify a result from, picking the right feed for the match's age.
 *
 * This exists because of how TxLINE serves a finished match, which is exactly when a judge tests
 * a settlement. The live stream and snapshot are for a match that is happening now. Once a match
 * is over, the stream sends nothing and the snapshot can go empty, so reading the result from
 * them returns "no score yet" precisely when someone tries to check a completed game. The record
 * of a finished match lives at /api/scores/historical, which carries the full sequence and the
 * real Seq the proof is bound to, for matches that started between two weeks and six hours ago.
 *
 * So: take the snapshot while the match is live or just ended, and fall back to historical once
 * it is the only source that still has the result. Returns { score, recs, source }.
 */
export async function loadResultScore(client, fixtureId) {
  const snap = await client.scoresSnapshot(fixtureId).catch(() => null);
  const fromSnap = readScore(snap);
  // A final row in the snapshot means the match is fresh enough that the snapshot still holds it.
  if (fromSnap?.final) return { score: fromSnap, recs: snap, source: "snapshot" };
  // Otherwise the authoritative record is historical, which is also the only source for a match
  // that has aged out of the snapshot, and the one a judge testing after the fact will hit.
  const hist = await client.scoresHistorical(fixtureId).catch(() => null);
  const fromHist = readScore(hist);
  if (fromHist) return { score: fromHist, recs: hist, source: "historical" };
  // Nothing final anywhere: hand back whatever the snapshot had, so a live match still reads.
  return { score: fromSnap, recs: snap ?? [], source: "snapshot" };
}

/** Is the match being played right now? */
export const isInPlay = (snapshot) => {
  const s = statusNow(snapshot);
  return s != null && [STATUS.FIRST_HALF, STATUS.HALF_TIME, STATUS.SECOND_HALF, STATUS.ET_FIRST, STATUS.ET_SECOND, STATUS.PENALTIES].includes(s);
};

/**
 * Has this match reached full time, in any sense at all?
 *
 * This is the question anything quoting a price has to ask, and it is not the same question as
 * "can I settle it". Settlement needs a specific provable moment. Quoting needs to know only
 * that the answer is now knowable by somebody.
 *
 * The distinction bites because a finished match keeps moving through states. It reaches full
 * time at 5, then an administrative finalisation at 100, and 100 is not in the terminal list,
 * because a proof taken there is rejected. So a market maker checking the terminal list against
 * the current status finds no match on a match that ended two days ago, concludes the game has
 * not started, and carries on quoting both sides of a result that anyone can already look up.
 * That is not a stale price. It is an offer to lose money to whoever reads the score first.
 */
export const isOver = (snapshot) => {
  const s = statusNow(snapshot);
  return s != null && [STATUS.FULL_TIME, STATUS.AFTER_ET, STATUS.PENALTIES, STATUS.AFTER_PENALTIES, STATUS.FINALISED].includes(s);
};

/**
 * The match clock, which the feed publishes as {Running, Seconds} on most in-play rows.
 *
 * Running is the signal worth having. It says whether the clock is ticking right now, which is
 * a more direct answer than inferring play from the status, and it goes false the moment the
 * game stops for half time, full time, or a suspension.
 */
export function clockOf(snapshot) {
  const rows = rowsOf(snapshot).filter((r) => r?.Clock?.Seconds != null);
  if (!rows.length) return null;
  const r = rows.reduce((a, b) => (seqOf(b) > seqOf(a) ? b : a));
  const seconds = Number(r.Clock.Seconds);
  return { running: !!r.Clock.Running, seconds, minute: Math.floor(seconds / 60), seq: seqOf(r) };
}

/** Has this match kicked off? Kickoff is an action, since the clock and GameState both lie. */
export const hasKickedOff = (snapshot) => rowsOf(snapshot).some((r) => r.Action === "kickoff");
