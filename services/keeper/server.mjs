// fischio crank keeper. The exchange settles fills asynchronously: matching pushes each
// maker credit to a per-book event heap, and this service drains those heaps by calling the
// permissionless `consume_events` instruction. Makers are paid in the order their orders
// filled. Anyone can run this; it holds no authority over funds, it only triggers payouts
// that are already owed. If it stops, no funds are lost: credits simply wait in the heap
// until it, or any other caller, cranks.
//
// It signs as the cranker (pays tx fees only) with a key you provide:
//   KEEPER_KEY=path/to/key.json   (defaults to local/devnet-wallet.json for devnet)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js"; // cranker key + RPC only

const here = dirname(fileURLToPath(import.meta.url));
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const POLL_MS = Number(process.env.POLL_MS ?? 8000);
const BATCH = Number(process.env.BATCH ?? 16); // events (and distinct makers) per crank tx
const KEY_PATH = process.env.KEEPER_KEY ?? join(here, "..", "..", "local", "devnet-wallet.json");

const connection = new Connection(RPC, "confirmed");
const cranker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY_PATH, "utf8"))));
const idl = JSON.parse(readFileSync(join(here, "..", "api", "idl", "fischio_exchange.json"), "utf8"));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(cranker), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the maker credits queued in a heap, oldest first, read straight off the ring buffer
function queued(heap) {
  const out = [];
  const cap = heap.events.length, head = Number(heap.head), count = Number(heap.count);
  for (let k = 0; k < count; k++) out.push(heap.events[(head + k) % cap].maker);
  return out;
}

// drain one book's heap fully, one bounded batch per tx so we never exceed the tx account cap
async function drain(heapPk, heap) {
  const book = heap.book;
  let remaining = Number(heap.count);
  while (remaining > 0) {
    const fresh = await program.account.eventHeap.fetch(heapPk);
    if (Number(fresh.count) === 0) break;
    const makers = queued(fresh).slice(0, BATCH);
    // distinct makers for exactly the events we will process this tx (crank stops at the
    // first maker not supplied, so this prefix drains cleanly)
    const distinct = [...new Map(makers.map((m) => [m.toBase58(), m])).values()];
    const sig = await program.methods.consumeEvents(makers.length)
      .accountsPartial({ cranker: cranker.publicKey, eventHeap: heapPk, book })
      .remainingAccounts(distinct.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false })))
      .rpc();
    const after = await program.account.eventHeap.fetch(heapPk);
    const paid = remaining - Number(after.count);
    console.log(`  crank ${heapPk.toBase58().slice(0, 8)} paid ${paid} (${sig.slice(0, 8)})`);
    if (Number(after.count) >= remaining) { console.log("  no progress, stopping this heap"); break; }
    remaining = Number(after.count);
  }
}

export async function tick() {
  const heaps = await program.account.eventHeap.all();
  const pending = heaps.filter(({ account }) => Number(account.count) > 0);
  if (pending.length === 0) return;
  console.log(`${new Date().toISOString()}  ${pending.length} heap(s) with unpaid fills`);
  for (const { publicKey, account } of pending) {
    try { await drain(publicKey, account); }
    catch (e) { console.error(`  heap ${publicKey.toBase58().slice(0, 8)} error: ${String(e.message ?? e)}`); }
  }
}

// run the poll loop only when this file is the entry point; when imported (e.g. by the smoke
// test) the caller drives tick() itself
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`fischio keeper on ${RPC}\ncranker ${cranker.publicKey.toBase58()}  batch ${BATCH}  poll ${POLL_MS}ms`);
  for (;;) {
    try { await tick(); } catch (e) { console.error("tick error:", String(e.message ?? e)); }
    await sleep(POLL_MS);
  }
}
