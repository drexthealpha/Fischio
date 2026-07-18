// When to restart a crashed service, when to wait, and when to stop trying.
//
// A supervisor that always restarts is not resilience, it is a way to hide a broken service. A
// process that dies on startup every time will be restarted forever, the logs will fill with the
// same failure, and from the outside the box looks busy rather than broken. So this decides three
// things and records why.
//
// TWO DEFECTS THIS FIXES, BOTH FROM THE SUPERVISOR THAT CAME BEFORE IT
//
// The backoff doubled on every crash and never reset. A service that ran healthily for six hours
// and then died once came back with whatever delay had accumulated from unrelated failures hours
// earlier, and there was no path back down. Backoff is meant to protect against a tight crash
// loop, so it has to reset once a run proves the service can stay up.
//
// Nothing ever gave up. Restarting on a five second cycle forever is indistinguishable in the logs
// from a service that is fine, which is the same class of problem as an endpoint reporting "ok"
// while returning nothing. A service that cannot stay up needs to stop and say so.
//
// The policy is pure so it can be tested without spawning anything. Timing bugs in supervisors are
// otherwise found in production at three in the morning.

export const DEFAULTS = {
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  // A run this long counts as the service having actually worked, so the backoff resets.
  healthyAfterMs: 60_000,
  // Give up after this many crashes that each failed to reach healthyAfterMs.
  maxRapidCrashes: 8,
};

/**
 * What to do about a service that just exited.
 *
 * @param {object} state         mutable per-service record: { rapidCrashes, delayMs, startedAt }
 * @param {object} exit          { code, ranForMs }
 * @param {object} [opts]
 * @returns {{restart: boolean, delayMs: number, reason: string, healthy: boolean}}
 */
export function restartDecision(state, exit, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const ranForMs = Math.max(0, Number(exit?.ranForMs ?? 0));
  const healthy = ranForMs >= o.healthyAfterMs;

  if (healthy) {
    // The service worked. Whatever killed it is not a startup problem, so start from the bottom
    // again rather than punishing it for failures that happened hours ago.
    state.rapidCrashes = 0;
    state.delayMs = o.baseDelayMs;
    return {
      restart: true,
      delayMs: o.baseDelayMs,
      healthy: true,
      reason: `ran ${Math.round(ranForMs / 1000)}s before exiting, so the backoff resets`,
    };
  }

  state.rapidCrashes = (state.rapidCrashes ?? 0) + 1;
  if (state.rapidCrashes >= o.maxRapidCrashes) {
    return {
      restart: false,
      delayMs: 0,
      healthy: false,
      reason: `${state.rapidCrashes} crashes in a row without staying up for ${o.healthyAfterMs / 1000}s, so this needs a person`,
    };
  }

  const delayMs = Math.min((state.delayMs ?? o.baseDelayMs) * 2, o.maxDelayMs);
  state.delayMs = delayMs;
  return {
    restart: true,
    delayMs,
    healthy: false,
    reason: `crashed after ${Math.round(ranForMs / 1000)}s, attempt ${state.rapidCrashes} of ${o.maxRapidCrashes}`,
  };
}

/** A fresh per-service record. */
export const newState = (opts = {}) => ({
  rapidCrashes: 0,
  delayMs: (opts.baseDelayMs ?? DEFAULTS.baseDelayMs),
  startedAt: null,
  restarts: 0,
  lastExit: null,
  givenUp: false,
});

/**
 * Overall health, for an endpoint an operator or a monitor can poll.
 *
 * "ok" has to be able to be false. A supervisor reporting ok while three of its children have
 * given up is the same defect as a feed endpoint returning "ok, 0 rows" while the feature is dead.
 */
export function healthOf(services, now = Date.now()) {
  const rows = [...services.entries()].map(([name, s]) => ({
    name,
    up: s.startedAt != null && !s.givenUp,
    givenUp: !!s.givenUp,
    uptimeSeconds: s.startedAt ? Math.round((now - s.startedAt) / 1000) : 0,
    restarts: s.restarts ?? 0,
    rapidCrashes: s.rapidCrashes ?? 0,
    lastExit: s.lastExit ?? null,
  }));
  const givenUp = rows.filter((r) => r.givenUp).map((r) => r.name);
  const down = rows.filter((r) => !r.up && !r.givenUp).map((r) => r.name);
  return {
    ok: givenUp.length === 0 && down.length === 0,
    services: rows,
    givenUp,
    down,
    // Said plainly, because this is what a person reads at three in the morning.
    summary: givenUp.length
      ? `${givenUp.length} service(s) gave up and need attention: ${givenUp.join(", ")}`
      : down.length
        ? `${down.length} service(s) restarting: ${down.join(", ")}`
        : `all ${rows.length} service(s) running`,
  };
}
