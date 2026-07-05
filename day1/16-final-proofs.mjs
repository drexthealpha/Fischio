// Prove the "match ended" signal: fetch proofs at terminal seqs of finished fixtures,
// check statToProve.period, and verify the USA-Bosnia final proof on-chain.
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import BN from "bn.js";
import { readFileSync, writeFileSync } from "node:fs";

const API = "https://txline-dev.txodds.com";
const { jwt, apiToken } = JSON.parse(readFileSync("day1/credentials.json", "utf8"));
const h = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

// terminal seqs from 15-full-history: [fixture, seq at/after terminal phase, label]
const CASES = [
  [18172379, 1054, "USA-Bosnia @ phase-5 transition"],
  [18172379, 1058, "USA-Bosnia @ very last update"],
  [18179764, 1161, "England-Congo @ phase-5 transition"],
  [18179764, 1165, "England-Congo @ very last update"],
  [18179550, 1312, "Belgium-Senegal @ phase-10 transition (after ET)"],
  [18179550, 1316, "Belgium-Senegal @ very last update"],
];

const proofs = {};
for (const [fid, seq, label] of CASES) {
  const r = await fetch(`${API}/api/scores/stat-validation?fixtureId=${fid}&seq=${seq}&statKey=1&statKey2=2`, { headers: h });
  if (!r.ok) { console.log(`${label}: ${r.status} ${(await r.text()).slice(0, 120)}`); continue; }
  const v = await r.json();
  proofs[`${fid}:${seq}`] = v;
  console.log(`${label}: stat1=${JSON.stringify(v.statToProve)} stat2=${JSON.stringify(v.statToProve2)}`);
  await new Promise((s) => setTimeout(s, 150));
}
writeFileSync("day1/final-proofs.json", JSON.stringify(proofs, null, 2));

// on-chain verification of USA-Bosnia final: P1 goals - P2 goals > 0 must be TRUE (2-0)
const pick = proofs["18172379:1058"] ?? proofs["18172379:1054"];
if (!pick) { console.log("no USA proof to verify"); process.exit(1); }

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(kp), { commitment: "confirmed" });
const program = new anchor.Program(JSON.parse(readFileSync("day1/txoracle-devnet-idl.json", "utf8")), provider);

const b32 = (a) => Array.from(Buffer.from(a));
const nodes = (ns) => ns.map((n) => ({ hash: b32(n.hash), isRightSibling: n.isRightSibling }));
const v = pick;
const minTs = v.summary.updateStats.minTimestamp;
const [pda] = PublicKey.findProgramAddressSync(
  [Buffer.from("daily_scores_roots"), new BN(Math.floor(minTs / 86400000)).toArrayLike(Buffer, "le", 2)],
  program.programId
);
const ix = await program.methods
  .validateStat(
    new BN(minTs),
    {
      fixtureId: new BN(v.summary.fixtureId),
      updateStats: { updateCount: v.summary.updateStats.updateCount, minTimestamp: new BN(minTs), maxTimestamp: new BN(v.summary.updateStats.maxTimestamp) },
      eventsSubTreeRoot: b32(v.summary.eventStatsSubTreeRoot),
    },
    nodes(v.subTreeProof), nodes(v.mainTreeProof),
    { threshold: 0, comparison: { greaterThan: {} } },
    { statToProve: v.statToProve, eventStatRoot: b32(v.eventStatRoot), statProof: nodes(v.statProof) },
    { statToProve: v.statToProve2, eventStatRoot: b32(v.eventStatRoot), statProof: nodes(v.statProof2) },
    { subtract: {} }
  )
  .accounts({ dailyScoresMerkleRoots: pda })
  .instruction();
const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
tx.feePayer = kp.publicKey;
tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
const sim = await connection.simulateTransaction(tx);
const ret = sim.value.returnData?.data ? Buffer.from(sim.value.returnData.data[0], "base64")[0] === 1 : null;
console.log(`\nON-CHAIN (USA-Bosnia FINAL, goalsA-goalsB>0): err=${JSON.stringify(sim.value.err)} return=${ret} cu=${sim.value.unitsConsumed}`);
console.log(`  proven leaves: stat1 period=${v.statToProve.period} value=${v.statToProve.value}, stat2 period=${v.statToProve2.period} value=${v.statToProve2.value}`);
if (sim.value.err) for (const l of sim.value.logs.slice(-6)) console.log("  ", l);
