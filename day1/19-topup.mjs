// Top up the devnet wallet for program deploy rent (~2.2 SOL needed total)
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { readFileSync } from "node:fs";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));
let bal = await connection.getBalance(kp.publicKey);
console.log("balance:", bal / LAMPORTS_PER_SOL);
for (let i = 0; i < 3 && bal < 3.5 * LAMPORTS_PER_SOL; i++) {
  try {
    const sig = await connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    bal = await connection.getBalance(kp.publicKey);
    console.log(`airdrop ${i + 1} ok, balance:`, bal / LAMPORTS_PER_SOL);
  } catch (e) {
    console.log(`airdrop ${i + 1} failed:`, e.message.slice(0, 120));
    await new Promise((r) => setTimeout(r, 3000));
  }
}
