// Does the proven stat leaf carry a "match ended" signal? Compare FINISHED vs LIVE proofs.
// Finished: USA vs Bosnia 18172379 (2026-07-02T00:00Z). Live sample already saved: Spain-Austria period=2 mid-H1.
import { readFileSync, writeFileSync } from "node:fs";

const API = "https://txline-dev.txodds.com";
const FIXTURE = Number(process.argv[2] ?? 18172379);
const { jwt, apiToken } = JSON.parse(readFileSync("day1/credentials.json", "utf8"));
const h = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

// 1. full snapshot of the finished fixture
const snap = await (await fetch(`${API}/api/scores/snapshot/${FIXTURE}?asOf=${Date.now()}`, { headers: h })).json();
console.log(`snapshot records: ${snap.length}`);
const last = snap[snap.length - 1];
writeFileSync("day1/finished-snapshot.json", JSON.stringify(snap, null, 2));
for (const r of snap.slice(-3)) {
  console.log(`Seq=${r.Seq} Ts=${r.Ts} GameState=${JSON.stringify(r.GameState)} StatusId=${r.StatusId} Type=${r.Type} Clock=${JSON.stringify(r.Clock)} Score=${JSON.stringify(r.Score)}`);
}
console.log("\nlast record Stats:", JSON.stringify(last.Stats)?.slice(0, 800));
console.log("last record Data:", JSON.stringify(last.Data)?.slice(0, 400));

// 2. proof at the FINAL seq
const seqFinal = last.Seq;
const vFinal = await (await fetch(`${API}/api/scores/stat-validation?fixtureId=${FIXTURE}&seq=${seqFinal}&statKey=1&statKey2=2`, { headers: h })).json();
writeFileSync("day1/proof-finished.json", JSON.stringify(vFinal, null, 2));
console.log(`\nFINAL proof (seq=${seqFinal}):`);
console.log("  statToProve :", JSON.stringify(vFinal.statToProve));
console.log("  statToProve2:", JSON.stringify(vFinal.statToProve2));
console.log("  summary.updateStats:", JSON.stringify(vFinal.summary?.updateStats));

// 3. proof at an EARLY seq (mid-match) for the same fixture
const seqMid = Math.max(1, Math.floor(seqFinal / 2));
const rMid = await fetch(`${API}/api/scores/stat-validation?fixtureId=${FIXTURE}&seq=${seqMid}&statKey=1&statKey2=2`, { headers: h });
if (rMid.ok) {
  const vMid = await rMid.json();
  console.log(`\nMID proof (seq=${seqMid}):`);
  console.log("  statToProve :", JSON.stringify(vMid.statToProve));
  console.log("  statToProve2:", JSON.stringify(vMid.statToProve2));
} else {
  console.log(`\nMID proof (seq=${seqMid}): ${rMid.status} ${(await rMid.text()).slice(0, 150)}`);
}

// 4. what other stat keys are provable at the final seq? probe a range incl. possible phase keys
console.log("\nprobing statKeys at final seq:");
for (const k of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 50, 100, 1001, 1002, 2001, 2002]) {
  const r = await fetch(`${API}/api/scores/stat-validation?fixtureId=${FIXTURE}&seq=${seqFinal}&statKey=${k}`, { headers: h });
  if (r.ok) {
    const v = await r.json();
    console.log(`  key=${k}: PROVABLE -> ${JSON.stringify(v.statToProve)}`);
  } else {
    console.log(`  key=${k}: ${r.status}`);
  }
  await new Promise((s) => setTimeout(s, 150));
}
