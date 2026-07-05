// Linchpin: (a) genuine phase-5 proof must verify on-chain; (b) mid-match period-0 proof
// relabeled as period=5 must be REJECTED (proves period is inside the hashed leaf).
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import BN from "bn.js";
import { readFileSync } from "node:fs";

const API = "https://txline-dev.txodds.com";
const FID = 18172379;
const { jwt, apiToken } = JSON.parse(readFileSync("day1/credentials.json", "utf8"));
const h = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(kp), { commitment: "confirmed" });
const program = new anchor.Program(JSON.parse(readFileSync("day1/txoracle-devnet-idl.json", "utf8")), provider);
const b32 = (a) => Array.from(Buffer.from(a));
const nodes = (ns) => ns.map((n) => ({ hash: b32(n.hash), isRightSibling: n.isRightSibling }));

async function fetchProof(seq) {
  const r = await fetch(`${API}/api/scores/stat-validation?fixtureId=${FID}&seq=${seq}&statKey=1&statKey2=2`, { headers: h });
  if (!r.ok) throw new Error(`stat-validation ${r.status}`);
  return r.json();
}

async function simulate(v, stat1Override, label) {
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
      { statToProve: stat1Override ?? v.statToProve, eventStatRoot: b32(v.eventStatRoot), statProof: nodes(v.statProof) },
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
  const errLog = (sim.value.logs ?? []).find((l) => l.includes("Error Code"));
  console.log(`${label}: err=${JSON.stringify(sim.value.err)} return=${ret} cu=${sim.value.unitsConsumed}${errLog ? `\n   ${errLog.split("Program log: ")[1]}` : ""}`);
}

const vFinal = await fetchProof(1054); // genuine phase-5 (period=5, 2-0)
const vMid = await fetchProof(446);    // mid-H1 period=0, value 1-0

await simulate(vFinal, null, "GENUINE phase-5 final proof (expect true)          ");
await simulate(vMid, null, "GENUINE mid-match period-0 proof (verifies as data) ");
await simulate(vMid, { ...vMid.statToProve, period: 5 }, "FORGED: mid-match proof relabeled period=5 (expect reject)");
