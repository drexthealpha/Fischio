// Which TxLINE lines can settle trustlessly on-chain, and the exact terms that settle them.
//
// A fischio market is binary. YES wins or NO wins, and nothing is returned in between. That single
// constraint decides the whole board, because most of a bookmaker's catalogue is not two-way:
//
//   half lines (.5)      Two-way. Over 2.5 either happened or it did not.
//   integer lines (.0)   Three-way. Over 2.0 pushes on exactly two goals and the stake goes back.
//                        Handicap -1.0 pushes when home wins by exactly one.
//   quarter lines (.25)  Not a single line at all. The stake splits across the two neighbours.
//
// Only half lines are settleable. Marking an integer line settleable would pay one side in full on
// an outcome where both sides are owed their stake, so this is a money rule and not a display rule.
//
// The on-chain type says the same thing independently: TraderPredicate.threshold is an i32, and a
// push line can only be written with a non-integer threshold. If the arithmetic below ever produces
// a fraction, the line is not binary. That is a useful cross-check rather than a coincidence.
//
// PERIOD LIVES IN THE STAT KEY, NOT IN THE TERMS
//
// MarketTerms has no period field, which looked at first like a hard limit that confined fischio to
// full-match markets. It is not. The feed packs the period into the key itself, as period*1000 +
// stat, so key 1 is full-match goals for the home side and key 1001 is the same figure at half
// time. MarketTerms.stat_a_key is a u32 and holds either.
//
// Verified against the live oracle on fixture 18241006 (England v Argentina, 1-2, 0-0 at the
// break), seq 961:
//
//   key=1    value=1  period=5      key=1001 value=0  period=5
//   key=2    value=2  period=5      key=1002 value=0  period=5
//
// The `period` on the leaf is the phase the proof was taken at, which is 5 for full time, and 5 is
// terminal. So a first-half market settles on a full-time proof with no program change. Corners
// (keys 7 and 8) and cards (3 to 6) came back the same way, which is what makes prop settlement
// reachable on the same path.

/** Stat key pair for each period the feed publishes. Home first, away second. */
export const STAT_KEYS = {
  FT: [1, 2],       // full match
  H1: [1001, 1002], // first half
};

/** A line is two-way only when its fractional part is exactly one half. */
export const isHalfLine = (line) =>
  line != null && Number.isInteger(line * 2) && !Number.isInteger(line);

/** Why a line is not settleable, for a UI that has to explain itself. */
export function lineKind(line) {
  if (line == null) return "none";
  if (isHalfLine(line)) return "half";
  if (Number.isInteger(line)) return "integer";
  return "quarter";
}

const REASON = {
  integer: "pushes when the result lands exactly on the line, so the stake is returned",
  quarter: "splits the stake across two neighbouring lines, so it is not one market",
};

/**
 * The on-chain terms that settle one leg of a feed market, or null when nothing settles it.
 *
 * `leg` selects which side YES pays on. For a three-way result that is "home" | "draw" | "away".
 * For a two-way line it is ignored, because one market covers both sides: YES is the over on a
 * totals line and the home side on a handicap, and NO is the other side of the same market.
 *
 * Returns terms in the market program's own vocabulary so they translate 1:1 into validate_stat.
 */
export function termsOfFeedMarket(m, leg = "home") {
  if (!m) return null;
  const keys = STAT_KEYS[m.period];
  if (!keys) return null; // a period the feed publishes but we hold no stat keys for
  const [statAKey, statBKey] = keys;

  if (m.type === "1X2_PARTICIPANT_RESULT") {
    const comparison = leg === "home" ? "greaterThan" : leg === "away" ? "lessThan" : leg === "draw" ? "equalTo" : null;
    if (!comparison) return null;
    return { statAKey, statBKey, op: "subtract", comparison, threshold: 0 };
  }

  if (!isHalfLine(m.line)) return null;

  // Over 2.5 is "goals scored > 2". floor() of a half line is always an integer.
  if (m.type === "OVERUNDER_PARTICIPANT_GOALS") {
    return { statAKey, statBKey, op: "add", comparison: "greaterThan", threshold: Math.floor(m.line) };
  }

  // Home -1.5 is "home won by two or more", so home - away > 1. Home +0.5 is "home did not lose",
  // so home - away > -1. Both fall out of floor(-line).
  if (m.type === "ASIANHANDICAP_PARTICIPANT_GOALS") {
    return { statAKey, statBKey, op: "subtract", comparison: "greaterThan", threshold: Math.floor(-m.line) };
  }

  return null;
}

/**
 * Settleability of one feed market, with the reason when the answer is no.
 * The reason is written for a reader who is not holding the rulebook, because it goes on screen.
 */
export function settleabilityOf(m) {
  if (!m) return { settleable: false, reason: "no market" };
  if (!STAT_KEYS[m.period]) {
    return { settleable: false, reason: `the feed publishes no stat key for the ${m.period} period` };
  }
  if (m.type === "1X2_PARTICIPANT_RESULT") {
    return { settleable: true, legs: ["home", "draw", "away"] };
  }
  const kind = lineKind(m.line);
  if (kind !== "half") {
    return { settleable: false, reason: `this line ${REASON[kind] ?? "is not a two-way market"}` };
  }
  if (m.type === "OVERUNDER_PARTICIPANT_GOALS" || m.type === "ASIANHANDICAP_PARTICIPANT_GOALS") {
    return { settleable: true, legs: ["home"] }; // one market, YES is over or home
  }
  return { settleable: false, reason: `no settlement path for ${m.type}` };
}

/** A stable string for one set of terms, so two descriptions of the same bet compare equal. */
export const termsKey = (t) =>
  t == null ? null : `${t.statAKey}:${t.statBKey}:${t.op}:${t.comparison}:${t.threshold}`;

/**
 * Did a market's proposition hold on the proven final score? YES wins when it did.
 *
 * This mirrors what the market program does at resolution, so off-chain scoreboards and on-chain
 * settlement cannot disagree about who won. Anything reading a result has to come through here
 * rather than reimplementing the comparison, which is how the arena scoreboard was briefly wrong:
 * it read `score.h1p1`, a field that does not exist, so every first-half market scored as nil-nil
 * and the half-time draw won every single time.
 *
 * `score` is the shape lib/scores.mjs returns: { p1, p2, firstHalf: { p1, p2 }, ... }.
 * Returns null when the score does not carry the statistic this market settles on, because a
 * missing number must not be silently read as zero.
 */
export function predicateHolds(terms, score) {
  if (!terms || !score) return null;
  const period = terms.statAKey === 1001 ? "firstHalf" : terms.statAKey === 1 ? "match" : null;
  if (!period) return null; // corners, cards and anything else this helper does not cover yet

  const a = period === "firstHalf" ? score.firstHalf?.p1 : score.p1;
  const b = period === "firstHalf" ? score.firstHalf?.p2 : score.p2;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  const value = terms.op === "add" ? a + b : a - b;
  if (terms.comparison === "greaterThan") return value > terms.threshold;
  if (terms.comparison === "lessThan") return value < terms.threshold;
  if (terms.comparison === "equalTo") return value === terms.threshold;
  return null;
}

/**
 * Every on-chain market a feed catalogue implies, deduplicated by terms.
 *
 * Deduplication is not tidiness, it is correctness. Handicap -0.5 and the home leg of the result
 * are the same proposition: both are "home - away > 0", both are simply "home wins". The feed
 * quotes them as two markets and they must collapse to one on chain, or the same bet would sit in
 * two books at two prices with no way to arbitrage between them.
 *
 * Handicap +0.5 does NOT collapse. It is "home - away > -1", meaning home won or drew, which is a
 * double chance and matches no single result leg.
 */
export function onChainMarketsOf(markets) {
  const byTerms = new Map();
  for (const m of markets ?? []) {
    const s = settleabilityOf(m);
    if (!s.settleable) continue;
    for (const leg of s.legs) {
      const terms = termsOfFeedMarket(m, leg);
      if (!terms) continue;
      const key = termsKey(terms);
      const existing = byTerms.get(key);
      if (existing) { existing.sources.push({ feedKey: m.key, leg }); continue; }
      byTerms.set(key, { termsKey: key, terms, leg, fixtureId: m.fixtureId, sources: [{ feedKey: m.key, leg }] });
    }
  }
  return [...byTerms.values()];
}
