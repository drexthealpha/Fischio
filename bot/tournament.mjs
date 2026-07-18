// Run fischio across the tournament instead of one fixture at a time.
//
// Loads the full World Cup schedule from the feed, works out which matches capital can reach, and
// prints or executes the plan. This is the piece that turns a single-fixture demo into something a
// desk could point at a whole competition.
//
// WHY THERE IS AN ALLOCATION PLAN AT ALL
//
// The schedule really does hold the whole tournament. Sweeping 44 epoch days against the live feed
// returns 1905 World Cup rows, 106 unique fixture ids, 105 distinct pairings. At roughly 11
// settleable markets a match that is about 1150 markets, each needing pool collateral and book
// inventory. Nobody funds that from one wallet. So which matches get money is a decision made
// deliberately, ahead of time, and every match that does not get money says why.
//
//   node bot/tournament.mjs                        the plan, nothing sent
//   node bot/tournament.mjs --budget 20000         with a real budget
//   node bot/tournament.mjs --execute              open boards on the funded matches
//
// --execute runs bot/market-factory.mjs per funded match. It does not start market makers; those
// are separate processes so one crashing cannot take the rest down.

import "../lib/env.mjs";
import { spawn } from "node:child_process";
import { txlineClient } from "../lib/txline.mjs";
import { allocationPlan, dedupeFixtures, stateOf, kickoffMs, describePlan } from "../lib/tournament.mjs";

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const EXECUTE = argv.includes("--execute");
const BUDGET = Number(flag("budget", 20_000));
const PER_MARKET = Number(flag("liquidity", 1000));
const LEAD_HOURS = Number(flag("lead-hours", 48));
const MAX_CONCURRENT = Number(flag("max-matches", 4));
const DAYS_BACK = Number(flag("days-back", 40));
const DAYS_FORWARD = Number(flag("days-forward", 30));

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const tx = txlineClient();

// ---- the schedule -----------------------------------------------------------------------------
// fixturesSnapshot is per day, so the tournament is assembled by sweeping the window. Days with no
// World Cup fixtures cost one request and return nothing, which is cheaper than guessing the range.
const today = Math.floor(Date.now() / 86_400_000);
const raw = [];
for (let d = today - DAYS_BACK; d <= today + DAYS_FORWARD; d++) {
  const fx = await tx.fixturesSnapshot(d).catch(() => null);
  for (const f of fx ?? []) if (f.Competition === "World Cup") raw.push(f);
}
const fixtures = dedupeFixtures(raw);
const dropped = new Set(raw.map((f) => f.FixtureId)).size - fixtures.length;

log(`schedule: ${raw.length} rows, ${fixtures.length} matches after collapsing duplicate listings${dropped ? ` (${dropped} dropped)` : ""}`);

const now = Date.now();
const by = { live: 0, upcoming: 0, finished: 0, unknown: 0 };
for (const f of fixtures) by[stateOf(f, now)]++;
log(`state: ${by.live} live, ${by.upcoming} upcoming, ${by.finished} finished${by.unknown ? `, ${by.unknown} unknown` : ""}`);

// ---- the plan ---------------------------------------------------------------------------------
// perMatch is the whole board for one fixture. Eleven markets was measured on fixture 18257739;
// other fixtures carry more or fewer, so this is an estimate used only for budgeting, and the
// factory still refuses to overspend on the day.
const MARKETS_PER_MATCH = 11;
const perMatch = PER_MARKET * MARKETS_PER_MATCH;
const plan = allocationPlan(fixtures, { now, budget: BUDGET, perMatch, maxConcurrent: MAX_CONCURRENT, leadHours: LEAD_HOURS });

log(`budget ${BUDGET}, about ${perMatch} per match (${MARKETS_PER_MATCH} markets at ${PER_MARKET})`);
log(describePlan(plan));

console.log(`\nFUNDED`);
for (const r of plan.fund) {
  const hrs = ((r.ko - now) / 3600_000).toFixed(1);
  console.log(`  ${r.fixture.FixtureId}  ${r.state.padEnd(8)} ${hrs.padStart(7)}h  ${r.fixture.Participant1} v ${r.fixture.Participant2}`);
}

// Only the near misses are printed in full. Eighty "already played" lines is noise, but the count
// still appears, because a board that shows nothing on most of the tournament has to be explainable.
const reasons = new Map();
for (const s of plan.skip) {
  const kind = /already played/.test(s.why) ? "already played"
    : /funding window/.test(s.why) ? "beyond the funding window"
    : /ceiling/.test(s.why) ? "at the concurrent match ceiling"
    : /budget/.test(s.why) ? "no budget left"
    : s.why;
  reasons.set(kind, (reasons.get(kind) ?? 0) + 1);
}
console.log(`\nNOT FUNDED`);
for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${why}`);

const nearMiss = plan.skip.filter((s) => /ceiling|budget/.test(s.why)).slice(0, 5);
if (nearMiss.length) {
  console.log(`\n  next in line if the budget grew:`);
  for (const s of nearMiss) {
    console.log(`    ${s.fixture.FixtureId}  ${((s.ko - now) / 3600_000).toFixed(1)}h  ${s.fixture.Participant1} v ${s.fixture.Participant2}`);
  }
}

if (!EXECUTE) {
  console.log(`\nNothing sent. Re-run with --execute to open boards on the funded matches.`);
  process.exit(0);
}

// ---- execute ----------------------------------------------------------------------------------
// One factory process per match, run in sequence. Sequential rather than parallel because they
// share one wallet, and concurrent transactions from the same payer race on the blockhash and the
// collateral balance.
log(`\nopening boards on ${plan.fund.length} match(es)`);
let ok = 0, failed = 0;
for (const r of plan.fund) {
  const id = r.fixture.FixtureId;
  log(`--- fixture ${id}: ${r.fixture.Participant1} v ${r.fixture.Participant2}`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["bot/market-factory.mjs", "--fixture", String(id), "--liquidity", String(PER_MARKET)], { stdio: "inherit" });
    child.on("close", resolve);
  });
  if (code === 0) ok++; else { failed++; log(`fixture ${id} factory exited ${code}`); }
}
log(`done. ${ok} match(es) opened, ${failed} failed`);
if (failed) process.exitCode = 1;
