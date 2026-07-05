// (a) Does daily_scores_roots PDA exist for today on devnet/mainnet?
// (b) Scan mainnet program history for settle/validate txs and read REAL compute-unit usage from logs.
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { readFileSync } from "node:fs";

const NETS = {
  devnet: { rpc: "https://api.devnet.solana.com", programId: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J" },
  mainnet: { rpc: "https://api.mainnet-beta.solana.com", programId: "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA" },
};
const idl = JSON.parse(readFileSync("day1/txoracle-devnet-idl.json", "utf8"));
const epochDayMs = Math.floor(Date.now() / 86400000); // docs derive epoch day from ms timestamps

for (const [net, cfg] of Object.entries(NETS)) {
  const connection = new Connection(cfg.rpc, "confirmed");
  const programId = new PublicKey(cfg.programId);
  for (const day of [epochDayMs, epochDayMs - 1]) {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("daily_scores_roots"), new BN(day).toArrayLike(Buffer, "le", 2)],
      programId
    );
    const info = await connection.getAccountInfo(pda);
    console.log(`${net} daily_scores_roots day=${day}: ${info ? `EXISTS (${info.data.length} bytes)` : "missing"} ${pda.toBase58()}`);
  }
}

// b) mainnet history scan
const connection = new Connection(NETS.mainnet.rpc, "confirmed");
const programId = new PublicKey(NETS.mainnet.programId);
const coder = new anchor.BorshInstructionCoder({ ...idl, address: NETS.mainnet.programId });

let before;
const found = [];
const counts = {};
for (let page = 0; page < 5 && found.length < 8; page++) {
  const sigs = await connection.getSignaturesForAddress(programId, { limit: 100, before });
  if (sigs.length === 0) break;
  before = sigs[sigs.length - 1].signature;
  for (const s of sigs) {
    if (s.err) continue;
    // cheap pre-filter: skip the 5-min oracle cadence txs by checking ix name only when needed
    const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx) continue;
    const msg = tx.transaction.message;
    const keys = msg.staticAccountKeys ?? msg.accountKeys;
    const ixs = msg.compiledInstructions ?? msg.instructions;
    for (const ix of ixs) {
      if (!keys[ix.programIdIndex].equals(programId)) continue;
      const raw = ix.data instanceof Uint8Array ? Buffer.from(ix.data) : Buffer.from(anchor.utils.bytes.bs58.decode(ix.data));
      const name = coder.decode(raw)?.name ?? "unknown";
      counts[name] = (counts[name] ?? 0) + 1;
      if (["settle_trade", "settle_matched_trade", "validate_stat", "audit_trade_result", "claim_via_resolution"].includes(name)) {
        found.push({ sig: s.signature, name, cu: tx.meta?.computeUnitsConsumed, time: new Date(s.blockTime * 1000).toISOString() });
        console.log(`FOUND ${name} cu=${tx.meta?.computeUnitsConsumed} ${s.signature} ${new Date(s.blockTime * 1000).toISOString()}`);
      }
    }
    await new Promise((r) => setTimeout(r, 120)); // stay under public RPC rate limits
  }
  console.log(`scanned page ${page}: counts so far`, JSON.stringify(counts));
}
console.log("\nix histogram:", JSON.stringify(counts, null, 1));
console.log("settlement txs found:", found.length);
