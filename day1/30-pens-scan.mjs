// Scan every recent World Cup fixture's full history for shootout phase codes
// (docs: 12 = penalties in progress; the post-pens terminal code is UNCONFIRMED).
import { readFileSync } from "node:fs";

const API = "https://txline-dev.txodds.com";
const { jwt, apiToken } = JSON.parse(readFileSync("day1/credentials.json", "utf8"));
const h = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

const epochDay = Math.floor(Date.now() / 86400000);
const fixtures = new Map();
for (const day of [epochDay - 3, epochDay - 2, epochDay - 1, epochDay]) {
  const r = await fetch(`${API}/api/fixtures/snapshot?startEpochDay=${day}`, { headers: h });
  if (!r.ok) continue;
  for (const f of await r.json()) {
    if (f.Competition !== "World Cup") continue;
    const start = f.StartTime > 1e11 ? f.StartTime : f.StartTime * 1000;
    // historical needs start >6h past; skip future/in-play-recent fixtures
    if (start < Date.now() - 6 * 3600_000 && start > Date.now() - 14 * 86400_000) {
      fixtures.set(f.FixtureId, { participant1: f.Participant1, participant2: f.Participant2, start });
    }
  }
}
console.log(`${fixtures.size} finished World Cup fixtures to scan\n`);

for (const [fid, f] of fixtures) {
  const r = await fetch(`${API}/api/scores/historical/${fid}`, { headers: h });
  if (!r.ok) { console.log(`${fid} ${f.participant1} v ${f.participant2}: ${r.status}`); continue; }
  const recs = (await r.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
  const statuses = [];
  for (const rec of recs) {
    if (rec.StatusId != null && statuses.at(-1)?.s !== rec.StatusId) {
      statuses.push({ s: rec.StatusId, seq: rec.Seq });
    }
  }
  const last = recs.at(-1);
  const pens = statuses.some((x) => x.s >= 11);
  console.log(
    `${fid} ${f.participant1} v ${f.participant2} (${new Date(f.start).toISOString().slice(0, 16)}): ` +
    `statuses [${statuses.map((x) => `${x.s}@${x.seq}`).join(" ")}]` +
    `${pens ? "  <<< SHOOTOUT PHASES PRESENT" : ""}` +
    ` finalStats 1=${last?.Stats?.["1"]} 2=${last?.Stats?.["2"]} 5001=${last?.Stats?.["5001"]} 5002=${last?.Stats?.["5002"]}`
  );
  await new Promise((s) => setTimeout(s, 200));
}
