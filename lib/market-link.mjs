// The single place that knows how a TxLINE market maps to an on-chain fischio market.
//
// WHY THIS EXISTS
//
// The feed and the chain describe the same bet in different vocabularies. TxLINE says
// "OVERUNDER_PARTICIPANT_GOALS, full match, line 2.5". The market program says "stat 1 + stat 2 >
// 2". Anything connecting the two, the market maker choosing which book to quote, the app deciding
// which board cell is tradeable, needs that translation, and if each caller writes its own they
// drift apart and the UI marks the wrong markets live.
//
// Which lines are settleable at all, and on what terms, lives in settleable.mjs. This module is the
// lookup on top of it: given a feed market, find the on-chain market that prices it.
//
// MATCHING IS ON TERMS, NOT ON A LABEL
//
// An earlier version compared a string key built from the feed's own vocabulary. That cannot be
// right, because two different feed lines can be the same bet. Handicap -0.5 and the home leg of
// the result are both "home - away > 0", which is just "home wins". Comparing labels keeps them
// apart and puts one bet in two books at two prices. Comparing terms collapses them, which is what
// the chain does anyway, since both derive the same market PDA.

import { termsOfFeedMarket, termsKey, settleabilityOf } from "./settleable.mjs";

export { termsOfFeedMarket, termsKey, settleabilityOf, onChainMarketsOf, isHalfLine, lineKind }
  from "./settleable.mjs";

/**
 * Terms read off chain come back in Anchor's shape, where an enum is an object like {subtract:{}}
 * and a predicate is nested. Terms built locally are already flat. Accept both, because the bots
 * read from chain and the factory builds from the feed, and they have to compare equal.
 */
export function normalizeTerms(t) {
  if (!t) return null;
  const enumName = (v) => (typeof v === "string" ? v : v && typeof v === "object" ? Object.keys(v)[0] : null);
  const op = enumName(t.op);
  const comparison = enumName(t.comparison ?? t.predicate?.comparison);
  const threshold = Number(t.threshold ?? t.predicate?.threshold);
  const statAKey = Number(t.statAKey ?? t.stat_a_key);
  const statBKey = t.statBKey ?? t.stat_b_key;
  if (!Number.isFinite(statAKey) || !Number.isFinite(threshold) || !comparison) return null;
  return {
    statAKey,
    statBKey: statBKey == null ? null : Number(statBKey),
    op,
    comparison,
    threshold,
  };
}

/** Which leg of a feed row an outcome index refers to. */
export function legOf(feedMarket, outcomeIndex = 0) {
  if (feedMarket?.type === "1X2_PARTICIPANT_RESULT") {
    return ["home", "draw", "away"][outcomeIndex] ?? null;
  }
  // A two-way line is one market. Index 0 is the over or the home side, which is YES.
  return outcomeIndex === 0 || outcomeIndex === 1 ? "home" : null;
}

/**
 * Which side of the on-chain market an outcome index sits on.
 *
 * A totals line is one market whose YES pays on the over, so quoting the under means quoting NO on
 * that same market rather than finding a second one. A caller that ignores this would quote both
 * sides of a book as if they were both YES and end up long the same exposure twice.
 */
export function sideOf(feedMarket, outcomeIndex = 0) {
  if (feedMarket?.type === "1X2_PARTICIPANT_RESULT") return "yes"; // each leg is its own market
  return outcomeIndex === 0 ? "yes" : outcomeIndex === 1 ? "no" : null;
}

/**
 * Feed-side identity for an on-chain market's terms, for labelling only.
 *
 * This is deliberately one-way. Terms can be reached from more than one feed line, so there is no
 * single correct answer, and the canonical choice below is the plainest description of the bet.
 * Never match on this string. Match on termsKey.
 */
export function feedKeyOfTerms(fixtureId, rawTerms) {
  const t = normalizeTerms(rawTerms);
  if (!t) return null;
  const period = t.statAKey === 1 && t.statBKey === 2 ? "FT"
    : t.statAKey === 1001 && t.statBKey === 1002 ? "H1" : null;
  if (!period) return null;

  if (t.op === "subtract" && t.threshold === 0) {
    return `${fixtureId}:1X2_PARTICIPANT_RESULT:${period}:-`;
  }
  if (t.op === "add" && t.comparison === "greaterThan") {
    return `${fixtureId}:OVERUNDER_PARTICIPANT_GOALS:${period}:${t.threshold + 0.5}`;
  }
  if (t.op === "subtract" && t.comparison === "greaterThan") {
    return `${fixtureId}:ASIANHANDICAP_PARTICIPANT_GOALS:${period}:${-t.threshold - 0.5}`;
  }
  return null;
}

/** Which leg of the match result an on-chain market prices, or null if it is not a result leg. */
export function resultLegOfTerms(rawTerms) {
  const t = normalizeTerms(rawTerms);
  if (!t) return null;
  if (t.op !== "subtract" || t.threshold !== 0) return null;
  if (!((t.statAKey === 1 && t.statBKey === 2) || (t.statAKey === 1001 && t.statBKey === 1002))) return null;
  return t.comparison === "greaterThan" ? "home"
    : t.comparison === "equalTo" ? "draw"
    : t.comparison === "lessThan" ? "away" : null;
}

/**
 * Find the on-chain market that prices a given feed market, from a list already read off chain.
 *
 * Each candidate is `{ address, fixtureId, terms }`, the shape the app and the bots already build.
 * Returns null when nothing on chain prices this line yet, which is a normal state and must never
 * be filled in with a substitute. Showing another market's depth reads as liquidity that is not
 * there, which is the whole reason this lookup is strict.
 */
export function findOnChainMarket(candidates, feedMarket, outcomeIndex = 0) {
  if (!feedMarket) return null;
  const leg = legOf(feedMarket, outcomeIndex);
  if (!leg) return null;
  const want = termsKey(termsOfFeedMarket(feedMarket, leg));
  if (!want) return null; // this line does not settle, so no on-chain market should exist for it
  return (candidates ?? []).find(
    (c) => Number(c.fixtureId) === Number(feedMarket.fixtureId) && termsKey(normalizeTerms(c.terms)) === want
  ) ?? null;
}
