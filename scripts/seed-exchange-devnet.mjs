// Seed one live order book on devnet so the exchange UI shows a real two-sided market. It
// mints two test SPL tokens (an outcome token and a USDC stand-in), opens a book, and rests
// bids and asks from two separate wallets so nothing self-trades. The orders stay resting, so
// the depth ladder has both sides with a visible spread. Run once; it prints the book address.
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const connection = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));
const idl = JSON.parse(readFileSync("target/idl/fischio_exchange.json", "utf8"));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);
const PID = program.programId;
const BN = anchor.BN, U = 1_000_000;

const seed = (s, k) => PublicKey.findProgramAddressSync([Buffer.from(s), k.toBuffer()], PID)[0];
const ooPda = (b, o) => PublicKey.findProgramAddressSync([Buffer.from("open_orders"), b.toBuffer(), o.toBuffer()], PID)[0];

console.log("payer:", payer.publicKey.toBase58(), "on", RPC);
const base = await createMint(connection, payer, payer.publicKey, null, 6);
const quote = await createMint(connection, payer, payer.publicKey, null, 6);
console.log("outcome mint:", base.toBase58(), "\nusdc mint:", quote.toBase58());

async function actor(bAmt, qAmt) {
  const kp = Keypair.generate();
  await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: 0.25 * LAMPORTS_PER_SOL })));
  const bAta = (await getOrCreateAssociatedTokenAccount(connection, payer, base, kp.publicKey)).address;
  const qAta = (await getOrCreateAssociatedTokenAccount(connection, payer, quote, kp.publicKey)).address;
  if (bAmt) await mintTo(connection, payer, base, bAta, payer, bAmt);
  if (qAmt) await mintTo(connection, payer, quote, qAta, payer, qAmt);
  return { kp, bAta, qAta };
}

const market = Keypair.generate().publicKey; // label for this book
const book = seed("book", market);
const baseVault = seed("base_vault", book), quoteVault = seed("quote_vault", book), eventHeap = seed("events", book);
await program.methods.createBook(market).accountsPartial({
  creator: payer.publicKey, book, baseMint: base, quoteMint: quote, baseVault, quoteVault,
  tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
}).rpc();
await program.methods.initEventHeap().accountsPartial({ creator: payer.publicKey, book, eventHeap, systemProgram: SystemProgram.programId }).rpc();
console.log("book:", book.toBase58());

async function setup(a, db, dq) {
  const oo = ooPda(book, a.kp.publicKey);
  await program.methods.initOpenOrders().accountsPartial({ owner: a.kp.publicKey, book, openOrders: oo, systemProgram: SystemProgram.programId }).signers([a.kp]).rpc();
  await program.methods.deposit(new BN(db), new BN(dq)).accountsPartial({ owner: a.kp.publicKey, book, openOrders: oo, baseVault, quoteVault, userBase: a.bAta, userQuote: a.qAta, tokenProgram: TOKEN_PROGRAM_ID }).signers([a.kp]).rpc();
  return oo;
}
// seller rests asks above the buyer's bids so nothing crosses: a clean spread
const seller = await actor(500 * U, 0);
const sellerOo = await setup(seller, 500 * U, 0);
await program.methods.placeOrder({ ask: {} }, new BN(0.55 * U), new BN(120 * U)).accountsPartial({ owner: seller.kp.publicKey, book, openOrders: sellerOo, eventHeap }).signers([seller.kp]).rpc();
await program.methods.placeOrder({ ask: {} }, new BN(0.60 * U), new BN(200 * U)).accountsPartial({ owner: seller.kp.publicKey, book, openOrders: sellerOo, eventHeap }).signers([seller.kp]).rpc();
await program.methods.placeOrder({ ask: {} }, new BN(0.65 * U), new BN(150 * U)).accountsPartial({ owner: seller.kp.publicKey, book, openOrders: sellerOo, eventHeap }).signers([seller.kp]).rpc();

const buyer = await actor(0, 500 * U);
const buyerOo = await setup(buyer, 0, 500 * U);
await program.methods.placeOrder({ bid: {} }, new BN(0.50 * U), new BN(180 * U)).accountsPartial({ owner: buyer.kp.publicKey, book, openOrders: buyerOo, eventHeap }).signers([buyer.kp]).rpc();
await program.methods.placeOrder({ bid: {} }, new BN(0.45 * U), new BN(240 * U)).accountsPartial({ owner: buyer.kp.publicKey, book, openOrders: buyerOo, eventHeap }).signers([buyer.kp]).rpc();
await program.methods.placeOrder({ bid: {} }, new BN(0.40 * U), new BN(300 * U)).accountsPartial({ owner: buyer.kp.publicKey, book, openOrders: buyerOo, eventHeap }).signers([buyer.kp]).rpc();

const b = await program.account.book.fetch(book);
console.log(`\nseeded: ${Number(b.bidCount)} bids, ${Number(b.askCount)} asks`);
console.log("best bid 0.50, best ask 0.55, spread 0.05");
console.log("\nBOOK", book.toBase58());
