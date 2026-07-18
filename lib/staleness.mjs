// When is an old price dangerous, and when is it simply a line nobody trades?
//
// A market maker resting quotes on a price it cannot vouch for is how a bot gets picked off. The
// obvious defence is an age limit: refuse anything older than N seconds. That is what fischio did,
// and it is wrong, because age alone cannot tell apart two situations that need opposite answers.
//
//   the feed has stopped      Every market goes quiet together. Our prices are blind to whatever
//                             has happened since. Pull everything.
//
//   nobody trades this line   One market is quiet while the rest of the board ticks along. The
//                             bookmaker has not moved the price because there is no reason to. The
//                             price is still the price.
//
// Measured on fixture 18257739, a single snapshot, ages in minutes:
//
//   1X2 FT 6, handicap FT 0 6, handicap FT -0.5 31, totals FT 2.5 29,
//   handicap FT +0.5 478, totals FT 3 662, totals FT 1.25 812
//
// The feed was healthy the whole time. Its freshest market was six minutes old, and the same
// timestamp came back from both the snapshot and the updates endpoint, so this was the feed's own
// newest record and not a cached copy on our side. Four of twenty-nine markets were over six hours
// old purely because they are peripheral lines on a match where the money is elsewhere.
//
// A flat six-hour limit refused to quote those four. That is how the handicap +0.5 market ended up
// as the only proposition on the board with a market and no order book.
//
// So the question asked here is not "how old is this price" but "is the feed still talking to us".
// If it is, a quiet market gets quoted wider rather than refused, because a price nobody has
// revisited in hours is one we are more likely to be picked off on. In play that leniency stops:
// the line has to track the match, and a price from before the goal went in is exactly what an
// informed trader lifts.

export const DEFAULTS = {
  feedDeadSeconds: 900,     // nothing on the whole board inside this means the feed, not the market
  inPlayMaxSeconds: 180,    // service level 1 is already ~60s delayed, so this cannot go much lower
  quietAfterSeconds: 1800,  // pre-match, past this the line is quoted wider
  quietWiden: 2,            // how much wider
};

/**
 * Whether to quote this market, and how wide.
 *
 * @param {number|null} age       seconds since this market's own last update
 * @param {number|null} boardAge  seconds since the freshest market on the whole board updated
 * @param {boolean} inPlay        is the match being played right now
 * @param {object} [opts]         overrides for DEFAULTS
 * @returns {{quote: boolean, widen?: number, reason?: string}}
 */
export function ageVerdict(age, boardAge, inPlay, opts = {}) {
  const { feedDeadSeconds, inPlayMaxSeconds, quietAfterSeconds, quietWiden } = { ...DEFAULTS, ...opts };

  if (age == null) return { quote: false, reason: "no timestamp on this line" };

  // Checked before anything else. A market whose own reading looks recent is still not trustworthy
  // when nothing else on the board has moved, because that one reading is all that is holding the
  // board up and it may itself be a repeat.
  if (boardAge == null || boardAge > feedDeadSeconds) {
    return { quote: false, reason: `the feed itself has gone quiet (nothing on the board inside ${feedDeadSeconds}s)` };
  }

  if (inPlay && age > inPlayMaxSeconds) {
    return { quote: false, reason: `in-play line is ${age}s old, past the ${inPlayMaxSeconds}s limit` };
  }

  if (!inPlay && age > quietAfterSeconds) {
    return {
      quote: true,
      widen: quietWiden,
      reason: `the feed is live but has not repriced this line in ${Math.round(age / 60)} min, so quoting wider`,
    };
  }

  return { quote: true, widen: 1 };
}
