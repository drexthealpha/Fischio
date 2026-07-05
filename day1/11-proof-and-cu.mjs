// THE day-1 test: pull a real stat-validation proof from devnet API,
// simulate validate_stat on devnet, report ACTUAL compute units consumed.
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import BN from "bn.js";
import { readFileSync, writeFileSync } from "node:fs";

const API = "https://txline-dev.txodds.com";
const FIXTURE_ID = Number(process.argv[2] ?? 18179551); // Spain vs Austria, live now
const STAT_KEY = Number(process.argv[3] ?? 1);  // P1 goals, full match
const STAT_KEY2 = Number(process.argv[4] ?? 2); // P2 goals, full match

const { jwt, apiToken } = JSON.parse(readFileSync("day1/credentials.json", "utf8"));
const h = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

// --- 1. scores snapshot: find latest seq ---
const snapRes = await fetch(`${API}/api/scores/snapshot/${FIXTURE_ID}?asOf=${Date.now()}`, { headers: h });
if (!snapRes.ok) throw new Error(`snapshot ${snapRes.status}: ${(await snapRes.text()).slice(0, 200)}`);
const snap = await snapRes.json();
writeFileSync("day1/scores-snapshot.json", JSON.stringify(snap, null, 2));
console.log(`scores snapshot: ${Array.isArray(snap) ? snap.length : 1} records (saved to day1/scores-snapshot.json)`);
const first = Array.isArray(snap) ? snap[0] : snap;
console.log("sample record keys:", first ? Object.keys(first).join(", ") : "EMPTY");
const seq = first?.seq ?? first?.Seq ?? first?.sequence;
console.log("using seq:", seq);
if (seq == null) { console.log("no seq found - dump:", JSON.stringify(first).slice(0, 600)); process.exit(1); }

// --- 2. stat-validation proof package ---
const valRes = await fetch(`${API}/api/scores/stat-validation?fixtureId=${FIXTURE_ID}&seq=${seq}&statKey=${STAT_KEY}&statKey2=${STAT_KEY2}`, { headers: h });
if (!valRes.ok) throw new Error(`stat-validation ${valRes.status}: ${(await valRes.text()).slice(0, 200)}`);
const v = await valRes.json();
writeFileSync("day1/proof-package.json", JSON.stringify(v, null, 2));
console.log("proof package saved to day1/proof-package.json; top-level keys:", Object.keys(v).join(", "));

// --- 3. build validate_stat and simulate ---
const toBytes32 = (val) => {
  const b = Array.isArray(val) ? Buffer.from(val)
    : typeof val === "string" && val.startsWith("0x") ? Buffer.from(val.slice(2), "hex")
    : Buffer.from(val, "base64");
  if (b.length !== 32) throw new Error(`expected 32 bytes, got ${b.length}`);
  return Array.from(b);
};
const toProofNodes = (nodes) => nodes.map((n) => ({ hash: toBytes32(n.hash), isRightSibling: n.isRightSibling ?? n.is_right_sibling }));

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(kp), { commitment: "confirmed" });
const idl = JSON.parse(readFileSync("day1/txoracle-devnet-idl.json", "utf8"));
const program = new anchor.Program(idl, provider);

const summary = v.summary;
const fixtureSummary = {
  fixtureId: new BN(summary.fixtureId),
  updateStats: {
    updateCount: summary.updateStats.updateCount,
    minTimestamp: new BN(summary.updateStats.minTimestamp),
    maxTimestamp: new BN(summary.updateStats.maxTimestamp),
  },
  eventsSubTreeRoot: toBytes32(summary.eventStatsSubTreeRoot ?? summary.eventsSubTreeRoot),
};
const stat1 = {
  statToProve: { key: v.statToProve.key, value: v.statToProve.value, period: v.statToProve.period },
  eventStatRoot: toBytes32(v.eventStatRoot),
  statProof: toProofNodes(v.statProof),
};
const stat2 = v.statToProve2 ? {
  statToProve: { key: v.statToProve2.key, value: v.statToProve2.value, period: v.statToProve2.period },
  eventStatRoot: toBytes32(v.eventStatRoot),
  statProof: toProofNodes(v.statProof2),
} : null;

const targetTs = Number(summary.updateStats.minTimestamp);
const epochDay = Math.floor(targetTs / 86400000);
const [dailyScoresPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)],
  program.programId
);
console.log(`ts=${targetTs} epochDay=${epochDay} dailyScoresPda=${dailyScoresPda.toBase58()}`);
console.log(`stat1 key=${stat1.statToProve.key} value=${stat1.statToProve.value} | stat2 ${stat2 ? `key=${stat2.statToProve.key} value=${stat2.statToProve.value}` : "none"}`);

// P1 goals - P2 goals > threshold(-99) : always-true predicate so a valid proof returns true
const predicate = { threshold: -99, comparison: { greaterThan: {} } };
const op = stat2 ? { subtract: {} } : null;

const ix = await program.methods
  .validateStat(new BN(targetTs), fixtureSummary, toProofNodes(v.subTreeProof), toProofNodes(v.mainTreeProof), predicate, stat1, stat2, op)
  .accounts({ dailyScoresMerkleRoots: dailyScoresPda })
  .instruction();

const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
tx.feePayer = kp.publicKey;
tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

const sim = await connection.simulateTransaction(tx);
console.log("\n=== SIMULATION RESULT ===");
console.log("err:", JSON.stringify(sim.value.err));
console.log("unitsConsumed:", sim.value.unitsConsumed);
console.log("returnData:", JSON.stringify(sim.value.returnData));
if (sim.value.returnData?.data) {
  const rd = Buffer.from(sim.value.returnData.data[0], "base64");
  console.log("decoded return (bool):", rd.length ? rd[0] === 1 : "empty");
}
console.log("logs:");
for (const l of sim.value.logs ?? []) console.log("  ", l);
