// Proof of the SOL on-ramp: a buyer sends SOL to the sponsor and receives test USDC back at
// the fixed devnet rate. Confirms the sponsor verifies the real payment before minting.
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, getAccount } from "@solana/spl-token";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const SPONSOR = process.env.SPONSOR ?? "http://127.0.0.1:8793";
const connection = new Connection(RPC, "confirmed");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("local/devnet-wallet.json", "utf8"))));
const { sponsor: sponsorStr, fusdc } = await (await fetch(`${SPONSOR}/sponsor`)).json();
const sponsorPk = new PublicKey(sponsorStr);
const fusdcMint = new PublicKey(fusdc);

// a buyer with a little SOL and no USDC
const buyer = Keypair.generate();
await (async () => {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: buyer.publicKey, lamports: 0.3 * LAMPORTS_PER_SOL }));
  tx.feePayer = funder.publicKey; tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash; tx.sign(funder);
  await connection.confirmTransaction(await connection.sendRawTransaction(tx.serialize()), "confirmed");
})();
console.log("buyer:", buyer.publicKey.toBase58(), "funded 0.3 SOL");

// buyer pays 0.1 SOL to the sponsor
const pay = new Transaction().add(SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: sponsorPk, lamports: 0.1 * LAMPORTS_PER_SOL }));
pay.feePayer = buyer.publicKey; pay.recentBlockhash = (await connection.getLatestBlockhash()).blockhash; pay.sign(buyer);
const sig = await connection.sendRawTransaction(pay.serialize());
await connection.confirmTransaction(sig, "confirmed");
console.log("paid 0.1 SOL to sponsor, sig", sig.slice(0, 12) + "…");

// redeem it for USDC
const j = await (await fetch(`${SPONSOR}/buy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signature: sig }) })).json();
console.log("sponsor /buy response:", j);

const ata = (await getOrCreateAssociatedTokenAccount(connection, funder, fusdcMint, buyer.publicKey)).address;
const bal = Number((await getAccount(connection, ata)).amount) / 1e6;
console.log("buyer USDC balance:", bal);
const ok = j.ok && Math.abs(bal - 0.1 * 100) < 0.001; // 0.1 SOL * 100 = 10 USDC
console.log(ok ? "ON-RAMP OK: 0.1 SOL bought 10 test USDC" : "unexpected");
process.exit(ok ? 0 : 1);
