// Sponsor guidance: use the record with Action = "game_finalised" (FixtureId + Seq)
// and request proof for statKeys=1,2. Compare that record against our period-based
// terminal transition on real finished fixtures.
import { readFileSync } from "node:fs";

const API = "https://txline-dev.txodds.com";
const { jwt, apiToken } = JSON.parse(readFileSync("day1/credentials.json", "utf8"));
const h = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

const FIXTURES = [
  [18172379, "USA-Bosnia (FT, our terminal seq 1054)"],
  [18172280, "Netherlands-Morocco (pens, our terminal seq 1425)"],
  [18188721, "Paraguay-France (played last night)"],
];

for (const [fid, label] of FIXTURES) {
  const r = await fetch(`${API}/api/scores/historical/${fid}`, { headers: h });
  if (!r.ok) { console.log(`${label}: ${r.status}`); continue; }
  const recs = (await r.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
  console.log(`\n=== ${label}: ${recs.length} records ===`);
  const actions = new Map();
  for (const rec of recs) {
    if (rec.Action) actions.set(rec.Action, (actions.get(rec.Action) ?? 0) + 1);
  }
  console.log("distinct Actions:", [...actions.entries()].map(([a, n]) => `${a}(${n})`).join(" "));
  const finals = recs.filter((rec) => /finali[sz]ed/i.test(rec.Action ?? ""));
  for (const rec of finals) {
    console.log(`game_finalised record: seq=${rec.Seq} StatusId=${rec.StatusId} Ts=${new Date(rec.Ts).toISOString()}`);
    // what does the proof at THAT seq carry?
    const v = await (await fetch(`${API}/api/scores/stat-validation?fixtureId=${fid}&seq=${rec.Seq}&statKey=1&statKey2=2`, { headers: h })).json();
    console.log(`  proof at that seq: stat1=${JSON.stringify(v.statToProve)} stat2=${JSON.stringify(v.statToProve2)}`);
  }
  if (!finals.length) console.log("no game_finalised record in this fixture's history");
}
