// Safety check: can a MID-MATCH seq ever yield period=0 leaves? Probe the undefined-StatusId
// score-update records observed mid-match in USA-Bosnia history, plus pre-match seqs.
import { readFileSync } from "node:fs";

const API = "https://txline-dev.txodds.com";
const { jwt, apiToken } = JSON.parse(readFileSync("day1/credentials.json", "utf8"));
const h = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };
const FID = 18172379; // USA-Bosnia

// seq -> where it sits in the match (from 15-full-history output)
const CASES = [
  [5, "pre-match (StatusId=1 NS)"],
  [16, "kickoff (StatusId=2)"],
  [202, "mid-H1 score-action record (StatusId=undefined)"],
  [446, "mid-H1 score-action record (StatusId=undefined)"],
  [703, "mid-H2 score-action record (StatusId=undefined)"],
  [826, "mid-H2 score-action record (StatusId=undefined)"],
  [1032, "late-H2 score-action record (StatusId=undefined)"],
  [1050, "89th-min score record (clock 5983s)"],
  [1051, "StatusId=4 record seconds before FT"],
  [1057, "post-FT record (StatusId=undefined)"],
];

for (const [seq, label] of CASES) {
  const r = await fetch(`${API}/api/scores/stat-validation?fixtureId=${FID}&seq=${seq}&statKey=1&statKey2=2`, { headers: h });
  if (!r.ok) { console.log(`seq=${seq} (${label}): ${r.status} ${(await r.text()).slice(0, 100)}`); continue; }
  const v = await r.json();
  console.log(`seq=${String(seq).padStart(4)} ${label}: period=${v.statToProve.period} value=${v.statToProve.value} | stat2 period=${v.statToProve2?.period} value=${v.statToProve2?.value}`);
  await new Promise((s) => setTimeout(s, 150));
}
