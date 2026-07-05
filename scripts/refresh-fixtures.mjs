// Regenerate app/src/fixtures.json from the real devnet feed (World Cup fixtures,
// recent + upcoming). Run before a demo so the markets view shows current fixtures
// without shipping API credentials to the browser.
import { readFileSync, writeFileSync } from "node:fs";

const API = "https://txline-dev.txodds.com";
const { jwt, apiToken } = JSON.parse(readFileSync("day1/credentials.json", "utf8"));
const h = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

const today = Math.floor(Date.now() / 86400000);
const map = new Map();
for (const day of [today - 4, today - 2, today]) {
  const r = await fetch(`${API}/api/fixtures/snapshot?startEpochDay=${day}`, { headers: h });
  if (!r.ok) continue;
  for (const f of await r.json()) {
    if (f.Competition !== "World Cup") continue;
    map.set(f.FixtureId, {
      id: f.FixtureId,
      home: f.Participant1,
      away: f.Participant2,
      kickoff: new Date(f.StartTime > 1e11 ? f.StartTime : f.StartTime * 1000).toISOString(),
    });
  }
}
const fixtures = [...map.values()].sort((a, b) => a.kickoff.localeCompare(b.kickoff));
writeFileSync("app/src/fixtures.json", JSON.stringify({ generatedAt: new Date().toISOString(), fixtures }, null, 2));
console.log(`${fixtures.length} World Cup fixtures -> app/src/fixtures.json`);
for (const f of fixtures) console.log(`  ${f.id} ${f.home} v ${f.away} ${f.kickoff.slice(0, 16)}`);
