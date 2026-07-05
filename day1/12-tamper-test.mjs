// Negative tests: (a) tampered stat value must fail Merkle checks; (b) honest proof with a
// false predicate must return false. Uses the saved proof package.
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import BN from "bn.js";
import { readFileSync } from "node:fs";

const v = JSON.parse(readFileSync("day1/proof-package.json", "utf8"));
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(kp), { commitment: "confirmed" });
const program = new anchor.Program(JSON.parse(readFileSync("day1/txoracle-devnet-idl.json", "utf8")), provider);

const b32 = (a) => Array.from(Buffer.from(a));
const nodes = (ns) => ns.map((n) => ({ hash: b32(n.hash), isRightSibling: n.isRightSibling ?? n.is_right_sibling }));
const summary = {
  fixtureId: new BN(v.summary.fixtureId),
  updateStats: {
    updateCount: v.summary.updateStats.updateCount,
    minTimestamp: new BN(v.summary.updateStats.minTimestamp),
    maxTimestamp: new BN(v.summary.updateStats.maxTimestamp),
  },
  eventsSubTreeRoot: b32(v.summary.eventStatsSubTreeRoot),
};
const ts = new BN(v.summary.updateStats.minTimestamp);
const epochDay = Math.floor(v.summary.updateStats.minTimestamp / 86400000);
const [pda] = PublicKey.findProgramAddressSync(
  [Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)],
  program.programId
);

async function run(label, statValue, predicate) {
  const stat1 = {
    statToProve: { key: v.statToProve.key, value: statValue, period: v.statToProve.period },
    eventStatRoot: b32(v.eventStatRoot),
    statProof: nodes(v.statProof),
  };
  const ix = await program.methods
    .validateStat(ts, summary, nodes(v.subTreeProof), nodes(v.mainTreeProof), predicate, stat1, null, null)
    .accounts({ dailyScoresMerkleRoots: pda })
    .instruction();
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const sim = await connection.simulateTransaction(tx);
  const ret = sim.value.returnData?.data ? Buffer.from(sim.value.returnData.data[0], "base64")[0] === 1 : null;
  const errLog = (sim.value.logs ?? []).find((l) => l.includes("Error") || l.includes("error"));
  console.log(`${label}: err=${JSON.stringify(sim.value.err)} return=${ret} cu=${sim.value.unitsConsumed}${errLog ? `\n   ${errLog}` : ""}`);
}

// honest value is v.statToProve.value (0). Predicate ">-99" true; tampering value to 3 must fail merkle.
await run("HONEST  single-stat, pred >-99 (expect true)  ", v.statToProve.value, { threshold: -99, comparison: { greaterThan: {} } });
await run("HONEST  single-stat, pred >0   (expect false) ", v.statToProve.value, { threshold: 0, comparison: { greaterThan: {} } });
await run("TAMPERED value=3, pred >-99    (expect reject)", 3, { threshold: -99, comparison: { greaterThan: {} } });
