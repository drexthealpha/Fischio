#!/usr/bin/env node
// Sharp-movement detector: an autonomous agent that watches the live TxLINE board for steam and
// keeps an honest record of whether it was right.
//
// WHAT STEAM IS
//
// A line that moves fast and does not come back is usually informed money arriving. A line that
// jitters and reverts is noise. The difference matters, because the first is a signal and the
// second is a way to lose money paying spread. This agent watches every market on the board,
// flags a move that clears a threshold inside a window, and then, crucially, waits for the match
// to settle and scores itself.
//
// WHY THE SCORING IS THE POINT
//
// Any bot can print an alert. The thing that makes a signal worth anything is a hit rate you did
// not choose after the fact, so every signal is written to a journal the moment it fires, with
// the odds update that caused it, and is scored later against a result proven on-chain. The
// agent cannot quietly drop the signals that went wrong, because they are already on disk.
//
//   node bot/steam-agent.mjs                     watch every tracked fixture
//   node bot/steam-agent.mjs --fixture 18257739  watch one
//   node bot/steam-agent.mjs --score             score past signals against settled results
//   flags: --move 0.03  --window 300  --interval 20000  --journal <path>
import "../lib/env.mjs";
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { txlineClient, parseMarkets } from "../lib/txline.mjs";
import { loadResultScore, outcomeOf } from "../lib/scores.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const MOVE = Number(arg("move", 0.03));        // how far a probability must travel to count
const WINDOW_S = Number(arg("window", 300));   // inside how many seconds
const INTERVAL = Number(arg("interval", 20000));
const ONLY = Number(arg("fixture", 0));
const JOURNAL = arg("journal", join(root, "local", "steam-journal.jsonl"));
const INGEST = arg("ingest", process.env.INGEST ?? "http://127.0.0.1:8795");

const tx = txlineClient();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const pct = (p) => (p == null ? "n/a" : `${(p * 100).toFixed(1)}%`);

// ---- scoring mode: settle the journal against results proven on-chain ----
if (process.argv.includes("--score")) {
  if (!existsSync(JOURNAL)) { console.log(`No journal at ${JOURNAL} yet. Run the agent first.`); process.exit(0); }
  const rows = readFileSync(JOURNAL, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const byFixture = new Map();
  for (const r of rows) { const a = byFixture.get(r.fixtureId) ?? []; a.push(r); byFixture.set(r.fixtureId, a); }

  console.log(`\nScoring ${rows.length} signals across ${byFixture.size} fixtures\n`);
  let scored = 0, correct = 0, unsettled = 0;
  for (const [fixtureId, sigs] of byFixture) {
    const { score } = await loadResultScore(tx, fixtureId).catch(() => ({ score: null }));
    if (!score?.final) { unsettled += sigs.length; continue; }
    const winner = outcomeOf(score);
    const total = score.p1 + score.p2;
    let fixHit = 0, fixN = 0;
    for (const s of sigs) {
      // Did the outcome the line moved toward actually happen?
      let happened = null;
      const n = String(s.outcome).toLowerCase();
      if (s.type === "1X2_PARTICIPANT_RESULT") {
        happened = n === "part1" ? winner === "P1" : n === "part2" ? winner === "P2" : n === "draw" ? winner === "DRAW" : null;
      } else if (s.type === "OVERUNDER_PARTICIPANT_GOALS" && s.line != null) {
        happened = n.startsWith("over") ? total > s.line : n.startsWith("under") ? total < s.line : null;
      }
      if (happened == null) continue;
      const right = (s.move > 0) === happened; // it drifted toward the truth
      fixN++; if (right) fixHit++;
      scored++; if (right) correct++;
    }
    if (fixN) console.log(`  ${fixtureId}  ${score.p1}-${score.p2}  ${fixHit}/${fixN} signals pointed the right way`);
  }
  console.log(`\nTotal: ${scored} scored, ${correct} correct${scored ? ` (${((correct / scored) * 100).toFixed(1)}%)` : ""}`);
  if (unsettled) console.log(`${unsettled} signals are on matches that have not settled yet.`);
  if (scored && scored < 30) console.log(`\nToo few signals to call this an edge. It is a record, not yet a result.`);
  console.log(`\nEvery result above is a settled TxLINE record: fischio verify result <id>\n`);
  process.exit(0);
}

// ---- watch mode ----
mkdirSync(dirname(JOURNAL), { recursive: true });
const history = new Map(); // `${fixtureId}:${marketKey}:${outcome}` -> [{ts, p}]
let fired = 0;

async function fixturesToWatch() {
  if (ONLY) return [ONLY];
  try {
    const r = await fetch(`${INGEST}/live`);
    if (r.ok) { const j = await r.json(); const ids = Object.keys(j.fixtures ?? {}).map(Number).filter(Boolean); if (ids.length) return ids; }
  } catch { /* ingestion not running, fall through */ }
  const day = Math.floor(Date.now() / 86_400_000);
  const out = [];
  for (const f of (await tx.fixturesSnapshot(day, 72).catch(() => null)) ?? []) if (f?.FixtureId) out.push(Number(f.FixtureId));
  return out;
}

async function sweep() {
  const ids = await fixturesToWatch();
  for (const fixtureId of ids) {
    const board = parseMarkets((await tx.oddsSnapshot(fixtureId).catch(() => null)) ?? []);
    for (const m of board) {
      if (!m.demargined) continue; // a quarter line has no fair price, so it cannot steam
      for (const o of m.outcomes) {
        if (o.prob == null) continue;
        const key = `${fixtureId}:${m.key}:${o.name}`;
        const hist = history.get(key) ?? [];
        // Only record a genuinely new odds update. Polling faster than the book reprices would
        // otherwise stack the same price repeatedly and make a quiet line look like a busy one.
        const stamp = m.ts ?? Date.now();
        if (hist.length && hist[hist.length - 1].ts === stamp) continue;
        hist.push({ ts: stamp, p: o.prob });
        while (hist.length && (m.ts ?? Date.now()) - hist[0].ts > WINDOW_S * 1000) hist.shift();
        history.set(key, hist);
        if (hist.length < 2) continue;
        const move = o.prob - hist[0].p;
        if (Math.abs(move) < MOVE) continue;

        // A signal, written down before anyone knows if it was right, with the exact odds update
        // that caused it so the price can be proven later with validate_odds.
        const signal = {
          at: new Date().toISOString(), fixtureId, market: m.key, type: m.type, line: m.line,
          period: m.period, outcome: o.name, from: hist[0].p, to: o.prob, move,
          windowSeconds: Math.round(((m.ts ?? Date.now()) - hist[0].ts) / 1000),
          messageId: m.messageId, ts: m.ts, inRunning: m.inRunning,
        };
        appendFileSync(JOURNAL, JSON.stringify(signal) + "\n");
        fired++;
        log(`STEAM ${fixtureId} ${m.type.split("_")[0]}${m.line != null ? ` ${m.line}` : ""} ${o.name}  ${pct(hist[0].p)} -> ${pct(o.prob)}  (${move > 0 ? "+" : ""}${(move * 100).toFixed(1)}pp in ${signal.windowSeconds}s)  proof ${m.messageId}`);
        history.set(key, [{ ts: m.ts ?? Date.now(), p: o.prob }]); // reset so one drift is not counted twice
      }
    }
  }
}

log(`steam agent watching${ONLY ? ` fixture ${ONLY}` : " every tracked fixture"}`);
log(`threshold ${pct(MOVE)} inside ${WINDOW_S}s, journal ${JOURNAL}`);
log(`score what it has recorded so far with:  node bot/steam-agent.mjs --score`);
for (;;) {
  await sweep().catch((e) => log(`sweep failed: ${String(e.message ?? e).slice(0, 120)}`));
  await new Promise((r) => setTimeout(r, INTERVAL));
}
