// Scan mainnet txoracle history for settlement/validation txs; report real CU consumed.
// Public RPC rate-limit tolerant: sequential, 350ms spacing, backoff on 429.
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync, writeFileSync } from "node:fs";

const RPC = "https://api.devnet.solana.com";
const PROGRAM = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J";
const MAX_PAGES = 8; // 8 x 100 sigs
const TARGET = ["settle_trade", "settle_matched_trade", "validate_stat", "validate_odds", "audit_trade_result", "claim_via_resolution", "claim_batch_legacy", "create_trade", "create_intent", "execute_match"];

const connection = new Connection(RPC, "confirmed");
const programId = new PublicKey(PROGRAM);
const idl = JSON.parse(readFileSync("day1/txoracle-devnet-idl.json", "utf8"));
const coder = new anchor.BorshInstructionCoder({ ...idl, address: PROGRAM });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { await sleep(1500 * (i + 1)); }
  }
  return null;
}

let before;
const counts = {};
const found = [];
let scanned = 0, oldest = null;
for (let page = 0; page < MAX_PAGES; page++) {
  const sigs = await withRetry(() => connection.getSignaturesForAddress(programId, { limit: 100, before }));
  if (!sigs || sigs.length === 0) break;
  before = sigs[sigs.length - 1].signature;
  oldest = new Date(sigs[sigs.length - 1].blockTime * 1000).toISOString();
  for (const s of sigs) {
    if (s.err) { counts.__failed = (counts.__failed ?? 0) + 1; continue; }
    const tx = await withRetry(() => connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }));
    scanned++;
    if (!tx) continue;
    const msg = tx.transaction.message;
    const keys = msg.staticAccountKeys ?? msg.accountKeys;
    const ixs = msg.compiledInstructions ?? msg.instructions;
    for (const ix of ixs) {
      if (!keys[ix.programIdIndex].equals(programId)) continue;
      let raw;
      try {
        raw = ix.data instanceof Uint8Array ? Buffer.from(ix.data) : Buffer.from(anchor.utils.bytes.bs58.decode(ix.data));
      } catch { continue; }
      const name = coder.decode(raw)?.name ?? "unknown";
      counts[name] = (counts[name] ?? 0) + 1;
      if (TARGET.includes(name)) {
        found.push({ sig: s.signature, name, cu: tx.meta?.computeUnitsConsumed, time: new Date(s.blockTime * 1000).toISOString() });
        console.log(`FOUND ${name} cu=${tx.meta?.computeUnitsConsumed} ${new Date(s.blockTime * 1000).toISOString()} ${s.signature}`);
      }
    }
    await sleep(350);
  }
  console.log(`page ${page + 1}/${MAX_PAGES} done, scanned=${scanned}, oldest=${oldest}, counts=${JSON.stringify(counts)}`);
}
writeFileSync("day1/cu-scan-devnet.json", JSON.stringify({ scanned, oldest, counts, found }, null, 2));
console.log("\nFINAL histogram:", JSON.stringify(counts, null, 1));
console.log("settlement/trade txs:", JSON.stringify(found, null, 1));
