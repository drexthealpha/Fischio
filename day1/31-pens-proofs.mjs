// Netherlands v Morocco 18172280: pull the terminal (StatusId 13) and mid-shootout
// (StatusId 12) proofs; confirm the exact period codes their leaves carry.
import { readFileSync, writeFileSync } from "node:fs";

const API = "https://txline-dev.txodds.com";
const { jwt, apiToken } = JSON.parse(readFileSync("day1/credentials.json", "utf8"));
const h = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };
const FID = 18172280;

for (const [seq, label, file] of [
  [1425, "terminal transition (StatusId 13)", "test-fixtures/proof-pens-final.json"],
  [1381, "shootout start (StatusId 12)", "test-fixtures/proof-pens-mid.json"],
  [1400, "mid-shootout", null],
]) {
  const r = await fetch(`${API}/api/scores/stat-validation?fixtureId=${FID}&seq=${seq}&statKey=1&statKey2=2`, { headers: h });
  if (!r.ok) { console.log(`seq ${seq} (${label}): ${r.status} ${(await r.text()).slice(0, 120)}`); continue; }
  const v = await r.json();
  console.log(`seq ${seq} (${label}): stat1=${JSON.stringify(v.statToProve)} stat2=${JSON.stringify(v.statToProve2)} minTs=${v.summary.updateStats.minTimestamp} epochDay=${Math.floor(v.summary.updateStats.minTimestamp / 86400000)}`);
  if (file) writeFileSync(file, JSON.stringify(v, null, 2));
  await new Promise((s) => setTimeout(s, 200));
}

// pens-goal keys (5001/5002) at the terminal seq, if they are provable leaves
const r = await fetch(`${API}/api/scores/stat-validation?fixtureId=${FID}&seq=1425&statKey=5001&statKey2=5002`, { headers: h });
if (r.ok) {
  const v = await r.json();
  console.log(`pens-goal keys @1425: stat1=${JSON.stringify(v.statToProve)} stat2=${JSON.stringify(v.statToProve2)}`);
} else {
  console.log(`pens-goal keys @1425: ${r.status}`);
}
