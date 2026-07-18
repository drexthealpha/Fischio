// Two strategies that read the same feed and disagree.
//
// The Trading Tools track asks for exactly this: "Two agents reading the same TxLINE feed, running
// opposite strategies. Positions settle on-chain. The better strategy wins over the course of the
// tournament."
//
// Opposite has to mean something precise, or the contest proves nothing. These two take the same
// input, detect the same move, and then buy opposite sides of the same market. There is no
// signal on which they agree, so their results cannot both be good, and the tournament decides.
//
//   follower   a line that moves fast and does not come back is informed money arriving. Buy the
//              side it moved toward and hold to settlement.
//
//   fader      most sharp moves overshoot. Buy the side it moved away from and let it come back.
//
// Both are real positions in the market program, not journal entries. The steam agent that came
// before this wrote signals to a file and scored them later, which is honest but self-reported.
// A position that settles from a Merkle proof is scored by the chain instead, and nobody has to
// take our word for the record.
//
// WHY THE DECISION LOGIC IS PURE
//
// Nothing here touches the network or the chain. A strategy is a function from observed prices to
// an intent, so the same history always produces the same decision and the whole thing is testable
// without a validator. Execution, capital checks and confirmation live in bot/arena.mjs. That
// split is what makes a backtest and a live run provably the same strategy.

/** Default thresholds. Overridable per run, but recorded with every decision so a log is complete. */
export const DEFAULTS = {
  minMove: 0.03,        // a probability has to travel this far to count as a signal
  windowSeconds: 300,   // inside this many seconds
  size: 50,             // shares per position
  maxPositions: 1,      // per market, so one line cannot absorb the whole allocation
};

/**
 * Did this market move enough, recently enough, to be a signal?
 *
 * `history` is [{ ts, prob }] for one market, any order. Oldest and newest inside the window are
 * chosen by timestamp rather than array position, because the feed does not return them in order
 * and reading the array's ends gets the direction backwards.
 */
export function detectMove(history, { windowSeconds = DEFAULTS.windowSeconds, minMove = DEFAULTS.minMove, now = Date.now() } = {}) {
  const pts = (history ?? [])
    .filter((p) => p && Number.isFinite(p.ts) && Number.isFinite(p.prob))
    .filter((p) => now - p.ts <= windowSeconds * 1000)
    .sort((a, b) => a.ts - b.ts);
  if (pts.length < 2) return { moved: false, reason: "not enough observations in the window" };

  const first = pts[0], last = pts[pts.length - 1];
  const delta = last.prob - first.prob;
  if (Math.abs(delta) < minMove) {
    return { moved: false, delta, from: first.prob, to: last.prob, reason: `moved ${(delta * 100).toFixed(1)} points, under the ${(minMove * 100).toFixed(1)} threshold` };
  }
  return {
    moved: true,
    delta,
    from: first.prob,
    to: last.prob,
    seconds: Math.round((last.ts - first.ts) / 1000),
    observations: pts.length,
  };
}

/** Shared shape so the runner treats both strategies identically. */
const hold = (reason) => ({ action: "hold", reason });

/**
 * A strategy decides one market at a time.
 *
 * @param {object} ctx
 * @param {object[]} ctx.history    [{ ts, prob }] for this market's YES probability
 * @param {number} ctx.position     shares already held, positive YES, negative NO
 * @param {object} ctx.params       thresholds, merged over DEFAULTS
 * @param {number} ctx.now
 * @returns {{action: "buy"|"hold", side?: "yes"|"no", size?: number, reason: string, signal?: object}}
 */
function decideWith(direction, { history, position = 0, params = {}, now = Date.now() } = {}) {
  const p = { ...DEFAULTS, ...params };
  const signal = detectMove(history, { ...p, now });
  if (!signal.moved) return hold(signal.reason);

  // Already holding on this market. Adding again on the same signal would turn one view into an
  // ever growing position on a line that keeps ticking, which is a way to be maximally wrong.
  if (Math.abs(position) >= p.size * p.maxPositions) {
    return hold(`already holding ${position} shares, at the ${p.maxPositions} position limit`);
  }

  // The whole contest is this line. `rising` means YES got more likely.
  const rising = signal.delta > 0;
  const side = direction === "follow" ? (rising ? "yes" : "no") : (rising ? "no" : "yes");
  const move = `${signal.delta > 0 ? "+" : ""}${(signal.delta * 100).toFixed(1)} points in ${signal.seconds}s`;
  const reason = direction === "follow"
    ? `line moved ${move}, following it into ${side}`
    : `line moved ${move}, fading it into ${side}`;

  return { action: "buy", side, size: p.size, reason, signal };
}

export const follower = {
  name: "follower",
  description: "buys the side a sharp move went toward, on the view that a fast move that does not come back is informed money",
  decide: (ctx) => decideWith("follow", ctx),
};

export const fader = {
  name: "fader",
  description: "buys the side a sharp move went away from, on the view that sharp moves overshoot and revert",
  decide: (ctx) => decideWith("fade", ctx),
};

export const STRATEGIES = { follower, fader };

/**
 * Score a set of settled positions.
 *
 * A position is `{ side, size, entryPrice, won }` where `won` comes from the proven result rather
 * than from the agent. A binary share pays 1 if its side won and 0 otherwise, so profit on a YES
 * bought at 0.42 is 0.58 a share when it wins and -0.42 when it does not.
 *
 * Drawdown is measured on the running realised total in the order positions settled, which is the
 * worst peak-to-trough an operator would actually have lived through.
 */
export function scorePositions(positions) {
  const settled = (positions ?? []).filter((p) => p && typeof p.won === "boolean" && Number.isFinite(p.size) && Number.isFinite(p.entryPrice));
  if (!settled.length) return { n: 0, wins: 0, hitRate: null, realised: 0, maxDrawdown: 0 };

  let realised = 0, wins = 0, peak = 0, maxDrawdown = 0;
  for (const p of settled) {
    const payout = p.won ? 1 : 0;
    realised += (payout - p.entryPrice) * p.size;
    if (p.won) wins++;
    peak = Math.max(peak, realised);
    maxDrawdown = Math.max(maxDrawdown, peak - realised);
  }
  return {
    n: settled.length,
    wins,
    hitRate: wins / settled.length,
    realised: Number(realised.toFixed(6)),
    maxDrawdown: Number(maxDrawdown.toFixed(6)),
  };
}
