#!/usr/bin/env node
// Backtest a strategy against a real match, scored on a result that is proven on-chain.
//
// WHY THIS IS DIFFERENT FROM A NORMAL BACKTEST
//
// Every backtest answers "would this have worked". The usual weak point is the answer key: if the
// outcome you score against came from a scraped web page, your whole result inherits that page's
// trustworthiness. Here the outcome comes from the settled TxLINE record whose Merkle proof is
// checked on-chain by a program we do not control, so the answer key is not something anyone can
// quietly edit, including us.
//
// The price history is real too. One World Cup fixture carries tens of thousands of odds updates,
// several thousand of them on the full-match line alone, so this replays the actual sequence of
// prices a trader would have seen rather than a synthetic walk.
//
//   node bot/backtest.mjs --fixture 18241006
//   node bot/backtest.mjs --fixture 18241006 --type totals --line 2.5
//   flags: --type 1x2|totals|handicap  --line <n>  --steam-move 0.04  --steam-window 600
import "../lib/env.mjs";
import { txlineClient } from "../lib/txline.mjs";
import { parseRow, periodOf, lineOf } from "../lib/markets.mjs";
import { loadResultScore, outcomeOf } from "../lib/scores.mjs";
import { brier, logLoss, calibration, expectedCalibrationError, brierSkillScore } from "../lib/scoring.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const FIXTURE = Number(arg("fixture", 0));
const CALIBRATE = process.argv.includes("--calibrate");
if (!FIXTURE && !CALIBRATE) {
  console.error("usage:\n  node bot/backtest.mjs --fixture <id> [--type 1x2|totals|handicap] [--line 2.5]\n  node bot/backtest.mjs --calibrate [--days 14] [--limit 20]");
  process.exit(1);
}

const TYPES = { "1x2": "1X2_PARTICIPANT_RESULT", totals: "OVERUNDER_PARTICIPANT_GOALS", handicap: "ASIANHANDICAP_PARTICIPANT_GOALS" };
const TYPE = TYPES[String(arg("type", "1x2")).toLowerCase()];
const LINE = arg("line", null) == null ? null : Number(arg("line"));
const STEAM_MOVE = Number(arg("steam-move", 0.04));      // how big a probability jump counts as steam
const STEAM_WINDOW_S = Number(arg("steam-window", 600)); // over how many seconds
const pct = (x) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const num = (x, d = 4) => (x == null ? "n/a" : x.toFixed(d));

const tx = txlineClient();

// ---- calibration mode: many matches, one independent sample each ----
//
// This is the statistically honest way to ask "are the stated probabilities true". It takes a
// single pre-match forecast from each finished match, so the samples are independent events
// rather than one price path sampled thousands of times. Fewer numbers, but they mean something.
if (process.argv.includes("--calibrate")) {
  const days = Number(arg("days", 14));
  const limit = Number(arg("limit", 20));
  const today = Math.floor(Date.now() / 86_400_000);
  const seen = new Map();
  for (let d = today - days; d <= today; d++) {
    for (const comp of [72, 430]) {
      for (const f of (await tx.fixturesSnapshot(d, comp).catch(() => null)) ?? []) {
        if (f?.FixtureId) seen.set(f.FixtureId, f);
      }
    }
  }
  const candidates = [...seen.values()]
    .filter((f) => Number(f.StartTime) < Date.now() - 3 * 3600 * 1000) // started long enough ago to be over
    .sort((a, b) => Number(b.StartTime) - Number(a.StartTime))
    .slice(0, limit);

  console.log(`\nCalibration study: up to ${candidates.length} finished matches, one pre-match forecast each`);
  const samples = [];
  let used = 0;
  for (const f of candidates) {
    const fid = Number(f.FixtureId);
    const { score } = await loadResultScore(tx, fid).catch(() => ({ score: null }));
    if (!score?.final) continue;
    const w = outcomeOf(score);
    // the price as it stood at kickoff, which every match has in common
    const rows = (await tx.oddsSnapshot(fid, Number(f.StartTime)).catch(() => null)) ?? [];
    const m = rows.map(parseRow).find((x) => x.type === TYPES["1x2"] && x.line == null && x.demargined);
    if (!m) continue;
    used++;
    for (const o of m.outcomes) {
      const n = String(o.name).toLowerCase();
      const outcome = n === "part1" ? w === "P1" : n === "part2" ? w === "P2" : n === "draw" ? w === "DRAW" : null;
      if (o.prob != null && outcome != null) samples.push({ p: o.prob, outcome });
    }
    process.stdout.write(".");
  }
  console.log(`\n\nMatches scored: ${used}, independent forecasts: ${samples.length}`);
  if (samples.length < 12) {
    console.log("Too few finished matches in range to say anything honest about calibration.");
    process.exit(0);
  }
  console.log(`  Brier score          ${num(brier(samples))}   (0 perfect, 0.25 is a coin flip)`);
  console.log(`  Log loss             ${num(logLoss(samples))}`);
  console.log(`  Calibration error    ${num(expectedCalibrationError(samples))}`);
  console.log(`  Skill over base rate ${num(brierSkillScore(samples))}   (above 0 beats guessing the average)`);
  // Say plainly when the sample is too small to support a conclusion. A skill score from a few
  // dozen forecasts is noise, and presenting it as a verdict on the bookmaker would be dishonest.
  if (used < 40) {
    console.log(`\n  Read these with care. ${used} matches is a small sample, so the error bars are`);
    console.log(`  wider than the differences shown. This measures the harness, not the bookmaker.`);
    console.log(`  A season of fixtures would make these numbers mean something.`);
  }
  const bins = calibration(samples, 5).filter((b) => b.n >= 5);
  if (bins.length) {
    console.log(`\nCalibration by band (bands with at least 5 forecasts)`);
    for (const b of bins) {
      console.log(`  ${b.bucket.padEnd(9)} said ${pct(b.forecast).padStart(6)}  happened ${pct(b.actual).padStart(6)}  gap ${(b.gap >= 0 ? "+" : "")}${pct(b.gap).padStart(6)}  n=${b.n}`);
    }
  }
  console.log(`\nEvery outcome above is a settled TxLINE record, provable on-chain.\n`);
  process.exit(0);
}

// ---- 1. the answer key: the settled result, the same record the on-chain proof is bound to ----
const { score, source } = await loadResultScore(tx, FIXTURE);
if (!score?.final) {
  console.error(`Fixture ${FIXTURE} has no settled result yet. A backtest needs a finished match.`);
  process.exit(1);
}
const winner = outcomeOf(score); // P1 | P2 | DRAW
const totalGoals = score.p1 + score.p2;

// ---- 2. the price history: every update this market actually printed ----
const updates = await tx.oddsUpdatesFixture(FIXTURE);
if (!Array.isArray(updates) || !updates.length) {
  console.error(`No odds history for fixture ${FIXTURE}.`);
  process.exit(1);
}

// Keep the rows for the one market being tested, in time order, demargined only. A quarter line
// publishes no fair price, so it cannot be scored and is dropped rather than guessed at.
const series = updates
  .filter((r) => r.SuperOddsType === TYPE)
  .map(parseRow)
  .filter((m) => m.demargined && m.ts && (LINE == null ? m.line == null || TYPE === TYPES["1x2"] : m.line === LINE))
  .filter((m) => periodOf(m.period) === "FT" || m.period === "FT")
  .sort((a, b) => a.ts - b.ts);

if (!series.length) {
  console.error(`No demargined ${TYPE} history${LINE != null ? ` on line ${LINE}` : ""} for this fixture.`);
  process.exit(1);
}

// ---- 3. which outcome actually won, in this market's own vocabulary ----
function didWin(outcomeName) {
  const n = String(outcomeName).toLowerCase();
  if (TYPE === TYPES["1x2"]) {
    if (n === "part1") return winner === "P1";
    if (n === "part2") return winner === "P2";
    if (n === "draw") return winner === "DRAW";
  }
  if (TYPE === TYPES.totals) {
    if (n.startsWith("over")) return totalGoals > LINE;
    if (n.startsWith("under")) return totalGoals < LINE;
  }
  if (TYPE === TYPES.handicap) {
    const margin = score.p1 - score.p2;
    if (n === "part1") return margin + LINE > 0;
    if (n === "part2") return margin + LINE < 0;
  }
  return null;
}

// ---- 4. score every price the market printed, as a forecast ----
const forecasts = [];
for (const m of series) {
  for (const o of m.outcomes) {
    const outcome = didWin(o.name);
    if (o.prob != null && outcome != null) forecasts.push({ ts: m.ts, name: o.name, p: o.prob, outcome, inRunning: m.inRunning });
  }
}

// ---- 5. steam: a sharp move in the fair price, and whether it pointed the right way ----
// A signal fires when one outcome's probability jumps by more than the threshold inside the
// window. It is scored on whether the direction it moved matched what actually happened, which is
// the only honest test of a movement signal.
const signals = [];
const byName = new Map();
for (const m of series) {
  for (const o of m.outcomes) {
    if (o.prob == null) continue;
    const hist = byName.get(o.name) ?? [];
    hist.push({ ts: m.ts, p: o.prob });
    while (hist.length && m.ts - hist[0].ts > STEAM_WINDOW_S * 1000) hist.shift();
    byName.set(o.name, hist);
    if (hist.length > 1) {
      const move = o.prob - hist[0].p;
      if (Math.abs(move) >= STEAM_MOVE) {
        const outcome = didWin(o.name);
        if (outcome != null) {
          signals.push({ ts: m.ts, name: o.name, from: hist[0].p, to: o.prob, move, outcome, correct: move > 0 === outcome });
        }
        byName.set(o.name, [{ ts: m.ts, p: o.prob }]); // reset so one drift is not counted repeatedly
      }
    }
  }
}

// ---- report ----
const first = series[0], last = series[series.length - 1];
const span = Math.round((last.ts - first.ts) / 60000);
const label = `${arg("type", "1x2")}${LINE != null ? ` ${LINE}` : ""}`;

console.log(`\nBacktest  fixture ${FIXTURE}  ${label}`);
console.log(`Result    ${score.p1}-${score.p2} (${winner}), read from ${source}, settled at sequence ${score.seq}`);
console.log(`History   ${series.length} price points over ${span} minutes, ${forecasts.length} scored forecasts`);
console.log(`Opened    ${first.outcomes.map((o) => `${o.name} ${pct(o.prob)}`).join("  ")}`);
console.log(`Closed    ${last.outcomes.map((o) => `${o.name} ${pct(o.prob)}`).join("  ")}`);

// How sharp the price got, measured in slices of the match.
//
// A deliberate omission: this does NOT report calibration or a skill score for a single match.
// Those need independent samples, and every price in one match is the same story told repeatedly,
// so pooling them produces a confident-looking number that means nothing. A match with one big
// swing would always score as "badly calibrated" when the market was simply uncertain early and
// correct later, which is what a market is supposed to do. Calibration is a many-match question,
// and `--calibrate` answers it with one independent sample per match.
//
// What is valid within one match is convergence: did the price move toward the truth as the
// evidence arrived. Brier per slice shows exactly that, and lower is sharper.
// Split on the feed's own in-running flag rather than wall-clock. The price history starts days
// before kickoff, so slicing the raw span by time would bury the entire match in the last slice
// and make a sharpening price look like a worsening one.
const pre = forecasts.filter((f) => !f.inRunning);
const live = forecasts.filter((f) => f.inRunning);
console.log(`\nDid the price converge on the truth (Brier, lower is sharper)`);
if (pre.length) console.log(`  before kickoff   ${num(brier(pre))}  (${pre.length} forecasts)`);
if (live.length) {
  const s = live[0].ts, dur = (live[live.length - 1].ts - s) || 1;
  for (const [name, lo, hi] of [["opening third", 0, 1 / 3], ["middle third", 1 / 3, 2 / 3], ["closing third", 2 / 3, 1.01]]) {
    const slice = live.filter((f) => { const t = (f.ts - s) / dur; return t >= lo && t < hi; });
    if (slice.length >= 10) console.log(`  in play, ${name.padEnd(14)} ${num(brier(slice))}  (${slice.length} forecasts)`);
  }
}
// The closing price is the cleanest single read on whether the market ended up right.
const closing = forecasts.filter((f) => f.ts === last.ts);
if (closing.length) console.log(`  closing price    ${num(brier(closing))}  (the last price printed)`);
console.log(`  log loss overall ${num(logLoss(forecasts))}`);

console.log(`\nSteam signals (a move of ${pct(STEAM_MOVE)} or more within ${STEAM_WINDOW_S}s)`);
if (!signals.length) {
  console.log(`  none fired on this market`);
} else {
  const right = signals.filter((s) => s.correct).length;
  console.log(`  fired ${signals.length}, pointed the right way ${right} (${pct(right / signals.length)})`);
  for (const s of signals.slice(0, 8)) {
    console.log(`    ${new Date(s.ts).toISOString().slice(11, 19)}  ${s.name.padEnd(6)} ${pct(s.from)} -> ${pct(s.to)}  ${s.correct ? "correct" : "wrong"}`);
  }
  if (signals.length > 8) console.log(`    ... and ${signals.length - 8} more`);
}

console.log(`\nThe result above is the settled TxLINE record, provable on-chain:`);
console.log(`  fischio verify result ${FIXTURE}\n`);
