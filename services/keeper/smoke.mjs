// Proof the keeper drains a real heap: seed a crossing trade on a local validator (leaving a
// maker credit queued), then run the keeper's own tick() once and confirm the maker is paid.
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const BN = anchor.BN, U = 1_000_000;
const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));
const idl = JSON.parse(readFileSync("services/api/idl/fischio_exchange.json", "utf8"));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);
const PID = program.programId;
const seed = (s, k) => PublicKey.findProgramAddressSync([Buffer.from(s), k.toBuffer()], PID)[0];
const ooPda = (b, o) => PublicKey.findProgramAddressSync([Buffer.from("open_orders"), b.toBuffer(), o.toBuffer()], PID)[0];

const base = await createMint(connection, payer, payer.publicKey, null, 6);
const quote = await createMint(connection, payer, payer.publicKey, null, 6);
async function actor(bAmt, qAmt) {
  const kp = Keypair.generate();
  await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: LAMPORTS_PER_SOL })));
  const bAta = (await getOrCreateAssociatedTokenAccount(connection, payer, base, kp.publicKey)).address;
  const qAta = (await getOrCreateAssociatedTokenAccount(connection, payer, quote, kp.publicKey)).address;
  if (bAmt) await mintTo(connection, payer, base, bAta, payer, bAmt);
  if (qAmt) await mintTo(connection, payer, quote, qAta, payer, qAmt);
  return { kp, bAta, qAta };
}
const market = Keypair.generate().publicKey;
const book = seed("book", market), baseVault = seed("base_vault", book), quoteVault = seed("quote_vault", book), eventHeap = seed("events", book);
await program.methods.createBook(market).accountsPartial({ creator: payer.publicKey, book, baseMint: base, quoteMint: quote, baseVault, quoteVault, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY }).rpc();
await program.methods.initEventHeap().accountsPartial({ creator: payer.publicKey, book, eventHeap, systemProgram: SystemProgram.programId }).rpc();

const maker = await actor(100 * U, 0), taker = await actor(0, 100 * U);
async function setup(a, db, dq) {
  const oo = ooPda(book, a.kp.publicKey);
  await program.methods.initOpenOrders().accountsPartial({ owner: a.kp.publicKey, book, openOrders: oo, systemProgram: SystemProgram.programId }).signers([a.kp]).rpc();
  await program.methods.deposit(new BN(db), new BN(dq)).accountsPartial({ owner: a.kp.publicKey, book, openOrders: oo, baseVault, quoteVault, userBase: a.bAta, userQuote: a.qAta, tokenProgram: TOKEN_PROGRAM_ID }).signers([a.kp]).rpc();
  return oo;
}
const makerOo = await setup(maker, 100 * U, 0), takerOo = await setup(taker, 0, 100 * U);
const place = (a, oo, side, price, size) => program.methods.placeOrder(side, new BN(price), new BN(size)).accountsPartial({ owner: a.kp.publicKey, book, openOrders: oo, eventHeap }).signers([a.kp]).rpc();
await place(maker, makerOo, { ask: {} }, 600_000, 100 * U);
await place(taker, takerOo, { bid: {} }, 650_000, 100 * U);

const heapBefore = await program.account.eventHeap.fetch(eventHeap);
console.log("queued events before keeper:", Number(heapBefore.count));
console.log("maker quote before:", Number((await program.account.openOrders.fetch(makerOo)).quoteFree));

// run the keeper's own tick() once against this validator
process.env.RPC = "http://127.0.0.1:8899";
process.env.KEEPER_KEY = "day1/devnet-wallet.json";
const { tick } = await import("./server.mjs");
await tick();

const heapAfter = await program.account.eventHeap.fetch(eventHeap);
const makerAfter = Number((await program.account.openOrders.fetch(makerOo)).quoteFree);
console.log("queued events after keeper:", Number(heapAfter.count));
console.log("maker quote after:", makerAfter);
console.log(Number(heapAfter.count) === 0 && makerAfter === 60 * U ? "KEEPER OK: heap drained, maker paid 60" : "KEEPER FAILED");
process.exit(Number(heapAfter.count) === 0 && makerAfter === 60 * U ? 0 : 1);
