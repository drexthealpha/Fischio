// Proof of full zero-SOL onboarding: an embedded wallet with no SOL and no accounts becomes
// a live trading account on a real devnet book, because the sponsor pays the rent and fee
// while the wallet only signs as owner. The wallet's balance stays exactly zero throughout.
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const SPONSOR = process.env.SPONSOR ?? "http://127.0.0.1:8793";
const BOOK = process.env.BOOK ?? "8mDh7frTvZuUJfCGwypzWSVzkHmD572DCn5TVSN6qYNX"; // seeded devnet book
const connection = new Connection(RPC, "confirmed");
const idl = JSON.parse(readFileSync("services/api/idl/fischio_exchange.json", "utf8"));
const PID = new PublicKey(idl.address);

const readWallet = { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t };
const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, readWallet, { commitment: "confirmed" }));

const sponsorPk = new PublicKey((await (await fetch(`${SPONSOR}/sponsor`)).json()).sponsor);
const guest = Keypair.generate(); // embedded wallet, never funded
const book = new PublicKey(BOOK);
const openOrders = PublicKey.findProgramAddressSync(
  [Buffer.from("open_orders"), book.toBuffer(), guest.publicKey.toBuffer()], PID)[0];

console.log("embedded wallet:", guest.publicKey.toBase58(), `(${await connection.getBalance(guest.publicKey)} lamports)`);
console.log("sponsor:", sponsorPk.toBase58());

// build init_open_orders: sponsor pays rent, guest is the owner authority
const ix = await program.methods.initOpenOrders()
  .accountsPartial({ payer: sponsorPk, owner: guest.publicKey, book, openOrders, systemProgram: SystemProgram.programId })
  .instruction();

const tx = new Transaction();
tx.feePayer = sponsorPk;
tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
tx.add(ix);
tx.partialSign(guest); // guest signs only as owner; no fee-payer signature yet

const b64 = tx.serialize({ requireAllSignatures: false }).toString("base64");
const res = await fetch(`${SPONSOR}/onboard`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: b64 }) });
const j = await res.json();
console.log("sponsor response:", j);

if (j.signature) {
  const oo = await program.account.openOrders.fetch(openOrders);
  const bal = await connection.getBalance(guest.publicKey);
  const ok = oo.owner.toBase58() === guest.publicKey.toBase58() && bal === 0;
  console.log("OpenOrders owner:", oo.owner.toBase58(), "| guest balance:", bal, "lamports");
  console.log(ok ? "FULL ZERO-SOL ONBOARDING OK: empty wallet is now a trading account on devnet" : "unexpected state");
  process.exit(ok ? 0 : 1);
} else {
  console.log("onboard failed");
  process.exit(1);
}
