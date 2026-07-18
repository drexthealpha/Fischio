// Production safety for anything that spends money automatically.
//
// WHY THIS EXISTS
//
// The agents held risk limits in their own memory and trusted them. That is fine until the
// process restarts, or a transaction lands that the agent never recorded, or the same agent runs
// twice by accident. Then its idea of what it holds and what the chain says diverge, and every
// limit downstream is being enforced against a number that is wrong.
//
// Three guards, in the order they matter:
//
//   reconcile     ask the chain what we actually hold and refuse to act on a stale belief
//   spend cap     a hard ceiling per day that survives restarts, because a crash loop that
//                 re-funds itself on every boot is how an agent quietly drains a wallet
//   breaker       once something has failed repeatedly, stop, and require a human to resume
//
// The cap and breaker persist to disk. An in-memory limit resets to zero every time the process
// dies, which means it stops being a limit exactly when a crash loop makes it matter most.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DAY_MS = 86_400_000;

/** Load the durable state, tolerating a missing or corrupt file rather than dying on boot. */
function load(path) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  } catch { /* corrupt file: start clean rather than refuse to run */ }
  return { day: null, spent: 0, failures: 0, trippedAt: null, reason: null };
}

function save(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/**
 * A guard for one agent. `path` is where its state persists, `dailyCap` is the most collateral it
 * may commit in a rolling day, `maxFailures` is how many consecutive errors trip the breaker.
 */
export function createGuard({ path, dailyCap = 5000, maxFailures = 5 }) {
  const state = load(path);
  const today = Math.floor(Date.now() / DAY_MS);
  if (state.day !== today) { state.day = today; state.spent = 0; } // a new day resets the cap, nothing else

  const persist = () => save(path, state);

  return {
    get spent() { return state.spent; },
    get tripped() { return state.trippedAt != null; },
    get reason() { return state.reason; },

    /** May we commit `amount`? Returns { ok } or { ok: false, why }. */
    canSpend(amount) {
      if (state.trippedAt != null) return { ok: false, why: `circuit breaker tripped: ${state.reason}` };
      const day = Math.floor(Date.now() / DAY_MS);
      if (state.day !== day) { state.day = day; state.spent = 0; persist(); }
      if (state.spent + amount > dailyCap) {
        return { ok: false, why: `daily cap reached (${state.spent} + ${amount} > ${dailyCap})` };
      }
      return { ok: true };
    },

    /** Record money actually committed. Call this only after the transaction confirms. */
    recordSpend(amount) { state.spent += amount; persist(); },

    /** A step succeeded, so the failure streak is broken. */
    ok() { if (state.failures) { state.failures = 0; persist(); } },

    /** A step failed. Trips the breaker once the streak reaches the limit. */
    fail(why) {
      state.failures++;
      if (state.failures >= maxFailures && state.trippedAt == null) {
        state.trippedAt = Date.now();
        state.reason = `${state.failures} consecutive failures, last: ${String(why).slice(0, 120)}`;
      }
      persist();
      return state.trippedAt != null;
    },

    /** Clear a tripped breaker. Deliberately manual: something went wrong and someone should look. */
    reset() { state.failures = 0; state.trippedAt = null; state.reason = null; persist(); },
  };
}

/**
 * Reconcile believed holdings against the chain.
 *
 * `believed` and `actual` are maps of key to amount. Returns the entries that disagree by more
 * than `tolerance`. An agent that finds a mismatch should stop rather than keep trading, because
 * every risk decision it makes from here is based on a position it does not really have.
 */
export function reconcile(believed, actual, tolerance = 0) {
  const drift = [];
  const keys = new Set([...Object.keys(believed ?? {}), ...Object.keys(actual ?? {})]);
  for (const k of keys) {
    const want = Number(believed?.[k] ?? 0);
    const have = Number(actual?.[k] ?? 0);
    if (Math.abs(want - have) > tolerance) drift.push({ key: k, believed: want, actual: have, delta: have - want });
  }
  return drift;
}
