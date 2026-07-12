// Compute live World Cup winner odds from the remaining bracket, using TxLINE's 1X2 lines and
// the Monte Carlo simulator. Run any time; it reflects the current odds.
//
//   node scripts/winner-odds.mjs
import { readFileSync } from "node:fs";
import { txlineClient, impliedResult } from "../lib/txline.mjs";
import { simulateWinner } from "../lib/wc-simulator.mjs";

const INGEST = process.env.INGEST ?? "http://127.0.0.1:8795";
const tx = txlineClient();

async function liveImplied(id) {
  try { const r = await fetch(`${INGEST}/live/${id}`); if (r.ok) { const s = await r.json(); if (s?.implied?.home != null) return s.implied; } } catch { /* ingest down */ }
  try { return impliedResult(await tx.oddsSnapshot(id)); } catch { return null; }
}

const fixtures = JSON.parse(readFileSync("app/src/fixtures.json", "utf8")).fixtures;
const now = Date.now();
const upcoming = fixtures.filter((f) => new Date(f.kickoff).getTime() > now).sort((a, b) => a.kickoff.localeCompare(b.kickoff));
console.log(`${upcoming.length} remaining fixture(s) to decide the trophy`);

const round0 = [];
for (const f of upcoming) {
  const odds = await liveImplied(f.id);
  if (!odds) { console.log(`  no odds yet for ${f.home} v ${f.away}`); continue; }
  round0.push({ a: f.home, b: f.away, odds });
  console.log(`  ${f.home} v ${f.away}: ${(odds.home * 100).toFixed(0)}/${(odds.draw * 100).toFixed(0)}/${(odds.away * 100).toFixed(0)}`);
}
if (!round0.length) { console.log("no priced fixtures; nothing to simulate"); process.exit(0); }

const title = simulateWinner([round0], { iterations: 50000 });
console.log("\nWorld Cup winner (Monte Carlo, 50,000 simulations, deterministic):");
for (const [team, p] of Object.entries(title).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${team.padEnd(14)} ${(p * 100).toFixed(1)}%`);
}
