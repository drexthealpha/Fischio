// Adversarial + integration suite for the on-chain order book. Runs against a local
// validator with the exchange program. It trades two test SPL mints (base and quote),
// checks that fills happen at the maker's price, that cancel refunds the exact escrow,
// that a self-trade is rejected, and that no value is created or lost across a session
// (base and quote in the vaults always equal the sum of claimable balances, resting
// escrows, and credits still queued in the event heap waiting for the crank).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const BN = anchor.BN;
const PRICE_ONE = 1_000_000;
const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("local/devnet-wallet.json", "utf8"))));
const idl = JSON.parse(readFileSync("target/idl/fischio_exchange.json", "utf8"));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);
const PID = program.programId;

let base, quote; // test mints (base = outcome token, quote = USDC)
const U = 1_000_000; // 6 decimals

const seed = (s, k) => PublicKey.findProgramAddressSync([Buffer.from(s), k.toBuffer()], PID)[0];
const bookPdas = (market) => {
  const book = PublicKey.findProgramAddressSync([Buffer.from("book"), market.toBuffer()], PID)[0];
  return { book, baseVault: seed("base_vault", book), quoteVault: seed("quote_vault", book), eventHeap: seed("events", book) };
};
const ooPda = (book, owner) =>
  PublicKey.findProgramAddressSync([Buffer.from("open_orders"), book.toBuffer(), owner.toBuffer()], PID)[0];

async function actor(baseAmt, quoteAmt) {
  const kp = Keypair.generate();
  await provider.sendAndConfirm(new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: LAMPORTS_PER_SOL })));
  const baseAta = (await getOrCreateAssociatedTokenAccount(connection, payer, base, kp.publicKey)).address;
  const quoteAta = (await getOrCreateAssociatedTokenAccount(connection, payer, quote, kp.publicKey)).address;
  if (baseAmt) await mintTo(connection, payer, base, baseAta, payer, baseAmt);
  if (quoteAmt) await mintTo(connection, payer, quote, quoteAta, payer, quoteAmt);
  return { kp, baseAta, quoteAta };
}
const bal = async (a) => Number((await getAccount(connection, a)).amount);
const oo = async (addr) => program.account.openOrders.fetch(addr);

async function makeBook() {
  const market = Keypair.generate().publicKey; // the market this book trades (a label here)
  const P = bookPdas(market);
  await program.methods.createBook(market)
    .accountsPartial({
      creator: payer.publicKey, book: P.book, baseMint: base, quoteMint: quote,
      baseVault: P.baseVault, quoteVault: P.quoteVault,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    }).rpc();
  await program.methods.initEventHeap()
    .accountsPartial({ creator: payer.publicKey, book: P.book, eventHeap: P.eventHeap, systemProgram: SystemProgram.programId })
    .rpc();
  return { market, ...P };
}

async function setupTrader(P, a, depositBase, depositQuote) {
  const openOrders = ooPda(P.book, a.kp.publicKey);
  await program.methods.initOpenOrders()
    .accountsPartial({ payer: a.kp.publicKey, owner: a.kp.publicKey, book: P.book, openOrders, systemProgram: SystemProgram.programId })
    .signers([a.kp]).rpc();
  await program.methods.deposit(new BN(depositBase), new BN(depositQuote))
    .accountsPartial({
      owner: a.kp.publicKey, book: P.book, openOrders, baseVault: P.baseVault, quoteVault: P.quoteVault,
      userBase: a.baseAta, userQuote: a.quoteAta, tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([a.kp]).rpc();
  return openOrders;
}

// place an order under the new API: matching pushes maker credits to the event heap, so no
// maker accounts are passed here and one order can cross any number of makers.
async function place(P, a, openOrders, side, price, size) {
  return program.methods.placeOrder(side, new BN(price), new BN(size))
    .accountsPartial({ owner: a.kp.publicKey, book: P.book, openOrders, eventHeap: P.eventHeap })
    .signers([a.kp]).rpc();
}

// permissionless crank: pay out queued maker credits. Pass the makers' OpenOrders.
async function crank(P, makerOos, max = 200) {
  await program.methods.consumeEvents(max)
    .accountsPartial({ cranker: payer.publicKey, eventHeap: P.eventHeap, book: P.book })
    .remainingAccounts(makerOos.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false })))
    .rpc();
}

async function assertVaultConservation(P, label) {
  // base_vault must equal every trader's base_free, plus resting ask size, plus base credits
  // still queued in the event heap; quote_vault the same with bid notional and quote credits.
  const book = await program.account.book.fetch(P.book);
  const allOo = await program.account.openOrders.all([{ memcmp: { offset: 8 + 32, bytes: P.book.toBase58() } }]);
  let baseFree = 0, quoteFree = 0;
  for (const { account } of allOo) { baseFree += Number(account.baseFree); quoteFree += Number(account.quoteFree); }
  let restAsk = 0, restBidQuote = 0;
  for (let i = 0; i < Number(book.askCount); i++) restAsk += Number(book.asks[i].size);
  for (let i = 0; i < Number(book.bidCount); i++) {
    restBidQuote += Math.floor(Number(book.bids[i].price) * Number(book.bids[i].size) / PRICE_ONE);
  }
  const heap = await program.account.eventHeap.fetch(P.eventHeap);
  let pendBase = 0, pendQuote = 0;
  const cap = heap.events.length, head = Number(heap.head), count = Number(heap.count);
  for (let k = 0; k < count; k++) {
    const ev = heap.events[(head + k) % cap];
    pendBase += Number(ev.baseCredit); pendQuote += Number(ev.quoteCredit);
  }
  assert.equal(await bal(P.baseVault), baseFree + restAsk + pendBase, `${label}: base conserved`);
  assert.equal(await bal(P.quoteVault), quoteFree + restBidQuote + pendQuote, `${label}: quote conserved`);
}

test("setup: mint base and quote", async () => {
  base = await createMint(connection, payer, payer.publicKey, null, 6);
  quote = await createMint(connection, payer, payer.publicKey, null, 6);
  assert.ok(base && quote);
});

test("a bid crosses a resting ask at the maker's price; taker credited inline, maker by crank; value conserved", async () => {
  const P = await makeBook();
  const maker = await actor(100 * U, 0);
  const taker = await actor(0, 100 * U);
  const makerOo = await setupTrader(P, maker, 100 * U, 0); // maker deposits 100 base to sell
  const takerOo = await setupTrader(P, taker, 0, 100 * U); // taker deposits 100 quote to buy

  // maker rests an ask: sell 100 base @ 0.60
  await place(P, maker, makerOo, { ask: {} }, 600_000, 100 * U);
  // taker buys 100 @ up-to 0.65: crosses the 0.60 ask
  await place(P, taker, takerOo, { bid: {} }, 650_000, 100 * U);

  // taker is credited inside place_order; the maker's credit is queued in the heap
  const t = await oo(takerOo);
  assert.equal(Number(t.baseFree), 100 * U, "taker received 100 base immediately");
  assert.equal(Number(t.quoteFree), 40 * U, "taker keeps unspent quote (100 in, 60 spent)");
  assert.equal(Number((await oo(makerOo)).quoteFree), 0, "maker not yet paid (queued in heap)");
  await assertVaultConservation(P, "after cross, before crank");

  // crank pays the maker
  await crank(P, [makerOo]);
  assert.equal(Number((await oo(makerOo)).quoteFree), 60 * U, "maker received 60 quote after crank (100 @ 0.60)");
  assert.equal(Number((await program.account.eventHeap.fetch(P.eventHeap)).count), 0, "heap drained");
  await assertVaultConservation(P, "after crank");
});

test("same maker crossed twice: both fills accumulate through the heap, none lost", async () => {
  // one taker order crosses two resting orders from the same maker. Each fill is a separate
  // heap event; the crank must credit the maker twice, not overwrite.
  const P = await makeBook();
  const maker = await actor(200 * U, 0);
  const taker = await actor(0, 200 * U);
  const makerOo = await setupTrader(P, maker, 200 * U, 0);
  const takerOo = await setupTrader(P, taker, 0, 200 * U);
  await place(P, maker, makerOo, { ask: {} }, 600_000, 100 * U);
  await place(P, maker, makerOo, { ask: {} }, 600_000, 100 * U); // two resting asks, same maker
  await place(P, taker, takerOo, { bid: {} }, 650_000, 200 * U);

  assert.equal(Number((await oo(takerOo)).baseFree), 200 * U, "taker got all 200 base");
  assert.equal(Number((await program.account.eventHeap.fetch(P.eventHeap)).count), 2, "two events queued");
  await assertVaultConservation(P, "after double cross, before crank");

  await crank(P, [makerOo]);
  assert.equal(Number((await oo(makerOo)).quoteFree), 120 * U, "maker got BOTH fills: 200 @ 0.60");
  await assertVaultConservation(P, "after crank");
});

test("cancel returns the exact escrow", async () => {
  const P = await makeBook();
  const maker = await actor(0, 100 * U);
  const oo1 = await setupTrader(P, maker, 0, 100 * U);
  // rest a bid: buy 50 @ 0.40 -> escrow 20 quote
  await place(P, maker, oo1, { bid: {} }, 400_000, 50 * U);
  assert.equal(Number((await oo(oo1)).quoteFree), 80 * U, "20 escrowed into the order");
  const book = await program.account.book.fetch(P.book);
  const orderId = Number(book.bids[0].id);
  await program.methods.cancelOrder({ bid: {} }, new BN(orderId))
    .accountsPartial({ owner: maker.kp.publicKey, book: P.book, openOrders: oo1 }).signers([maker.kp]).rpc();
  assert.equal(Number((await oo(oo1)).quoteFree), 100 * U, "escrow fully refunded on cancel");
  await assertVaultConservation(P, "after cancel");
});

test("ATTACK: self-trade is rejected", async () => {
  const P = await makeBook();
  const u = await actor(100 * U, 100 * U);
  const uoo = await setupTrader(P, u, 100 * U, 100 * U);
  await place(P, u, uoo, { ask: {} }, 500_000, 50 * U);
  // same user tries to buy across their own ask
  try {
    await place(P, u, uoo, { bid: {} }, 550_000, 50 * U);
    assert.fail("self-trade should have been rejected");
  } catch (e) {
    assert.ok(`${e}${e.logs?.join("") ?? ""}`.includes("SelfTrade"), "rejected as SelfTrade");
  }
});

test("withdraw returns claimable balances to the wallet (after crank)", async () => {
  const P = await makeBook();
  const maker = await actor(100 * U, 0);
  const taker = await actor(0, 100 * U);
  const makerOo = await setupTrader(P, maker, 100 * U, 0);
  const takerOo = await setupTrader(P, taker, 0, 100 * U);
  await place(P, maker, makerOo, { ask: {} }, 500_000, 100 * U);
  await place(P, taker, takerOo, { bid: {} }, 500_000, 100 * U);
  await crank(P, [makerOo]); // the maker's 50 quote must be credited before it can be withdrawn

  const before = await bal(maker.quoteAta);
  await program.methods.withdraw(new BN(0), new BN(50 * U))
    .accountsPartial({
      owner: maker.kp.publicKey, book: P.book, openOrders: makerOo, baseVault: P.baseVault, quoteVault: P.quoteVault,
      userBase: maker.baseAta, userQuote: maker.quoteAta, tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([maker.kp]).rpc();
  assert.equal(await bal(maker.quoteAta), before + 50 * U, "maker withdrew 50 quote to wallet");
});

test("one taker order crosses two DIFFERENT makers, both paid by one crank", async () => {
  // this is the whole point of the heap: an order can cross many makers with no per-fill
  // account limit. Two makers rest asks; one taker sweeps both; one crank pays them both.
  const P = await makeBook();
  const m1 = await actor(100 * U, 0);
  const m2 = await actor(100 * U, 0);
  const taker = await actor(0, 200 * U);
  const m1Oo = await setupTrader(P, m1, 100 * U, 0);
  const m2Oo = await setupTrader(P, m2, 100 * U, 0);
  const takerOo = await setupTrader(P, taker, 0, 200 * U);
  await place(P, m1, m1Oo, { ask: {} }, 600_000, 100 * U);
  await place(P, m2, m2Oo, { ask: {} }, 700_000, 100 * U);
  await place(P, taker, takerOo, { bid: {} }, 700_000, 200 * U); // sweeps both asks

  assert.equal(Number((await oo(takerOo)).baseFree), 200 * U, "taker got 200 base across two makers");
  assert.equal(Number((await program.account.eventHeap.fetch(P.eventHeap)).count), 2, "two maker events queued");
  await assertVaultConservation(P, "two makers, before crank");

  await crank(P, [m1Oo, m2Oo]);
  assert.equal(Number((await oo(m1Oo)).quoteFree), 60 * U, "maker 1 paid 100 @ 0.60");
  assert.equal(Number((await oo(m2Oo)).quoteFree), 70 * U, "maker 2 paid 100 @ 0.70");
  assert.equal(Number((await program.account.eventHeap.fetch(P.eventHeap)).count), 0, "heap drained");
  await assertVaultConservation(P, "two makers, after crank");
});

test("crank is safe when a maker account is missing: it stops and a later crank finishes", async () => {
  // consume_events pops FIFO and stops at the first maker not provided, so it never fails and
  // never skips. Here maker 2 is withheld on the first crank, then paid on the second.
  const P = await makeBook();
  const m1 = await actor(100 * U, 0);
  const m2 = await actor(100 * U, 0);
  const taker = await actor(0, 200 * U);
  const m1Oo = await setupTrader(P, m1, 100 * U, 0);
  const m2Oo = await setupTrader(P, m2, 100 * U, 0);
  const takerOo = await setupTrader(P, taker, 0, 200 * U);
  await place(P, m1, m1Oo, { ask: {} }, 600_000, 100 * U); // fills first -> head of heap
  await place(P, m2, m2Oo, { ask: {} }, 600_000, 100 * U);
  await place(P, taker, takerOo, { bid: {} }, 600_000, 200 * U);

  // crank with ONLY maker 1: it is at the head, gets paid; then maker 2 is missing, so it stops
  await crank(P, [m1Oo]);
  assert.equal(Number((await oo(m1Oo)).quoteFree), 60 * U, "maker 1 paid");
  assert.equal(Number((await oo(m2Oo)).quoteFree), 0, "maker 2 not yet paid");
  assert.equal(Number((await program.account.eventHeap.fetch(P.eventHeap)).count), 1, "one event still queued");
  await assertVaultConservation(P, "partial crank");

  // second crank finishes maker 2
  await crank(P, [m2Oo]);
  assert.equal(Number((await oo(m2Oo)).quoteFree), 60 * U, "maker 2 paid on the second crank");
  assert.equal(Number((await program.account.eventHeap.fetch(P.eventHeap)).count), 0, "heap drained");
  await assertVaultConservation(P, "after finishing crank");
});
