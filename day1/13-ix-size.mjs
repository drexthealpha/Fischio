// Measure the serialized byte size of a real validate_stat instruction (tx budget is 1232 bytes)
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import BN from "bn.js";
import { readFileSync } from "node:fs";

const v = JSON.parse(readFileSync("day1/proof-package.json", "utf8"));
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));
const provider = new anchor.AnchorProvider(new Connection("https://api.devnet.solana.com"), new anchor.Wallet(kp), {});
const program = new anchor.Program(JSON.parse(readFileSync("day1/txoracle-devnet-idl.json", "utf8")), provider);

const b32 = (a) => Array.from(Buffer.from(a));
const nodes = (ns) => ns.map((n) => ({ hash: b32(n.hash), isRightSibling: n.isRightSibling }));
const summary = {
  fixtureId: new BN(v.summary.fixtureId),
  updateStats: { updateCount: v.summary.updateStats.updateCount, minTimestamp: new BN(v.summary.updateStats.minTimestamp), maxTimestamp: new BN(v.summary.updateStats.maxTimestamp) },
  eventsSubTreeRoot: b32(v.summary.eventStatsSubTreeRoot),
};
const stat1 = { statToProve: v.statToProve, eventStatRoot: b32(v.eventStatRoot), statProof: nodes(v.statProof) };
const stat2 = { statToProve: v.statToProve2, eventStatRoot: b32(v.eventStatRoot), statProof: nodes(v.statProof2) };
const [pda] = PublicKey.findProgramAddressSync(
  [Buffer.from("daily_scores_roots"), new BN(Math.floor(v.summary.updateStats.minTimestamp / 86400000)).toArrayLike(Buffer, "le", 2)],
  program.programId
);
const ix = await program.methods
  .validateStat(new BN(v.summary.updateStats.minTimestamp), summary, nodes(v.subTreeProof), nodes(v.mainTreeProof),
    { threshold: -99, comparison: { greaterThan: {} } }, stat1, stat2, { subtract: {} })
  .accounts({ dailyScoresMerkleRoots: pda })
  .instruction();

console.log("proof node counts: statProof=%d statProof2=%d subTreeProof=%d mainTreeProof=%d",
  v.statProof.length, v.statProof2.length, v.subTreeProof.length, v.mainTreeProof.length);
console.log("validate_stat ix data bytes:", ix.data.length);
const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ix);
tx.feePayer = kp.publicKey;
tx.recentBlockhash = "11111111111111111111111111111111";
console.log("full tx serialized bytes (1 signer):", tx.serialize({ requireAllSignatures: false }).length, "/ 1232 limit");
