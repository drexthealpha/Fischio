// What actually moved, market by market.
//
// The feed publishes every odds update inside a five minute window as one flat list of rows. A
// single row is a price at a moment. It says nothing about movement on its own, because movement
// needs the same market seen at two points in time. So this groups the window by market, takes
// the earliest and the latest price for each outcome, and reports the difference.
//
// Three details matter here, and two of them were wrong the first time this was written.
//
// Outcomes are compared by name, never by position. The earlier version read `outcomes[0]` and
// called that the market's move. On a three way line outcomes[0] is the home team, so a match
// where the draw drifted eight points while home held steady reported no movement at all. The
// move worth showing is whichever outcome travelled furthest, and on a live match that is very
// often the draw or the away side.
//
// Rows arrive out of order. The window is not sorted, so earliest and latest are chosen by
// timestamp rather than by position in the array.
//
// Quarter lines never appear. TxODDS sends "NA" for their demargined percentage, because a stake
// that splits across two lines has no single fair price. There is nothing to difference, and a
// movement figure for them would mean inventing both endpoints.

import { parseRow } from "./markets.mjs";

/**
 * Reduce a window of raw odds rows to the markets that moved.
 *
 * @param {object[]} rows   raw rows from /api/odds/updates for one window
 * @param {object} [opts]
 * @param {number} [opts.limit=25]   how many to return, largest move first; 0 returns all
 * @param {number} [opts.minMove=0]  drop moves smaller than this, as a probability (0.01 = 1 point)
 * @returns {object[]} one entry per market that moved, largest absolute move first
 */
export function computeMovers(rows, { limit = 25, minMove = 0 } = {}) {
  const byMarket = new Map();

  for (const row of rows ?? []) {
    if (!row?.SuperOddsType) continue;
    const m = parseRow(row);
    if (!m.demargined || !m.ts) continue; // quarter line, or a row with no usable timestamp

    let agg = byMarket.get(m.key);
    if (!agg) { agg = { first: m, last: m, ticks: 0 }; byMarket.set(m.key, agg); }
    if (m.ts < agg.first.ts) agg.first = m;
    if (m.ts > agg.last.ts) agg.last = m;
    agg.ticks += 1;
  }

  const out = [];
  for (const [key, { first, last, ticks }] of byMarket) {
    // One update in the window is a price, not a move. Differencing a row against itself would
    // report every market in the window as flat, padding the board with rows that say nothing.
    if (first.ts === last.ts) continue;

    const before = new Map(first.outcomes.map((o) => [o.name, o.prob]));
    const moves = [];
    for (const o of last.outcomes) {
      const from = before.get(o.name);
      if (from == null || o.prob == null) continue;
      moves.push({ outcome: o.name, from, to: o.prob, move: o.prob - from });
    }
    if (!moves.length) continue; // the outcome set changed under us; nothing comparable

    // A two way line moves symmetrically: over up four points is under down four. Ties are the
    // normal case here rather than an edge case, so they are broken by feed order, which keeps
    // the headline on the home team or the over, the side the line is quoted from.
    //
    // The tie has to be judged with a tolerance. These probabilities come from dividing integer
    // percentages by 100, so 0.35 - 0.27 is 0.07999999999999999 while 0.20 - 0.28 is
    // -0.08000000000000002. Comparing those exactly hands the tie to whichever side rounded
    // wider, which is arbitrary and not stable: the headline would flip between home and away
    // as the line ticked, for no reason a reader could see.
    const lead = moves.reduce((a, b) => (Math.abs(b.move) - Math.abs(a.move) > 1e-9 ? b : a));
    if (Math.abs(lead.move) < minMove) continue;

    out.push({
      key,
      fixtureId: last.fixtureId,
      type: last.type,
      period: last.period,
      line: last.line,
      // the headline move, which is the outcome that travelled furthest
      outcome: lead.outcome,
      from: lead.from,
      to: lead.to,
      move: lead.move,
      // every outcome's move, so a caller can show the whole line rather than one leg of it
      outcomes: moves,
      // how many updates landed in the window. A large move on two ticks is a repricing; the
      // same move on thirty is a market being pushed, and traders read those differently.
      ticks,
      seconds: Math.round((last.ts - first.ts) / 1000),
      inRunning: last.inRunning,
      // the handle that proves the closing price of this window through validate_odds
      messageId: last.messageId,
      ts: last.ts,
    });
  }

  out.sort((a, b) => Math.abs(b.move) - Math.abs(a.move));
  return limit > 0 ? out.slice(0, limit) : out;
}
