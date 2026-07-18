// The whole tournament, and which part of it fischio can afford to make markets on.
//
// The schedule is real and complete. Measured against the live feed, sweeping 44 epoch days:
// 1905 World Cup fixture rows resolving to 106 unique fixture ids and 105 distinct team pairings.
// So a full-tournament product is not a design claim, the data is there.
//
// WHAT CANNOT BE DONE IS FUND IT ALL
//
// 105 matches times roughly 11 settleable markets is about 1150 markets. Each needs collateral for
// its pool and inventory for its book. That is not a number any single operator seeds, and finding
// out by draining the wallet at match sixty is not a plan. So capital is allocated deliberately
// here, and the reason a match is not funded is recorded rather than left as silence on a board.
//
// THE DUPLICATE
//
// The feed lists USA v Paraguay twice, ids 17588394 and 17588396, three hours apart. One pairing
// out of 105, so an anomaly and not a pattern, but a market factory that trusts fixture ids alone
// would open two complete boards for one match and split its liquidity. Deduplication is by
// pairing plus a kickoff window, keeping the earlier id, because that is the one the rest of the
// feed's odds rows are keyed to.

/** Kickoff in ms, tolerating the feed's mix of second and millisecond timestamps. */
export const kickoffMs = (f) => {
  const t = Number(f?.StartTime ?? f?.kickoff ?? 0);
  if (!Number.isFinite(t) || t <= 0) return null;
  return t > 1e11 ? t : t * 1000;
};

/** Where a match sits relative to now. Time decides, because the feed's GameState never changes. */
export function stateOf(f, now = Date.now()) {
  const ko = kickoffMs(f);
  if (ko == null) return "unknown";
  // Regulation plus stoppage, extra time, penalties and a margin for a delayed feed.
  const MATCH_WINDOW_MS = 150 * 60 * 1000;
  if (now < ko) return "upcoming";
  if (now < ko + MATCH_WINDOW_MS) return "live";
  return "finished";
}

/**
 * One entry per real match, with the feed's duplicate listings collapsed.
 *
 * Two rows are the same match when they name the same two participants and kick off within
 * `windowHours` of each other. The earlier id wins, since the odds rows are keyed to it.
 */
export function dedupeFixtures(fixtures, { windowHours = 6 } = {}) {
  const byPair = new Map();
  for (const f of fixtures ?? []) {
    const ko = kickoffMs(f);
    if (ko == null) continue;
    const key = `${f.Participant1} v ${f.Participant2}`;
    const group = byPair.get(key) ?? byPair.set(key, []).get(key);
    const near = group.find((g) => Math.abs(kickoffMs(g) - ko) <= windowHours * 3600_000);
    if (!near) { group.push(f); continue; }
    if (ko < kickoffMs(near)) group[group.indexOf(near)] = f; // keep the earlier listing
  }
  return [...byPair.values()].flat().sort((a, b) => kickoffMs(a) - kickoffMs(b));
}

/**
 * Which matches get capital, and why the rest do not.
 *
 * The ordering is deliberate. A match being played now is where a market maker earns its spread and
 * where a price is worth quoting, so live comes first. After that, nearest kickoff, because odds on
 * a match three weeks out barely move and capital parked there does nothing.
 *
 * Every excluded match carries a reason. A board that silently shows nothing on eighty matches is
 * indistinguishable from a board that is broken.
 *
 * @param {object[]} fixtures
 * @param {object} opts
 * @param {number} opts.now
 * @param {number} opts.budget            total collateral available, in whole units
 * @param {number} opts.perMatch          collateral one match's board consumes
 * @param {number} opts.maxConcurrent     ceiling on simultaneously funded matches
 * @param {number} opts.leadHours         do not fund a match further out than this
 */
export function allocationPlan(fixtures, {
  now = Date.now(), budget = 0, perMatch = 1, maxConcurrent = Infinity, leadHours = 48,
} = {}) {
  const rank = { live: 0, upcoming: 1, finished: 2, unknown: 3 };
  const rows = dedupeFixtures(fixtures)
    .map((f) => ({ fixture: f, state: stateOf(f, now), ko: kickoffMs(f) }))
    .sort((a, b) => (rank[a.state] - rank[b.state]) || (a.ko - b.ko));

  const fund = [], skip = [];
  let spent = 0;
  for (const r of rows) {
    const hoursOut = (r.ko - now) / 3600_000;
    let why = null;
    if (r.state === "finished") why = "already played";
    else if (r.state === "unknown") why = "no kickoff time on the fixture";
    else if (r.state === "upcoming" && hoursOut > leadHours) why = `kicks off in ${Math.round(hoursOut)}h, beyond the ${leadHours}h funding window`;
    else if (fund.length >= maxConcurrent) why = `at the ceiling of ${maxConcurrent} funded matches`;
    else if (spent + perMatch > budget) why = `funding this would need ${spent + perMatch} of a ${budget} budget`;

    if (why) skip.push({ ...r, why });
    else { fund.push(r); spent += perMatch; }
  }
  return { fund, skip, spent, budget, perMatch };
}

/** A one-line summary an operator can read without opening the plan. */
export const describePlan = (p) =>
  `${p.fund.length} match(es) funded using ${p.spent} of ${p.budget}, ${p.skip.length} not funded`;
