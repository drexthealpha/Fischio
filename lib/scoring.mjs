// Proper scoring rules for probability forecasts.
//
// A prediction market is a forecasting machine, so the honest way to judge one is with a proper
// scoring rule, not with profit alone. Profit measures whether you got paid; a scoring rule
// measures whether you were right, and it cannot be gamed by shading forecasts toward the
// extremes. These are the standard ones.
//
// Everything here is pure and deterministic. No randomness, no fitted constants, no state. The
// inputs are a forecast probability and what actually happened, and what actually happened comes
// from a settled result that is Merkle-proven on-chain, which is the part that matters: a
// backtest scored against a scraped result is only as trustworthy as the scraper.

/**
 * Brier score for a binary forecast. The mean squared error of the probability.
 * 0 is perfect, 0.25 is what you get by always saying 50%, 1 is confidently wrong every time.
 * Lower is better.
 */
export function brier(forecasts) {
  const rows = forecasts.filter((f) => f.p != null && f.outcome != null);
  if (!rows.length) return null;
  const total = rows.reduce((s, f) => s + (f.p - (f.outcome ? 1 : 0)) ** 2, 0);
  return total / rows.length;
}

/**
 * Logarithmic score (log loss). Punishes confident mistakes far harder than Brier does, which is
 * the right bias for a market that pays out on certainty. Lower is better.
 *
 * A forecast of exactly 0 or 1 that turns out wrong is infinitely bad, so probabilities are
 * clamped a hair away from the ends. That clamp is a scoring convention, not a fudge of the data.
 */
export function logLoss(forecasts, eps = 1e-6) {
  const rows = forecasts.filter((f) => f.p != null && f.outcome != null);
  if (!rows.length) return null;
  const total = rows.reduce((s, f) => {
    const p = Math.min(1 - eps, Math.max(eps, f.p));
    return s - (f.outcome ? Math.log(p) : Math.log(1 - p));
  }, 0);
  return total / rows.length;
}

/**
 * Calibration: of everything forecast at about 70%, did roughly 70% happen?
 *
 * A market can be sharp and still badly calibrated, so this is a different question from Brier.
 * Returns one row per populated bucket with the forecast average, the realised rate, and the
 * count, plus the gap between them. A well calibrated book has small gaps in the busy buckets.
 */
export function calibration(forecasts, bucketCount = 10) {
  const rows = forecasts.filter((f) => f.p != null && f.outcome != null);
  const buckets = Array.from({ length: bucketCount }, () => ({ n: 0, sumP: 0, hits: 0 }));
  for (const f of rows) {
    const i = Math.min(bucketCount - 1, Math.floor(f.p * bucketCount));
    buckets[i].n++;
    buckets[i].sumP += f.p;
    if (f.outcome) buckets[i].hits++;
  }
  return buckets
    .map((b, i) => {
      if (!b.n) return null;
      const forecast = b.sumP / b.n;
      const actual = b.hits / b.n;
      return {
        bucket: `${Math.round((i / bucketCount) * 100)}-${Math.round(((i + 1) / bucketCount) * 100)}%`,
        n: b.n, forecast, actual, gap: actual - forecast,
      };
    })
    .filter(Boolean);
}

/**
 * Expected calibration error: the average calibration gap, weighted by how many forecasts fell in
 * each bucket. One number for "how far off were the stated probabilities". Lower is better.
 */
export function expectedCalibrationError(forecasts, bucketCount = 10) {
  const bins = calibration(forecasts, bucketCount);
  const n = bins.reduce((s, b) => s + b.n, 0);
  if (!n) return null;
  return bins.reduce((s, b) => s + (b.n / n) * Math.abs(b.gap), 0);
}

/**
 * Skill against the naive baseline of always forecasting the base rate, as a fraction of the
 * Brier score removed. Positive means the forecasts beat "always guess the average". This is the
 * number that says whether the forecasting added anything at all.
 */
export function brierSkillScore(forecasts) {
  const rows = forecasts.filter((f) => f.p != null && f.outcome != null);
  if (!rows.length) return null;
  const base = rows.reduce((s, f) => s + (f.outcome ? 1 : 0), 0) / rows.length;
  const ref = rows.reduce((s, f) => s + (base - (f.outcome ? 1 : 0)) ** 2, 0) / rows.length;
  const score = brier(rows);
  if (ref === 0) return null; // the outcome never varied, so there is nothing to beat
  return 1 - score / ref;
}
