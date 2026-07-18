// The TxLINE market catalogue.
//
// One TxLINE odds row is one price update for one market. A market is identified by three
// fields together: SuperOddsType (what is being bet on), MarketPeriod (which part of the
// match), and MarketParameters (the line, for handicaps and totals). Reading only the row
// where MarketPeriod and MarketParameters are both empty, which is what fischio did until
// now, sees the full-match 1X2 and nothing else. On a single World Cup fixture that is one
// market out of roughly forty.
//
// Verified against 1677 live rows on the free World Cup tier (fixtures 18257739, 18257865):
//
//   OVERUNDER_PARTICIPANT_GOALS      over/under      FT + half=1   18 lines (0.5 .. 5.5)
//   ASIANHANDICAP_PARTICIPANT_GOALS  part1/part2     FT + half=1   10 lines (-1.5 .. 0.75)
//   1X2_PARTICIPANT_RESULT           part1/draw/part2 FT + half=1  no line
//
// Every market on this feed is priced on goals. There is no corners or cards line, so a
// corners market cannot be priced from TxLINE. It can still be settled from a proof, because
// corners and cards are stat keys in the Merkle tree. Pricing and settlement are separate
// problems and only settlement is the one fischio claims to have solved.
//
// Prices are decimal odds scaled by 1000, so 2372 means 2.372. Pct is the demargined implied
// percentage that TxODDS already computed, and 1000/Price reproduces it exactly. Pct is the
// string "NA" on quarter lines, where a split stake has no clean two-way percentage. We do
// not invent a number for those. We mark the market and move on.

/** "half=1" -> "H1"; empty -> "FT". The feed only uses these two today. */
export const periodOf = (marketPeriod) => (marketPeriod ? (marketPeriod === "half=1" ? "H1" : marketPeriod) : "FT");

/** "line=-0.25" -> -0.25; empty -> null. MarketParameters only ever carries `line`. */
export function lineOf(marketParameters) {
  if (!marketParameters) return null;
  const m = String(marketParameters).match(/line=(-?\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/** Decimal odds from the scaled integer the feed sends. 2372 -> 2.372 */
export const decimalOdds = (price) => (Number(price) > 0 ? Number(price) / 1000 : null);

/** A stable id for one market on one fixture, so it can be tracked across updates. */
export const marketKey = (row) =>
  `${row.FixtureId}:${row.SuperOddsType}:${periodOf(row.MarketPeriod)}:${lineOf(row.MarketParameters) ?? "-"}`;

/**
 * Turn one odds row into a market with its outcomes.
 *
 * `demargined` is true when TxODDS gave us usable percentages. When it is false the market is
 * a quarter line and we report the decimal odds without a probability, because the honest
 * answer there is that a two-way percentage does not exist.
 */
export function parseRow(row) {
  const names = row.PriceNames ?? [];
  const prices = row.Prices ?? [];
  const pct = row.Pct ?? [];
  const demargined = Array.isArray(pct) && pct.length === names.length && !pct.some((p) => p === "NA");
  return {
    key: marketKey(row),
    fixtureId: row.FixtureId,
    type: row.SuperOddsType,
    period: periodOf(row.MarketPeriod),
    line: lineOf(row.MarketParameters),
    inRunning: !!row.InRunning,
    gameState: row.GameState ?? null,
    // the handle that proves this exact price through /api/odds/validation + validate_odds
    messageId: row.MessageId,
    ts: Number(row.Ts) || null,
    bookmaker: row.Bookmaker,
    demargined,
    outcomes: names.map((name, i) => ({
      name,
      odds: decimalOdds(prices[i]),
      // Pct is already demargined. 1000/Price reproduces it, so we never recompute it here.
      prob: demargined ? Number(pct[i]) / 100 : null,
    })),
  };
}

/**
 * The full catalogue for a set of odds rows: one entry per market, holding the newest update.
 * Rows arrive out of order, so the newest Ts wins rather than the last one in the array.
 */
export function parseMarkets(rows) {
  const byKey = new Map();
  for (const row of rows ?? []) {
    if (!row?.SuperOddsType) continue;
    const m = parseRow(row);
    const prev = byKey.get(m.key);
    if (!prev || (m.ts ?? 0) > (prev.ts ?? 0)) byKey.set(m.key, m);
  }
  return [...byKey.values()];
}

/** Group a catalogue by type, then period, so a UI can render it without knowing the feed. */
export function groupMarkets(markets) {
  const out = {};
  for (const m of markets) {
    (out[m.type] ??= {});
    (out[m.type][m.period] ??= []).push(m);
  }
  for (const type of Object.values(out))
    for (const list of Object.values(type)) list.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return out;
}

/**
 * The full-match three-way line: home, draw, away as probabilities that sum to one.
 * This is the line every fischio price is held on, so it stays a named function.
 * Returns null when the feed has not sent a usable 1X2 row yet.
 */
export function impliedResult(oddsRows) {
  const m = parseMarkets(oddsRows).find(
    (x) => x.type === "1X2_PARTICIPANT_RESULT" && x.period === "FT" && x.demargined
  );
  if (!m || m.outcomes.length < 3) return null;
  const [home, draw, away] = m.outcomes.map((o) => o.prob);
  return { home, draw, away };
}

/** The same three-way line for the first half. */
export function impliedFirstHalf(oddsRows) {
  const m = parseMarkets(oddsRows).find(
    (x) => x.type === "1X2_PARTICIPANT_RESULT" && x.period === "H1" && x.demargined
  );
  if (!m || m.outcomes.length < 3) return null;
  const [home, draw, away] = m.outcomes.map((o) => o.prob);
  return { home, draw, away };
}

/** Goal totals ladder for a period: [{ line, over, under, odds }], lowest line first. */
export const totalsLadder = (oddsRows, period = "FT") =>
  parseMarkets(oddsRows)
    .filter((m) => m.type === "OVERUNDER_PARTICIPANT_GOALS" && m.period === period)
    .sort((a, b) => a.line - b.line);

/** Asian handicap ladder for a period. */
export const handicapLadder = (oddsRows, period = "FT") =>
  parseMarkets(oddsRows)
    .filter((m) => m.type === "ASIANHANDICAP_PARTICIPANT_GOALS" && m.period === period)
    .sort((a, b) => a.line - b.line);
