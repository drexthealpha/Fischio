// Decode the devnet pricing_matrix account to see real service levels
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(kp), { commitment: "confirmed" });
const idl = JSON.parse(readFileSync("day1/txoracle-devnet-idl.json", "utf8"));
const program = new anchor.Program(idl, provider);

const [pricingMatrixPda] = PublicKey.findProgramAddressSync([Buffer.from("pricing_matrix")], program.programId);
console.log("pricing_matrix PDA:", pricingMatrixPda.toBase58());

const acct = Object.keys(program.account).find((k) => k.toLowerCase().includes("pricing"));
console.log("account ns key:", acct);
const pm = await program.account[acct].fetch(pricingMatrixPda);
for (const row of pm.rows ?? pm.serviceRows ?? []) {
  console.log(JSON.stringify(row, (k, v) => (typeof v === "bigint" || v?._bn ? v.toString() : v)));
}
