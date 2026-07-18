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

// MEASURED, NOT ASSUMED
//
// The in-play limit used to be 180 seconds, on the reasoning that service level 1 is already about
// 60 seconds delayed so anything much older is dangerous. That reasoning was sound and the number
// was still wrong, because it was never checked against what the feed actually does.
//
// Measured on fixture 18257865, France against England, live at the 71st minute, polling every 12
// seconds for 3 minutes. Nine repricings observed across the board:
//
//   1X2 FT 300s, handicap FT -0.5 300s, handicap FT -1 300s, totals FT 8 300s,
//   totals FT 8.5 300s, totals FT 9.5 300s, handicap ET -0.5 195s, totals ET 271s,
//   totals ET first half 282s
//
//   min 195s, median 300s, max 300s
//
// The feed reprices a live match every five minutes on this tier. So a 180 second limit is not
// strict, it is unsatisfiable: every line is stale by definition and the maker quotes nothing at
// all, in play, forever. That is what it was doing.
//
// Raising the limit alone would be the wrong fix in the other direction, because a price from
// before the goal went in is exactly what an informed trader lifts. So the limit now sits at two
// publication intervals, and inside that window the spread widens with age. A line one interval old
// is normal and quoted normally. A line approaching two intervals has missed an update and is
// quoted wide enough to be paid for the risk of being wrong.
export const DEFAULTS = {
  feedDeadSeconds: 900,        // nothing on the whole board inside this means the feed, not the market
  inPlayIntervalSeconds: 300,  // the measured repricing cadence in play
  inPlayMaxSeconds: 660,       // two intervals plus a minute of slack
  inPlayMaxWiden: 4,           // ceiling on how wide age alone can push the spread
  quietAfterSeconds: 1800,     // pre-match, past this the line is quoted wider
  quietWiden: 2,               // how much wider
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
  const { feedDeadSeconds, inPlayIntervalSeconds, inPlayMaxSeconds, inPlayMaxWiden, quietAfterSeconds, quietWiden } = { ...DEFAULTS, ...opts };

  if (age == null) return { quote: false, reason: "no timestamp on this line" };

  // Checked before anything else. A market whose own reading looks recent is still not trustworthy
  // when nothing else on the board has moved, because that one reading is all that is holding the
  // board up and it may itself be a repeat.
  if (boardAge == null || boardAge > feedDeadSeconds) {
    return { quote: false, reason: `the feed itself has gone quiet (nothing on the board inside ${feedDeadSeconds}s)` };
  }

  if (inPlay) {
    if (age > inPlayMaxSeconds) {
      return {
        quote: false,
        reason: `in-play line is ${age}s old, past the ${inPlayMaxSeconds}s limit (the feed reprices about every ${inPlayIntervalSeconds}s, so this has missed more than one update)`,
      };
    }
    if (age > inPlayIntervalSeconds) {
      // Between one and two intervals the line has missed an update while the match moved on.
      // Quote it, and be paid for the risk: the spread scales from 1x at one interval toward the
      // ceiling as it approaches the point of being pulled entirely.
      const over = (age - inPlayIntervalSeconds) / inPlayIntervalSeconds;
      const widen = Math.min(1 + over * (inPlayMaxWiden - 1), inPlayMaxWiden);
      return {
        quote: true,
        widen,
        reason: `in-play line is ${age}s old against a ${inPlayIntervalSeconds}s repricing cadence, so quoting ${widen.toFixed(1)}x wider`,
      };
    }
    return { quote: true, widen: 1 };
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
