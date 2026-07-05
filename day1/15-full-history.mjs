// Full score history for finished fixtures: find the true final record and its phase.
// Valid window: start time between 2 weeks and 6 hours in the past.
import { readFileSync, writeFileSync } from "node:fs";

const API = "https://txline-dev.txodds.com";
const { jwt, apiToken } = JSON.parse(readFileSync("day1/credentials.json", "utf8"));
const h = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

const FIXTURES = {
  18172379: "USA-Bosnia (Jul 2 00:00Z)",
  18179550: "Belgium-Senegal (Jul 1 20:00Z)",
  18179764: "England-CongoDR (Jul 1 16:00Z)",
};

for (const [fid, label] of Object.entries(FIXTURES)) {
  const r = await fetch(`${API}/api/scores/historical/${fid}`, { headers: h });
  if (!r.ok) { console.log(`${label}: ${r.status} ${(await r.text()).slice(0, 120)}`); continue; }
  const raw = await r.text();
  // response is SSE-style: lines of `data: {json}` (possibly with heartbeats)
  const hist = raw.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)))
    .filter((o) => o.FixtureId != null);
  writeFileSync(`day1/history-${fid}.json`, JSON.stringify(hist, null, 2));
  console.log(`\n=== ${label}: ${hist.length} records ===`);
  // distinct GameState/StatusId transitions
  let prev = "";
  for (const rec of hist) {
    const sig = `${rec.GameState}|${rec.StatusId}`;
    if (sig !== prev) {
      console.log(` seq=${String(rec.Seq).padStart(4)} ts=${new Date(rec.Ts).toISOString()} GameState=${rec.GameState} StatusId=${rec.StatusId} clock=${rec.Clock?.Seconds}s score=${JSON.stringify(rec.Score?.Participant1?.Total)}v${JSON.stringify(rec.Score?.Participant2?.Total)}`);
      prev = sig;
    }
  }
  const last = hist[hist.length - 1];
  console.log(` LAST: seq=${last.Seq} ts=${new Date(last.Ts).toISOString()} GameState=${last.GameState} StatusId=${last.StatusId} clock=${last.Clock?.Seconds}s`);
  console.log(` LAST Stats totals: 1=${last.Stats?.["1"]} 2=${last.Stats?.["2"]}`);
}
