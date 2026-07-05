// List fixtures visible on the devnet free tier; find ones with recent score activity
import { readFileSync } from "node:fs";

const { jwt, apiToken } = JSON.parse(readFileSync("day1/credentials.json", "utf8"));
const API = "https://txline-dev.txodds.com";
const h = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };
const epochDay = Math.floor(Date.now() / 86400000);

for (const day of [epochDay - 1, epochDay]) {
  const r = await fetch(`${API}/api/fixtures/snapshot?startEpochDay=${day}`, { headers: h });
  if (!r.ok) { console.log(`day ${day}: ${r.status} ${(await r.text()).slice(0, 120)}`); continue; }
  const fixtures = await r.json();
  console.log(`\n=== startEpochDay=${day}: ${fixtures.length} fixtures ===`);
  for (const f of fixtures.slice(0, 40)) {
    console.log(`${f.fixtureId ?? f.FixtureId} | ${f.competition ?? f.Competition} | ${f.participant1 ?? f.Participant1} vs ${f.participant2 ?? f.Participant2} | start=${new Date((f.startTime ?? f.StartTime) * (String(f.startTime ?? f.StartTime).length > 11 ? 1 : 1000)).toISOString()}`);
  }
  if (fixtures.length > 40) console.log(`... and ${fixtures.length - 40} more`);
}
