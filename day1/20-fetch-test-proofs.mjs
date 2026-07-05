// Fetch remaining proof packages the adversarial suite needs:
// - corners proof (statKey 7/8) at USA-Bosnia terminal seq  -> wrong-stat-key case
// - re-check Spain-Austria final for a draw/pens data point
import { readFileSync, writeFileSync } from "node:fs";

const API = "https://txline-dev.txodds.com";
const { jwt, apiToken } = JSON.parse(readFileSync("day1/credentials.json", "utf8"));
const h = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

const get = async (label, url, file) => {
  const r = await fetch(url, { headers: h });
  if (!r.ok) { console.log(`${label}: ${r.status} ${(await r.text()).slice(0, 120)}`); return null; }
  const v = await r.json();
  if (file) writeFileSync(file, JSON.stringify(v, null, 2));
  console.log(`${label}: statToProve=${JSON.stringify(v.statToProve)} statToProve2=${JSON.stringify(v.statToProve2)}`);
  return v;
};

await get(
  "USA corners @1054",
  `${API}/api/scores/stat-validation?fixtureId=18172379&seq=1054&statKey=7&statKey2=8`,
  "day1/proof-usa-corners.json"
);
