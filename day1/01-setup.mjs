// Day-1 step 1: fund devnet wallet + fetch the deployed IDL (verify docs vs chain)
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { readFileSync, writeFileSync } from "node:fs";

import https from "node:https";

// api.devnet.solana.com serves an expired leaf cert (expired 2025-12-23, verified 2026-07-02).
// Throwaway devnet wallet only — never reuse this agent with real funds.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

const PROGRAM_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const connection = new Connection("https://api.devnet.solana.com", {
  commitment: "confirmed",
  httpAgent: insecureAgent,
});
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));
console.log("wallet:", kp.publicKey.toBase58());

let bal = await connection.getBalance(kp.publicKey);
console.log("balance:", bal / LAMPORTS_PER_SOL, "SOL");
if (bal < 0.05 * LAMPORTS_PER_SOL) {
  try {
    const sig = await connection.requestAirdrop(kp.publicKey, 1 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    bal = await connection.getBalance(kp.publicKey);
    console.log("airdrop ok, balance:", bal / LAMPORTS_PER_SOL, "SOL");
  } catch (e) {
    console.log("airdrop failed:", e.message);
  }
}

const wallet = new anchor.Wallet(kp);
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
const idl = await anchor.Program.fetchIdl(PROGRAM_ID, provider);
if (!idl) {
  console.log("NO IDL ON CHAIN for", PROGRAM_ID.toBase58());
  process.exit(1);
}
writeFileSync("day1/txoracle-devnet-idl.json", JSON.stringify(idl, null, 2));
console.log("IDL fetched:", idl.metadata?.name, idl.metadata?.version);
console.log("instructions:", idl.instructions.length);
for (const name of ["validate_stat", "subscribe", "settle_trade", "create_trade"]) {
  const ix = idl.instructions.find((i) => i.name === name);
  console.log(` ${name}: ${ix ? "PRESENT" : "MISSING"}${ix ? ` (args: ${ix.args.map(a=>a.name).join(", ")})` : ""}`);
}
