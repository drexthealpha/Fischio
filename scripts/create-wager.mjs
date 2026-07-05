// Create + accept a wager on any cluster. Maker and taker are fresh keypairs funded
// from the day1 wallet; their keys are saved so stakes are never stranded.
// Usage: node scripts/create-wager.mjs --fixture <id> [--rpc <url>] [--stake-sol 0.01] [--expiry-hours 6]
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";
import { readFileSync, writeFileSync } from "node:fs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const FIXTURE = Number(arg("fixture"));
if (!FIXTURE) { console.error("--fixture <id> is required"); process.exit(1); }
const RPC = arg("rpc", "https://api.devnet.solana.com");
const STAKE = Math.round(Number(arg("stake-sol", "0.01")) * LAMPORTS_PER_SOL);
const EXPIRY_H = Number(arg("expiry-hours", "6"));

const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));
// --maker-day1 / --taker-day1: use the day1 wallet itself as that party (so the
// Account view shows its wagers when that wallet is connected)
const maker = process.argv.includes("--maker-day1") ? funder : Keypair.generate();
const taker = process.argv.includes("--taker-day1") ? funder : Keypair.generate();
const connection = new Connection(RPC, "confirmed");

// fund generated actors: stake + fees + wager account rent headroom
const fundLamports = STAKE + 10_000_000;
const transfers = [maker, taker]
  .filter((kp) => !kp.publicKey.equals(funder.publicKey))
  .map((kp) => SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: kp.publicKey, lamports: fundLamports }));
if (transfers.length) {
  await sendAndConfirmTransaction(connection, new Transaction().add(...transfers), [funder], { commitment: "confirmed" });
}

const idl = JSON.parse(readFileSync("target/idl/wc_settle.json", "utf8"));
const makerProgram = new anchor.Program(idl, new anchor.AnchorProvider(connection, new anchor.Wallet(maker), { commitment: "confirmed" }));

const wagerId = (BigInt(Date.now()) << 8n) + BigInt(Math.floor(Math.random() * 256));
const [wager] = PublicKey.findProgramAddressSync(
  [Buffer.from("wager"), maker.publicKey.toBuffer(), new BN(wagerId.toString()).toArrayLike(Buffer, "le", 8)],
  makerProgram.programId
);
const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), wager.toBuffer()], makerProgram.programId);

// canonical v1 market: P1 to beat P2 in 90'+ET, pens excluded (shootout = taker's win)
const terms = {
  fixtureId: new BN(FIXTURE),
  statAKey: 1,
  statBKey: 2,
  op: { subtract: {} },
  predicate: { threshold: 0, comparison: { greaterThan: {} } },
};
const expiryTs = Math.floor(Date.now() / 1000) + EXPIRY_H * 3600;

await makerProgram.methods
  .createWager(new BN(wagerId.toString()), terms, new BN(STAKE), new BN(expiryTs))
  .accountsPartial({ maker: maker.publicKey, wager, vault, systemProgram: SystemProgram.programId })
  .rpc();

const NO_ACCEPT = process.argv.includes("--no-accept"); // leave the wager Open (a live market)
if (!NO_ACCEPT) {
  const takerProgram = new anchor.Program(idl, new anchor.AnchorProvider(connection, new anchor.Wallet(taker), { commitment: "confirmed" }));
  await takerProgram.methods
    .acceptWager()
    .accountsPartial({ taker: taker.publicKey, wager, vault, systemProgram: SystemProgram.programId })
    .rpc();
}

const actorsFile = `day1/actors-${wager.toBase58().slice(0, 8)}.json`;
writeFileSync(actorsFile, JSON.stringify({
  wager: wager.toBase58(),
  fixture: FIXTURE,
  maker: Array.from(maker.secretKey),
  taker: Array.from(taker.secretKey),
}, null, 2));

console.log(`fixture:   ${FIXTURE}`);
console.log(`maker:     ${maker.publicKey.toBase58()} (backs P1, stake ${STAKE / LAMPORTS_PER_SOL} SOL)`);
console.log(`taker:     ${taker.publicKey.toBase58()} (against)`);
console.log(`wager:     ${wager.toBase58()}  [${NO_ACCEPT ? "Open" : "Active"}, expires in ${EXPIRY_H}h]`);
console.log(`actors saved: ${actorsFile}`);
console.log(`\nbot:   node bot/settle-bot.mjs --wager ${wager.toBase58()} --rpc ${RPC} > live.log`);
console.log(`relay: node bot/live-relay.mjs --log live.log --rpc ${RPC}`);
console.log(`view:  http://localhost:5173/?live&wager=${wager.toBase58()}`);
