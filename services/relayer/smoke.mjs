// Proof of gasless: a wallet with zero SOL signs a transaction and it lands, because the
// relayer pays the fee. The user's balance stays zero. This is the whole point.
import { Connection, Keypair, Transaction, SystemProgram, PublicKey } from "@solana/web3.js";

const RELAY = process.env.RELAY ?? "http://127.0.0.1:8791";
const connection = new Connection(process.env.RPC ?? "https://api.devnet.solana.com", "confirmed");

const feePayer = new PublicKey((await (await fetch(`${RELAY}/feepayer`)).json()).feePayer);
const user = Keypair.generate(); // never funded: 0 SOL
console.log("user:", user.publicKey.toBase58(), "(0 SOL)");
console.log("fee payer (relayer):", feePayer.toBase58());

const { blockhash } = await connection.getLatestBlockhash();
const tx = new Transaction();
tx.feePayer = feePayer;
tx.recentBlockhash = blockhash;
// a minimal instruction the user must authorize: a 0-lamport self-transfer
tx.add(SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: user.publicKey, lamports: 0 }));
tx.partialSign(user); // user signs their instruction; no fee-payer signature yet

const b64 = tx.serialize({ requireAllSignatures: false }).toString("base64");
const res = await fetch(`${RELAY}/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: b64 }) });
const j = await res.json();
console.log("relay response:", j);

if (j.signature) {
  const bal = await connection.getBalance(user.publicKey);
  console.log(`user balance after: ${bal} lamports (should be 0)`);
  console.log(bal === 0 ? "GASLESS OK: user paid nothing, tx landed" : "user paid something?!");
} else {
  console.log("relay failed");
}
