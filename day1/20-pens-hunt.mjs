// Hunt for the penalties-decided terminal StatusId among finished knockout fixtures
import { readFileSync } from "node:fs";

const { jwt, apiToken } = JSON.parse(readFileSync("day1/credentials.json", "utf8"));
const h = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

const FIXTURES = [
  [18179551, "Spain-Austria (19:00Z today)"],
  [18179552, "Switzerland-Algeria (03:00Z today)"],
  [18179759, "Mexico-Ecuador (Jul 1 02:00Z)"],
];

for (const [fid, label] of FIXTURES) {
  const r = await fetch(`https://txline-dev.txodds.com/api/scores/historical/${fid}`, { headers: h });
  if (!r.ok) { console.log(`${label}: ${r.status} ${(await r.text()).slice(0, 80)}`); continue; }
  const recs = (await r.text()).split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
  if (recs.length === 0) { console.log(`${label}: 0 records (outside 6h..2wk window?)`); continue; }
  const statuses = [];
  for (const x of recs) if (x.StatusId != null && statuses[statuses.length - 1] !== x.StatusId) statuses.push(x.StatusId);
  const last = recs[recs.length - 1];
  const s = last.Stats ?? {};
  console.log(`${label}: ${recs.length} recs, StatusId path=[${statuses.join(",")}], lastSeq=${last.Seq}, totals ${s["1"]}-${s["2"]}, pens ${s["5001"] ?? 0}-${s["5002"] ?? 0}`);
}
